import puppeteer from "puppeteer";

const TIMEOUT_MS = 45000;
const UA_FALLBACK =
  process.env.USER_AGENT ||
  // Realistic Safari UA helps avoid blocks:
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keep only Apple's official categories */
const ALLOWED = new Set([
  "Contact Info","Health & Fitness","Financial Info","Location","Sensitive Info",
  "User Content","Identifiers","Purchases","Usage Data","Diagnostics","Contacts",
  "Search History","Browsing History","Browsing/Search History","Audio Data",
  "Photos or Videos","Messages","Other Data","Other Data Types","Customer Support",
  "Name"
]);

function cleanTokens(tokens) {
  const out = [];
  for (const raw of tokens) {
    const t = (raw || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (/^app privacy$/i.test(t)) continue;
    if (/^see details$/i.test(t)) continue;
    if (/^learn more$/i.test(t)) continue;
    if (t.length > 40) continue;
    if (ALLOWED.has(t)) out.push(t);
  }
  return Array.from(new Set(out));
}

function textIncludes(el, needle) {
  return ((el?.textContent || el?.innerText || "").toLowerCase().includes(needle));
}

export async function scrapePrivacyForApp(appId) {
  const url = `https://apps.apple.com/ie/app/id${appId}`;
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA_FALLBACK);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    // Nudge the SPA to render the privacy section
    await sleep(1200);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
    await sleep(1000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.8));
    await sleep(800);

    const scraped = await page.evaluate((allowedList) => {
      const byText = (needle) => {
        needle = needle.toLowerCase();
        const all = Array.from(document.querySelectorAll("h1,h2,h3,h4,section,div,span"));
        return all.find((el) => (el.textContent || "").trim().toLowerCase() === needle) || null;
      };

      const nearestSectionFor = (headerEl) => {
        if (!headerEl) return null;
        const sec = headerEl.closest("section");
        return sec || headerEl.parentElement || headerEl;
      };

      const harvest = (container) => {
        if (!container) return [];
        const chips = Array.from(container.querySelectorAll("li, span, div, a"))
          .map((el) => (el.textContent || "").trim())
          .filter(Boolean);
        // Filter later in Node using allowed set
        return chips;
      };

      const sections = {
        track: nearestSectionFor(byText("Data Used to Track You")),
        linked: nearestSectionFor(byText("Data Linked to You")),
        notLinked: nearestSectionFor(byText("Data Not Linked to You"))
      };

      const rawLabels = {
        "Data Used to Track You": harvest(sections.track),
        "Data Linked to You": harvest(sections.linked),
        "Data Not Linked to You": harvest(sections.notLinked)
      };

      // Try to find "Privacy Policy" and "Developer Website" links
      const anchors = Array.from(document.querySelectorAll("a"));
      const findLink = (substr) => {
        substr = substr.toLowerCase();
        const hit = anchors.find(
          (a) =>
            (a.textContent || a.ariaLabel || "").toLowerCase().includes(substr)
        );
        return hit?.href || null;
      };

      const privacyPolicyUrl =
        findLink("privacy policy") ||
        anchors.find(a => /privacy/i.test(a.href))?.href ||
        null;

      const developerWebsiteUrl =
        findLink("developer website") ||
        anchors.find(a => /developer/i.test(a.textContent || ""))?.href ||
        null;

      // Collect “purposes” if Apple shows them inline (varies)
      const purposeMap = {};
      const purposeBlocks = Array.from(document.querySelectorAll("section,div"));
      purposeBlocks.forEach((blk) => {
        const t = (blk.textContent || "").toLowerCase();
        if (!/app privacy|data used|data linked|data not linked/.test(t)) return;

        const catChips = Array.from(blk.querySelectorAll("li,span,div"))
          .map((n) => (n.textContent || "").trim())
          .filter(Boolean);
        const cats = Array.from(new Set(catChips));
        let purposes = [];
        if (/advertis(ing|ements)/i.test(t)) purposes.push("Advertising");
        if (/personalization|personalisation/i.test(t)) purposes.push("Personalization");
        if (/analytics/i.test(t)) purposes.push("Analytics");
        if (/fraud/i.test(t)) purposes.push("Fraud Prevention");
        if (/functionality|app function/i.test(t)) purposes.push("App Functionality");

        cats.forEach((c) => {
          if (!purposeMap[c]) purposeMap[c] = new Set();
          purposes.forEach((p) => purposeMap[c].add(p));
        });
      });

      return {
        rawLabels,
        privacyPolicyUrl,
        developerWebsiteUrl,
        purposeMap: Object.fromEntries(
          Object.entries(purposeMap).map(([k, v]) => [k, Array.from(v)])
        )
      };
    }, Array.from(ALLOWED));

    // Clean and normalize
    const cleaned = {};
    for (const [k, arr] of Object.entries(scraped.rawLabels || {})) {
      cleaned[k] = cleanTokens(arr || []);
    }

    // Build per-category flags (tracked/linked/notLinked)
    const allCats = new Set([
      ...(cleaned["Data Used to Track You"] || []),
      ...(cleaned["Data Linked to You"] || []),
      ...(cleaned["Data Not Linked to You"] || [])
    ]);

    const privacy_details = {};
    for (const cat of allCats) {
      privacy_details[cat] = {
        tracked: (cleaned["Data Used to Track You"] || []).includes(cat) || false,
        linked: (cleaned["Data Linked to You"] || []).includes(cat) || false,
        notLinked: (cleaned["Data Not Linked to You"] || []).includes(cat) || false,
        subtypes: [],
        purposes: scraped.purposeMap?.[cat] || []
      };
    }

    return {
      as_of: new Date().toISOString(),
      privacy_labels: cleaned,
      privacy_details,
      privacy_policy_url: scraped.privacyPolicyUrl || null,
      developer_website_url: scraped.developerWebsiteUrl || null,
      sources: [{ label: "App Store (IE)", url }]
    };
  } finally {
    await browser.close();
  }
}
