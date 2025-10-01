// scripts/update-apps.mjs
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
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(p, obj) {
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/** Pull numeric App Store ID from any known place on the app object */
function deriveAppId(app) {
  if (app?.app_id) return String(app.app_id);
  if (app?.id && /^\d+$/.test(String(app.id))) return String(app.id);

  const urls = [];
  if (Array.isArray(app?.sources)) {
    for (const s of app.sources) if (s?.url) urls.push(s.url);
  }
  if (app?.icon) urls.push(app.icon);
  if (app?.appStoreUrl) urls.push(app.appStoreUrl);

  for (const u of urls) {
    if (typeof u !== "string") continue;
    // Matches ".../id1470373330", ".../id1470373330?mt=8", "...id1470373330/"
    const m = u.match(/(?:^|\/|=)id(\d+)(?:[/?&]|$)/i);
    if (m) return m[1];
  }
  return null;
}

async function lookupFromiTunes(appId) {
  try {
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=ie`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`lookupFromiTunes: HTTP ${res.status} for ${url}`);
      return null;
    }
    const json = await res.json();
    const r = (json.results || [])[0];
    if (!r) return null;
    return {
      developerWebsiteUrl: r.sellerUrl || null,
      artistViewUrl: r.artistViewUrl || null,
      trackViewUrl: r.trackViewUrl || null,
    };
  } catch (e) {
    console.warn("lookupFromiTunes failed:", e.message);
    return null;
  }
}

async function mergePrivacy(app) {
  // Derive appId first
  const appId = deriveAppId(app);
  console.log(`• Merging "${app.name}" — derived ID:`, appId || "(none)");
  if (!appId) {
    console.warn(`  ↳ No App Store ID found; skipping scrape for "${app.name}"`);
    return app;
  }

  const cachePath = path.join(CACHE_DIR, `${appId}.json`);
  let cached = await readJson(cachePath);

  // Scrape if no cache file
  if (!cached) {
    try {
      console.log(`  ↳ Scraping privacy page for ${appId}…`);
      cached = await scrapePrivacyForApp(appId);
      await writeJson(cachePath, cached);
      console.log(`  ↳ Saved cache: data/privacy_cache/${appId}.json`);
    } catch (e) {
      console.warn(`  ✖ Privacy scrape failed for "${app.name}" (${appId}): ${e.message}`);
      return app; // keep original
    }
  } else {
    console.log(`  ↳ Using cached privacy: data/privacy_cache/${appId}.json`);
  }

  const merged = { ...app };

  // High-level buckets
  if (cached.privacy_labels) merged.privacy_labels = cached.privacy_labels;

  // Per-category details (includes purposes, subtypes, tracked flags)
  if (cached.privacy_details) merged.privacy_details = cached.privacy_details;

  // Policy + developer website
  if (cached.privacy_policy_url) merged.privacy_policy_url = cached.privacy_policy_url;
  if (cached.developer_website_url) merged.developer_website_url = cached.developer_website_url;

  // Try iTunes lookup to backfill developer website if missing
  if (!merged.developer_website_url) {
    const lu = await lookupFromiTunes(appId);
    if (lu?.developerWebsiteUrl) merged.developer_website_url = lu.developerWebsiteUrl;
  }

  // Merge sources (dedupe by URL)
  const srcs = new Map((merged.sources || []).map(s => [s.url, s]));
  for (const s of (cached.sources || [])) {
    if (s?.url) srcs.set(s.url, s);
  }
  merged.sources = Array.from(srcs.values());

  // Basic summary if absent
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
  console.log("== FiosFon updater starting ==");
  await ensureDir(CACHE_DIR);

  // apps.json format we use in the site is { as_of, apps: [...] }
  const data = await readJson(APPS_JSON, { as_of: "", apps: [] });
  const apps = Array.isArray(data.apps) ? data.apps : [];
  console.log(`Loaded ${apps.length} apps from data/apps.json`);

  // Allow TEST_N to limit updates for quick runs (e.g. TEST_N=10 npm run update:apps)
  const max = Number.isFinite(+process.env.TEST_N) ? Math.max(0, +process.env.TEST_N) : apps.length;
  const slice = apps.slice(0, max || apps.length);
  if (slice.length !== apps.length) {
    console.log(`Processing only first ${slice.length} apps due to TEST_N=${process.env.TEST_N}`);
  }

  const out = [];
  for (const app of slice) {
    try {
      const merged = await mergePrivacy(app);
      out.push(merged);
    } catch (e) {
      console.warn(`!! merge failed for "${app.name}": ${e.message}`);
      out.push(app); // keep original
    }
  }
  // keep any remaining apps unmodified if TEST_N used
  if (slice.length < apps.length) out.push(...apps.slice(slice.length));

  const result = { as_of: new Date().toISOString().slice(0, 10), apps: out };
  await writeJson(APPS_JSON, result);
  console.log("Wrote", APPS_JSON);
  console.log("== FiosFon updater done ==");
}

if (process.env.NODE_ENV !== "test") {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
