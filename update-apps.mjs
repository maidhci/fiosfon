import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import pLimit from "p-limit";
import { scrapePrivacyForApp } from "./scrape-privacy.mjs";

const COUNTRY = "ie";
const GENRE_GAMES = 6014;
const LIMIT = 50;
const OUT_PATH = "data/apps.json";
const CACHE_DIR = "data/privacy_cache";
const UA = process.env.USER_AGENT || "FiosFonBot/1.0";

async function ensureDir(dir){ await fs.mkdir(dir,{recursive:true}); }
function rssUrl(kind, genre){ const b=`https://itunes.apple.com/${COUNTRY}/rss/${kind}/limit=${LIMIT}`; return `${b}${genre?`/genre=${genre}`:""}/json`; }
async function fetchJSON(url){ const r=await fetch(url,{headers:{"user-agent":UA}}); if(!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.json(); }

function parseRssApps(json){
  const entries = json?.feed?.entry || [];
  return entries.map((e,i) => {
    const images = e["im:image"] || [];
    const icon = images.length ? images[images.length-1].label : null;
    const link = e.link?.attributes?.href || e.id?.label || "";
    const idMatch = link.match(/id(\d+)/);
    const app_id = idMatch ? idMatch[1] : undefined;
    return {
      rank: i+1,
      name: e["im:name"]?.label || "",
      platform: "iOS",
      developer: e["im:artist"]?.label || "",
      icon, app_id,
      sources: link ? [{label:"App Store (IE)", url:link}] : []
    };
  });
}

async function fetchCharts(){
  const [free,paid,games] = await Promise.all([
    fetchJSON(rssUrl("topfreeapplications")),
    fetchJSON(rssUrl("toppaidapplications")),
    fetchJSON(rssUrl("topfreeapplications", GENRE_GAMES)),
  ]);
  return { as_of: new Date().toISOString().slice(0,10),
           free: parseRssApps(free),
           paid: parseRssApps(paid),
           games: parseRssApps(games) };
}

function normalizeSummary(labels){
  const tracked = (labels["Data Used to Track You"]||[]).length>0;
  const linked  = (labels["Data Linked to You"]||[]).length>0;
  const out=[];
  if(tracked) out.push("Identifiers and usage data may be used for advertising/personalisation.");
  if(linked) out.push("Some data may be collected and linked to your identity for app functionality or analytics.");
  return out;
}

async function loadCache(id){ try{ return JSON.parse(await fs.readFile(path.join(CACHE_DIR,`${id}.json`),"utf8")); }catch{ return null; } }
async function saveCache(id,obj){ await fs.writeFile(path.join(CACHE_DIR,`${id}.json`), JSON.stringify(obj,null,2)); }

async function enrichApps(apps){
  await ensureDir(CACHE_DIR);
  const limit = pLimit(3);
  const tasks = apps.map(app => limit(async () => {
    if(!app.app_id) return app;
    let priv = await loadCache(app.app_id);
    const fresh = priv && (Date.now()-Date.parse(priv.as_of) < 14*24*3600*1000);
    if(!fresh){
      try {
        priv = await scrapePrivacyForApp(app.app_id);
        await saveCache(app.app_id, priv);
        await new Promise(r=>setTimeout(r, 500+Math.random()*400));
      } catch(e) {
        if(!priv) console.warn("Privacy scrape failed:", app.name, e.message);
      }
    }
    const merged = { ...app };
    if (priv?.privacy_labels){
      merged.privacy_labels = priv.privacy_labels;
      merged.tracking_summary = normalizeSummary(priv.privacy_labels);
      if(!merged.sources?.length) merged.sources=[{label:"App Store (IE)", url:`https://apps.apple.com/ie/app/id${app.app_id}`}];
    }
    return merged;
  }));
  return Promise.all(tasks);
}

async function run(){
  const charts = await fetchCharts();
  const allApps = [...charts.free, ...charts.paid, ...charts.games];

  // unique by name+developer
  const key = a => `${a.name.toLowerCase()}|${a.developer.toLowerCase()}`;
  const map = new Map();
  allApps.forEach(a => map.set(key(a), a));

  const enrichedUnique = await enrichApps([...map.values()]);

  const findEnriched = a => enrichedUnique.find(x => key(x)===key(a)) || a;
  const mapBack = list => list.map(a => ({ ...a, ...findEnriched(a), rank:a.rank }));

  const finalJson = {
    as_of: charts.as_of,
    boards: {
      free:  { as_of: charts.as_of, apps: mapBack(charts.free)  },
      paid:  { as_of: charts.as_of, apps: mapBack(charts.paid)  },
      games: { as_of: charts.as_of, apps: mapBack(charts.games) }
    }
  };
  finalJson.apps = [...finalJson.boards.free.apps, ...finalJson.boards.paid.apps, ...finalJson.boards.games.apps];

  await fs.writeFile(OUT_PATH, JSON.stringify(finalJson,null,2));
  console.log("Wrote", OUT_PATH);
}

run().catch(err => { console.error(err); process.exit(1); });