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
  url.searchParams.set('v', Date.now().toString()); // cache-bust on GH Pages
  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
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

/**
 * Merge RSS apps with local privacy/extra fields.
 * Prefer strong key: app_id, then name+developer, finally name-only.
 */
function mergeAppsByName(rssApps, localApps){
  const byKey = new Map();
  (localApps || []).forEach(a => {
    const kFull = `${normaliseName(a.name)}|${normaliseName(a.developer)}`;
    byKey.set(kFull, a);
    // fallback: name-only
    const kName = normaliseName(a.name);
    if (!byKey.has(kName)) byKey.set(kName, a);
    // strongest: app_id
    if (a.app_id) byKey.set(`id:${a.app_id}`, a);
  });

  return (rssApps || []).map(r => {
    const kFull = `${normaliseName(r.name)}|${normaliseName(r.developer)}`;
    const hit = byKey.get(`id:${r.app_id}`) || byKey.get(kFull) || byKey.get(normaliseName(r.name));
    return hit ? {
      rank: r.rank, name: r.name, platform: 'iOS',
      developer: r.developer, icon: r.icon || hit.icon,
      sources: (r.sources?.length ? r.sources : hit.sources) || [],
      tracking_summary: hit.tracking_summary,
      privacy_labels: hit.privacy_labels,
      privacy_details: hit.privacy_details,
      privacy_policy_url: hit.privacy_policy_url,
      developer_website_url: hit.developer_website_url,
      app_id: hit.app_id || r.app_id
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
  const url = `https://itunes.apple.com/search?term=${q}&entity=software&country=${COUNTRY}&limit=${SEARCH_LIMIT}`;
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
  try{
    if (!u || u.startsWith('data:')) return u;
    const clean = u.replace(/^https?:\/\//,'');
    return `https://images.weserv.nl/?url=${encodeURIComponent(clean)}&w=100&h=100&fit=contain&we`;
  } catch { return u; }
}

/* =========================
   Glossary drawer
   ========================= */
let GLOSSARY = null;
async function loadGlossary(){
  if (GLOSSARY) return GLOSSARY;
  try{ GLOSSARY = await loadJSON('data/glossary.json'); }
  catch{ GLOSSARY = { terms:{} }; }
  return GLOSSARY;
}
function openDrawerHTML(title, html){
  const d = document.getElementById('glossary-drawer');
  const b = document.getElementById('drawer-backdrop');
  document.getElementById('glossary-title').textContent = title || 'Privacy term';
  document.getElementById('glossary-body').innerHTML = html || '<p>No description available.</p>';
  d.classList.add('open'); d.setAttribute('aria-hidden','false'); b.hidden = false;
}
function closeDrawer(){ const d=document.getElementById('glossary-drawer'); const b=document.getElementById('drawer-backdrop'); d.classList.remove('open'); d.setAttribute('aria-hidden','true'); b.hidden = true; }

/* =========================
   Risk meter (granular + purpose aware)
   ========================= */
const RISK_WEIGHTS = {
  track: {
    "Identifiers": 12, "Location": 12, "Contact Info": 10, "Financial Info": 12,
    "Health & Fitness": 12, "Browsing/Search History": 10, "User Content": 8,
    "Purchases": 6, "Usage Data": 6, "Diagnostics": 2, "Photos or Videos": 8,
    "Audio Data": 6, "Messages": 10, "Contacts": 8, "Sensitive Info": 12
  },
  linked: {
    "Identifiers": 9, "Location": 9, "Contact Info": 8, "Financial Info": 9,
    "Health & Fitness": 9, "Browsing/Search History": 8, "User Content": 7,
    "Purchases": 4, "Usage Data": 4, "Diagnostics": 1, "Photos or Videos": 7,
    "Audio Data": 5, "Messages": 8, "Contacts": 6, "Sensitive Info": 10
  },
  notLinked: {
    "Identifiers": 2, "Location": 2, "Contact Info": 2, "Financial Info": 2,
    "Health & Fitness": 2, "Browsing/Search History": 2, "User Content": 2,
    "Purchases": 1, "Usage Data": 1, "Diagnostics": 1, "Photos or Videos": 2,
    "Audio Data": 1, "Messages": 2, "Contacts": 1, "Sensitive Info": 3
  }
};

const PURPOSE_BONUS = {
  "Advertising": 6,
  "Developer's Advertising": 4,
  "Personalization": 4,
  "Product Personalization": 3,
  "Analytics": 2,
  "Fraud Prevention": 3,
  "App Functionality": 0,
  "Other Purposes": 1
};

const SECTION_CAPS = { track: 70, linked: 50, notLinked: 20 };

function smoothScale(x, max) {
  const t = Math.max(0, Math.min(1, x / max));
  const k = 5;
  const y = 1 / (1 + Math.exp(-k * (t - 0.5)));
  return y * 100;
}

function computePrivacyScore(app){
  const labels = app.privacy_labels || {};
  const details = app.privacy_details || {};
  const sections = {
    track: labels["Data Used to Track You"] || [],
    linked: labels["Data Linked to You"] || [],
    notLinked: labels["Data Not Linked to You"] || []
  };

  const scoreSection = (sectionName, items, weights, cap) => {
    const set = new Set(items.map(s => String(s).trim()));
    let sum = 0;
    set.forEach(cat => {
      let base = weights[cat] || 0;
      const det = details[cat];
      if (det && Array.isArray(det.purposes)) {
        for (const p of det.purposes) base += (PURPOSE_BONUS[p] || 0);
        if (sectionName !== 'track' && det.tracked) base += 3;
      }
      sum += base;
    });
    const softened = Math.sqrt(sum) * Math.sqrt(cap);
    return Math.min(softened, cap);
  };

  const sTrack     = scoreSection('track',     sections.track,     RISK_WEIGHTS.track,     SECTION_CAPS.track);
  const sLinked    = scoreSection('linked',    sections.linked,    RISK_WEIGHTS.linked,    SECTION_CAPS.linked);
  const sNotLinked = scoreSection('notLinked', sections.notLinked, RISK_WEIGHTS.notLinked, SECTION_CAPS.notLinked);

  const raw = sTrack + sLinked + sNotLinked;
  const score = Math.round(smoothScale(raw, 140));

  let band = "Low";
  if (score >= 66) band = "High";
  else if (score >= 33) band = "Medium";

  return { score, band, parts: { sTrack, sLinked, sNotLinked } };
}

function renderRiskMeter(containerEl, app){
  const { score, band } = computePrivacyScore(app);
  const pct = Math.max(0, Math.min(100, score)); // 0..100

  const bandClass =
    band === "High" ? "high" :
    band === "Medium" ? "med" : "low";

  containerEl.innerHTML = `
    <div class="risk-label">
      Data collection intensity
      <span class="risk-badge ${bandClass}">${band}</span>
    </div>

    <div class="risk-track" role="img"
         aria-label="Data collection intensity ${Math.round(pct)} out of 100">
      <div class="risk-marker" style="left:${pct}%"
           title="${Math.round(pct)}/100"></div>
    </div>

    <div class="risk-scale">
      <span>low</span><span>medium</span><span>high</span>
    </div>
  `;
}

/* =========================
   Rendering
   ========================= */
function renderAsOf(boardKey){
  const el = document.getElementById(`asof-${boardKey}`);
  const val = state.boards[boardKey].asOf;
  if (el) el.textContent = val ? `(updated ${val})` : '';
}

async function resolveIcon(imgEl, app){
  const trySearchFirst = app.icon && /mzstatic\.com/.test(app.icon);
  const setWithFallbacks = (primaryUrl) => {
    imgEl.onerror = () => { imgEl.onerror = () => { imgEl.src = DEFAULT_ICON; }; imgEl.src = viaProxy(primaryUrl); };
    imgEl.src = primaryUrl;
  };
  if (trySearchFirst){
    const art = await findArtworkBySearch(app.name, app.developer);
    if (art) return setWithFallbacks(art);
    if (app.icon) return setWithFallbacks(app.icon);
    imgEl.src = DEFAULT_ICON; return;
  }
  if (app.icon){
    imgEl.onerror = async () => {
      const art = await findArtworkBySearch(app.name, app.developer);
      if (art) return setWithFallbacks(art);
      imgEl.onerror = () => { imgEl.src = DEFAULT_ICON; };
      imgEl.src = viaProxy(app.icon);
    };
    imgEl.src = app.icon; return;
  }
  const art = await findArtworkBySearch(app.name, app.developer);
  if (art) return setWithFallbacks(art);
  imgEl.src = DEFAULT_ICON;
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
    const frag = tpl.content.cloneNode(true);
    const root = frag.querySelector('.app-card') || frag.firstElementChild;
    if (root) root.dataset.appKey = appKey(app);

    const iconEl = frag.querySelector('.app-icon');
    iconEl.alt = `${app.name} icon`;
    iconEl.referrerPolicy = 'no-referrer';
    resolveIcon(iconEl, app);

    // Rank text
    let rankText = '';
    const hasRealRank = Number.isFinite(app.rank);
    rankText = (context === 'board') ? `#${hasRealRank ? app.rank : (idx+1)}` : (hasRealRank ? `#${app.rank}` : '');
    frag.querySelector('.rank').textContent = rankText;

    // Name + platform
    frag.querySelector('.name').textContent = app.name;
    const plat = frag.querySelector('.platform'); if (plat) plat.textContent = 'iOS';

    // Developer label + developer name
    const devEl = frag.querySelector('.developer');
    if (devEl) {
      const devLabel = document.createElement('span');
      devLabel.className = 'maker-label'; // reuse CSS class
      devLabel.textContent = 'Developer';
      devEl.before(devLabel);
      devEl.textContent = app.developer || '';
    }

    // Tracking summary
    const tracking = frag.querySelector('.tracking');
    tracking.innerHTML = app.tracking_summary
      ? `<ul>${app.tracking_summary.map(t => `<li>${t}</li>`).join('')}</ul>`
      : '<p class="muted">Tracking details coming soon.</p>';

    // Privacy labels -> chips
    const privacy = frag.querySelector('.privacy');
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
    const riskEl = frag.querySelector('.risk');
    if (riskEl) renderRiskMeter(riskEl, app);

    // Sources
    const sources = frag.querySelector('.sources');
    if (app.sources && app.sources.length){
      sources.innerHTML =
        `<strong>Sources:</strong> ` +
        app.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.label || 'Link'}</a>`).join(' ');
    }

    listEl.appendChild(frag);
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

  // Refresh button clears caches and reloads
  document.getElementById('refresh-data')?.addEventListener('click', (e) => {
    e.preventDefault();
    ['free','paid','games'].forEach(k => localStorage.removeItem('ff-cache:rss:'+k+':'+RSS_LIMIT));
    Object.keys(localStorage).forEach(k => { if (k.startsWith('art:')) localStorage.removeItem(k); });
    init(true);
  });

  // Drawer controls
  document.getElementById('drawer-close')?.addEventListener('click', closeDrawer);
  document.getElementById('drawer-backdrop')?.addEventListener('click', closeDrawer);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // Glossary chip clicks -> open drawer with definition + app-specific details (if available)
  document.body.addEventListener('click', async (e) => {
    const liChip = e.target.closest('.privacy li');
    if (!liChip) return;

    const card = e.target.closest('[data-app-key]');
    const key = card?.dataset.appKey;
    const app = key
      ? (['free','paid','games'].flatMap(k => state.boards[k].apps).find(a => appKey(a) === key))
      : null;

    const term = liChip.dataset.term || liChip.textContent.trim();
    const glossary = await loadGlossary();
    const def = glossary.terms?.[term] || glossary.terms?.[term.toLowerCase()] ||
                'This category groups similar types of data. Exact collection depends on the features you use and your settings.';

    let html = `<p class="muted">${def}</p>`;

    const details = app?.privacy_details?.[term];
    if (details) {
      const statusBadges = [
        details.tracked ? '<span class="badge warn">Used to Track You</span>' : '',
        details.linked ? '<span class="badge info">Linked to You</span>' : '',
        details.notLinked ? '<span class="badge">Not Linked</span>' : ''
      ].filter(Boolean).join(' ');

      const sub = (details.subtypes || []).map(s => `<span class="chip">${s}</span>`).join(' ') || '<em>No specific sub-items disclosed.</em>';
      const purp = (details.purposes || []).map(p => `<span class="chip soft">${p}</span>`).join(' ') || '<em>No purposes listed.</em>';

      html += `
        <hr/>
        <h4>This app’s disclosure for “${term}”</h4>
        <div class="drawer-block">
          <div class="drawer-row"><strong>Status:</strong> ${statusBadges || '<span class="badge">Unspecified</span>'}</div>
          <div class="drawer-row"><strong>Sub-items:</strong> ${sub}</div>
          <div class="drawer-row"><strong>Purposes:</strong> ${purp}</div>
        </div>
      `;

      const srcLinks = (app.sources || []).map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.label || 'Source'}</a>`).join(' · ');
      const policy = app.privacy_policy_url ? ` · <a href="${app.privacy_policy_url}" target="_blank" rel="noopener">Privacy Policy</a>` : '';
      const devSite = app.developer_website_url ? ` · <a href="${app.developer_website_url}" target="_blank" rel="noopener">Developer Website</a>` : '';
      html += `<p class="muted small">Source: ${srcLinks || 'App Store listing'}${policy}${devSite}</p>`;
    }

    openDrawerHTML(term, html);
  });

  // Search (local first, then live iTunes Search)
  const input = document.getElementById('search-input');
  const resultsEl = document.getElementById('search-results');
  const noRes = document.getElementById('no-results');
  let debounceId = null;

  input?.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q){
      resultsEl.innerHTML = '';
      if (noRes) noRes.hidden = true;
      if (searchAbort) searchAbort.abort();
      return;
    }

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
          return hit ? {
            ...a,
            tracking_summary: hit.tracking_summary,
            privacy_labels: hit.privacy_labels,
            privacy_details: hit.privacy_details,
            privacy_policy_url: hit.privacy_policy_url,
            developer_website_url: hit.developer_website_url
          } : a;
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
   Data loading with safe fallback
   ========================= */

