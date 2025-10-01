// scripts/update-apps.mjs
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { scrapePrivacyForApp } from "./scrape-privacy.mjs";

// If you run on very old Node, uncomment next line and add node-fetch to deps
// import fetch from "node-fetch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const APPS_JSON = path.join(DATA_DIR, "apps.json");
const CACHE_DIR = path.join(DATA_DIR, "privacy_cache");

const COUNTRY = "ie";
const RSS_LIMIT = 50;             // how many per board
const GENRE_GAMES = 6014;         // Apple games genre code

/* ---------------- utils ---------------- */
async function ensureDir(p){ await fs.mkdir(p, { recursive: true }); }
async function readJson(p, fallback = null){ try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } }
async function writeJson(p, obj){ await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); }

function extractIdFromLink(link){ const m = String(link||"").match(/id(\d+)/); return m ? m[1] : null; }

function uniqBy(arr, keyFn){
  const seen = new Set();
  const out = [];
  for (const x of arr){
    const k = keyFn(x);
    if (k && !seen.has(k)){ seen.add(k); out.push(x); }
  }
  return out;
}

/* ------------- Apple RSS fetch ------------- */
function rssUrl({ kind, limit = RSS_LIMIT, country = COUNTRY, genre }){
  const base = `https://itunes.apple.com/${country}/rss/${kind}/limit=${limit}`;
  return genre ? `${base}/genre=${genre}/json` : `${base}/json`;
}

async function fetchAppleChart({ kind, limit, genre }){
  const res = await fetch(rssUrl({ kind, limit, genre }));
  if (!res.ok) throw new Error(`Apple RSS HTTP ${res.status} (${kind}${genre?` g=${genre}`:''})`);
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
      sources: link ? [{ label: "App Store (RSS)", url: link }] : [],
      app_id: extractIdFromLink(link)
    };
  });
}

/* ------------- Optional lookup for dev site ------------- */
async function lookupFromiTunes(appId){
  try{
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
  }catch{ return null; }
}

/* ------------- Enrichment & merge ------------- */
async function mergePrivacy(app, previousByKey){
  const appId = app.app_id || app.id;
  const key = appId || (app.name + "|" + app.developer).toLowerCase().replace(/\s+/g," ").trim();

  // Start with previous data if we have it (helps when scraping fails)
  const prev = previousByKey.get(key) || {};
  const merged = { ...prev, ...app };

  if (!appId){
    // Without an ID we can’t scrape; return what we have
    return merged;
  }

  const cachePath = path.join(CACHE_DIR, `${appId}.json`);
  let cached = await readJson(cachePath);

  if (!cached){
    try{
      cached = await scrapePrivacyForApp(appId);
      await writeJson(cachePath, cached);
    }catch(e){
      console.warn(`Privacy scrape failed for ${app.name}: ${e.message}`);
      // keep merged as-is (maybe prev had data)
      return merged;
    }
  }

  if (cached.privacy_labels)  merged.privacy_labels = cached.privacy_labels;
  if (cached.privacy_details) merged.privacy_details = cached.privacy_details;

  if (cached.privacy_policy_url)   merged.privacy_policy_url = cached.privacy_policy_url;
  if (cached.developer_website_url) merged.developer_website_url = cached.developer_website_url;

  if (!merged.developer_website_url){
    const lu = await lookupFromiTunes(appId);
    if (lu?.developerWebsiteUrl) merged.developer_website_url = lu.developerWebsiteUrl;
  }

  // merge sources (dedupe by URL)
  const srcs = new Map((merged.sources || []).map(s => [s.url, s]));
  for (const s of (cached.sources || [])){ if (s?.url) srcs.set(s.url, s); }
  merged.sources = Array.from(srcs.values());

  // Populate a friendly summary if missing
  if (!merged.tracking_summary && merged.privacy_labels){
    const hasTrack  = (merged.privacy_labels["Data Used to Track You"] || []).length > 0;
    const hasLinked = (merged.privacy_labels["Data Linked to You"] || []).length > 0;
    merged.tracking_summary = [
      hasTrack  ? "Some data may be used to track you across apps and websites." : "No tracking categories disclosed.",
      hasLinked ? "Some data may be collected and linked to your identity."      : "No linked data categories disclosed."
    ];
  }

  return merged;
}

/* ------------- Main ------------- */
async function main(){
  await ensureDir(CACHE_DIR);

  // Load previous apps.json so we can preserve/enrich when scraping fails
  const previous = await readJson(APPS_JSON, { as_of: "", apps: [] });
  const prevApps = previous.apps || [];
  const prevByKey = new Map(
    prevApps.map(a => {
      const k = (a.app_id || (a.name + "|" + a.developer).toLowerCase().replace(/\s+/g," ").trim());
      return [k, a];
    })
  );

  // Pull today’s charts
  const [free, paid, games] = await Promise.all([
    fetchAppleChart({ kind: "topfreeapplications", limit: RSS_LIMIT }),
    fetchAppleChart({ kind: "toppaidapplications", limit: RSS_LIMIT }),
    fetchAppleChart({ kind: "topfreeapplications", limit: RSS_LIMIT, genre: GENRE_GAMES })
  ]);

  // Combine and dedupe (prefer apps with an ID)
  let combined = [...free, ...paid, ...games];
  combined = uniqBy(
    combined.sort((a,b) => (b.app_id?1:0) - (a.app_id?1:0)), // ensure items with IDs win ties
    a => a.app_id || ((a.name + "|" + a.developer).toLowerCase().replace(/\s+/g," ").trim())
  );

  //
