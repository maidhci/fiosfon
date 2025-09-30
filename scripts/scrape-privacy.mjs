import puppeteer from "puppeteer";

const WAIT_MS = 18000;
const UA = process.env.USER_AGENT || "FiosFonBot/1.0 (+https://github.com/)";

function normText(t = "") {
  return t.replace(/\s+/g, " ").trim();
}

// Maps verbose subtypes to our canonical bucket names used in your UI
const CANON = {
  "Email Address": "Email Address",
  "Phone Number": "Phone Number",
  "Name": "Name",
  "Device ID": "Device ID",
  "User ID": "User ID",
  "Precise Location": "Location",
  "Coarse Location": "Location",
  "Contact Info": "Contact Info",
  "User Content": "User Content",
  "Photos or Videos": "Photos or Videos",
  "Audio Data": "Audio Data",
  "Contacts": "Contacts",
  "Health & Fitness": "Health & Fitness",
  "Financial Info": "Financial Info",
  "Purchases": "Purchases",
  "Browsing History": "Browsing/Search History",
  "Search History": "Browsing/Search History",
  "Identifiers": "Identifiers",
  "Usage Data": "Usage Data",
  "Diagnostics": "Diagnostics",
  "Sensitive Info": "Sensitive Info",
  "Messages": "Messages",
  "Other Data": "Other Data Types",
  "Other Data Types": "Other Data Types",
};

function canonBucket(label) {
  const k = CANON[label] || CANON[label.replace(/s$/,"")] || label;
  return k;
}

/**
 * Scrape the App Store page:
 * - privacy_labels (3 buckets)
 * - privacy_details: per bucket (e.g., "Contact Info") -> { subtypes, flags, purposes }
 * - privacy_policy_url
 */
export async function scrapePrivacyForApp(appId) {
  const url = `https://apps.apple.com/ie/app/id${appId}`;
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: WAIT_MS });

    // Scroll a bit to ensure privacy section is in DOM
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.55));
    await page.waitForTimeout(1200);

    // Try to capture privacy policy URL from the "Developer Website / Privacy Policy" area
    const privacyPolicyUrl = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const hit = anchors.find(a => /privacy/i.test(a.textContent || '') && /^https?:/i.test(a.href));
      return hit ? hit.href : null;
    });

    const raw = await page.evaluate(() => {
      // Grab the whole App Privacy block text and structured nodes if present
      function grabBuckets() {
        // high-level “chips” as we already did
        const titles = ["Data Used to Track You", "Data Linked to You", "Data Not Linked to You"];
        const res = Object.fromEntries(titles.map(t => [t, []]));

        function findSection(label) {
          const all = Array.from(document.querySelectorAll("section,div,article"));
          return all.find(el => (el.textContent || "").trim().toLowerCase().includes(label.toLowerCase()));
        }

        function harvestSimple(section) {
          if (!section) return [];
          const possible = Array.from(section.querySelectorAll("li,span,div"));
          return possible
            .map(x => (x.textContent || "").trim())
            .filter(Boolean)
            .filter(t => t.length <= 40)
            .filter(t => /^[\w\s/&().,-]+$/.test(t));
        }

        for (const t of titles) {
          const sec = findSection(t);
          res[t] = Array.from(new Set(harvestSimple(sec)));
        }
        return res;
      }

      // More detailed table often found under “See Details”
      function grabDetails() {
        // We look for rows that look like:
        // [Category]  [Sub-item badges ...]  [Purpose chips ...]  [TRACKED|LINKED|NOT LINKED markers]
        const details = {};
        const containers = Array.from(document.querySelectorAll("section,div,article"));
        const root = containers.find(el => /App Privacy|Data Used to Track/i.test(el.textContent || "")) || document.body;

        const rows = Array.from(root.querySelectorAll("table tr, div[role='row'], li"));
        rows.forEach(row => {
          const text = (row.textContent || "").trim();
          if (!text) return;

          // Category / bucket label (left-most strong or first cell)
          const labelEl =
            row.querySelector("th, strong, h3, h4, [data-test-detail-header]") ||
            row.querySelector("div, span");
          if (!labelEl) return;

          const bucket = (labelEl.textContent || "").trim();
          if (!bucket) return;

          // Collect “subtypes” as pill/badge texts
          const badgeEls = Array.from(row.querySelectorAll("[class*=Badge], [class*=Tag], li, .badge, .chip, span"));
          const subtypes = Array.from(
            new Set(
              badgeEls
                .map(b => (b.textContent || "").trim())
                .filter(x => x && x.length <= 40)
            )
          );

          // Purposes are often rendered as chips after a label like “Used for”
          const purposeKeywords = ["Advertising", "Analytics", "App Functionality", "Personalization", "Developer's Advertising", "Product Personalization", "Fraud Prevention", "Other Purposes"];
          const purposes = Array.from(
            new Set(
              purposeKeywords.filter(k => text.toLowerCase().includes(k.toLowerCase()))
            )
          );

          // Flags (rough heuristics from text)
          const tracked = /track/i.test(text);
          const linked = /link(ed)? to you/i.test(text);
          const notLinked = /not linked/i.test(text);

          const key = bucket;
          if (!details[key]) {
            details[key] = { subtypes: [], purposes: [], tracked: false, linked: false, notLinked: false };
          }
          details[key].subtypes = Array.from(new Set([...details[key].subtypes, ...subtypes]));
          details[key].purposes = Array.from(new Set([...details[key].purposes, ...purposes]));
          details[key].tracked = details[key].tracked || tracked;
          details[key].linked = details[key].linked || linked;
          details[key].notLinked = details[key].notLinked || notLinked;
        });

        return details;
      }

      return { buckets: grabBuckets(), details: grabDetails() };
    });

    // Canonicalize & shape
    const labels = raw.buckets;
    const details = {};
    for (const [bucket, obj] of Object.entries(raw.details || {})) {
      const key = bucket.trim();
      const subs = Array.from(new Set((obj.subtypes || []).map(s => canonBucket(s))));
      details[key] = {
        subtypes: subs,
        purposes: obj.purposes || [],
        tracked: !!obj.tracked,
        linked: !!obj.linked,
        notLinked: !!obj.notLinked
      };
    }

    return {
      as_of: new Date().toISOString(),
      privacy_labels: labels,
      privacy_details: details,
      privacy_policy_url: privacyPolicyUrl || null,
      sources: [{ label: "App Store (IE)", url }]
    };
  } finally {
    await browser.close();
  }
}
