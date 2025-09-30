import puppeteer from "puppeteer";

const WAIT_MS = 45000; // be patient on headless runners
const UA_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function scrapePrivacyForApp(appId) {
  const urlWithAnchor = `https://apps.apple.com/ie/app/id${appId}#privacy`;
  const urlPlain      = `https://apps.apple.com/ie/app/id${appId}`;

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--lang=en-IE,en"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(process.env.USER_AGENT || UA_SAFARI);
    await page.setExtraHTTPHeaders({ "accept-language": "en-IE,en;q=0.9" });
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });

    // Block heavy assets (keep CSS)
    await page.setRequestInterception(true);
    page.on("request", req => {
      const t = req.resourceType();
      if (t === "image" || t === "font" || t === "media") return req.abort();
      req.continue();
    });

    // 1) Try to land on the privacy anchor
    await page.goto(urlWithAnchor, { waitUntil: "domcontentloaded", timeout: WAIT_MS });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
    await sleep(1200);

    // Expand “See details” if present
    try {
      await page.$$eval("button,a", els => {
        els
          .filter(el => /see details/i.test(el.textContent || ""))
          .forEach(el => el instanceof HTMLElement && el.click());
      });
      await sleep(900);
    } catch {}

    // If headings don’t appear quickly, reload without anchor and wait for network idle
    try {
      await page.waitForFunction(() => {
        const txt = el => (el.textContent || "").trim().toLowerCase();
        return Array.from(document.querySelectorAll("h2,h3,h4,div,span"))
          .some(el => ["data used to track you","data linked to you","data not linked to you"].includes(txt(el)));
      }, { timeout: 6000 });
    } catch {
      await page.goto(urlPlain, { waitUntil: "networkidle2", timeout: WAIT_MS });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
      await sleep(1500);
      try {
        await page.$$eval("button,a", els => {
          els
            .filter(el => /see details/i.test(el.textContent || ""))
            .forEach(el => el instanceof HTMLElement && el.click());
        });
        await sleep(900);
      } catch {}
    }

    // Final wait: confirm at least one privacy heading is present
    await page.waitForFunction(() => {
      const txt = el => (el.textContent || "").trim().toLowerCase();
      return Array.from(document.querySelectorAll("h2,h3,h4,div,span"))
        .some(el => ["data used to track you","data linked to you","data not linked to you"].includes(txt(el)));
    }, { timeout: WAIT_MS });

    // Extract chip-like items near each heading
    const raw = await page.evaluate(() => {
      const HEADS = [
        "Data Used to Track You",
        "Data Linked to You",
        "Data Not Linked to You"
      ];

      const findBlock = (label) => {
        const all = Array.from(document.querySelectorAll("h2,h3,h4,div,span"));
        const h = all.find(el => (el.textContent || "").trim().toLowerCase() === label.toLowerCase());
        if (!h) return null;
        let node = h;
        for (let i = 0; i < 4 && node && node !== document.body; i++) {
          if (node.querySelectorAll("li, span, div").length > 6) break;
          node = node.parentElement;
        }
        return node || h.parentElement || h;
      };

      const harvest = (block) => {
        if (!block) return [];
        const texts = Array.from(block.querySelectorAll("li,span,div"))
          .map(x => (x.textContent || "").trim())
          .filter(Boolean)
          .filter(t => t.length <= 40 && /^[\w\s/()&-]+$/.test(t));
        const uniq = Array.from(new Set(texts));
        return uniq.filter(t =>
          !/data used to track you|data linked to you|data not linked to you|app privacy/i.test(t)
        );
      };

      const out = {};
      for (const label of HEADS) out[label] = harvest(findBlock(label));
      return out;
    });

    // Normalise to your buckets
    const norm = (arr = []) => Array.from(new Set(arr.map(v => {
      const t = v.trim();
      if (/purchase/i.test(t)) return "Purchases";
      if (/identifier|device id|user id/i.test(t)) return "Identifiers";
      if (/usage|product interaction|performance data/i.test(t)) return "Usage Data";
      if (/diagnostic/i.test(t)) return "Diagnostics";
      if (/contact\s*info|email address|phone/i.test(t)) return "Contact Info";
      if (/user\s*content|photos?|videos?/i.test(t)) return "User Content";
      if (/browsing|search history/i.test(t)) return "Browsing/Search History";
      if (/location/i.test(t)) return "Location";
      if (/health/i.test(t)) return "Health & Fitness";
      if (/financial/i.test(t)) return "Financial Info";
      return t;
    })));

    const privacy_labels = {
      "Data Used to Track You": norm(raw["Data Used to Track You"]),
      "Data Linked to You":     norm(raw["Data Linked to You"]),
      "Data Not Linked to You": norm(raw["Data Not Linked to You"])
    };

    return {
      as_of: new Date().toISOString(),
      privacy_labels,
      sources: [{ label: "App Store (IE)", url: urlPlain }]
    };
  } finally {
    await browser.close();
  }
}