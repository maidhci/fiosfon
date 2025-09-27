'use strict';

/* =========================
   App state (three boards)
   ========================= */
const state = {
  boards: {
    free:  { apps: [], asOf: '', rangeIndex: 0 }, // 0..4 -> 1–10 ... 41–50
    paid:  { apps: [], asOf: '', rangeIndex: 0 },
    games: { apps: [], asOf: '', rangeIndex: 0 }
  },
  rights: [],
  localApps: []
};

/* =========================
   Config
   ========================= */
const RSS_LIMIT = 50;
const GENRE_GAMES = 6014;
const COUNTRY = 'ie';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_LIMIT = 25;
const RANGES = [[0,10],[10,20],[20,30],[30,40],[40,50]];

const DEFAULT_ICON =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="18" fill="%238ecae6"/><circle cx="24" cy="26" r="6" fill="%23ffb703"/><rect x="18" y="52" width="60" height="10" rx="5" fill="%23023047"/><rect x="18" y="68" width="48" height="10" rx="5" fill="%23219ebc"/></svg>';

/* =========================
   Helpers
   ========================= */
async function loadJSON(path){
  const url = new URL(path, document.baseURI);
  // Add cache-busting query so Pages/CDN can’t serve stale file
  url.searchParams.set('v', Date.now().toString());
  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch(e){ throw new Error(`Invalid JSON in ${url}: ${e.message}`); }
}
async function getCached(key, loader, ttlMs = CACHE_TTL_MS){
  const k = 'ff-cache:'+key;
  try {
    const item = JSON.parse(localStorage.getItem(k) || 'null');
    if (item && (Date.now()-item.t) < ttlMs) return item.v;
  } catch {}
  const v = await loader();
  localStorage.setItem(k, JSON.stringify({t:Date.now(), v}));
  return v;
}
function normaliseName(n){ return (n||'').toLowerCase().replace(/\s+/g,' ').trim(); }
function appKey(a){ return `${normaliseName(a.name)}|${normaliseName(a.developer)}`; }

function mergeAppsByName(rssApps, localApps){
  const map = new Map((localApps||[]).map(a => [normaliseName(a.name), a]));
  return rssApps.map(r => {
    const hit = map.get(normaliseName(r.name));
    return hit ? {
      rank: r.rank, name: r.name, platform: 'iOS',
      developer: r.developer, icon: r.icon || hit.icon,
      sources: r.sources?.length ? r.sources : hit.sources,
      tracking_summary: hit.tracking_summary,
      privacy_labels: hit.privacy_labels
    } : r;
  });
}

/* =========================
   Apple APIs
   ========================= */
function rssUrl({ kind, limit=50, country=COUNTRY, genre }){
  const base = `https://itunes.apple.com/${country}/rss/${kind}/limit=${limit}`;
  const g = genre ? `/genre=${genre}` : '';
  return `${base}${g}/json`;
}
async function fetchAppleChart({ kind, limit=50, genre }){
  const res = await fetch(rssUrl({kind, limit, genre}));
  if (!res.ok) throw new Error(`Apple RSS HTTP ${res.status} (${kind}${genre?` g=${genre}`:''})`);
  const data = await res.json();
  const apps = (data.feed?.entry || []).map((e, idx) => {
    const images = e['im:image'] || [];
    const icon = images.length ? images[images.length-1].label : null;
    const link = e.link?.attributes?.href || e.id?.label || null;
    return {
      rank: idx+1,
      name: e['im:name']?.label || '',
      platform: 'iOS',
      developer: e['im:artist']?.label || '',
      icon,
      sources: link ? [{label:'App Store (RSS)', url: link}] : []
    };
  });
  return { as_of: new Date().toLocaleDateString(), apps };
}

