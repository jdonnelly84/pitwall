/* Pit Wall - an F1 race-weekend app that runs entirely on the phone.
 *
 * Data (all free, no keys, read straight from the phone):
 *   Jolpica  api.jolpi.ca/ergast/f1   calendar, session times, results, qualifying, sprints, standings
 *   OpenF1   api.openf1.org/v1        practice times, tyre strategy, pit stops, race control, weather, photos, team colours
 *                                     (free from 30 min after each session ends; during sessions it needs a paid account)
 *   ESPN     site.api.espn.com        live running order and lap count during sessions, F1 news
 *   MultiViewer api.multiviewer.app   circuit outlines
 *   Open-Meteo api.open-meteo.com     race-weekend weather forecast
 *
 * Everything fetched is kept on the phone (Cache Storage) so screens paint instantly from the saved copy
 * and refresh in the background, only redrawing when something changed.
 */
'use strict';
(() => {
const VERSION = '1.0.0';
const J = 'https://api.jolpi.ca/ergast/f1';
const O = 'https://api.openf1.org/v1';
const E = 'https://site.api.espn.com/apis/site/v2/sports/racing/f1';
const MIN = 6e4, H = 36e5, D = 864e5;

// ---------------------------------------------------------------- clock (overridable for testing: ?at=2026-11-29T16:30:00Z)
const atParam = new URLSearchParams(location.search).get('at');
const clockOffset = atParam ? new Date(atParam).getTime() - Date.now() : 0;
const now = () => Date.now() + clockOffset;

// ---------------------------------------------------------------- settings
const S = Object.assign({ text: 'l', theme: 'auto', fav: [] }, readLS('pw-settings', {}));
function readLS(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full */ } }
function saveSettings() { writeLS('pw-settings', S); applySettings(); }
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applySettings() {
  const root = document.documentElement;
  root.dataset.text = S.text;
  root.dataset.theme = S.theme === 'auto' ? (darkMQ.matches ? 'dark' : 'light') : S.theme;
}
darkMQ.addEventListener && darkMQ.addEventListener('change', applySettings);
applySettings();
const isFav = code => code && S.fav.includes(code);

// ---------------------------------------------------------------- small helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const fmt = (t, o) => new Intl.DateTimeFormat(undefined, o).format(new Date(t));
const fDay = t => fmt(t, { weekday: 'short' });
const fDayNum = t => fmt(t, { day: 'numeric' });
const fMon = t => fmt(t, { month: 'short' });
const fTime = t => fmt(t, { hour: 'numeric', minute: '2-digit' });
const fDayLong = t => fmt(t, { weekday: 'long', day: 'numeric', month: 'long' });
const fWhen = t => fmt(t, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; } })();
function dateRange(a, b) {
  const sameMonth = fMon(a) === fMon(b);
  return sameMonth ? `${fDayNum(a)} – ${fDayNum(b)} ${fMon(b)}` : `${fDayNum(a)} ${fMon(a)} – ${fDayNum(b)} ${fMon(b)}`;
}
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
function lapTime(sec) {
  if (sec == null || isNaN(sec)) return '';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return (m ? m + ':' + (s < 10 ? '0' : '') : '') + s.toFixed(3);
}
function raceTime(sec) {
  if (sec == null || isNaN(sec)) return '';
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const chev = '<svg class="chev" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const backIcon = '<svg viewBox="0 0 24 24"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------- data layer: gentle fetching + saved copies
const hosts = {
  'api.openf1.org': { gap: 450, last: 0, chain: Promise.resolve() }, // free tier: 3 a second, 30 a minute
  'api.jolpi.ca': { gap: 300, last: 0, chain: Promise.resolve() },   // 4 a second, 500 an hour
};
let openf1PauseUntil = 0;
let lastNetError = 0, lastNetOk = 0;
function queuedFetch(url) {
  const q = hosts[new URL(url).host];
  const go = () => {
    // never let a slow service hold a screen up: give up after 15 s and use the saved copy
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac && setTimeout(() => ac.abort(), 15000);
    return fetch(url, { credentials: 'omit', cache: 'no-store', signal: ac ? ac.signal : undefined })
      .finally(() => timer && clearTimeout(timer));
  };
  if (!q) return go();
  const p = q.chain.then(async () => {
    const wait = q.last + q.gap - Date.now();
    if (wait > 0) await sleep(wait);
    q.last = Date.now();
    return go();
  });
  q.chain = p.catch(() => {});
  return p;
}
const mem = new Map();
let store = null;
async function cacheStore() {
  if (!('caches' in window)) return null;
  try { return store || (store = await caches.open('pw-data-1')); } catch (e) { return null; }
}
async function readCache(url) {
  if (mem.has(url)) return mem.get(url);
  const c = await cacheStore();
  if (!c) return null;
  try {
    const r = await c.match(url);
    if (!r) return null;
    const e = { t: +r.headers.get('x-t') || 0, data: await r.json() };
    mem.set(url, e);
    return e;
  } catch (e) { return null; }
}
async function writeCache(url, data) {
  const e = { t: Date.now(), data };
  mem.set(url, e);
  const c = await cacheStore();
  if (c) c.put(url, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'x-t': String(e.t) } })).catch(() => {});
  return e;
}
class HttpError extends Error { constructor(status) { super('HTTP ' + status); this.status = status; } }
const inflight = new Map();
function net(url) {
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const isO1 = url.startsWith(O);
    if (isO1 && Date.now() < openf1PauseUntil) throw new HttpError(401);
    let r;
    try { r = await queuedFetch(url); }
    catch (e) { lastNetError = Date.now(); throw e; }
    lastNetOk = Date.now();
    if (isO1 && (r.status === 401 || r.status === 403 || r.status === 429)) {
      openf1PauseUntil = Date.now() + (r.status === 429 ? MIN : 5 * MIN); // live session (paid only) or too many requests
      throw new HttpError(r.status);
    }
    let data;
    if (isO1 && r.status === 404) data = []; // OpenF1 says "No results found" this way
    else if (!r.ok) throw new HttpError(r.status);
    else data = await r.json();
    await writeCache(url, data);
    return data;
  })();
  inflight.set(url, p);
  p.then(() => inflight.delete(url), () => inflight.delete(url));
  return p;
}
// Computed results (e.g. practice times worked out from every lap) are saved under made-up addresses.
const calcKey = k => location.origin + location.pathname.replace(/[^/]*$/, '') + '__calc/' + encodeURIComponent(k);

// A render pass: first paint from whatever is saved (any age); anything past its freshness gets refreshed
// afterwards and the screen redrawn only if it changed.
function makeCtx(force) {
  const stale = new Set();
  const ctx = {
    stale,
    async get(url, ttl) {
      const c = await readCache(url);
      if (c && !force) { if (Date.now() - c.t >= ttl) stale.add(url); return c.data; }
      try { return await net(url); }
      catch (e) { if (c) return c.data; throw e; }
    },
    async opt(url, ttl) { try { return await ctx.get(url, ttl); } catch (e) { return null; } },
    async savedAt(url) { const c = await readCache(url); return c ? c.t : 0; },
  };
  return ctx;
}

// ---------------------------------------------------------------- teams and drivers
const TEAMS = {
  mercedes: ['Mercedes', '00D7B6'], ferrari: ['Ferrari', 'ED1131'], red_bull: ['Red Bull Racing', '4781D7'],
  mclaren: ['McLaren', 'F47600'], rb: ['Racing Bulls', '6C98FF'], alpine: ['Alpine', '00A1E8'],
  haas: ['Haas', '9C9FA2'], audi: ['Audi', 'F50537'], sauber: ['Kick Sauber', '01C00E'], williams: ['Williams', '1868DB'],
  aston_martin: ['Aston Martin', '229971'], cadillac: ['Cadillac', '909090'],
};
const teamName = c => (TEAMS[c.constructorId] || [c.name.replace(/ F1 Team$/, '')])[0];
const teamColour = (c, dir, code) => {
  const d = code && dir.byCode[code];
  return '#' + ((d && d.colour) || (TEAMS[c.constructorId] || [, '888888'])[1]);
};

// Driver directory from OpenF1 (photos, team colours, numbers), merged into a saved copy so it survives
// race weekends when OpenF1 is closed to free users.
let DIR = buildDir(readLS('pw-dir', []));
function buildDir(list) {
  const dir = { list, byCode: {}, byNum: {}, byName: {}, byLast: {} };
  for (const d of list) {
    const e = {
      code: d.name_acronym, num: d.driver_number, first: d.first_name, last: d.last_name,
      team: d.team_name, colour: d.team_colour, photo: d.headshot_url ? d.headshot_url.replace('/1col/', '/2col/') : '',
    };
    dir.byCode[e.code] = e; dir.byNum[e.num] = e;
    dir.byName[norm(e.first + e.last)] = e; dir.byLast[norm(e.last)] = e;
  }
  return dir;
}
function mergeDir(list) {
  if (!list || !list.length) return;
  const byNum = {};
  for (const d of DIR.list) byNum[d.driver_number] = d;
  for (const d of list) byNum[d.driver_number] = Object.assign({}, byNum[d.driver_number], d,
    { headshot_url: d.headshot_url || (byNum[d.driver_number] || {}).headshot_url, team_colour: d.team_colour || (byNum[d.driver_number] || {}).team_colour });
  const merged = Object.values(byNum);
  // a number can move between drivers between seasons; keep the most recent owner of each acronym
  DIR = buildDir(merged);
  writeLS('pw-dir', merged);
}
function espnDriver(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return DIR.byName[norm(name)] || DIR.byLast[norm(parts.slice(1).join(''))] || DIR.byLast[norm(parts[parts.length - 1])] || null;
}
function avatar(code, name, colour, cls = 'shot') {
  const d = code && DIR.byCode[code];
  if (d && d.photo) return `<img class="${cls}" src="${esc(d.photo)}" alt="" loading="lazy" style="background:${colour}33" data-ini="${esc(code)}" data-c="${colour}">`;
  const ini = code || String(name || '?').split(' ').map(w => w[0]).join('').slice(0, 3);
  return `<div class="ini" style="background:${colour}">${esc(ini)}</div>`;
}

