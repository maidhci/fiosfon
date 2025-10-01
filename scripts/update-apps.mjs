import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { scrapePrivacyForApp } from "./scrape-privacy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const APPS_JSON = path.join(DATA_DIR, "apps.json");
const CACHE_DIR = path.join(DATA_DIR, "privacy_cache");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Node 18+ has global fetch
async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
async function readJson(p, fallback = null) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch { return fallback; }
}
async function writeJson(p, obj) {
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function idFromUrl(u) {
  if (!u) return null;
  const m = u.match(/\/id(\d+)(?:\?|$)/);
  return m ? m[1] : null;
}

async function fetchRss(kind, limit = 50, genre = null) {
  const country = "ie";
  const base = `https://itunes.apple.com/${country}/rss/${kind}/limit=${limit}`;
  const url = genre ? `${base}/genre=${genre}/json` : `${base}/json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RSS ${kind} HTTP ${res.status}`);
  const data = await res.json();
  const entries = data.feed?.entry || [];

  return entries.map((e, idx) => {
    const images = e["im:image"] || [];
    const icon = images.length ? images[images.length - 1].label : null;
    const link = e.link?.attributes?.href || e.id?.label || null;
    return {
      rank: idx + 1,
      name: e["im:name"]?.label || "",
      platform: "iOS",
      developer: e["im:artist"]?.label || "",
      icon,
      sources: link ? [{ label: "App Store (RSS)", url: link }] : []
    };
  });
}

function keyNameDev(a) {
  return `${(a.name || "").toLowerCase().trim()}|${(a.developer || "").toLowerCase().trim()}`;
}

async function mergePrivacy(app) {
  // get appId from existing, or from sources
  let appId = app.app_id || app.id;
  if (!appId && app.sources?.length) {
    for (const s of app.sources) {
      const id = idFromUrl(s.url);
      if (id) { appId = id; break; }
    }
  }
  if (!appId) return app; // skip if we can’t determine id

  const cachePath = path.join(CACHE_DIR, `${appId}.json`);
  let cached = await readJson(cachePath);

  if (!cached) {
    try {
      cached = await scrapePrivacyForApp(appId);
      await writeJson(cachePath, cached);
    } catch (e) {
      console.warn(`Privacy scrape failed for "${app.name}" (${appId}): ${e.message}`);
      return app;
    }
  }

  const merged = { ...app, app_id: appId };

  if (cached.privacy_labels) merged.privacy_labels = cached.privacy_labels;
  if (cached.privacy_details) merged.privacy_details = cached.privacy_details;
  if (cached.privacy_policy_url) merged.privacy_policy_url = cached.privacy_policy_url;
  if (cached.developer_website_url) merged.developer_website_url = cached.developer_website_url;

  // merge/dedupe sources
  const srcs = new Map((merged.sources || []).map(s => [s.url, s]));
  for (const s of (cached.sources || [])) if (s?.url) srcs.set(s.url, s);
  merged.sources = Array.from(srcs.values());

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
  console.log("== FiosFon updater (charts → scrape) ==");

  await ensureDir(CACHE_DIR);
  const GENRE_GAMES = 6014;

  // 1) fetch fresh charts
  const [free, paid, games] = await Promise.all([
    fetchRss("topfreeapplications", 50),
    fetchRss("toppaidapplications", 50),
    fetchRss("topfreeapplications", 50, GENRE_GAMES)
  ]);
  console.log(`Fetched charts: free=${free.length}, paid=${paid.length}, games=${games.length}`);

  // 2) combine unique by (name+dev)
  const pool = [...free, ...paid, ...games];
  const seen = new Set();
  const unique = [];
  for (const a of pool) {
    const k = keyNameDev(a);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(a);
  }
  console.log(`Combined unique apps to process: ${unique.length}`);

  // 3) scrape privacy for each (sequential to be gentle)
  const out = [];
  let n = 0;
  for (const app of unique) {
    const idx = ++n;
    const idCandidate = (app.sources?.length ? idFromUrl(app.sources[0].url) : null) || app.app_id || "";
    console.log(`• ${app.name} (${idCandidate || "no-id"})`);
    out.push(await mergePrivacy(app));
    await sleep(300); // tiny delay
  }

  // 4) write apps.json in our simple format
  const result = { as_of: new Date().toISOString().slice(0, 10), apps: out };
  await writeJson(APPS_JSON, result);
  console.log("Wrote", APPS_JSON);
  console.log("== FiosFon updater done ==");
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
