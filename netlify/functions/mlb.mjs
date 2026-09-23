// Radar MLB — función de Netlify que lee TeamRankings.com y devuelve JSON.
// Sin dependencias externas: usa fetch nativo (Node 18+) y un lector de tablas HTML propio.

const BASE = "https://www.teamrankings.com/mlb";
const URLS = {
  standings: `${BASE}/standings/`,
  runs: `${BASE}/stat/runs-per-game`,
  hits: `${BASE}/stat/hits-per-game`,
  hr: `${BASE}/stat/home-runs-per-game`,
  outs: `${BASE}/stat/outs-pitched-per-game`,
};
const STAT_KEYS = ["runs", "hits", "hr", "outs"];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

// Grupos de nombres equivalentes (TeamRankings usa "NY Mets", "Chi Sox", "SF Giants", etc.)
const ALIAS_GROUPS = [
  ["oakland", "athletics", "sacramento", "oaklandathletics", "sacramentoathletics", "as"],
  ["chisox", "chiwhitesox", "chicagowhitesox", "whitesox", "cws"],
  ["chicubs", "chicagocubs", "cubs", "chc"],
  ["sfgiants", "sanfrancisco", "sanfranciscogiants", "giants", "sf"],
  ["ladodgers", "losangelesdodgers", "dodgers", "lad"],
  ["laangels", "losangelesangels", "angels", "laa"],
  ["nymets", "newyorkmets", "mets", "nym"],
  ["nyyankees", "newyorkyankees", "yankees", "nyy"],
  ["stlouis", "stlcardinals", "stlouiscardinals", "cardinals", "stl"],
  ["tampabay", "tampabayrays", "rays", "tb"],
  ["kansascity", "kansascityroyals", "royals", "kc"],
  ["sandiego", "sandiegopadres", "padres", "sd"],
  ["washington", "washingtonnationals", "nationals", "wsh"],
];
const ALIAS = {};
for (const g of ALIAS_GROUPS) for (const k of g) ALIAS[k] = g[0];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
const key = (s) => { const k = norm(s); return ALIAS[k] || k; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------- descarga con reintento y límite de tiempo ----------
async function getHtml(url, tries = 2, timeoutMs = 4000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      if (!/<table/i.test(html)) throw new Error("la página no trae tablas (posible bloqueo)");
      return html;
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error("tiempo de espera agotado") : e;
      if (i < tries - 1) await sleep(350);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr ? lastErr.message : "error desconocido");
}

// ---------- lector de tablas HTML ----------
function decode(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();
}

function parseTables(html) {
  const out = [];
  const reTable = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = reTable.exec(html))) {
    const rows = [];
    const reRow = /<tr[\s\S]*?<\/tr>/gi;
    let r;
    while ((r = reRow.exec(m[0]))) {
      const cells = [];
      const reCell = /<t([hd])[^>]*>([\s\S]*?)<\/t\1>/gi;
      let c;
      while ((c = reCell.exec(r[0]))) cells.push(decode(c[2]));
      if (cells.length) rows.push(cells);
    }
    out.push({ index: m.index, rows });
  }
  return out;
}