// ---------------------------------------------------------------- season, sessions, OpenF1 links
const SESS = [
  ['FirstPractice', 'Practice 1', 'P1', 60], ['SecondPractice', 'Practice 2', 'P2', 60], ['ThirdPractice', 'Practice 3', 'P3', 60],
  ['SprintQualifying', 'Sprint Qualifying', 'SQ', 45], ['SprintShootout', 'Sprint Qualifying', 'SQ', 45],
  ['Sprint', 'Sprint', 'Sprint', 60], ['Qualifying', 'Qualifying', 'Quali', 60],
];
function mkSess(o, key, name, short, dur) {
  const start = new Date(o.date + 'T' + (o.time || '12:00:00Z')).getTime();
  return { key, name, short, start, end: start + dur * MIN, tbc: !o.time };
}
function normRace(r) {
  const sessions = [];
  for (const [k, name, short, dur] of SESS) if (r[k]) sessions.push(mkSess(r[k], k, name, short, dur));
  const race = mkSess({ date: r.date, time: r.time }, 'Race', 'Race', 'Race', 120);
  sessions.push(race);
  sessions.sort((a, b) => a.start - b.start);
  const loc = r.Circuit.Location;
  return {
    season: +r.season, round: +r.round, name: r.raceName, short: r.raceName.replace(/ Grand Prix/, '').replace(/ GP$/, ''),
    circuit: r.Circuit.circuitName, circuitId: r.Circuit.circuitId, country: loc.country, locality: loc.locality,
    lat: +loc.lat, long: +loc.long, sessions, race, start: sessions[0].start, end: race.end, sprint: !!r.Sprint,
  };
}
const sessState = s => now() < s.start ? 'upcoming' : now() <= s.end + 10 * MIN ? 'live' : 'done';

