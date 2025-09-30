import puppeteer from "puppeteer";

const WAIT_MS = 18000;
const UA = process.env.USER_AGENT || "FiosFonBot/1.0 (+https://github.com/maidhci/fiosfon)";

// Map verbose subtypes to the canonical buckets we display in the UI
const CANON = {
  "Email Address": "Email Address",
  "Phone Number": "Phone Number",
  "Name": "Name",
  "Device ID": "Device ID",
  "User ID": "User ID",
  "Precise Location": "Location",
  "Coarse Location": "Location",
  "Approximate Location": "Location",
  "Location": "Location",
  "Contact Info": "Contact Info",
  "User Content": "User Content",
  "Photos or Videos": "Photos or Videos",
  "Photos": "Photos or Videos",
  "Videos": "Photos or Videos",
  "Audio Data": "Audio Data",
  "Voice Data": "Audio Data",
  "Contacts": "Contacts",
  "Health & Fitness": "Health & Fitness",
  "Health": "Health & Fitness",
  "Fitness": "Health & Fitness",
  "Financial Info": "Financial Info",
  "Payment Info": "Financial Info",
  "Purchases": "Purchases",
  "Browsing History": "Browsing/Search History",
  "Search History": "Browsing/Search History",
  "Identifiers": "Identifiers",
  "Usage Data": "Usage Data",
  "Diagnostics": "Diagnostics",
  "Crash Data": "Diagnostics",
  "Performance Data": "Diagnostics",
  "Sensitive Info": "Sensitive Info",
  "Messages": "Messages",
  "Other Data": "Other Data Types",
  "Other Data Types": "Other Data Types",
};

function canonBucket(label = "") {
  const t = String(label).trim();
  return CANON[t] || CANON[t.replace(/s$/, "")] || t;
}

/**
 * Scrape an App Store product page for:
 *  - privacy_labels (three buckets)
 *  - privacy_details (per category: subtypes, purposes, tracked/linked flags)
 *  - privacy_policy_url
 *  - developer_website_url
 */
export async function scrapePrivacyForApp(appId) {
  const url = `https://apps.apple.com/ie/app/id${encodeURIComponent(appId)}`;
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: WAIT_MS });

    // Nudge scroll so deferred sections render
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
    await page.waitForTimeout(1200);

    // Extract developer website & privacy policy URLs
    const linkInfo = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const pick = (pred) => {
        const hit = anchors.find(pred);
        return hit ? hit.href : null;
      };
      const privacyPolicyUrl = pick(a => /privacy/i.test(a.textContent || "") && /^https?:/i.test(a.href));
      const developerWebsiteUrl = pick(a => /developer website/i.test(a.textContent || "") && /^https?:/i.test(a.href));
      return { privacyPolicyUrl, developerWebsiteUrl };
    });

    // Pull both the simple chips & the detailed table-ish content
    const raw = await page.evaluate(() => {
      function findSection(label) {
        const all = Array.from(document.querySelectorAll("section,article,div"));
        return all.find(el => (el.textContent || "").trim().toLowerCase().includes(label.toLowerCase()));
      }

      function harvestSimple(section) {
        if (!section) return [];
        const nodes = Array.from(section.querySelectorAll("li,span,div"));
        return nodes
          .map(n => (n.textContent || "").trim())
          .filter(Boolean)
          .filter(t => t.length <= 40)
          .filter(t => /^[\w\s/&().,'-]+$/.test(t));
      }

      // High-level chips under "App Privacy"
      function grabBuckets() {
        const titles = ["Data Used to Track You", "Data Linked to You", "Data Not Linked to You"];
        const out = Object.fromEntries(titles.map(t => [t, []]));
        for (const t of titles) {
          const sec = findSection(t);
          out[t] = Array.from(new Set(harvestSimple(sec)));
        }
        return out;
      }

      // More detailed breakdown (after "See Details")
      function grabDetails() {
        const details = {};
        const root =
          Array.from(document.querySelectorAll("section,article,div"))
            .find(el => /app privacy|data used to track|data linked to you/i.test(el.textContent || "")) || document.body;

        // Rows can be div rows, table rows, or list items depending on Apple’s template
        const rows = Array.from(root.querySelectorAll("table tr, div[role='row'], li"));
        rows.forEach(row => {
          const text = (row.textContent || "").trim();
          if (!text) return;

          // Guess a category label (left-most strong/th/cell)
          const labelEl =
            row.querySelector("th, strong, h3, h4, [data-test-detail-header]") ||
            row.querySelector("div, span");
          if (!labelEl) return;

          const bucket = (labelEl.textContent || "").trim();
          if (!bucket) return;

          // Sub-items (chips/badges/pills)
          const badgeEls = Array.from(row.querySelectorAll("[class*=Badge], [class*=Tag], .badge, .chip, li, span"));
          const subtypes = Array.from(new Set(
            badgeEls.map(b => (b.textContent || "").trim()).filter(x => x && x.length <= 48)
          ));

          // Purposes: look for common keywords in the row’s text
          const PURPOSES = [
            "Advertising",
            "Developer's Advertising",
            "Personalization",
            "Product Personalization",
            "Analytics",
            "Fraud Prevention",
            "App Functionality",
            "Other Purposes"
          ];
          const purposes = Array.from(new Set(PURPOSES.filter(p => text.toLowerCase().includes(p.toLowerCase()))));

          // Flags
          const tracked = /track/i.test(text);
          const linked = /link(ed)? to you/i.test(text);
          const notLinked = /not linked/i.test(text);

          if (!details[bucket]) {
            details[bucket] = { subtypes: [], purposes: [], tracked: false, linked: false, notLinked: false };
          }
          details[bucket].subtypes = Array.from(new Set([...details[bucket].subtypes, ...subtypes]));
          details[bucket].purposes = Array.from(new Set([...details[bucket].purposes, ...purposes]));
          details[bucket].tracked = details[bucket].tracked || tracked;
          details[bucket].linked = details[bucket].linked || linked;
          details[bucket].notLinked = details[bucket].notLinked || notLinked;
        });

        return details;
      }

      return { buckets: grabBuckets(), details: grabDetails() };
    });

    // Canonicalize details keys & subtypes
    const labels = raw.buckets || {};
    const details = {};
    for (const [bucket, info] of Object.entries(raw.details || {})) {
      const key = bucket.trim();
      const subs = Array.from(new Set((info.subtypes || []).map(s => canonBucket(s))));
      details[key] = {
        subtypes: subs,
        purposes: info.purposes || [],
        tracked: !!info.tracked,
        linked: !!info.linked,
        notLinked: !!info.notLinked
      };
    }

    return {
      as_of: new Date().toISOString(),
      privacy_labels: labels,
      privacy_details: details,
      privacy_policy_url: linkInfo.privacyPolicyUrl || null,
      developer_website_url: linkInfo.developerWebsiteUrl || null,
      sources: [{ label: "App Store (IE)", url }]
    };
  } finally {
    await browser.close();
  }
}
