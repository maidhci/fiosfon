// scripts/scrape-privacy.mjs
import puppeteer from "puppeteer";

const WAIT_MS = 20000;

// tiny sleep helper (instead of page.waitForTimeout)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function scrapePrivacyForApp(appId) {
  const url = `https://apps.apple.com/ie/app/id${appId}`;
  const browser = await puppeteer.launch({
    headless: true, // compatible with GH Actions' Chromium
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(process.env.USER_AGENT || "FiosFonBot/1.0 (+github actions)");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: WAIT_MS });

    // Give the page some time to lazy-load sections and hydrate
    await sleep(1500);

    // Try to scroll a bit to trigger further content loads
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight * 0.6);
    });
    await sleep(800);

    // Try to reveal “See Details” inside the App Privacy panel if present
    try {
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a"));
        const target = btns.find((b) => {
          const t = (b.textContent || "").trim().toLowerCase();
          return t.includes("see details") || t === "details";
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      });
      if (clicked) await sleep(800);
    } catch {
      // non-fatal
    }

    const data = await page.evaluate(() => {
      const titles = [
        "Data Used to Track You",
        "Data Linked to You",
        "Data Not Linked to You",
      ];

      // Find a section node that appears to be the App Privacy area
      function findPrivacyRoot() {
        // Look for headings like “App Privacy” or the three titles
        const candidates = Array.from(document.querySelectorAll("section, div"));
        const hits = candidates.filter((el) => {
          const txt = (el.textContent || "").toLowerCase();
          return (
            txt.includes("app privacy") ||
            txt.includes("data used to track you") ||
            txt.includes("data linked to you") ||
            txt.includes("data not linked to you")
          );
        });
        // choose the largest text block to reduce false positives
        return hits.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)[0] || document.body;
      }

      function findSection(root, label) {
        const all = Array.from(root.querySelectorAll("h2, h3, h4, div, span, strong"));
        // exact match first
        let node = all.find(
          (el) => (el.textContent || "").trim().toLowerCase() === label.toLowerCase()
        );
        // then partial match
        if (!node) {
          node = all.find((el) =>
            (el.textContent || "").trim().toLowerCase().includes(label.toLowerCase())
          );
        }
        if (!node) return null;
        // Climb up a bit to a reasonable container
        return node.closest("section") || node.parentElement || node;
      }

      // Harvest “chips”/list items that look like category names
      function harvest(section) {
        if (!section) return [];
        // common patterns: li, chip-like spans/divs
        const nodes = Array.from(section.querySelectorAll("li,span,div,a"))
          .map((n) => (n.textContent || "").trim())
          .filter(Boolean);

        // Keep things that look like category labels, not whole sentences
        const filtered = nodes.filter((t) => {
          if (t.length > 48) return false;
          // Avoid generic words
          if (/^see details$/i.test(t)) return false;
          if (/^details$/i.test(t)) return false;
          if (/^learn more$/i.test(t)) return false;
          // Category-like tokens (letters, spaces, /, (), -)
          return /^[\w\s/()'-]+$/.test(t);
        });

        // Deduplicate while preserving order
        const seen = new Set();
        const out = [];
        for (const t of filtered) {
          const key = t.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            out.push(t);
          }
        }
        return out;
      }

      const root = findPrivacyRoot();
      const result = {};
      for (const title of [
        "Data Used to Track You",
        "Data Linked to You",
        "Data Not Linked to You",
      ]) {
        const sec = findSection(root, title);
        result[title] = harvest(sec);
      }

      // Try to extract a privacy policy link and developer website link
      function pickLink(testFn) {
        const links = Array.from(document.querySelectorAll('a[href]'));
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const txt = (a.textContent || '').trim().toLowerCase();
          if (testFn(href, txt)) return a.href || href;
        }
        return null;
      }

      const privacyPolicyUrl = pickLink((href, txt) =>
        /privacy/.test(href) || txt.includes('privacy policy')
      );

      // Prefer explicit “Developer Website”, else a non-apple external link in header area
      let developerWebsiteUrl = pickLink((href, txt) =>
        txt.includes('developer website')
      );
      if (!developerWebsiteUrl) {
        developerWebsiteUrl = pickLink((href) =>
          /^https?:\/\//.test(href) && !/apple\.com/i.test(href)
        );
      }

      return { result, privacyPolicyUrl, developerWebsiteUrl };
    });

    // Normalise/clean category tokens to our canonical buckets
    const normalise = (arr) =>
      Array.from(
        new Set(
          (arr || [])
            .map((v) => String(v).trim())
            .map((t) => {
              if (/purchase/i.test(t)) return "Purchases";
              if (/identifier/i.test(t)) return "Identifiers";
              if (/usage/i.test(t)) return "Usage Data";
              if (/diagnostic|crash/i.test(t)) return "Diagnostics";
              if (/contact\s*info/i.test(t)) return "Contact Info";
              if (/user\s*content/i.test(t)) return "User Content";
              if (/browsing|search\s*history/i.test(t)) return "Browsing/Search History";
              if (/location/i.test(t)) return "Location";
              if (/financial/i.test(t)) return "Financial Info";
              if (/photos?|videos?/i.test(t)) return "Photos or Videos";
              if (/audio/i.test(t)) return "Audio Data";
              if (/messages?/i.test(t)) return "Messages";
              if (/contacts?/i.test(t)) return "Contacts";
              if (/health|fitness/i.test(t)) return "Health & Fitness";
              if (/sensitive/i.test(t)) return "Sensitive Info";
              return t;
            })
        )
      );

    const privacy_labels = {
      "Data Used to Track You": normalise(data.result["Data Used to Track You"] || []),
      "Data Linked to You": normalise(data.result["Data Linked to You"] || []),
      "Data Not Linked to You": normalise(data.result["Data Not Linked to You"] || []),
    };

    // Lightweight per-category details scaffold (we don’t have subtypes reliably without
    // a deeper parse; we still add booleans for which buckets the category appeared in)
    const privacy_details = {};
    for (const bucket of Object.keys(privacy_labels)) {
      for (const cat of privacy_labels[bucket]) {
        if (!privacy_details[cat]) {
          privacy_details[cat] = { tracked: false, linked: false, notLinked: false, purposes: [], subtypes: [] };
        }
        if (bucket === "Data Used to Track You") privacy_details[cat].tracked = true;
        if (bucket === "Data Linked to You") privacy_details[cat].linked = true;
        if (bucket === "Data Not Linked to You") privacy_details[cat].notLinked = true;
      }
    }

    // Compose response
    const out = {
      as_of: new Date().toISOString(),
      privacy_labels,
      privacy_details,
      privacy_policy_url: data.privacyPolicyUrl || null,
      developer_website_url: data.developerWebsiteUrl || null,
      sources: [{ label: "App Store (IE)", url }],
    };

    return out;
  } finally {
    await browser.close();
  }
}