async function season(ctx, year) {
  const d = await ctx.get(`${J}/${year || 'current'}/races.json?limit=40`, 6 * H);
  const rt = d.MRData.RaceTable;
  return { year: +rt.season, races: rt.Races.map(normRace) };
}
// The race weekend to feature: the one under way, or the next one; after the final round, the final round.
function featured(races) {
  return races.find(r => now() < r.end + 20 * H) || races[races.length - 1];
}
function nextSession(races) {
  for (const r of races) for (const s of r.sessions) if (s.start > now()) return { race: r, sess: s };
  return null;
}
async function o1Year(ctx, year) {
  const [meetings, sessions] = await Promise.all([
    ctx.opt(`${O}/meetings?year=${year}`, D),
    ctx.opt(`${O}/sessions?year=${year}`, 6 * H),
  ]);
  return { meetings: meetings || [], sessions: sessions || [] };
}
function meetingFor(race, o1) {
  const s = o1.sessions.find(s => s.session_name === 'Race' && Math.abs(new Date(s.date_start) - race.race.start) < 1.5 * D);
  if (s) return o1.meetings.find(m => m.meeting_key === s.meeting_key) || null;
  return o1.meetings.find(m => !/test/i.test(m.meeting_name) && Math.abs(new Date(m.date_end) - race.race.end) < 1.5 * D) || null;
}
function o1SessionFor(sess, o1) {
  let best = null, bd = 50 * MIN;
  for (const s of o1.sessions) {
    const d = Math.abs(new Date(s.date_start) - sess.start);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
// OpenF1 data stays put once a session is long over; recent sessions are re-checked every few minutes.
const o1ttl = sess => (now() - sess.end > 8 * H ? 60 * D : 4 * MIN);
const o1open = sess => now() > sess.end + 35 * MIN || now() < sess.start - 35 * MIN;

async function loadDrivers(ctx, o1) {
  const done = o1.sessions.filter(s => new Date(s.date_end).getTime() < now() - 40 * MIN);
  const last = done[done.length - 1];
  if (!last) return;
  const list = await ctx.opt(`${O}/drivers?session_key=${last.session_key}`, 60 * D);
  if (list && list.length) mergeDir(list);
}

// ESPN: live running order and lap count (free, no delay restrictions)
// ESPN files events under US dates, so ask for the whole race weekend
function espnUrl(race) {
  const ymd = t => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
  return `${E}/scoreboard?dates=${ymd(race.start - D)}-${ymd(race.end + D)}`;
}
function espnComp(board, sess) {
  const comps = [];
  for (const ev of (board && board.events) || []) comps.push(...(ev.competitions || []));
  let best = null, bd = 50 * MIN;
  for (const c of comps) {
    const d = Math.abs(new Date(c.date) - sess.start);
    if (d < bd) { bd = d; best = c; }
  }
  if (!best) return null;
  const st = best.status || {}, ty = st.type || {};
  const demo = new URLSearchParams(location.search).get('demo') === 'live'; // test hook: replay a past session as live
  return {
    state: demo ? 'in' : ty.state, detail: ty.shortDetail || ty.detail || '', lap: st.period, clock: st.displayClock,
    order: (best.competitors || []).slice().sort((a, b) => a.order - b.order).map(c => ({
      pos: c.order, name: (c.athlete && (c.athlete.displayName || c.athlete.fullName)) || '?',
      stats: c.statistics || [],
    })),
  };
}

// Weather forecast for a race weekend (Open-Meteo, free)
const WMO = c => c == null ? ['', ''] : c === 0 ? ['☀️', 'Sunny'] : c <= 2 ? ['🌤️', 'Partly cloudy'] : c === 3 ? ['☁️', 'Cloudy'] : c <= 48 ? ['🌫️', 'Fog'] :
  c <= 57 ? ['🌦️', 'Drizzle'] : c <= 67 ? ['🌧️', 'Rain'] : c <= 77 ? ['🌨️', 'Snow'] : c <= 82 ? ['🌧️', 'Showers'] : ['⛈️', 'Storms'];
async function forecast(ctx, race) {
  if (race.end < now() || race.start - now() > 14 * D || isNaN(race.lat)) return null;
  const day = t => new Date(t).toISOString().slice(0, 10);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${race.lat}&longitude=${race.long}&daily=weather_code,temperature_2m_max,precipitation_probability_max&timezone=auto&start_date=${day(race.start - D)}&end_date=${day(race.end + D)}`;
  const d = await ctx.opt(url, 3 * H);
  if (!d || !d.daily) return null;
  const want = new Set(race.sessions.map(s => new Date(s.start + (d.utc_offset_seconds || 0) * 1000).toISOString().slice(0, 10)));
  return d.daily.time.map((t, i) => ({ t, code: d.daily.weather_code[i], max: d.daily.temperature_2m_max[i], rain: d.daily.precipitation_probability_max[i] }))
    .filter(x => want.has(x.t));
}
function wxStrip(fc) {
  if (!fc || !fc.length) return '';
  return `<div class="wx">${fc.map(x => {
    const [ic] = WMO(x.code);
    const dd = new Date(x.t + 'T12:00:00');
    return `<div><span>${esc(fmt(dd, { weekday: 'short' }))}</span><i>${ic}</i><b>${Math.round(x.max)}°</b><span>${x.rain == null ? '' : x.rain + '% rain'}</span></div>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------- shared bits of UI
function countdownBlocks(target) {
  return `<div class="cd" data-cd="${target}">${cdInner(target)}</div>`;
}
function cdInner(target) {
  let ms = Math.max(0, target - now());
  const d = Math.floor(ms / D), h = Math.floor(ms % D / H), m = Math.floor(ms % H / MIN), s = Math.floor(ms % MIN / 1000);
  const p = n => String(n).padStart(2, '0');
  return d > 0
    ? `<div><b>${d}</b><span>DAYS</span></div><div><b>${p(h)}</b><span>HRS</span></div><div><b>${p(m)}</b><span>MINS</span></div>`
    : `<div><b>${p(h)}</b><span>HRS</span></div><div><b>${p(m)}</b><span>MINS</span></div><div><b>${p(s)}</b><span>SECS</span></div>`;
}
function sessionRows(race, liveSess, linkBase) {
  const nxt = race.sessions.find(s => s.start > now());
  return race.sessions.map(s => {
    const st = liveSess && liveSess.start === s.start ? 'live' : sessState(s);
    const chip = st === 'live' ? '<span class="chip live">Live</span>'
      : st === 'done' ? '<span class="chip res">Results</span>'
      : nxt && nxt.start === s.start ? '<span class="chip next">Next</span>' : '';
    const href = st === 'live' ? '#/live' : `${linkBase}/${s.short.toLowerCase()}`;
    return `<a class="sess tap ${st === 'done' ? 'done' : ''}" href="${href}">
      <div class="sd"><b>${esc(fDayNum(s.start))}</b><span>${esc(fDay(s.start))}</span></div>
      <div class="sn"><b>${esc(s.name)}</b><span>${s.tbc ? 'Time to be confirmed' : esc(fTime(s.start) + ' – ' + fTime(s.end))}</span></div>${chip}</a>`;
  }).join('');
}
function sec(title, link, linkText) {
  return `<div class="sec"><h2>${esc(title)}</h2>${link ? `<a href="${link}">${esc(linkText || 'See all')}</a>` : ''}</div>`;
}
function flagImg(meeting, cls = 'flag') {
  return meeting && meeting.country_flag ? `<img class="${cls}" src="${esc(meeting.country_flag)}" alt="" loading="lazy">` : '';
}
function resultRow({ pos, code, name, team, meta, colour, right, rightSub, pts, href, extra, dense }) {
  const fav = isFav(code) ? ' fav' : '';
  const tag = href ? 'a' : 'div';
  return `<${tag} class="row${href ? ' tap' : ''}${fav}"${href ? ` href="${href}"` : ''}>
    <div class="pos">${esc(pos)}</div><div class="bar" style="background:${colour}"></div>
    ${dense ? '' : avatar(code, name, colour)}
    <div class="who"><b>${name}${extra || ''}</b><span class="tm">${esc(team || '')}${meta ? ' · ' + meta : ''}</span></div>
    ${right != null ? `<div class="val"><b>${right}</b>${rightSub ? `<span>${rightSub}</span>` : ''}</div>` : ''}
    ${pts != null ? `<div class="pts">${esc(pts)}<small>PTS</small></div>` : ''}
  </${tag}>`;
}
const nameHtml = (first, last) => `<em>${esc(first)}</em> ${esc(String(last).toUpperCase())}`;
// "Andrea Kimi" goes by Kimi: use the last given name so rows stay short
function jName(d) { return nameHtml(String(d.givenName).split(' ').pop(), d.familyName); }

// ---------------------------------------------------------------- live state
async function liveNow(ctx) {
  const sea = await season(ctx);
  const race = featured(sea.races);
  const sess = race.sessions.find(s => now() >= s.start - 2 * MIN && now() <= s.end + 25 * MIN);
  if (!sess) return { sea, race, sess: null };
  const live = now() >= sess.start - 2 * MIN && now() <= sess.end + 25 * MIN;
  const board = await ctx.opt(espnUrl(race), live ? 10 * 1000 : 10 * MIN);
  const comp = espnComp(board, sess);
  // ESPN marks the session finished: stop calling it live (races often end well before the 2-hour slot)
  if (comp && comp.state === 'post' && now() > sess.start + 20 * MIN) return { sea, race, sess: null, finished: sess, comp };
  if (comp && comp.state === 'pre' && now() > sess.end) return { sea, race, sess: null };
  if (!comp && now() > sess.end) return { sea, race, sess: null };
  return { sea, race, sess, comp };
}
function setLiveDot(on) { const d = $('.live-dot'); if (d) d.hidden = !on; }

function liveTower(comp, limit) {
  if (!comp || !comp.order.length) return '<div class="note">Waiting for the running order…</div>';
  const rows = comp.order.slice(0, limit || 99).map(o => {
    const d = espnDriver(o.name);
    const colour = '#' + ((d && d.colour) || '888888');
    const parts = o.name.split(' ');
    const stat = o.stats.find(s => /behind|gap|time/i.test(s.name || s.abbreviation || ''));
    return resultRow({
      pos: o.pos, code: d && d.code, colour, name: nameHtml(parts.slice(0, -1).join(' '), parts[parts.length - 1]),
      team: d ? d.team : '', right: stat ? esc(stat.displayValue) : null,
      href: d ? `#/driver/${encodeURIComponent(d.code)}` : null,
    });
  }).join('');
  return rows;
}

// ---------------------------------------------------------------- views
const views = {};

// HOME --------------------------------------------------------------
views.home = async ctx => {
  const sea = await season(ctx);
  const o1 = await o1Year(ctx, sea.year);
  await loadDrivers(ctx, o1);
  const race = featured(sea.races);
  const meeting = meetingFor(race, o1);
  const lv = await liveNow(ctx);
  setLiveDot(!!lv.sess);
  let html = '';

  // Live card
  if (lv.sess) {
    const c = lv.comp;
    html += `<div class="live-card"><a class="live-head" href="#/live"><b class="live-badge">Live · ${esc(lv.sess.name)}</b><span>${c && c.lap && (lv.sess.key === 'Race' || lv.sess.key === 'Sprint') ? 'Lap ' + c.lap : esc(lv.race.short)}</span></a>
      ${liveTower(c, 5)}<a class="hero-cta" href="#/live">Full running order</a></div>`;
  }

  // Race weekend hero
  const nxt = nextSession(sea.races);
  const weekendOn = now() >= race.start - 3 * D && now() <= race.end + 20 * H;
  const isOver = sea.races.every(r => r.end < now());
  html += `<div class="hero">
    ${meeting && meeting.circuit_image ? `<img class="track-img" src="${esc(meeting.circuit_image)}" alt="" loading="lazy">` : ''}
    <a class="hero-top tap" href="#/race/${race.season}/${race.round}">${flagImg(meeting)}
      <div><div class="eyebrow">${isOver ? 'Season finale' : weekendOn ? 'This weekend' : 'Next race'} · Round ${race.round}</div>
      <h1>${esc(race.short)}</h1><div class="dates">${esc(dateRange(race.start, race.race.start))} · ${esc(race.locality)}</div></div></a>`;
  if (nxt && !lv.sess) {
    html += `<div class="cd-wrap"><div class="cd-label"><b>${esc(nxt.sess.name)}</b>${nxt.race.round !== race.round ? ' · ' + esc(nxt.race.short) : ''} starts ${esc(fWhen(nxt.sess.start))}</div>${countdownBlocks(nxt.sess.start)}</div>`;
  } else if (isOver && !lv.sess) {
    html += `<div class="cd-wrap"><div class="cd-label">The ${sea.year} season is over. The new calendar appears here as soon as it is published.</div></div>`;
  }
  html += wxStrip(await forecast(ctx, race));
  html += `<div class="hero-sessions">${sessionRows(race, lv.sess, `#/race/${race.season}/${race.round}`)}</div></div>`;

  // Favourite drivers
  const [ds, last] = await Promise.all([
    ctx.opt(`${J}/${sea.year}/driverstandings.json`, 20 * MIN),
    lastResult(ctx, sea),
  ]);
  const standings = ds && ds.MRData.StandingsTable.StandingsLists[0];
  if (S.fav.length && standings) {
    const cards = S.fav.map(code => {
      const st = standings.DriverStandings.find(x => x.Driver.code === code);
      if (!st) return '';
      const c = st.Constructors[st.Constructors.length - 1];
      const colour = teamColour(c, DIR, code);
      const lr = last && last.res.find(x => x.Driver.code === code);
      return `<a class="favc tap" style="--c:${colour}" href="#/driver/${code}"><div class="fh">${avatar(code, st.Driver.familyName, colour)}<b>${esc(st.Driver.givenName)}<br>${esc(st.Driver.familyName)}</b></div>
        <div class="fs"><div><b>P${st.position}</b><span>Champ.</span></div><div><b>${st.points}</b><span>Pts</span></div><div><b>${lr ? (isNaN(+lr.positionText) ? lr.positionText : 'P' + lr.position) : '–'}</b><span>Last</span></div></div></a>`;
    }).join('');
    if (cards.trim()) html += sec('My drivers', '#/settings', 'Edit') + `<div class="favs">${cards}</div>`;
  }

  // Last result podium
  if (last && last.res.length >= 3) {
    html += sec(`${last.race.raceName.replace(/ Grand Prix/, ' GP')} result`, `#/race/${sea.year}/${last.race.round}/race`, 'Full result');
    const pod = [last.res[1], last.res[0], last.res[2]].map((r, i) => {
      const p = [2, 1, 3][i];
      const colour = teamColour(r.Constructor, DIR, r.Driver.code);
      return `<a class="pod p${p} tap" style="--c:${colour}" href="#/driver/${r.Driver.code}"><span class="pn">${p}</span>${avatar(r.Driver.code, r.Driver.familyName, colour)}<b>${esc(r.Driver.familyName)}</b><span>${esc(teamName(r.Constructor))}</span><span>${esc(p === 1 ? (r.Time ? r.Time.time : '') : (r.Time ? r.Time.time : r.status))}</span></a>`;
    }).join('');
    html += `<div class="card"><div class="podium">${pod}</div></div>`;
  }

  // Championship top 5
  if (standings) {
    html += sec(`${sea.year} drivers' championship`, '#/standings/drivers', 'Full table');
    html += `<div class="card">${standings.DriverStandings.slice(0, 5).map(st => {
      const c = st.Constructors[st.Constructors.length - 1];
      return resultRow({ pos: st.position, code: st.Driver.code, name: jName(st.Driver), team: teamName(c), colour: teamColour(c, DIR, st.Driver.code), pts: st.points, href: `#/driver/${st.Driver.code}` });
    }).join('')}</div>`;
    const after = standings.round ? `After round ${standings.round}` : '';
    if (after) html += `<div class="note" style="padding-top:0">${after}</div>`;
  }

  // News
  const news = await ctx.opt(`${E}/news?limit=12`, 20 * MIN);
  const arts = news && news.articles ? news.articles.filter(a => a.headline) : [];
  if (arts.length) {
    html += sec('Latest news', '#/news', 'More news');
    html += `<div class="card">${arts.slice(0, 4).map(newsRow).join('')}</div>`;
  }
  return html;
};

async function lastResult(ctx, sea) {
  const w = await ctx.opt(`${J}/${sea.year}/results/1.json?limit=40`, 30 * MIN);
  const races = w ? w.MRData.RaceTable.Races : [];
  if (!races.length) return null;
  const lastRace = races[races.length - 1];
  const sched = sea.races.find(r => r.round === +lastRace.round);
  const done = sched && now() - sched.end > 3 * D;
  const full = await ctx.opt(`${J}/${sea.year}/${lastRace.round}/results.json`, done ? 30 * D : 15 * MIN);
  const r = full && full.MRData.RaceTable.Races[0];
  return r ? { race: r, res: r.Results } : null;
}

// SCHEDULE ----------------------------------------------------------
views.schedule = async (ctx, [yearArg]) => {
  const sea = await season(ctx, yearArg);
  const o1 = await o1Year(ctx, sea.year);
  const winners = await ctx.opt(`${J}/${sea.year}/results/1.json?limit=40`, 30 * MIN);
  const won = {};
  for (const r of winners ? winners.MRData.RaceTable.Races : []) won[r.round] = r.Results[0];
  const nextR = sea.races.find(r => r.end + 3 * H > now());
  let month = '', rows = '';
  for (const r of sea.races) {
    const m = fmt(r.race.start, { month: 'long' });
    if (m !== month) { month = m; rows += `<div class="month">${esc(m)}</div>`; }
    const meeting = meetingFor(r, o1);
    const w = won[r.round];
    const cls = w ? 'done' : nextR && nextR.round === r.round ? 'next' : '';
    const right = w
      ? `<div class="win"><i style="background:${teamColour(w.Constructor, DIR, w.Driver.code)}"></i>${esc(w.Driver.code || w.Driver.familyName)}</div>`
      : cls === 'next' ? '<span class="chip next">Next</span>' : '';
    rows += `<a class="rnd tap ${cls}" href="#/race/${r.season}/${r.round}"><div class="rn"><span>RND</span><b>${r.round}</b></div>${flagImg(meeting)}
      <div class="rx"><b>${esc(r.short)}</b><span>${esc(dateRange(r.start, r.race.start))}${r.sprint ? ' · Sprint' : ''} · ${esc(r.locality)}</span></div>${right}</a>`;
  }
  const y = sea.year;
  return `<h1 class="page-title"><small>Formula One season</small>${y} Schedule</h1>
    <div class="seg"><a href="#/schedule/${y - 1}" data-replace>${y - 1}</a><a class="on" href="#/schedule/${y}" data-replace>${y}</a>${yearArg && +yearArg < new Date(now()).getFullYear() ? `<a href="#/schedule" data-replace>Current</a>` : ''}</div>
    <div class="card">${rows || '<div class="empty"><b>No races yet</b>The calendar has not been published.</div>'}</div>
    <div class="note">All times are shown in your time zone${TZ ? ' (' + esc(TZ.replace(/_/g, ' ')) + ')' : ''}.</div>`;
};

// RACE WEEKEND ------------------------------------------------------
views.race = async (ctx, [year, round, tab]) => {
  const sea = await season(ctx, year);
  const race = sea.races.find(r => r.round === +round);
  if (!race) return '<div class="err">That race could not be found.</div>';
  const o1 = await o1Year(ctx, sea.year);
  const meeting = meetingFor(race, o1);
  const lv = await liveNow(ctx);
  const liveHere = lv.sess && lv.race.round === race.round && lv.sea.year === race.season ? lv.sess : null;

  const doneSessions = race.sessions.filter(s => sessState(s) === 'done' && !(liveHere && liveHere.start === s.start));
  if (!tab) tab = doneSessions.length ? doneSessions[doneSessions.length - 1].short.toLowerCase() : 'info';
  const base = `#/race/${race.season}/${race.round}`;
  const tabs = [['info', 'Info'], ...race.sessions.map(s => [s.short.toLowerCase(), s.short === 'Quali' ? 'Qualifying' : s.short])];
  const segHtml = tabs.map(([k, label]) => {
    const s = race.sessions.find(x => x.short.toLowerCase() === k);
    const isLive = s && liveHere && liveHere.start === s.start;
    return `<a href="${base}/${k}" data-replace class="${k === tab ? 'on' : ''}${isLive ? ' live-tab' : ''}">${esc(label)}${isLive ? ' · Live' : ''}</a>`;
  }).join('');

  let html = `<div class="race-head">
    <a class="back" href="#/schedule${race.season !== new Date(now()).getFullYear() ? '/' + race.season : ''}" data-back>${backIcon}Schedule</a>
    ${flagImg(meeting)}
    <div class="eyebrow">Round ${race.round} · ${race.season}</div>
    <h1>${esc(race.name)}</h1>
    <div class="sub">${esc(race.circuit)} · ${esc(dateRange(race.start, race.race.start))}</div>
    <div class="seg">${segHtml}</div></div>`;

  if (tab === 'info') {
    html += await raceInfo(ctx, race, meeting, liveHere);
  } else {
    const sess = race.sessions.find(s => s.short.toLowerCase() === tab);
    if (!sess) html += '<div class="err">No such session.</div>';
    else html += await sessionTab(ctx, race, sess, o1, liveHere);
  }
  return html;
};