// Toggle: render from local apps.json only (set to false to use Apple RSS)
const USE_LOCAL_ONLY = false; // ← live mode

async function loadBoards(){
  // Load local dataset (for enrichment + fallback)
  let local = { apps: [], as_of: '' };
  try { local = await loadJSON('data/apps.json'); } catch {}
  state.localApps = local.apps || [];

  if (USE_LOCAL_ONLY) {
    const asof = local.as_of || new Date().toLocaleDateString();
    ['free','paid','games'].forEach(k => {
      state.boards[k].apps = [...state.localApps];
      state.boards[k].asOf = asof + ' (local)';
    });
    return;
  }

  // Normal path: fetch Apple RSS and enrich with local privacy labels
  const safeFetch = async (key, fn) => {
    try { return await getCached(key, fn); }
    catch(e){ console.warn('RSS failed:', e.message); return { as_of: '', apps: [] }; }
  };

  const freeRss  = await safeFetch('rss:free:'+RSS_LIMIT,
                    () => fetchAppleChart({ kind:'topfreeapplications', limit:RSS_LIMIT }));
  const paidRss  = await safeFetch('rss:paid:'+RSS_LIMIT,
                    () => fetchAppleChart({ kind:'toppaidapplications', limit:RSS_LIMIT }));
  const gamesRss = await safeFetch('rss:games:'+RSS_LIMIT,
                    () => fetchAppleChart({ kind:'topfreeapplications', limit:RSS_LIMIT, genre:GENRE_GAMES }));

  const useLocal = (rss) => (rss.apps && rss.apps.length) ? rss
                      : { as_of: local.as_of || '', apps: [...state.localApps] };

  const free  = useLocal(freeRss);
  const paid  = useLocal(paidRss);
  const games = useLocal(gamesRss);

  state.boards.free.apps  = mergeAppsByName(free.apps,  state.localApps);
  state.boards.free.asOf  = free.as_of  || local.as_of || '';

  state.boards.paid.apps  = mergeAppsByName(paid.apps,  state.localApps);
  state.boards.paid.asOf  = paid.as_of  || local.as_of || '';

  state.boards.games.apps = mergeAppsByName(games.apps, state.localApps);
  state.boards.games.asOf = games.as_of || local.as_of || '';
}

async function init(forceRefresh=false){
  try {
    await loadBoards();
  } catch(err){
    console.error('Failed to load boards:', err);
    // last-resort fallback to local only
    ['free','paid','games'].forEach(k => {
      state.boards[k].apps = state.localApps;
      state.boards[k].asOf = state.boards[k].asOf || '';
    });
  }

  try {
    const rights = await loadJSON('data/rights_ie.json');
    state.rights = rights.items || [];
  } catch(err){
    console.warn('Rights failed to load:', err.message);
  }

  renderAllBoards();
  renderRights();

  if (forceRefresh) localStorage.setItem('ff-last-refresh', String(Date.now()));
}

window.addEventListener('DOMContentLoaded', () => {
  setupControls();
  init();
});
