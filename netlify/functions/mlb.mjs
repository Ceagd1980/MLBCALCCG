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

// Estadísticas de jugadores (orden = columnas de la página)
const PLAYER_STATS = {
  runs: "https://www.teamrankings.com/mlb/player-stat/runs",
  hits: "https://www.teamrankings.com/mlb/player-stat/hits",
  hr: "https://www.teamrankings.com/mlb/player-stat/home-runs",
  so: "https://www.teamrankings.com/mlb/player-stat/strikeouts",
};
const PLAYER_KEYS = Object.keys(PLAYER_STATS);
const FILL_ORDER = ["hits", "runs", "hr", "so"]; // "so" = strikeouts lanzados (pitchers)
const TOP_PLAYERS = 5;

// Los 30 equipos como los escribe TeamRankings en calendario y estadísticas
const MLB_TEAMS = ["Arizona", "Atlanta", "Baltimore", "Boston", "Chi Cubs", "Chi Sox", "Cincinnati",
  "Cleveland", "Colorado", "Detroit", "Houston", "Kansas City", "LA Angels", "LA Dodgers", "Miami",
  "Milwaukee", "Minnesota", "NY Mets", "NY Yankees", "Oakland", "Philadelphia", "Pittsburgh",
  "San Diego", "SF Giants", "Seattle", "St. Louis", "Tampa Bay", "Texas", "Toronto", "Washington"];

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
const cleanTeam = (s) => String(s || "").replace(/\(\d+-\d+(-\d+)?\)/g, "").replace(/^#\d+\s+/, "").trim();
const pkey = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------- descarga con reintento y límite de tiempo ----------
async function getHtml(url, tries = 2, timeoutMs = 3500) {
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
const ZONE = { east: "Este", central: "Central", west: "Oeste" };

function parseStandings(html) {
  const isHdr = (r) => r.some((c) => /streak/i.test(c)) && r.some((c) => /pct/i.test(c));
  const tables = parseTables(html).filter((t) => t.rows.some(isHdr));
  const map = {};
  tables.forEach((t, ti) => {
    // Liga de la tabla: texto previo a la tabla; si no aparece, por orden (1ª AL, 2ª NL)
    const before = html.slice(Math.max(0, t.index - 2500), t.index);
    const lgAll = [...before.matchAll(/\b(American League|National League|AL|NL)\b/g)];
    const league = lgAll.length ? (/^A/.test(lgAll[lgAll.length - 1][1]) ? "AL" : "NL") : ti % 2 === 0 ? "AL" : "NL";

    const hdr = t.rows.find(isHdr);
    const idx = (re) => hdr.findIndex((c) => re.test(c));
    let iT = idx(/^team$/i);
    if (iT < 0) iT = 0;
    const iRank = idx(/^rank$/i), iWL = idx(/overall|^w-l$/i), iPct = idx(/^pct$/i),
      iStreak = idx(/streak/i);

    // Las filas de título ("AL East", "NL West"...) marcan la división y reinician la posición
    let div = null, pos = 0;
    const setDiv = (text) => {
      const m = /(?:\b(American League|National League|AL|NL)\s*)?\b(East|Central|West)\b/i.exec(text);
      if (!m) return;
      const lg = m[1] ? (/^a/i.test(m[1]) ? "AL" : "NL") : league;
      div = `${lg} ${ZONE[m[2].toLowerCase()]}`;
      pos = 0;
    };

    for (const r of t.rows) {
      const isLabel = isHdr(r) || r.length < 3 || r.every((c) => !/\d/.test(c));
      if (isLabel) { setDiv(r.join(" ")); continue; }
      if (!r[iT]) continue;
      pos++;
      map[key(r[iT])] = {
        team: r[iT], pos, div: div || league,
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
// ---------- estadísticas de jugadores ----------
// Busca la tabla con columnas de jugador, equipo y valor. Si la cabecera no las nombra,
// las deduce del contenido (columna con nombres de personas, columna con equipos, última numérica).
const RE_PLAYER = /player|^name$|athlete/i;
const RE_TEAM = /team|school|college/i;
const RE_VALUE = /^value$|per\s*game|^avg|average|^ppg$|^apg$|^rpg$|^pts$|^ast$|^reb$|points|assists|rebounds/i;

function parsePlayers(html) {
  const tables = parseTables(html).filter((t) => t.rows.length >= 3);
  if (!tables.length) throw new Error("tabla de jugadores no encontrada");
  let best = null;
  for (const t of tables) {
    const hi = t.rows.findIndex((r) => r.some((c) => RE_PLAYER.test(c)) && r.some((c) => RE_TEAM.test(c)));
    let iP = -1, iT = -1, iV = -1, iPos = -1, start = 0;
    if (hi >= 0) {
      const hdr = t.rows[hi];
      iP = hdr.findIndex((c) => RE_PLAYER.test(c));
      iT = hdr.findIndex((c, i) => i !== iP && RE_TEAM.test(c));
      iV = hdr.findIndex((c, i) => i !== iP && i !== iT && RE_VALUE.test(c));
      iPos = hdr.findIndex((c) => /^pos/i.test(c));
      start = hi + 1;
    } else {
      // Deducción por contenido: texto sin dígitos en 2 columnas (jugador = la que tiene más palabras)
      const body = t.rows.filter((r) => r.length >= 3).slice(0, 30);
      if (body.length < 3) continue;
      const cols = Math.max(...body.map((r) => r.length));
      const textCols = [];
      for (let i = 0; i < cols; i++) {
        const vals = body.map((r) => r[i] || "");
        const txt = vals.filter((v) => /[a-z]/i.test(v) && !/\d/.test(v)).length;
        const avgLen = vals.reduce((n, v) => n + v.length, 0) / vals.length;
        // descarta columnas cortas tipo posición (G, F, C, G-F)
        if (txt >= body.length * 0.8 && avgLen > 3) textCols.push({ i, uniq: new Set(vals).size / vals.length });
      }
      if (textCols.length < 2) continue;
      // Jugador = la columna con más valores distintos (los equipos se repiten); empate = la primera
      textCols.sort((x, y) => y.uniq - x.uniq || x.i - y.i);
      iP = textCols[0].i; iT = textCols[1].i;
    }
    const byTeam = {};
    let n = 0;
    for (const r of t.rows.slice(start)) {
      if (!r[iP] || !r[iT] || RE_PLAYER.test(r[iP])) continue;
      let v = iV >= 0 ? num(r[iV]) : null;
      if (v == null) for (let i = r.length - 1; i >= 0; i--) { if (i === iP || i === iT) continue; v = num(r[i]); if (v != null) break; }
      if (v == null) continue;
      const tk = key(cleanTeam(r[iT]));
      (byTeam[tk] ||= {})[pkey(r[iP])] = { name: r[iP], team: r[iT], pos: iPos >= 0 ? r[iPos] : "", v };
      n++;
    }
    if (!best || n > best.n) best = { n, byTeam };
  }
  if (!best || !best.n) throw new Error("tabla de jugadores no encontrada");
  return best.byTeam;
}

// Las páginas de jugadores escriben el equipo con su apodo ("BYU Cougars", "Iowa State Cyclones",
// "North Carolina Tar Heels"). Se quita el apodo palabra por palabra desde el final hasta que el
// nombre coincide EXACTO con un equipo conocido; así "Iowa State Cyclones" nunca cae en "Iowa".
// La página de jugadores usa el nombre completo ("New York Yankees", "Chicago White Sox",
// "Toronto Blue Jays"). Se prueba el nombre entero y luego quitando el apodo (máx. 2 palabras)
// hasta que coincide EXACTO con un equipo conocido. Nunca "NY Mets" con "NY Yankees".
function teamFromPlayerPage(raw, known) {
  const words = cleanTeam(raw).split(/\s+/).filter(Boolean);
  for (let drop = 0; drop <= 2 && drop < words.length; drop++) {
    const k = key(words.slice(0, words.length - drop).join(" "));
    if (k && known.has(k)) return { k, drop };
  }
  return null;
}

function remapAllPlayers(players, known) {
  const raws = new Map();
  for (const map of Object.values(players)) {
    if (!map) continue;
    for (const [rawKey, plist] of Object.entries(map)) {
      const team = Object.values(plist)[0].team;
      if (raws.has(team)) continue;
      raws.set(team, known.has(rawKey) ? { k: rawKey, drop: 0 } : teamFromPlayerPage(team, known));
    }
  }
  const bestDrop = {};
  for (const r of raws.values()) if (r) bestDrop[r.k] = Math.min(bestDrop[r.k] ?? 9, r.drop);
  const out = {};
  for (const [name, map] of Object.entries(players)) {
    if (!map) { out[name] = null; continue; }
    const m = {};
    for (const plist of Object.values(map)) {
      const r = raws.get(Object.values(plist)[0].team);
      if (!r || r.drop !== bestDrop[r.k]) continue;
      Object.assign((m[r.k] ||= {}), plist);
    }
    out[name] = m;
  }
  return out;
}

// Se elige primero al líder del equipo en cada estadística (carreras, hits, jonrones y el pitcher
// con más strikeouts) y luego se completa hasta 5 con los siguientes bateadores en hits, carreras y jonrones.
function teamPlayers(players, tk) {
  const all = {};
  for (const s of PLAYER_KEYS) {
    const m = players[s]?.[tk];
    if (!m) continue;
    for (const [pk, p] of Object.entries(m)) {
      const o = (all[pk] ||= { name: p.name, team: p.team, pos: p.pos || "" });
      if (!o.pos && p.pos) o.pos = p.pos;
      o[s] = p.v;
    }
  }
  const ids = Object.keys(all);
  if (!ids.length) return null;
  const chosen = [];
  const add = (pk) => { if (pk && !chosen.includes(pk) && chosen.length < TOP_PLAYERS) chosen.push(pk); };
  const rank = (s) => ids.filter((pk) => all[pk][s] != null).sort((a, b) => all[b][s] - all[a][s]);
  for (const s of PLAYER_KEYS) add(rank(s)[0]);
  for (const s of FILL_ORDER) for (const pk of rank(s)) add(pk);
  return chosen.map((pk) => {
    const p = all[pk];
    const o = { name: p.name, team: p.team, pos: p.pos };
    for (const s of PLAYER_KEYS) o[s] = p[s] ?? null;
    return o;
  });
}

// Diagnóstico: /api/mlb?debug=players muestra cómo vienen las páginas de jugadores
async function debugPlayers() {
  const out = {};
  await Promise.all(Object.entries(PLAYER_STATS).map(async ([k, u]) => {
    try {
      const r = await fetch(u, { headers: HEADERS });
      const html = await r.text();
      const tables = parseTables(html);
      out[k] = {
        url: u, status: r.status, bytes: html.length, tables: tables.length,
        muestra: tables.slice(0, 3).map((t) => ({ filas: t.rows.length, primeras: t.rows.slice(0, 4) })),
      };
      try { const m = parsePlayers(html); out[k].equipos = Object.keys(m).length; out[k].ejemploEquipos = Object.keys(m).slice(0, 8); }
      catch (e) { out[k].error = e.message; }
    } catch (e) { out[k] = { url: u, error: e.message }; }
  }));
  return out;
}

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

// /api/mlb?part=players — jugadores de los 30 equipos, en una llamada aparte
async function playersResponse() {
  const warnings = [];
  const res = await Promise.allSettled(PLAYER_KEYS.map((k) => getHtml(PLAYER_STATS[k], 2, 4000)));
  let players = {};
  res.forEach((r, i) => {
    const k = PLAYER_KEYS[i];
    if (r.status !== "fulfilled") { warnings.push(`jugadores ${k}: ${r.reason?.message || r.reason}`); players[k] = null; return; }
    try { players[k] = parsePlayers(r.value); } catch (e) { warnings.push(`jugadores ${k}: ${e.message}`); players[k] = null; }
  });
  const known = new Set(MLB_TEAMS.map((t) => key(t)));
  const sample = PLAYER_KEYS.map((k) => players[k]).filter(Boolean).slice(0, 1)
    .flatMap((m) => Object.values(m).slice(0, 3).map((x) => Object.values(x)[0].team));
  players = remapAllPlayers(players, known);
  const byTeam = {};
  for (const k of known) { const list = teamPlayers(players, k); if (list) byTeam[k] = list; }
  if (PLAYER_KEYS.some((k) => players[k]) && !Object.keys(byTeam).length)
    warnings.push(`Jugadores: las tablas cargaron pero ningún equipo coincidió. Ej.: ${sample.join(", ")}`);
  const ok = Object.keys(byTeam).length > 0;
  return json({ ok, updated: new Date().toISOString(), players: byTeam, warnings, error: ok ? undefined : "No se pudieron cargar los jugadores" },
    ok ? 200 : 502,
    ok ? {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=1800, stale-while-revalidate=3600",
      "Netlify-Vary": "query=part",
    } : { "Cache-Control": "no-store" });
}

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("debug") === "players")
    return json(await debugPlayers(), 200, { "Cache-Control": "no-store" });
  if (url.searchParams.get("part") === "players") return playersResponse();
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
    // clave con la que la página busca a sus jugadores en /api/mlb?part=players
    const kk = key(name);
    t.key = MLB_TEAMS.some((x) => key(x) === kk) ? kk : (find(Object.fromEntries(MLB_TEAMS.map((x) => [key(x), key(x)])), name) || kk);
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