async function raceInfo(ctx, race, meeting, liveHere) {
  let html = sec('Weekend schedule');
  html += `<div class="card">${sessionRows(race, liveHere, `#/race/${race.season}/${race.round}`)}</div>`;
  const nxt = race.sessions.find(s => s.start > now());
  if (nxt && nxt.start - now() < 30 * D) html += `<div class="hero" style="margin-top:0"><div class="cd-wrap" style="padding-top:1rem"><div class="cd-label"><b>${esc(nxt.name)}</b> starts ${esc(fWhen(nxt.start))}</div>${countdownBlocks(nxt.start)}</div></div>`;
  const fc = await forecast(ctx, race);
  if (fc && fc.length) html += sec('Weather at the track') + `<div class="card" style="padding-top:.8rem">${wxStrip(fc)}</div>`;
  html += `<div class="note" style="padding-top:0">Times in your time zone${TZ ? ' (' + esc(TZ.replace(/_/g, ' ')) + ')' : ''}.</div>`;

  // circuit
  html += sec('Circuit');
  const map = meeting ? await ctx.opt(`https://api.multiviewer.app/api/v1/circuits/${meeting.circuit_key}/${race.season}`, 30 * D) : null;
  const svg = trackSvg(map);
  const prev = await ctx.opt(`${J}/${race.season - 1}/circuits/${race.circuitId}/results/1.json`, 30 * D);
  const pr = prev && prev.MRData.RaceTable.Races[0];
  const facts = [
    ['Circuit', race.circuit], ['Location', `${race.locality}, ${race.country}`],
    meeting && meeting.circuit_type ? ['Type', meeting.circuit_type.replace(' - ', ' / ')] : null,
    map && map.corners ? ['Corners', map.corners.length] : null,
    pr ? ['Race laps', pr.Results[0].laps] : null,
    pr ? [`${race.season - 1} winner`, `${pr.Results[0].Driver.givenName} ${pr.Results[0].Driver.familyName}`] : null,
  ].filter(Boolean);
  html += `<div class="card">${svg ? `<div class="track">${svg}</div>` : ''}<div class="facts">${facts.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div></div>`;
  return html;
}

