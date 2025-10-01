import puppeteer from "puppeteer";

const WAIT_MS = 20000;

// Known Apple privacy categories (keep only these)
const ALLOWED = new Set([
  "Contact Info",
  "Health & Fitness",
  "Financial Info",
  "Location",
  "Sensitive Info",
  "Contacts",
  "User Content",
  "Browsing/Search History",
  "Identifiers",
  "Purchases",
  "Usage Data",
  "Diagnostics",
  "Other Data"
]);

// Normalise minor wording differences into our canonical labels
function normaliseCategory(s) {
  const t = s.trim()
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " "); // nbsp

  const lower = t.toLowerCase();

  // Common variants seen on the App Store
  if (lower === "photos and videos") return "Photos or Videos"; // (we don't currently include this in ALLOWED; keep mapping here if you later add it)
  if (lower === "photos or videos") return "Photos or Videos";
  if (lower === "search history") return "Browsing/Search History";
  if (lower === "browsing history") return "Browsing/Search History";
  if (lower === "customer support") return "Other Data";

  // Return original (capitalisation fixed) if it matches an allowed one
  // Capitalise words properly
  const cased = t
    .split(" ")
    .map(w => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

  return cased;
}

function cleanTokens(tokens, developerName = "") {
  const dev = (developerName || "").toLowerCase();
  const out = [];
  for (let raw of tokens) {
    if (!raw) continue;
    let s = raw.replace(/\u00A0/g, " ").trim();

    // Drop obvious noise
    const noise =
      /^(app privacy|see details|learn more|privacy policy|more|details)$/i;
    if (noise.test(s)) continue;

    // Drop bare developer name or lines that are just the dev
    if (dev && s.toLowerCase() === dev) continue;

    // Toss very long strings (they’re not chips)
    if (s.length > 40) continue;

    // Normalise & keep only if in our allow-list
    const norm = normaliseCategory(s);

    // Some categories we normalise to labels not currently in ALLOWED;
    // If you want them, add to ALLOWED above.
    if (ALLOWED.has(norm)) out.push(norm);
  }

  // Dedupe while preserving order
  return Array.from(new Set(out));
}

async function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

export async function scrapePrivacyForApp(appId) {
  const url = `https://apps.apple.com/ie/app/id${appId}`;
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(process.env.USER_AGENT || "FiosFonBot/1.0");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: WAIT_MS });

    // Nudge page so privacy section mounts
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
    await delay(1200);

    const devName = await page.evaluate(() => {
      // Try to read the developer name from the header area
      const dev =
        document.querySelector('[data-test-we-artist-link]') ||
        document.querySelector('a[href*="developer"]') ||
        document.querySelector('h2 ~ a') ||
        document.querySelector('header a');

      return (dev?.textContent || "").trim();
    });

    const data = await page.evaluate(() => {
      // Grab lots of small text nodes in the privacy area
      // (DOM changes often; we’ll filter on the Node side)
      function pickText(el) {
        return (el?.textContent || "")
          .replace(/\u00A0/g, " ")
          .trim();
      }

      // Collect texts near headings that look like the three buckets
      const titles = [
        "Data Used to Track You",
        "Data Linked to You",
        "Data Not Linked to You"
      ];

      // Try to find blocks per title; fall back to scanning the page
      function findSectionTexts(title) {
        const all = Array.from(document.querySelectorAll("h2, h3, h4, section, div"));
        const h = all.find(n => pickText(n).toLowerCase() === title.toLowerCase());
        const scope = h ? (h.closest("section") || h.parentElement || h) : document;
        // Collect likely chip texts under that scope
        const chips = Array.from(scope.querySelectorAll("li, span, div, a, p"))
          .map(pickText)
          .map(s => s.replace(/\s+/g, " "))
          .filter(Boolean);
        return chips;
      }

      const res = {};
      for (const t of titles) {
        res[t] = findSectionTexts(t);
      }

      // Also try to read the Privacy Policy link
      const policyEl =
        document.querySelector('a[href*="privacy"]') ||
        document.querySelector('a[aria-label*="Privacy"]');
      const policy = policyEl ? policyEl.href : null;

      // Try to read developer website link
      const devSiteEl =
        document.querySelector('a[href*="http"]a[href*="developer"]') ||
        document.querySelector('a[href*="seller"]') ||
        document.querySelector('[data-test-we-artist-link]');

      const devSite = devSiteEl ? devSiteEl.href : null;

      return {
        raw: res,
        privacy_policy_url: policy,
        developer_website_url: devSite
      };
    });

    // Clean sections using whitelist + normalisation
    const cleaned = {};
    for (const [bucket, tokens] of Object.entries(data.raw || {})) {
      cleaned[bucket] = cleanTokens(tokens, devName);
    }

    // Build final object
    const privacy_labels = {
      "Data Used to Track You": cleaned["Data Used to Track You"] || [],
      "Data Linked to You": cleaned["Data Linked to You"] || [],
      "Data Not Linked to You": cleaned["Data Not Linked to You"] || []
    };

    // Placeholder – we can later enrich this with per-category purposes/subtypes
    const privacy_details = {}; // keep for future

    const out = {
      as_of: new Date().toISOString(),
      privacy_labels,
      privacy_details,
      privacy_policy_url: data.privacy_policy_url || null,
      developer_website_url: data.developer_website_url || null,
      sources: [{ label: "App Store (IE)", url }]
    };

    return out;
  } finally {
    await browser.close();
  }
}
