import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { scrapePrivacyForApp } from "./scrape-privacy.mjs";

// Node 18+ has global fetch; if using older Node, uncomment next line and add node-fetch
// import fetch from "node-fetch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const APPS_JSON = path.join(DATA_DIR, "apps.json");
const CACHE_DIR = path.join(DATA_DIR, "privacy_cache");

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}
async function readJson(p, fallback = null) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch { return fallback; }
}
async function writeJson(p, obj) {
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function lookupFromiTunes(appId) {
  try {
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=ie`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const r = (json.results || [])[0];
    if (!r) return null;
    return {
      developerWebsiteUrl: r.sellerUrl || null,
      artistViewUrl: r.artistViewUrl || null
    };
  } catch {
    return null;
  }
}

async function mergePrivacy(app) {
  const appId = app.app_id || app.id;
  if (!appId) return app;

  const cachePath = path.join(CACHE_DIR, `${appId}.json`);
  let cached = await readJson(cachePath);

  // scrape if no cache
  if (!cached) {
    try {
      cached = await scrapePrivacyForApp(appId);
      await writeJson(cachePath, cached);
    } catch (e) {
      console.warn(`Privacy scrape failed for ${app.name}: ${e.message}`);
      return app; // keep original, don't drop the app
    }
  }

  const merged = { ...app };

  // high-level buckets
  if (cached.privacy_labels) merged.privacy_labels = cached.privacy_labels;

  // new: per-bucket details
  if (cached.privacy_details) merged.privacy_details = cached.privacy_details;

  // policy + developer website
  if (cached.privacy_policy_url) merged.privacy_policy_url = cached.privacy_policy_url;
  if (cached.developer_website_url) merged.developer_website_url = cached.developer_website_url;

  // try iTunes lookup for developer site if missing
  if (!merged.developer_website_url) {
    const lu = await lookupFromiTunes(appId);
    if (lu?.developerWebsiteUrl) merged.developer_website_url = lu.developerWebsiteUrl;
  }

  // merge sources (dedupe by URL)
  const srcs = new Map((merged.sources || []).map(s => [s.url, s]));
  for (const s of (cached.sources || [])) {
    if (s?.url) srcs.set(s.url, s);
  }
  merged.sources = Array.from(srcs.values());

  // basic summary if absent
  if (!merged.tracking_summary && merged.privacy_labels) {
    const hasTrack = (merged.privacy_labels["Data Used to Track You"] || []).length > 0;
    const hasLinked = (merged.privacy_labels["Data Linked to You"] || []).length > 0;
    merged.tracking_summary = [
      hasTrack ? "Some data may be used to track you across apps and websites." : "No tracking categories disclosed.",
      hasLinked ? "Some data may be collected and linked to your identity." : "No linked data categories disclosed."
    ];
  }

  return merged;
}

async function main() {
  await ensureDir(CACHE_DIR);

  // apps.json format we use in the site is { as_of, apps: [...] }
  // (Ignore older { boards: {...} } format)
  const data = await readJson(APPS_JSON, { as_of: "", apps: [] });
  const apps = data.apps || [];

  // Allow TEST_N to limit updates for quick runs (e.g. TEST_N=10 npm run update:apps)
  const max = Number.isFinite(+process.env.TEST_N) ? Math.max(0, +process.env.TEST_N) : apps.length;
  const slice = apps.slice(0, max || apps.length);

  const out = [];
  for (const app of slice) {
    out.push(await mergePrivacy(app));
  }
  // keep any remaining apps unmodified if TEST_N used
  if (slice.length < apps.length) out.push(...apps.slice(slice.length));

  const result = { as_of: new Date().toISOString().slice(0, 10), apps: out };
  await writeJson(APPS_JSON, result);
  console.log("Wrote", APPS_JSON);
}

if (process.env.NODE_ENV !== "test") {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