function trackSvg(m) {
  if (!m || !m.x || !m.x.length) return '';
  const rot = (m.rotation || 0) * Math.PI / 180, cs = Math.cos(rot), sn = Math.sin(rot);
  const pts = m.x.map((x, i) => [x * cs - m.y[i] * sn, -(x * sn + m.y[i] * cs)]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const w = maxX - minX, h = maxY - minY, pad = Math.max(w, h) * 0.06;
  const sw = Math.max(w, h) * 0.022;
  const d = 'M' + pts.map(([x, y]) => `${(x - minX + pad).toFixed(0)} ${(y - minY + pad).toFixed(0)}`).join('L') + 'Z';
  const [sx, sy] = pts[0];
  return `<svg viewBox="0 0 ${(w + 2 * pad).toFixed(0)} ${(h + 2 * pad).toFixed(0)}" role="img" aria-label="Circuit map">
    <path d="${d}" fill="none" stroke="#3A3A4A" stroke-width="${(sw * 2.2).toFixed(0)}" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="#fff" stroke-width="${sw.toFixed(0)}" stroke-linejoin="round"/>
    <circle cx="${(sx - minX + pad).toFixed(0)}" cy="${(sy - minY + pad).toFixed(0)}" r="${(sw * 1.6).toFixed(0)}" fill="#E10600" stroke="#fff" stroke-width="${(sw * .4).toFixed(0)}"/></svg>`;
}

async function sessionTab(ctx, race, sess, o1, liveHere) {
  if (liveHere && liveHere.start === sess.start) {
    return `<div class="card corner" style="margin-top:1rem"><div class="empty"><b>${esc(sess.name)} is live now</b>Follow the running order on the Live screen.<br><br><a class="btn red" href="#/live">Open Live</a></div></div>`;
  }
  if (sessState(sess) === 'upcoming') {
    return `<div class="hero"><div class="cd-wrap" style="padding-top:1rem"><div class="cd-label"><b>${esc(sess.name)}</b> starts ${esc(sess.tbc ? fDayLong(sess.start) + ' (time to be confirmed)' : fWhen(sess.start))}</div>${countdownBlocks(sess.start)}</div></div>
      <div class="note">Results appear here once the session finishes.</div>`;
  }
  const o1s = o1SessionFor(sess, o1);
  const recentOk = now() - sess.end > 25 * MIN;
  let html = '';
  if (sess.key === 'Race' || sess.key === 'Sprint') html += await raceResult(ctx, race, sess, o1s);
  else if (sess.key === 'Qualifying') html += await qualiResult(ctx, race, sess, o1s);
  else if (sess.short === 'SQ') html += await o1QualiResult(ctx, sess, o1s) || await espnFallback(ctx, sess, race);
  else html += await practiceResult(ctx, sess, o1s, race);
  if (!html) html = `<div class="card" style="margin-top:1rem"><div class="empty"><b>Results on their way</b>${recentOk ? 'Official times usually appear within an hour of the session ending.' : 'The session has only just finished.'}</div></div>`;
  return html;
}

// Race or sprint: official result (Jolpica) -> OpenF1 classification -> ESPN order
async function raceResult(ctx, race, sess, o1s) {
  const sprint = sess.key === 'Sprint';
  const old = now() - sess.end > 3 * D;
  const d = await ctx.opt(`${J}/${race.season}/${race.round}/${sprint ? 'sprint' : 'results'}.json`, old ? 30 * D : 10 * MIN);
  const rr = d && d.MRData.RaceTable.Races[0];
  const res = rr && (sprint ? rr.SprintResults : rr.Results);
  let html = '';
  if (res && res.length) {
    html += sec(sprint ? 'Sprint result' : 'Race result');
    html += `<div class="card dense">${res.map(r => {
      const colour = teamColour(r.Constructor, DIR, r.Driver.code);
      const g = +r.grid, p = +r.position;
      const gain = g > 0 && !isNaN(+r.positionText) ? g - p : null;
      const right = r.Time ? (p === 1 ? `<span class="win-time">${esc(r.Time.time)}</span>` : esc(r.Time.time)) : /lap/i.test(r.status) ? esc(r.status) : r.status === 'Finished' ? '' : `<span class="out">${esc(/retired/i.test(r.status) ? 'DNF' : r.status)}</span>`;
      const sub = g === 0 ? 'pit lane start' : gain ? `<span class="gain ${gain > 0 ? 'up' : 'down'}">${gain > 0 ? '▲' : '▼'}${Math.abs(gain)}</span>` : '';
      const fl = r.FastestLap && r.FastestLap.rank === '1' ? '<span class="fl" title="Fastest lap">FL</span>' : '';
      return resultRow({ pos: posLabel(r.positionText, r.position), code: r.Driver.code, name: jName(r.Driver), team: teamName(r.Constructor), colour, right, meta: sub, pts: r.points, extra: fl, dense: true, href: `#/driver/${r.Driver.code}` });
    }).join('')}</div>`;
  } else if (o1s && o1open(sess)) {
    html += await o1Classification(ctx, sess, o1s, sprint ? 'Sprint result' : 'Race result');
  }
  if (!html) html = await espnFallback(ctx, sess, race);
  if (o1s && o1open(sess)) html += await raceExtras(ctx, sess, o1s, res);
  return html;
}

async function o1Drivers(ctx, sess, o1s) {
  const list = await ctx.opt(`${O}/drivers?session_key=${o1s.session_key}`, 60 * D);
  if (list && list.length) mergeDir(list);
  const byNum = {};
  for (const d of list || []) byNum[d.driver_number] = d;
  return byNum;
}

async function o1Classification(ctx, sess, o1s, title) {
  const res = await ctx.opt(`${O}/session_result?session_key=${o1s.session_key}`, o1ttl(sess));
  if (!res || !res.length) return '';
  const drv = await o1Drivers(ctx, sess, o1s);
  res.sort((a, b) => (a.position || 99) - (b.position || 99));
  return sec(title) + `<div class="note" style="padding-top:0">Provisional classification. The official result follows shortly.</div><div class="card dense">${res.map(r => {
    const d = drv[r.driver_number] || {};
    const colour = '#' + (d.team_colour || '888888');
    const right = r.dnf ? '<span class="out">DNF</span>' : r.dns ? '<span class="out">DNS</span>' : r.dsq ? '<span class="out">DSQ</span>'
      : r.position === 1 ? raceTime(r.duration) : typeof r.gap_to_leader === 'number' ? '+' + r.gap_to_leader.toFixed(3) : esc(r.gap_to_leader || '');
    return resultRow({ pos: r.position || '–', code: d.name_acronym, name: nameHtml(d.first_name || '', d.last_name || '#' + r.driver_number), team: d.team_name, colour, right, pts: r.points != null ? r.points : null, dense: true, href: d.name_acronym ? `#/driver/${d.name_acronym}` : null });
  }).join('')}</div>`;
}

async function espnFallback(ctx, sess, race) {
  if (!race || now() - sess.end > 7 * D) return '';
  const board = await ctx.opt(espnUrl(race), 5 * MIN);
  const comp = espnComp(board, sess);
  if (!comp || !comp.order.length || comp.state === 'pre') return '';
  return sec('Provisional order') + `<div class="note" style="padding-top:0">Finishing order as reported live. Times and points appear once the official result is published.</div><div class="card">${liveTower(comp)}</div>`;
}

async function raceExtras(ctx, sess, o1s, res) {
  const ttl = o1ttl(sess);
  const [stints, rc, wx] = await Promise.all([
    ctx.opt(`${O}/stints?session_key=${o1s.session_key}`, ttl),
    ctx.opt(`${O}/race_control?session_key=${o1s.session_key}`, ttl),
    ctx.opt(`${O}/weather?session_key=${o1s.session_key}`, ttl),
  ]);
  const drv = await o1Drivers(ctx, sess, o1s);
  let html = '';
  // tyre strategy
  if (stints && stints.length) {
    const by = {};
    for (const s of stints) (by[s.driver_number] = by[s.driver_number] || []).push(s);
    const totalLaps = Math.max(...stints.map(s => s.lap_end || 0));
    const order = res && res.length
      ? res.map(r => Object.values(drv).find(d => d.name_acronym === r.Driver.code)).filter(Boolean).map(d => d.driver_number)
      : Object.keys(by).map(Number);
    const rows = order.filter(n => by[n]).map(n => {
      const d = drv[n] || {};
      const ss = by[n].sort((a, b) => a.stint_number - b.stint_number);
      return `<div class="strat-row"><span class="code">${esc(d.name_acronym || n)}</span><div class="lane">${ss.map(s => {
        const laps = (s.lap_end || totalLaps) - (s.lap_start || 1) + 1;
        const comp = (s.compound || 'UNKNOWN').toUpperCase();
        return `<div class="stint t-${esc(comp)}" style="flex:${Math.max(laps, 0.5)}" title="${esc(comp)} ${laps} laps">${laps >= 6 ? laps : ''}</div>`;
      }).join('')}</div></div>`;
    }).join('');
    html += sec('Tyre strategy') + `<div class="card"><div class="strat">${rows}</div>
      <div class="legend"><span><i class="t-SOFT"></i>Soft</span><span><i class="t-MEDIUM"></i>Medium</span><span><i class="t-HARD"></i>Hard</span><span><i class="t-INTERMEDIATE"></i>Inter</span><span><i class="t-WET"></i>Wet</span><span>Numbers = laps</span></div></div>`;
  }
  // weather during the session
  if (wx && wx.length) {
    const air = wx.map(w => w.air_temperature), trk = wx.map(w => w.track_temperature);
    const rain = wx.some(w => w.rainfall > 0);
    html += sec('Conditions') + `<div class="card"><div class="stats"><div><b>${Math.round(Math.max(...air))}°</b><span>Air</span></div><div><b>${Math.round(Math.max(...trk))}°</b><span>Track</span></div><div><b>${rain ? 'Yes' : 'No'}</b><span>Rain</span></div></div></div>`;
  }
  // race control: the messages that matter
  if (rc && rc.length) {
    const key = rc.filter(m => m.category === 'SafetyCar' || ['RED', 'CHEQUERED'].includes(m.flag) || /PENALTY|DISQUALIF|RETIRED|INCIDENT|NOTED|VSC|SAFETY CAR|DRS ENABLED/.test(m.message || ''))
      .filter(m => !/BLUE FLAG/.test(m.message));
    if (key.length) {
      const colourOf = m => m.flag === 'RED' ? '#E10600' : m.category === 'SafetyCar' ? '#FFD12E' : m.flag === 'CHEQUERED' ? '#15151E' : /PENALTY/.test(m.message) ? '#FF8700' : '#9C9FA2';
      html += `<details class="card" style="margin-top:1.4rem"><summary>Race control (${key.length})</summary>${key.map(m =>
        `<div class="msg"><span class="flagc" style="background:${colourOf(m)}"></span><span class="lap">${m.lap_number ? 'Lap ' + m.lap_number : esc(fTime(m.date))}</span><span>${esc(m.message)}</span></div>`).join('')}</details>`;
    }
  }
  return html;
}

async function qualiResult(ctx, race, sess, o1s) {
  const old = now() - sess.end > 3 * D;
  const d = await ctx.opt(`${J}/${race.season}/${race.round}/qualifying.json`, old ? 30 * D : 10 * MIN);
  const rr = d && d.MRData.RaceTable.Races[0];
  const res = rr && rr.QualifyingResults;
  if (res && res.length) {
    const pole = res[0].Q3 || res[0].Q2 || res[0].Q1;
    return sec('Qualifying') + `<div class="card dense"><div class="tbl-head"><span style="width:1.9rem">Pos</span><span class="who">Driver</span><span>Best time</span></div>${res.map(r => {
      const best = r.Q3 || r.Q2 || r.Q1 || '';
      const knocked = r.Q3 ? '' : r.Q2 ? 'Out in Q2' : r.Q1 ? 'Out in Q1' : 'No time';
      const gap = r.position !== '1' && best && pole ? '+' + (toSec(best) - toSec(pole)).toFixed(3) : '';
      return resultRow({ pos: r.position, code: r.Driver.code, name: jName(r.Driver), team: teamName(r.Constructor), colour: teamColour(r.Constructor, DIR, r.Driver.code), right: esc(best || '—'), rightSub: gap, meta: knocked, dense: true, href: `#/driver/${r.Driver.code}` });
    }).join('')}</div>`;
  }
  return await o1QualiResult(ctx, sess, o1s) || await espnFallback(ctx, sess, race);
}
function posLabel(txt, pos) {
  if (!isNaN(+txt)) return pos || txt;
  return { R: 'NC', N: 'NC', D: 'DQ', E: 'EX', W: 'DNS', F: 'DNQ' }[txt] || txt;
}
function toSec(t) { const p = String(t).split(':'); return p.length > 1 ? +p[0] * 60 + +p[1] : +p[0]; }

async function o1QualiResult(ctx, sess, o1s) {
  if (!o1s || !o1open(sess)) return '';
  const res = await ctx.opt(`${O}/session_result?session_key=${o1s.session_key}`, o1ttl(sess));
  if (!res || !res.length) return '';
  const drv = await o1Drivers(ctx, sess, o1s);
  res.sort((a, b) => (a.position || 99) - (b.position || 99));
  const bestOf = r => Array.isArray(r.duration) ? [...r.duration].reverse().find(x => x) : r.duration;
  const pole = bestOf(res[0]);
  return sec(sess.name) + `<div class="card dense">${res.map(r => {
    const d = drv[r.driver_number] || {};
    const best = bestOf(r);
    const stage = Array.isArray(r.duration) ? (r.duration[2] ? '' : r.duration[1] ? `Out in ${sess.short === 'SQ' ? 'SQ2' : 'Q2'}` : `Out in ${sess.short === 'SQ' ? 'SQ1' : 'Q1'}`) : '';
    const gap = r.position > 1 && best && pole ? '+' + (best - pole).toFixed(3) : '';
    return resultRow({ pos: r.position || '–', code: d.name_acronym, name: nameHtml(d.first_name || '', d.last_name || '#' + r.driver_number), team: d.team_name, colour: '#' + (d.team_colour || '888888'), right: best ? lapTime(best) : '—', rightSub: gap, meta: stage, dense: true, href: d.name_acronym ? `#/driver/${d.name_acronym}` : null });
  }).join('')}</div>`;
}

// Practice: OpenF1 has no classification, so work out each driver's best lap from all laps (saved once worked out).
async function practiceResult(ctx, sess, o1s, race) {
  if (!o1s || !o1open(sess)) return await espnFallback(ctx, sess, race);
  const key = calcKey('practice-' + o1s.session_key);
  const saved = await readCache(key);
  let summary = saved && saved.data.length && (now() - sess.end > 8 * H || Date.now() - saved.t < 4 * MIN) ? saved.data : null;
  const lapsUrl = `${O}/laps?session_key=${o1s.session_key}`;
  const laps = summary ? null : await ctx.opt(lapsUrl, 0);
  if (!summary && !laps && saved) summary = saved.data;
  if (!summary && !laps) return await espnFallback(ctx, sess, race);
  if (!summary) {
    const best = {};
    for (const l of laps) {
      const b = best[l.driver_number] = best[l.driver_number] || { n: l.driver_number, laps: 0, best: null };
      b.laps = Math.max(b.laps, l.lap_number || 0);
      if (l.lap_duration && !l.is_pit_out_lap && (b.best == null || l.lap_duration < b.best)) b.best = l.lap_duration;
    }
    summary = Object.values(best).sort((a, b) => (a.best || 1e9) - (b.best || 1e9));
    if (summary.length) await writeCache(key, summary);
    // the raw lap list is large; only the summary is kept
    mem.delete(lapsUrl);
    const c = await cacheStore(); if (c) c.delete(lapsUrl).catch(() => {});
    ctx.stale.delete(lapsUrl);
  }
  if (!summary.length) return await espnFallback(ctx, sess, race);
  const drv = await o1Drivers(ctx, sess, o1s);
  const top = summary[0].best;
  return sec(sess.name) + `<div class="card dense"><div class="tbl-head"><span style="width:1.9rem">Pos</span><span class="who">Driver</span><span>Fastest lap</span></div>${summary.map((s, i) => {
    const d = drv[s.n] || {};
    return resultRow({ pos: i + 1, code: d.name_acronym, name: nameHtml(d.first_name || '', d.last_name || '#' + s.n), team: d.team_name, colour: '#' + (d.team_colour || '888888'), right: s.best ? lapTime(s.best) : '—', rightSub: i && s.best ? '+' + (s.best - top).toFixed(3) : '', meta: plural(s.laps, 'lap'), dense: true, href: d.name_acronym ? `#/driver/${d.name_acronym}` : null });
  }).join('')}</div>`;
}

// LIVE ---------------------------------------------------------------
views.live = async ctx => {
  const lv = await liveNow(ctx);
  setLiveDot(!!lv.sess);
  const o1 = await o1Year(ctx, lv.sea.year);
  if (lv.sess) {
    const c = lv.comp;
    const racey = lv.sess.key === 'Race' || lv.sess.key === 'Sprint';
    const status = !c ? 'Starting soon' : c.state === 'pre' ? 'Starting soon' : racey && c.lap ? `Lap ${c.lap}` : c.detail || 'Running';
    const saved = await ctx.savedAt(espnUrl(lv.race));
    return `<div class="live-card" style="margin-top:1rem"><div class="live-head"><b class="live-badge">${esc(lv.race.short)} · ${esc(lv.sess.name)}</b><span>${esc(status)}</span></div>
      ${liveTower(c)}
      <div class="live-foot"><span>Updates every 10 seconds</span><span>${saved ? 'Updated ' + esc(ago(saved)) : ''}</span></div></div>
      <div class="note">Live running order from ESPN. Lap times, gaps, tyres and pit stops appear on the ${esc(lv.race.short)} page about 30 minutes after the session ends.</div>`;
  }
  // nothing on track
  const nxt = nextSession(lv.sea.races);
  let html = `<h1 class="page-title"><small>Live timing</small>Nothing on track</h1>`;
  if (lv.finished) {
    html += `<div class="card corner"><div class="empty"><b>${esc(lv.race.short)} ${esc(lv.finished.name)} has finished</b><br><a class="btn red" href="#/race/${lv.race.season}/${lv.race.round}/${lv.finished.short.toLowerCase()}">See the result</a></div></div>`;
  }
  if (nxt) {
    const m2 = meetingFor(nxt.race, o1);
    html += `<div class="hero"><a class="hero-top tap" href="#/race/${nxt.race.season}/${nxt.race.round}">${flagImg(m2)}<div><div class="eyebrow">Next session</div><h1>${esc(nxt.race.short)}</h1><div class="dates">${esc(nxt.sess.name)} · ${esc(fWhen(nxt.sess.start))}</div></div></a>
      <div class="cd-wrap">${countdownBlocks(nxt.sess.start)}</div></div>
      <div class="note">This screen comes alive by itself when a session starts: the running order and lap count update every 10 seconds.</div>`;
  } else {
    html += `<div class="note">No more sessions are scheduled this season.</div>`;
  }
  return html;
};

// STANDINGS ---------------------------------------------------------
views.standings = async (ctx, [kind]) => {
  kind = kind === 'teams' ? 'teams' : 'drivers';
  let sea = await season(ctx);
  let year = sea.year;
  let ds = await ctx.opt(`${J}/${year}/${kind === 'teams' ? 'constructorstandings' : 'driverstandings'}.json`, 20 * MIN);
  let list = ds && ds.MRData.StandingsTable.StandingsLists[0];
  if (!list) { // new season with no races yet: show last season
    year -= 1;
    ds = await ctx.opt(`${J}/${year}/${kind === 'teams' ? 'constructorstandings' : 'driverstandings'}.json`, 7 * D);
    list = ds && ds.MRData.StandingsTable.StandingsLists[0];
  }
  let html = `<h1 class="page-title"><small>${year} season${list ? ' · after round ' + list.round : ''}</small>Standings</h1>
    <div class="seg"><a href="#/standings/drivers" data-replace class="${kind === 'drivers' ? 'on' : ''}">Drivers</a><a href="#/standings/teams" data-replace class="${kind === 'teams' ? 'on' : ''}">Teams</a></div>`;
  if (!list) return html + '<div class="card"><div class="empty"><b>No standings yet</b>They appear after the first race.</div></div>';
  if (kind === 'drivers') {
    html += `<div class="card">${list.DriverStandings.map(st => {
      const c = st.Constructors[st.Constructors.length - 1];
      return resultRow({ pos: st.position || st.positionText, code: st.Driver.code, name: jName(st.Driver), team: teamName(c), meta: st.wins !== '0' ? plural(+st.wins, 'win') : '', colour: teamColour(c, DIR, st.Driver.code), pts: st.points, href: `#/driver/${st.Driver.code}` });
    }).join('')}</div>`;
  } else {
    // who drives for whom, from the drivers' table (each driver's latest team)
    const dsd = await ctx.opt(`${J}/${year}/driverstandings.json`, 20 * MIN);
    const lineup = {};
    for (const s of dsd ? dsd.MRData.StandingsTable.StandingsLists[0].DriverStandings : []) {
      const cid = s.Constructors[s.Constructors.length - 1].constructorId;
      (lineup[cid] = lineup[cid] || []).push(s.Driver.familyName);
    }
    html += `<div class="card">${list.ConstructorStandings.map(st => {
      const c = st.Constructor;
      const colour = '#' + (TEAMS[c.constructorId] || [, '888888'])[1];
      const drivers = lineup[c.constructorId] || [];
      return `<a class="row tap" href="#/team/${esc(c.constructorId)}"><div class="pos">${esc(st.position || st.positionText)}</div><div class="bar" style="background:${colour}"></div>
        <div class="who"><b>${esc(teamName(c))}</b><span class="tm">${esc(drivers.join(' · ') || c.nationality)}${st.wins !== '0' ? ' · ' + plural(+st.wins, 'win') : ''}</span></div><div class="pts">${esc(st.points)}<small>PTS</small></div></a>`;
    }).join('')}</div>`;
  }
  return html;
};

// DRIVER --------------------------------------------------------------
views.driver = async (ctx, [code]) => {
  code = decodeURIComponent(code || '');
  const sea = await season(ctx);
  let year = sea.year;
  let ds = await ctx.opt(`${J}/${year}/driverstandings.json`, 20 * MIN);
  let list = ds && ds.MRData.StandingsTable.StandingsLists[0];
  if (!list) { year -= 1; ds = await ctx.opt(`${J}/${year}/driverstandings.json`, 7 * D); list = ds && ds.MRData.StandingsTable.StandingsLists[0]; }
  const st = list && list.DriverStandings.find(x => x.Driver.code === code);
  const dd = DIR.byCode[code];
  if (!st && !dd) return `<div class="err">No details for ${esc(code)} yet.</div>`;
  const drv = st ? st.Driver : { givenName: dd.first, familyName: dd.last, nationality: '' };
  const con = st ? st.Constructors[st.Constructors.length - 1] : null;
  const colour = con ? teamColour(con, DIR, code) : '#' + ((dd && dd.colour) || '555555');
  const num = (dd && dd.num) || (st && st.Driver.permanentNumber) || '';
  const fav = isFav(code);
  let html = `<div class="dhead" style="--c:${colour}">
    <a class="back" href="#/standings/drivers" data-back>${backIcon}Back</a>
    <div class="num">${esc(num)}</div>
    ${dd && dd.photo ? `<img class="photo" src="${esc(dd.photo.replace('/2col/', '/4col/'))}" alt="">` : ''}
    <h1>${esc(drv.givenName)}<b>${esc(String(drv.familyName).toUpperCase())}</b></h1>
    <div class="sub">${esc(con ? teamName(con) : dd.team)}${drv.nationality ? ' · ' + esc(drv.nationality) : ''}</div>
    <button class="star${fav ? ' on' : ''}" data-fav="${esc(code)}">${fav ? '★ My driver' : '☆ Add to my drivers'}</button></div>`;
  if (st && st.Driver.driverId) {
    const id = st.Driver.driverId;
    const [rr, sr] = await Promise.all([
      ctx.opt(`${J}/${year}/drivers/${id}/results.json?limit=40`, 30 * MIN),
      ctx.opt(`${J}/${year}/drivers/${id}/sprint.json?limit=40`, 30 * MIN),
    ]);
    const races = rr ? rr.MRData.RaceTable.Races : [];
    const sprints = {};
    for (const s of sr ? sr.MRData.RaceTable.Races : []) sprints[s.round] = s.SprintResults[0];
    const wins = races.filter(r => r.Results[0].position === '1').length;
    const pods = races.filter(r => +r.Results[0].position <= 3).length;
    html += `<div class="card" style="margin-top:1rem"><div class="stats"><div><b>P${esc(st.position || st.positionText)}</b><span>Championship</span></div><div><b>${esc(st.points)}</b><span>Points</span></div><div><b>${wins}</b><span>${wins === 1 ? 'Win' : 'Wins'}</span></div></div>
      <div class="stats" style="border-top:1px solid var(--line)"><div><b>${pods}</b><span>Podiums</span></div><div><b>${races.length ? Math.min(...races.map(r => +r.Results[0].position || 99)) : '–'}</b><span>Best finish</span></div><div><b>${races.filter(r => !/finished|lap/i.test(r.Results[0].status)).length}</b><span>Retirements</span></div></div></div>`;
    if (races.length) {
      html += sec(`${year} races`);
      html += `<div class="card">${races.slice().reverse().map(r => {
        const x = r.Results[0];
        const s = sprints[r.round];
        const posTxt = isNaN(+x.positionText) ? posLabel(x.positionText) : 'P' + x.position;
        const pts = +x.points + (s ? +s.points : 0);
        return `<a class="row tap" href="#/race/${year}/${r.round}/race"><div class="pos" style="font-size:.95rem;color:var(--muted)">R${r.round}</div>
          <div class="who"><b>${esc(r.raceName.replace(/ Grand Prix/, ''))}</b><span class="tm">${x.grid === '0' ? 'Pit lane start' : 'Started P' + esc(x.grid)}${s ? ` · Sprint P${esc(s.positionText)}` : ''}${/finished|lap/i.test(x.status) ? '' : ' · ' + esc(x.status)}</span></div>
          <div class="val"><b>${esc(posTxt)}</b></div><div class="pts">${pts}<small>PTS</small></div></a>`;
      }).join('')}</div>`;
    }
  }
  return html;
};

// TEAM ----------------------------------------------------------------
views.team = async (ctx, [id]) => {
  const sea = await season(ctx);
  let year = sea.year;
  let d = await ctx.opt(`${J}/${year}/constructors/${id}/results.json?limit=100`, 30 * MIN);
  let races = d ? d.MRData.RaceTable.Races : [];
  if (!races.length) { year -= 1; d = await ctx.opt(`${J}/${year}/constructors/${id}/results.json?limit=100`, 7 * D); races = d ? d.MRData.RaceTable.Races : []; }
  const cs = await ctx.opt(`${J}/${year}/constructorstandings.json`, 20 * MIN);
  const st = cs && cs.MRData.StandingsTable.StandingsLists[0] && cs.MRData.StandingsTable.StandingsLists[0].ConstructorStandings.find(x => x.Constructor.constructorId === id);
  const c = st ? st.Constructor : races[0] && races[0].Results[0].Constructor;
  if (!c) return '<div class="err">No details for this team yet.</div>';
  const colour = '#' + (TEAMS[id] || [, '555555'])[1];
  const drivers = {};
  for (const r of races) for (const x of r.Results) drivers[x.Driver.code] = x.Driver;
  let html = `<div class="dhead" style="--c:${colour};min-height:9rem"><a class="back" href="#/standings/teams" data-back>${backIcon}Back</a>
    <h1>${esc(c.nationality || '')}<b>${esc(teamName(c).toUpperCase())}</b></h1><div class="sub" style="margin-bottom:1rem">${year} season</div></div>`;
  if (st) html += `<div class="card" style="margin-top:1rem"><div class="stats"><div><b>P${esc(st.position || st.positionText)}</b><span>Championship</span></div><div><b>${esc(st.points)}</b><span>Points</span></div><div><b>${esc(st.wins)}</b><span>Wins</span></div></div></div>`;
  html += sec('Drivers') + `<div class="card">${Object.values(drivers).map(dr => resultRow({ pos: '', code: dr.code, name: jName(dr), team: dr.nationality, colour, href: `#/driver/${dr.code}` })).join('')}</div>`;
  if (races.length) {
    html += sec(`${year} races`) + `<div class="card">${races.slice().reverse().map(r => {
      const pts = r.Results.reduce((a, x) => a + +x.points, 0);
      return `<a class="row tap" href="#/race/${year}/${r.round}/race"><div class="pos" style="font-size:.95rem;color:var(--muted)">R${r.round}</div><div class="who"><b>${esc(r.raceName.replace(/ Grand Prix/, ''))}</b><span class="tm">${r.Results.map(x => `${esc(x.Driver.code)} ${isNaN(+x.positionText) ? esc(x.positionText) : 'P' + x.position}`).join(' · ')}</span></div><div class="pts">${pts}<small>PTS</small></div></a>`;
    }).join('')}</div>`;
  }
  return html;
};

// NEWS ----------------------------------------------------------------
function newsRow(a) {
  const img = a.images && a.images[0] && a.images[0].url;
  const href = a.links && a.links.web && a.links.web.href;
  return `<a class="news-row tap" href="${esc(href || '#')}" target="_blank" rel="noopener">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}<div><b>${esc(a.headline)}</b><span>${a.published ? esc(ago(new Date(a.published).getTime())) : ''}</span></div></a>`;
}
views.news = async ctx => {
  const news = await ctx.get(`${E}/news?limit=40`, 20 * MIN);
  const arts = (news.articles || []).filter(a => a.headline && a.links && a.links.web);
  if (!arts.length) return '<h1 class="page-title">News</h1><div class="card"><div class="empty">No news right now.</div></div>';
  const [first, ...rest] = arts;
  const img = first.images && first.images[0] && first.images[0].url;
  return `<h1 class="page-title"><small>From ESPN</small>Latest news</h1>
    <a class="news-big tap" href="${esc(first.links.web.href)}" target="_blank" rel="noopener">${img ? `<img src="${esc(img)}" alt="">` : ''}<div><b>${esc(first.headline)}</b>${first.description ? `<p>${esc(first.description)}</p>` : ''}<span>${first.published ? esc(ago(new Date(first.published).getTime())) : ''}</span></div></a>
    <div class="card">${rest.map(newsRow).join('')}</div>
    <div class="note">Stories open in the browser. Use the back button to return.</div>`;
};

// SETTINGS --------------------------------------------------------------
views.settings = async ctx => {
  const sea = await season(ctx).catch(() => null);
  let drivers = [];
  if (sea) {
    const ds = await ctx.opt(`${J}/${sea.year}/driverstandings.json`, 20 * MIN) || await ctx.opt(`${J}/${sea.year - 1}/driverstandings.json`, 7 * D);
    const list = ds && ds.MRData.StandingsTable.StandingsLists[0];
    drivers = list ? list.DriverStandings.map(s => ({ code: s.Driver.code, name: `${s.Driver.givenName} ${s.Driver.familyName}`, team: teamName(s.Constructors[s.Constructors.length - 1]), c: s.Constructors[s.Constructors.length - 1] })) : [];
  }
  const ch = (k, v, label) => `<button data-set="${k}" data-val="${v}" class="${S[k] === v ? 'on' : ''}">${label}</button>`;
  return `<h1 class="page-title"><small>Pit Wall</small>Settings</h1>
  <div class="card">
    <div class="opt"><b>Text size</b><div class="choice">${ch('text', 'm', 'Standard')}${ch('text', 'l', 'Large')}${ch('text', 'xl', 'Extra large')}</div></div>
    <div class="opt"><b>Appearance</b><div class="choice">${ch('theme', 'auto', 'Match phone')}${ch('theme', 'light', 'Light')}${ch('theme', 'dark', 'Dark')}</div></div>
    <div class="opt"><b>Time zone</b><p>Times are shown in the phone's time zone${TZ ? ': <b>' + esc(TZ.replace(/_/g, ' ')) + '</b>' : ''}.</p></div>
  </div>
  ${sec('My drivers')}
  <div class="note" style="padding-top:0">Tap a star to follow a driver. They're highlighted in every list and shown on Home.</div>
  <div class="card">${drivers.map(d => `<button class="row tap" style="width:100%;text-align:left" data-fav="${esc(d.code)}"><div class="bar" style="background:${teamColour(d.c, DIR, d.code)}"></div>${avatar(d.code, d.name, teamColour(d.c, DIR, d.code))}<div class="who"><b>${esc(d.name)}</b><span class="tm">${esc(d.team)}</span></div><span style="font-size:1.6rem;color:${isFav(d.code) ? '#F5A623' : 'var(--line)'}">★</span></button>`).join('') || '<div class="note">Drivers appear here once the data has loaded.</div>'}</div>
  ${sec('Saved data')}
  <div class="card"><div class="opt"><p>Pit Wall keeps a copy of everything it loads, so it opens instantly and works with a weak signal.</p><br><button class="btn" id="clear-data">Reload all data</button></div></div>
  ${sec('About')}
  <div class="src">Pit Wall ${VERSION}. An unofficial fan app, not associated with Formula 1 or the FIA. It runs entirely on this phone using free public data from
  <a href="https://github.com/jolpica/jolpica-f1" target="_blank" rel="noopener">Jolpica</a> (calendar, results, standings),
  <a href="https://openf1.org" target="_blank" rel="noopener">OpenF1</a> (timing, tyres, photos),
  <a href="https://www.espn.com/f1/" target="_blank" rel="noopener">ESPN</a> (live order, news),
  <a href="https://multiviewer.app" target="_blank" rel="noopener">MultiViewer</a> (circuit maps) and
  <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (weather).</div>`;
};

// ---------------------------------------------------------------- router + painting
const view = $('#view');
let routeToken = 0, currentRoute = '', fingerDown = false, pendingPaint = null, lastHtml = '';
const stack = [];        // in-app screens visited, so "Back" links and the phone's Back button agree
const scrollPos = {};    // where each screen was scrolled to, restored when going back
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, ...args] = h.split('/');
  return { name: views[name] ? name : 'home', args, key: h };
}
function markTab(name) {
  const tab = { race: 'schedule', driver: 'standings', team: 'standings', settings: '' }[name] ?? name;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
}
function paint(html, scrollTo) {
  if (html === lastHtml) return;
  if (fingerDown) { pendingPaint = [html, scrollTo]; return; }
  const y = window.scrollY;
  view.innerHTML = html;
  lastHtml = html;
  window.scrollTo(0, scrollTo == null ? y : scrollTo);
  const on = view.querySelector('.seg .on');
  if (on) on.parentNode.scrollLeft = on.offsetLeft - (on.parentNode.clientWidth - on.offsetWidth) / 2;
}
async function render(opts = {}) {
  const r = parseRoute();
  const token = ++routeToken;
  const isNew = r.key !== currentRoute;
  let restore = null;
  if (isNew) {
    if (stack.length > 1 && stack[stack.length - 2] === r.key) { stack.pop(); restore = scrollPos[r.key] || 0; }
    else if (opts.replace && stack.length) stack[stack.length - 1] = r.key;
    else stack.push(r.key);
  }
  currentRoute = r.key;
  markTab(r.name);
  if (isNew) lastHtml = '';
  const ctx = makeCtx(opts.force);
  let html;
  try { html = await views[r.name](ctx, r.args); }
  catch (e) {
    console.error(e);
    html = `<div class="err"><b>Couldn't load this screen.</b><br>${navigator.onLine ? 'The data service did not answer. Tap the ↻ button at the top to try again.' : 'The phone is offline. Check Wi-Fi or mobile data.'}</div>`;
  }
  if (token !== routeToken) return;
  paint(html, isNew ? (restore != null ? restore : opts.replace ? null : 0) : null);
  updateStatus();
  // second pass: refresh anything that was out of date, redraw only if it changed
  if (ctx.stale.size) {
    await Promise.allSettled([...ctx.stale].map(u => net(u)));
    if (token !== routeToken) return;
    const ctx2 = makeCtx(false);
    try { html = await views[r.name](ctx2, r.args); } catch (e) { return; }
    if (token !== routeToken) return;
    paint(html, null);
    updateStatus();
  }
}
addEventListener('scroll', () => { scrollPos[currentRoute] = window.scrollY; }, { passive: true });
function updateStatus() {
  const el = $('#status');
  const offline = !navigator.onLine || (lastNetError && lastNetError > lastNetOk);
  el.hidden = !offline;
  if (offline) el.textContent = 'No connection — showing saved information';
}

