import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { scrapePrivacyForApp } from "./scrape-privacy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const APPS_JSON = path.join(DATA, "apps.json");
const CACHE_DIR = path.join(DATA, "privacy_cache");

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

async function mergePrivacy(app) {
  const appId = app.app_id || app.id;
  if (!appId) return app;

  const cachePath = path.join(CACHE_DIR, `${appId}.json`);
  let cached = await readJson(cachePath);

  if (!cached) {
    try {
      cached = await scrapePrivacyForApp(appId);
      await writeJson(cachePath, cached);
    } catch (e) {
      console.warn(`Privacy scrape failed for ${app.name}: ${e.message}`);
      return app;
    }
  }

  const merged = { ...app };

  // high-level buckets
  if (cached.privacy_labels) merged.privacy_labels = cached.privacy_labels;

  // new: per-bucket details
  if (cached.privacy_details) merged.privacy_details = cached.privacy_details;

  // policy url
  if (cached.privacy_policy_url) merged.privacy_policy_url = cached.privacy_policy_url;

  // add/merge sources
  const srcs = new Map((merged.sources || []).map(s => [s.url, s]));
  for (const s of (cached.sources || [])) srcs.set(s.url, s);
  merged.sources = Array.from(srcs.values());

  // optionally stamp/refresh summary
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

  const data = await readJson(APPS_JSON, { as_of: "", apps: [] });
  const apps = data.apps || [];

  const out = [];
  for (const app of apps) {
    out.push(await mergePrivacy(app));
  }

  const result = { as_of: new Date().toISOString().slice(0, 10), apps: out };
  await writeJson(APPS_JSON, result);
  console.log("Wrote", APPS_JSON);
}

if (process.env.NODE_ENV !== "test") {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