// iTunes Search (artwork + live search)
async function findArtworkBySearch(name, developer){
  const cacheKey = `art:${name}::${developer||''}`;
  const hit = localStorage.getItem(cacheKey);
  if (hit) return hit;
  const q = encodeURIComponent(`${name} ${developer||''}`.trim());
  const url = `https://itunes.apple.com/search?term=${q}&entity=software&country=${COUNTRY}&limit=3`;
  try{
    const res = await fetch(url);
    if(!res.ok) throw new Error('search http '+res.status);
    const json = await res.json();
    const art = json.results?.[0]?.artworkUrl100 || json.results?.[0]?.artworkUrl60 || json.results?.[0]?.artworkUrl512 || null;
    if (art) localStorage.setItem(cacheKey, art);
    return art;
  }catch{ return null; }
}

let searchAbort = null;
async function liveSearchAllApps(query){
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  const signal = searchAbort.signal;

  const term = encodeURIComponent(query.trim());
  const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=software&country=${COUNTRY}&limit=${SEARCH_LIMIT}`, { signal });
  if (!res.ok) throw new Error(`iTunes Search HTTP ${res.status}`);
  const data = await res.json();
  return (data.results||[]).map((r, idx) => ({
    rank: r.trackId ? idx+1 : undefined, // not a chart rank
    name: r.trackName || r.collectionName || '',
    platform: 'iOS',
    developer: r.sellerName || r.artistName || '',
    icon: r.artworkUrl100 || r.artworkUrl60 || r.artworkUrl512 || null,
    sources: r.trackViewUrl ? [{label:'App Store', url:r.trackViewUrl}] : []
  }));
}

function viaProxy(u){
  try{ const clean = u.replace(/^https?:\/\//,''); return `https://images.weserv.nl/?url=${encodeURIComponent(clean)}&w=100&h=100&fit=contain&we`; }
  catch{ return u; }
}

/* =========================
   Glossary drawer
   ========================= */
let GLOSSARY = null;
async function loadGlossary(){ if (GLOSSARY) return GLOSSARY; try{ GLOSSARY = await loadJSON('data/glossary.json'); }catch{ GLOSSARY = { terms:{} }; } return GLOSSARY; }
function openDrawer(title, body){
  const d = document.getElementById('glossary-drawer');
  const b = document.getElementById('drawer-backdrop');
  document.getElementById('glossary-title').textContent = title || 'Privacy term';
  document.getElementById('glossary-body').textContent = body || 'No description available.';
  d.classList.add('open'); d.setAttribute('aria-hidden','false'); b.hidden = false;
}
function closeDrawer(){ const d=document.getElementById('glossary-drawer'); const b=document.getElementById('drawer-backdrop'); d.classList.remove('open'); d.setAttribute('aria-hidden','true'); b.hidden = true; }

/* =========================
   Risk meter (granular)
   ========================= */

// Category weights (tune as you like)
const RISK_WEIGHTS = {
  // “track” section is generally higher risk than “linked” for the same field
  track: {
    "Identifiers": 12,
    "Location": 12,
    "Contact Info": 10,
    "Financial Info": 12,
    "Health & Fitness": 12,
    "Browsing/Search History": 10,
    "User Content": 8,
    "Purchases": 6,
    "Usage Data": 6,
    "Diagnostics": 2,
    "Photos or Videos": 8,
    "Audio Data": 6,
    "Messages": 10,
    "Contacts": 8,
    "Sensitive Info": 12
  },
  linked: {
    "Identifiers": 9,
    "Location": 9,
    "Contact Info": 8,
    "Financial Info": 9,
    "Health & Fitness": 9,
    "Browsing/Search History": 8,
    "User Content": 7,
    "Purchases": 4,
    "Usage Data": 4,
    "Diagnostics": 1,
    "Photos or Videos": 7,
    "Audio Data": 5,
    "Messages": 8,
    "Contacts": 6,
    "Sensitive Info": 10
  },
  notLinked: {
    // low impact, but still counts a little
    "Identifiers": 2,
    "Location": 2,
    "Contact Info": 2,
    "Financial Info": 2,
    "Health & Fitness": 2,
    "Browsing/Search History": 2,
    "User Content": 2,
    "Purchases": 1,
    "Usage Data": 1,
    "Diagnostics": 1,
    "Photos or Videos": 2,
    "Audio Data": 1,
    "Messages": 2,
    "Contacts": 1,
    "Sensitive Info": 3
  }
};