// countdown ticker and live refresh
setInterval(() => {
  document.querySelectorAll('[data-cd]').forEach(el => {
    const t = +el.dataset.cd;
    el.innerHTML = cdInner(t);
    if (t <= now() && t > now() - 1500) setTimeout(() => render({ silent: true }), 1500);
  });
}, 1000);
setInterval(() => {
  if (document.hidden) return;
  const name = parseRoute().name;
  const dot = $('.live-dot');
  const liveOn = dot && !dot.hidden;
  if (name === 'live' || (liveOn && (name === 'home' || name === 'race'))) render({ silent: true });
}, 10 * 1000);
// Refresh the screen every 10 minutes in any case, and as soon as the app comes back to the front.
setInterval(() => { if (!document.hidden) render({ silent: true }); }, 10 * MIN);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render({ silent: true }); });
addEventListener('online', () => render({ silent: true }));
addEventListener('offline', updateStatus);

addEventListener('touchstart', () => { fingerDown = true; }, { passive: true });
addEventListener('touchend', () => {
  fingerDown = false;
  if (pendingPaint) { const p = pendingPaint; pendingPaint = null; setTimeout(() => paint(p[0], p[1]), 250); }
}, { passive: true });
addEventListener('touchcancel', () => { fingerDown = false; }, { passive: true });

