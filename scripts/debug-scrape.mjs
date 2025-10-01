import { scrapePrivacyForApp } from "./scrape-privacy.mjs";

const appId = process.argv[2];
if (!appId) {
  console.error("Usage: node scripts/debug-scrape.mjs <APP_ID>");
  process.exit(1);
}

console.log("== Debug scrape for App ID:", appId, "==");
try {
  const data = await scrapePrivacyForApp(appId);
  console.log(JSON.stringify(data, null, 2));
} catch (e) {
  console.error("Scrape failed:", e);
  process.exit(1);
}