// Soft cap per section to add diminishing returns (prevents everything pegging at 100)
const SECTION_CAPS = { track: 70, linked: 50, notLinked: 20 };

// Smooth mapping: turn a raw 0–(cap sum) into a nicer 0–100 curve
function smoothScale(x, max) {
  // logistic-ish: more resolution in the middle, avoids pinning at extremes
  const t = Math.max(0, Math.min(1, x / max));
  const k = 5;              // curve steepness
  const y = 1 / (1 + Math.exp(-k * (t - 0.5)));
  return y * 100;
}

function computePrivacyScore(app){
  const labels = app.privacy_labels || {};
  const sections = {
    track: labels["Data Used to Track You"] || labels["Data used to track you"] || [],
    linked: labels["Data Linked to You"] || labels["Data linked to you"] || [],
    notLinked: labels["Data Not Linked to You"] || labels["Data not linked to you"] || []
  };

  // Sum weighted scores per section with diminishing returns
  const scoreSection = (items, weights, cap) => {
    // unique normalized set
    const set = new Set(items.map(s => String(s).trim()));
    let sum = 0;
    set.forEach(cat => { sum += (weights[cat] || 0); });
    // diminishing returns: soft cap via sqrt
    const softened = Math.sqrt(sum) * Math.sqrt(cap);
    return Math.min(softened, cap);
  };

  const sTrack    = scoreSection(sections.track,    RISK_WEIGHTS.track,    SECTION_CAPS.track);
  const sLinked   = scoreSection(sections.linked,   RISK_WEIGHTS.linked,   SECTION_CAPS.linked);
  const sNotLinked= scoreSection(sections.notLinked,RISK_WEIGHTS.notLinked,SECTION_CAPS.notLinked);

  const raw = sTrack + sLinked + sNotLinked;                 // 0 .. (70+50+20)=140
  const score = Math.round(smoothScale(raw, 140));           // 0..100 smoothed

  // For the label (Low/Medium/High) we’ll use more balanced thresholds
  let band = "Low";
  if (score >= 66) band = "High";
  else if (score >= 33) band = "Medium";

  return { score, band, parts: { sTrack, sLinked, sNotLinked } };
}

function renderRiskMeter(containerEl, app){
  const { score, band } = computePrivacyScore(app);
  const pct = Math.max(0, Math.min(100, score));
  containerEl.innerHTML = `
    <div class="risk-label">Data collection intensity <strong>${band}</strong></div>
    <div class="risk-bar" role="img" aria-label="Data collection intensity ${pct} out of 100">
      <span style="--p:${pct}%"></span>
    </div>
    <div class="risk-scale"><span>low</span><span>medium</span><span>high</span></div>
  `;
}

/**
 * Render a list of apps.
 * context: 'board' shows chart rank (or position fallback). 'search' only shows rank if known.
 */