// a driver photo that fails to load becomes their initials on the team colour
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.dataset.ini != null) {
    const div = document.createElement('div');
    div.className = 'ini';
    div.style.background = img.dataset.c;
    div.textContent = img.dataset.ini;
    img.replaceWith(div);
  } else if (img.tagName === 'IMG') img.style.visibility = 'hidden';
}, true);

addEventListener('hashchange', () => render());
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#/"]');
  if (a && a.hasAttribute('data-replace')) {
    e.preventDefault();
    history.replaceState(null, '', a.getAttribute('href'));
    render({ replace: true });
    return;
  }
  if (a && a.hasAttribute('data-back') && stack.length > 1) {
    e.preventDefault();
    history.back();
    return;
  }
  if (a && a.getAttribute('href') === location.hash) { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    const c = fav.dataset.fav;
    S.fav = isFav(c) ? S.fav.filter(x => x !== c) : [...S.fav, c];
    saveSettings();
    render({ silent: true });
    return;
  }
  const set = e.target.closest('[data-set]');
  if (set) { S[set.dataset.set] = set.dataset.val; saveSettings(); render({ silent: true }); return; }
  if (e.target.closest('#clear-data')) {
    (async () => { mem.clear(); try { await caches.delete('pw-data-1'); } catch (_) {} store = null; location.hash = '#/home'; render({ force: true }); })();
  }
});
$('#refresh').addEventListener('click', async () => {
  const b = $('#refresh');
  b.classList.add('spin');
  try { await render({ force: true, silent: true }); } finally { setTimeout(() => b.classList.remove('spin'), 400); }
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
render();
})();
