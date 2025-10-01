import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { scrapePrivacyForApp } from "./scrape-privacy.mjs";

// Node 18+ has global fetch. If you run locally on older Node, install node-fetch and uncomment:
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
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJson(p, obj) {
  const json = JSON.stringify(obj, null, 2) + "\n";
  await fs.writeFile(p, json, "utf8");
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
      artistViewUrl: r.artistViewUrl || null,
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

  // Scrape if not cached yet
  if (!cached) {
    try {
      cached = await scrapePrivacyForApp(appId);
      await writeJson(cachePath, cached);
    } catch (e) {
      console.warn(`Privacy scrape failed for ${app.name}: ${e.message}`);
      return app; // keep original app object
    }
  }

  const merged = { ...app };

  // High-level buckets (labels)
  if (cached.privacy_labels) merged.privacy_labels = cached.privacy_labels;

  // Purpose & sub-type details
  if (cached.privacy_details) merged.privacy_details = cached.privacy_details;

  // Links
  if (cached.privacy_policy_url) merged.privacy_policy_url = cached.privacy_policy_url;
  if (cached.developer_website_url) merged.developer_website_url = cached.developer_website_url;

  // Try iTunes for developer site if still missing
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
      hasLinked ? "Some data may be collected and linked to your identity." : "No linked data categories disclosed.",
    ];
  }

  return merged;
}

async function main() {
  await ensureDir(CACHE_DIR);

  // apps.json format: { as_of, apps: [...] }
  const data = await readJson(APPS_JSON, { as_of: "", apps: [] });
  const apps = Array.isArray(data.apps) ? data.apps : [];

  // Allow TEST_N to limit apps processed (useful for debugging)
  const limitEnv = Number(process.env.TEST_N);
  const max = Number.isFinite(limitEnv) && limitEnv > 0 ? limitEnv : apps.length;
  const slice = apps.slice(0, max);

  const out = [];
  for (const app of slice) {
    out.push(await mergePrivacy(app));
  }
  if (slice.length < apps.length) {
    out.push(...apps.slice(slice.length));
  }

  const result = { as_of: new Date().toISOString().slice(0, 10), apps: out };
  await writeJson(APPS_JSON, result);
  console.log("Wrote", APPS_JSON);
}

// Execute when not under tests
if (process.env.NODE_ENV !== "test") {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