// ---------- partidos del día ----------
function parseSchedule(html) {
  const isHdr = (r) => r.some((c) => /matchup/i.test(c));
  const t = parseTables(html).find((t) => t.rows.some(isHdr));
  if (!t) return [];
  const hdr = t.rows.find(isHdr);
  const idx = (re) => hdr.findIndex((c) => re.test(c));
  const iM = idx(/matchup/i), iTime = idx(/^time/i), iLoc = idx(/location/i), iHot = idx(/hotness/i);

  const games = [];
  for (const r of t.rows) {
    if (isHdr(r)) continue;
    const txt = (r[iM] || "").replace(/\(\d+-\d+\)/g, "").trim();
    const mm = txt.match(/^(?:#(\d+)\s+)?(.+?)\s+(at|vs\.?|@)\s+(?:#(\d+)\s+)?(.+)$/i);
    if (!mm) continue;
    games.push({
      away: mm[2].trim(),
      awayRank: mm[1] ? +mm[1] : null,
      home: mm[5].trim(),
      homeRank: mm[4] ? +mm[4] : null,
      neutral: !/^(at|@)$/i.test(mm[3]),
      time: iTime >= 0 ? r[iTime] || "" : "",
      location: iLoc >= 0 ? r[iLoc] || "" : "",
      hotness: iHot >= 0 ? num(r[iHot]) : null,
    });
  }
  return games;
}

// ---------- tabla de posiciones (6 divisiones) ----------
const DIV_RE = /\b(AL|NL|American League|National League)\s*(East|Central|West)\b/gi;
const FALLBACK_DIVS = ["AL East", "AL Central", "AL West", "NL East", "NL Central", "NL West"];

function divName(raw) {
  const m = /(AL|NL|American League|National League)\s*(East|Central|West)/i.exec(raw || "");
  if (!m) return null;
  const lg = /^a/i.test(m[1]) ? "AL" : "NL";
  const zone = { east: "Este", central: "Central", west: "Oeste" }[m[2].toLowerCase()];
  return `${lg} ${zone}`;
}

function parseStandings(html) {
  const isHdr = (r) => r.some((c) => /streak/i.test(c)) && r.some((c) => /pct/i.test(c));
  const tables = parseTables(html).filter((t) => t.rows.some(isHdr));
  const map = {};
  tables.forEach((t, ti) => {
    const hdr = t.rows.find(isHdr);
    // División: 1) en la cabecera de la tabla, 2) en el texto justo antes, 3) por orden
    let div = divName(hdr.join(" "));
    if (!div) {
      const before = html.slice(Math.max(0, t.index - 2500), t.index);
      const all = [...before.matchAll(DIV_RE)];
      if (all.length) div = divName(all[all.length - 1][0]);
    }
    if (!div) div = divName(FALLBACK_DIVS[ti] || "") || `Grupo ${ti + 1}`;

    const idx = (re) => hdr.findIndex((c) => re.test(c));
    let iT = idx(/^team$/i);
    if (iT < 0) iT = 0;
    const iRank = idx(/^rank$/i), iWL = idx(/overall|^w-l$/i), iPct = idx(/^pct$/i),
      iStreak = idx(/streak/i);

    let pos = 0;
    for (const r of t.rows) {
      if (isHdr(r) || !r[iT] || r.length < 3) continue;
      pos++;
      map[key(r[iT])] = {
        team: r[iT], pos, div,
        powerRank: iRank >= 0 ? num(r[iRank]) : null,
        record: iWL >= 0 ? r[iWL] : "",
        pct: iPct >= 0 ? num(r[iPct]) : null,
        streak: iStreak >= 0 ? r[iStreak] : "",
      };
    }
  });
  if (!Object.keys(map).length) throw new Error("tabla de posiciones no encontrada");
  return map;
}

// ---------- páginas de estadística (Temporada, Last 3, Home, Away) ----------
function parseStat(html) {
  const isHdr = (r) => r.includes("Team") && r.includes("Home") && r.includes("Away");
  const t = parseTables(html).find((t) => t.rows.some(isHdr));
  if (!t) throw new Error("tabla de estadística no encontrada");
  const hdr = t.rows.find(isHdr);
  const iT = hdr.indexOf("Team"), iH = hdr.indexOf("Home"), iA = hdr.indexOf("Away"),
    iL3 = hdr.findIndex((c) => /last\s*3/i.test(c));
  let iS = hdr.findIndex((c, i) => i > iT && /^\d{4}$/.test(c)); // columna del año actual
  if (iS < 0) iS = iT + 1;

  const map = {};
  for (const r of t.rows) {
    if (isHdr(r) || !r[iT]) continue;
    map[key(r[iT])] = {
      season: num(r[iS]),
      last3: iL3 >= 0 ? num(r[iL3]) : null,
      home: num(r[iH]),
      away: num(r[iA]),
    };
  }
  return map;
}

// Búsqueda segura: exacta primero; parcial solo si hay UNA coincidencia (evita mezclar NY Mets / NY Yankees)
function find(map, name) {
  if (!map) return null;
  const k = key(name);
  if (map[k]) return map[k];
  const keys = Object.keys(map);
  let hits = keys.filter((x) => x.startsWith(k) || k.startsWith(x));
  if (hits.length !== 1) hits = keys.filter((x) => x.includes(k) || k.includes(x));
  return hits.length === 1 ? map[hits[0]] : null;
}

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

export default async (req) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date");
  const validDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  const scheduleUrl = `${BASE}/schedules/${validDate ? `?date=${validDate}` : ""}`;

  const names = ["schedule", "standings", ...STAT_KEYS];
  const results = await Promise.allSettled([
    getHtml(scheduleUrl),
    ...["standings", ...STAT_KEYS].map((k) => getHtml(URLS[k])),
  ]);

  const warnings = [];
  const html = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled") html[names[i]] = r.value;
    else warnings.push(`${names[i]}: ${r.reason?.message || r.reason}`);
  });

  if (!html.schedule) {
    return json(
      { ok: false, error: "No se pudo leer el calendario de TeamRankings.", warnings },
      502,
      { "Cache-Control": "no-store" }
    );
  }

  const safe = (label, fn, src) => {
    if (!src) return null;
    try { return fn(src); } catch (e) { warnings.push(`${label}: ${e.message}`); return null; }
  };

  const games = safe("schedule", parseSchedule, html.schedule) || [];
  const standings = safe("standings", parseStandings, html.standings);
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = safe(k, parseStat, html[k]);

  const warned = new Set();
  const team = (name, rank) => {
    const t = { name, rank, standing: find(standings, name) };
    for (const k of STAT_KEYS) t[k] = find(stats[k], name);
    const loaded = { standing: standings, ...stats };
    const missing = Object.keys(loaded).filter((k) => loaded[k] && !t[k]);
    if (missing.length && !warned.has(name)) {
      warned.add(name);
      warnings.push(`${name}: sin datos en ${missing.join(", ")}`);
    }
    return t;
  };

  const out = games.map((g) => ({
    time: g.time, location: g.location, hotness: g.hotness, neutral: g.neutral,
    home: team(g.home, g.homeRank),
    away: team(g.away, g.awayRank),
  }));

  return json(
    { ok: true, date: validDate, updated: new Date().toISOString(), games: out, warnings },
    200,
    {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=900, stale-while-revalidate=3600",
      "Netlify-Vary": "query=date",
    }
  );
};

export const config = { path: "/api/mlb" };