function renderAppsInto(listEl, apps, context='board'){
  if (!listEl) return;
  listEl.innerHTML = '';
  const tpl = document.getElementById('app-card-tpl');
  apps.forEach((app, idx) => {
    const li = tpl.content.cloneNode(true);

    const iconEl = li.querySelector('.app-icon');
    iconEl.alt = `${app.name} icon`;
    iconEl.referrerPolicy = 'no-referrer';
    resolveIcon(iconEl, app);

    // Rank text
    let rankText = '';
    const hasRealRank = Number.isFinite(app.rank);
    rankText = (context === 'board') ? `#${hasRealRank ? app.rank : (idx+1)}` : (hasRealRank ? `#${app.rank}` : '');
    li.querySelector('.rank').textContent = rankText;

    // Name + platform
    li.querySelector('.name').textContent = app.name;
    const plat = li.querySelector('.platform'); if (plat) plat.textContent = 'iOS';

    // "Maker" label + developer
    const devEl = li.querySelector('.developer');
    if (devEl) {
      const maker = document.createElement('span');
      maker.className = 'maker-label';
      maker.textContent = 'Maker';
      devEl.before(maker);
      devEl.textContent = app.developer || '';
    }

    // Tracking summary
    const tracking = li.querySelector('.tracking');
    tracking.innerHTML = app.tracking_summary
      ? `<ul>${app.tracking_summary.map(t => `<li>${t}</li>`).join('')}</ul>`
      : '<p class="muted">Tracking details coming soon.</p>';

    // Privacy labels -> chips
    const privacy = li.querySelector('.privacy');
    if (app.privacy_labels){
      let html = '';
      for (const [section, items] of Object.entries(app.privacy_labels)){
        html += `<h5>${section}</h5><ul>`;
        html += items.map(i => `<li data-term="${i}">${i}</li>`).join('');
        html += `</ul>`;
      }
      privacy.innerHTML = html;
    } else {
      privacy.innerHTML = '';
    }

    // Risk meter
    const riskEl = li.querySelector('.risk');
    if (riskEl) renderRiskMeter(riskEl, app);

    // Sources
    const sources = li.querySelector('.sources');
    if (app.sources && app.sources.length){
      sources.innerHTML =
        `<strong>Sources:</strong> ` +
        app.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.label || 'Link'}</a>`).join(' ');
    }

    listEl.appendChild(li);
  });
}

function renderBoard(key){
  const board = state.boards[key];
  const [start,end] = RANGES[board.rangeIndex] || RANGES[0];
  const slice = board.apps.slice(start,end);
  renderAppsInto(document.getElementById(`list-${key}`), slice, 'board');
  renderAsOf(key);
}
function renderAllBoards(){ ['free','paid','games'].forEach(renderBoard); }

function renderRights(){
  const container = document.getElementById('rights-cards');
  if (!container) return;
  container.innerHTML = '';
  const tpl = document.getElementById('right-card-tpl');
  state.rights.forEach(r => {
    const card = tpl.content.cloneNode(true);
    card.querySelector('.right-title').textContent = r.title;
    card.querySelector('.right-desc').textContent = r.description;
    const learn = card.querySelector('.right-learn');
    learn.innerHTML = r.learn_more ? `<a href="${r.learn_more}" target="_blank" rel="noopener">Learn more</a>` : '';
    container.appendChild(card);
  });
}

/* =========================
   UI wiring
   ========================= */
function setActiveRangeUI(boardKey){
  const group = document.getElementById(`range-${boardKey}`);
  if (!group) return;
  const idx = state.boards[boardKey].rangeIndex;
  [...group.querySelectorAll('.range-btn')].forEach((btn,i) => {
    btn.setAttribute('aria-selected', String(i===idx));
  });
}
function setupRangeControls(boardKey){
  const group = document.getElementById(`range-${boardKey}`);
  if (!group) return;
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.range-btn');
    if (!btn) return;
    const all = [...group.querySelectorAll('.range-btn')];
    const index = all.indexOf(btn);
    if (index < 0) return;
    state.boards[boardKey].rangeIndex = index;
    setActiveRangeUI(boardKey);
    renderBoard(boardKey);
  });
  setActiveRangeUI(boardKey);
}

function setupControls(){
  ['free','paid','games'].forEach(setupRangeControls);

  // Refresh
  document.getElementById('refresh-data')?.addEventListener('click', (e) => {
    e.preventDefault();
    ['free','paid','games'].forEach(k => localStorage.removeItem('ff-cache:rss:'+k+':'+RSS_LIMIT));
    init(true);
  });

  // Drawer
  document.getElementById('drawer-close')?.addEventListener('click', closeDrawer);
  document.getElementById('drawer-backdrop')?.addEventListener('click', closeDrawer);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // Glossary chip clicks
  document.body.addEventListener('click', async (e) => {
    const li = e.target.closest('.privacy li');
    if (!li) return;
    const term = li.dataset.term || li.textContent.trim();
    const glossary = await loadGlossary();
    const entry = glossary.terms?.[term] || glossary.terms?.[term.toLowerCase()];
    openDrawer(term, entry || 'This category groups similar types of data. Exact collection depends on the features you use and your settings.');
  });

  // Search
  const input = document.getElementById('search-input');
  const resultsEl = document.getElementById('search-results');
  const noRes = document.getElementById('no-results');
  let debounceId = null;

  input?.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q){ resultsEl.innerHTML=''; if(noRes) noRes.hidden=true; if(searchAbort) searchAbort.abort(); return; }

    const seen = new Set();
    const localCombined = ['free','paid','games']
      .flatMap(k => state.boards[k].apps)
      .filter(app => {
        const k = appKey(app);
        if (seen.has(k)) return false;
        seen.add(k);
        return [app.name, app.developer].filter(Boolean).join(' ').toLowerCase().includes(q);
      });

    resultsEl.innerHTML = '';
    renderAppsInto(resultsEl, localCombined, 'search');
    if (noRes) noRes.hidden = localCombined.length > 0;

    clearTimeout(debounceId);
    debounceId = setTimeout(async () => {
      try{
        const live = await liveSearchAllApps(q);
        const mapLocal = new Map((state.localApps||[]).map(a => [normaliseName(a.name), a]));
        const enriched = live.map(a => {
          const hit = mapLocal.get(normaliseName(a.name));
          return hit ? { ...a, tracking_summary: hit.tracking_summary, privacy_labels: hit.privacy_labels } : a;
        });

        const have = new Set(localCombined.map(appKey));
        const uniqueLive = enriched.filter(a => !have.has(appKey(a)));

        const merged = localCombined.concat(uniqueLive);
        resultsEl.innerHTML = '';
        if (merged.length){
          renderAppsInto(resultsEl, merged, 'search');
          if (noRes) noRes.hidden = true;
        } else {
          if (noRes) noRes.hidden = false;
        }
      }catch(err){
        if (err?.name === 'AbortError') return;
        console.warn('Search failed:', err.message);
      }
    }, 300);
  });
}

/* =========================
   App lifecycle
   ========================= */
async function loadBoards(){
  let local = { apps: [], as_of: '' };
  try { local = await loadJSON('data/apps.json'); } catch {}

  // apps.json from automation contains BOTH boards and a flat "apps" list.
  // Prefer the flat list if present; otherwise flatten from boards.
  const flatFromBoards = local?.boards
    ? [
        ...(local.boards.free?.apps  || []),
        ...(local.boards.paid?.apps  || []),
        ...(local.boards.games?.apps || [])
      ]
    : [];
  state.localApps = Array.isArray(local.apps) && local.apps.length ? local.apps : flatFromBoards;

  const freeRss = await getCached('rss:free:'+RSS_LIMIT, () => fetchAppleChart({ kind:'topfreeapplications', limit:RSS_LIMIT }));
  state.boards.free.apps = mergeAppsByName(freeRss.apps, state.localApps);
  state.boards.free.asOf = freeRss.as_of;

  const paidRss = await getCached('rss:paid:'+RSS_LIMIT, () => fetchAppleChart({ kind:'toppaidapplications', limit:RSS_LIMIT }));
  state.boards.paid.apps = mergeAppsByName(paidRss.apps, state.localApps);
  state.boards.paid.asOf = paidRss.as_of;

  const gamesRss = await getCached('rss:games:'+RSS_LIMIT, () => fetchAppleChart({ kind:'topfreeapplications', limit:RSS_LIMIT, genre:GENRE_GAMES }));
  state.boards.games.apps = mergeAppsByName(gamesRss.apps, state.localApps);
  state.boards.games.asOf = gamesRss.as_of;
}

async function init(forceRefresh=false){
  try{ await loadBoards(); }catch(err){ alert('Failed to load Apple charts: '+err.message); return; }

  try{ const rights = await loadJSON('data/rights_ie.json'); state.rights = rights.items || []; }
  catch(err){ console.warn('Rights failed to load:', err.message); }

  renderAllBoards();
  renderRights();

  if (forceRefresh) localStorage.setItem('ff-last-refresh', String(Date.now()));
}

window.addEventListener('DOMContentLoaded', () => {
  setupControls();
  init();
});