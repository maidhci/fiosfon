import puppeteer from "puppeteer";
const WAIT_MS = 15000;

export async function scrapePrivacyForApp(appId){
  const url = `https://apps.apple.com/ie/app/id${appId}`;
  const browser = await puppeteer.launch({ headless: "new", args:["--no-sandbox","--disable-setuid-sandbox"] });
  try{
    const page = await browser.newPage();
    await page.setUserAgent(process.env.USER_AGENT || "FiosFonBot/1.0");
    await page.goto(url, { waitUntil:"domcontentloaded", timeout: WAIT_MS });
    await page.evaluate(()=>window.scrollTo(0, document.body.scrollHeight*0.6));
    await page.waitForTimeout(1200);

    const data = await page.evaluate(() => {
      const titles = [
        "Data Used to Track You",
        "Data Linked to You",
        "Data Not Linked to You"
      ];
      const result = Object.fromEntries(titles.map(t => [t, []]));

      function findSection(label){
        const els = Array.from(document.querySelectorAll("h2,h3,h4,div,span"));
        const h = els.find(el => (el.textContent||"").trim().toLowerCase() === label.toLowerCase());
        if(!h) return null;
        return h.closest("section") || h.parentElement || h;
      }

      function harvest(section){
        if(!section) return [];
        const chips = Array.from(section.querySelectorAll("li,span,div"))
          .map(x => (x.textContent||"").trim())
          .filter(Boolean)
          .filter(t => t.length <= 32 && /^[\w\s/()-]+$/.test(t));
        return Array.from(new Set(chips));
      }

      titles.forEach(t => { result[t] = harvest(findSection(t)); });
      return result;
    });

    const norm = arr => Array.from(new Set((arr||[]).map(v=>{
      const t=v.trim();
      if(/purchase/i.test(t)) return "Purchases";
      if(/identifier/i.test(t)) return "Identifiers";
      if(/usage/i.test(t)) return "Usage Data";
      if(/diagnostic/i.test(t)) return "Diagnostics";
      if(/contact info/i.test(t)) return "Contact Info";
      if(/user content/i.test(t)) return "User Content";
      if(/browsing|search history/i.test(t)) return "Browsing/Search History";
      return t;
    })));

    const privacy_labels = {
      "Data Used to Track You": norm(data["Data Used to Track You"]),
      "Data Linked to You":     norm(data["Data Linked to You"]),
      "Data Not Linked to You": norm(data["Data Not Linked to You"])
    };

    return { as_of: new Date().toISOString(), privacy_labels, sources:[{label:"App Store (IE)", url}] };
  } finally {
    await browser.close();
  }
}