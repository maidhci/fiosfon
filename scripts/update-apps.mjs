import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { scrapePrivacyForApp } from "./scrape-privacy.mjs";

// Node 18+ has fetch built-in

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const APPS_JSON = path.join(DATA_DIR, "apps.json");
const CACHE_DIR = path.join(DATA_DIR, "privacy_cache");

const COUNTRY = "ie";
const LIMIT = Number(process.env.CHART_LIMIT || 50);
const GENRE_GAMES = 6014;

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

function rssUrl({ kind, limit = 50, country = COUNTRY, genre }) {
  const base = `https://itunes.apple.com/${country}/rss/${kind}/limit=${limit}`;
  const g = genre ? `/genre=${genre}` : "";
  return `${base}${g}/json`;
}

function parseAppFromRssEntry(e, idx) {
  const images = e["im:image"] || [];
  const icon = images.length ? images[images.length - 1].label : null;
  const name = e["im:name"]?.label || "";
  const developer = e["im:artist"]?.label || "";
  const link = e.link?.attributes?.href || e.id?.label || null;
  const appId = (() => {
    if (!link) return null;
    const m = link.match(/\/id(\d+)(?:\?|$)/);
    return m ? m[1] : null;
  })();

  const sources = link ? [{ label: "App Store (RSS)", url: link }] : [];

  return {
    rank: idx + 1,
    name,
    platform: "iOS",
    developer,
    icon,
    app_id: appId,
    sources
  };
}

async function fetchChart(kind, { genre } = {}) {
  const url = rssUrl({ kind, limit: LIMIT, genre });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Apple RSS HTTP ${res.status} (${url})`);
  const data = await res.json();
  const apps = (data.feed?.entry || []).map((e, i) => parseAppFromRssEntry(e, i));
  const as_of = new Date().toISOString().slice(0, 10);
  return { as_of, apps };
}

async function lookupFromiTunes(appId) {
  try {
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${COUNTRY}`;
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

  if (!cached) {
    try {
      cached = await scrapePrivacyForApp(appId);
      await writeJson(cachePath, cached);
    } catch (e) {
      console.warn(`Privacy scrape failed for "${app.name}" (${appId}): ${e.message}`);
      return app; // keep original
    }
  }

  const merged = { ...app };

  if (cached.privacy_labels) merged.privacy_labels = cached.privacy_labels;
  if (cached.privacy_details) merged.privacy_details = cached.privacy_details;
  if (cached.privacy_policy_url) merged.privacy_policy_url = cached.privacy_policy_url;
  if (cached.developer_website_url) merged.developer_website_url = cached.developer_website_url;

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

function uniqueByAppIdOrKey(apps) {
  // Prefer app_id; fall back to name|developer
  const keyFor = a => a.app_id ? `id:${a.app_id}` : `nk:${(a.name||"").toLowerCase()}|${(a.developer||"").toLowerCase()}`;
  const map = new Map();
  for (const a of apps) {
    const k = keyFor(a);
    if (!map.has(k)) map.set(k, a);
  }
  return Array.from(map.values());
}

async function main() {
  console.log("== FiosFon updater (charts → scrape) ==");

  await ensureDir(CACHE_DIR);

  // 1) Pull today’s charts
  const [free, paid, games] = await Promise.all([
    fetchChart("topfreeapplications"),
    fetchChart("toppaidapplications"),
    fetchChart("topfreeapplications", { genre: GENRE_GAMES })
  ]);

  // 2) Combine (union) and keep uniqueness
  let combined = uniqueByAppIdOrKey([
    ...free.apps,
    ...paid.apps,
    ...games.apps
  ]);

  // Optional limiter for faster tests
  const max = Number.isFinite(+process.env.TEST_N) ? Math.max(0, +process.env.TEST_N) : null;
  if (max) combined = combined.slice(0, max);

  console.log(`Fetched charts: free=${free.apps.length}, paid=${paid.apps.length}, games=${games.apps.length}`);
  console.log(`Combined unique apps to process: ${combined.length}`);

  // 3) Scrape/merge privacy for each app
  const out = [];
  for (const app of combined) {
    if (!app.app_id) {
      out.push(app);
      continue;
    }
    console.log(`• ${app.name} (${app.app_id})`);
    out.push(await mergePrivacy(app));
  }

  // 4) Write apps.json in the site’s format the frontend expects { as_of, apps }
  const result = { as_of: new Date().toISOString().slice(0, 10), apps: out };
  await writeJson(APPS_JSON, result);
  console.log("Wrote", APPS_JSON);
  console.log("== Done ==");
}

if (process.env.NODE_ENV !== "test") {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
