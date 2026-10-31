/**
 * F1 Scoreboard Card — live Formula 1 sessions, results and championship standings
 * https://github.com/AOPW-llc/f1-scoreboard-card
 *
 * Data: ESPN's public scoreboard, standings and session feeds (CORS-open, no key).
 * One Grand Prix weekend per screen, with a tab per session (practice,
 * qualifying, sprint, race); the arrows (or a swipe) move through the season.
 * Times are shown in the browser's time zone.
 */

const VERSION = '1.0.0';
const CARD_TAG = 'f1-scoreboard-card';

const SITE = 'https://site.api.espn.com/apis';
const CORE = 'https://sports.core.api.espn.com/v2/sports/racing';
const IDLE_REFRESH_S = 300;        // no session on
const SEASON_REFRESH_S = 1800;     // the whole-season scoreboard is large: reload it every half hour
const STANDINGS_REFRESH_S = 1800;
const LIVE_STATS_MIN_S = 60;       // times and gaps are one request per driver: at most once a minute
const SETTLED_H = 3;               // a session's results are kept for good this long after it started
const FETCH_TIMEOUT_MS = 15000;
const STATS_CONCURRENCY = 11;
const RECENT_GP_H = 36;            // a Grand Prix finished this recently is still the one to show
const DRIVER_REFRESH_S = 600;

// ESPN session types. kind: how results are shown
const SESSIONS = {
  FP1: { label: 'Practice 1', tab: 'FP1', kind: 'practice' },
  FP2: { label: 'Practice 2', tab: 'FP2', kind: 'practice' },
  FP3: { label: 'Practice 3', tab: 'FP3', kind: 'practice' },
  SS: { label: 'Sprint Qualifying', tab: 'Sprint Quali', kind: 'qual', q: ['SQ1', 'SQ2', 'SQ3'] },
  SR: { label: 'Sprint', tab: 'Sprint', kind: 'race', grid: 'SS' },
  Qual: { label: 'Qualifying', tab: 'Quali', kind: 'qual', q: ['Q1', 'Q2', 'Q3'] },
  Race: { label: 'Race', tab: 'Race', kind: 'race', grid: 'Qual' },
};
// Title sponsors, left off the short Grand Prix names ("MSC Cruises United States GP" → "United States GP")
const SPONSOR = /^(?:Qatar Airways|Heineken|Aramco|Gulf Air|STC|Crypto\.com|Lenovo|MSC Cruises|Pirelli|Mo[eë]t & Chandon|AWS|Tag Heuer|Singapore Airlines|Etihad Airways|Louis Vuitton|Rolex|Formula 1|DHL|Emirates|Santander)\s+/i;
// Standings columns that aren't a round
const META_STATS = new Set(['rank', 'championshipPts', 'points', 'overall']);

/* ── helpers ── */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDay = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
const fmtDate = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
/** The US Eastern calendar date of an instant, which is how ESPN buckets the scoreboard. */
const etDate = d => { const x = new Date(d.getTime() - 5 * 3600e3); return new Date(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()); };
const https = url => String(url ?? '').replace(/^http:/, 'https:');
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** "Mexico city" → "Mexico City" */
const cap = s => String(s ?? '').replace(/(^|[\s-])(\p{Ll})/gu, (m, a, c) => a + c.toUpperCase());
const gpShort = s => { let x = String(s ?? ''); while (SPONSOR.test(x)) x = x.replace(SPONSOR, ''); return x.replace(/\s+Grand Prix\b/i, ' GP'); };
/** "1:37.976" → 97976 (ms); null when blank. */
const lapMs = s => { const p = String(s ?? '').split(':').map(Number); return p.some(isNaN) || !s ? null : p.reduce((a, v) => a * 60 + v, 0) * 1000; };
/** Black or white text, whichever reads better on a team color. */
const textOn = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 160 ? '#111' : '#fff';
};
/** 179 → "+0.179"; 63250 → "+1:03.250" */
const fmtGap = ms => (ms == null || ms < 0 ? null : `+${ms >= 60000 ? `${Math.floor(ms / 60000)}:${pad(((ms % 60000) / 1000).toFixed(3)).padStart(6, '0')}` : (ms / 1000).toFixed(3)}`);
const color = hex => (/^[0-9a-f]{6}$/i.test(hex ?? '') ? `#${hex}` : '');

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Run `fn` over `items`, a few at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/* ── data model ── */

/** One session (practice, qualifying, sprint, race) from a scoreboard competition, with the field in order. */
function parseSession(c) {
  const type = c.status?.type ?? {};
  const abbr = c.type?.abbreviation ?? '';
  return {
    id: c.id,
    abbr,
    ...(SESSIONS[abbr] ?? { label: abbr, tab: abbr, kind: 'practice' }),
    date: new Date(c.date),
    state: type.state ?? 'pre',           // pre | in | post
    statusName: type.name ?? '',
    detail: type.shortDetail ?? '',
    lap: Number(c.status?.period) || 0,
    tv: (c.broadcasts ?? []).flatMap(b => b.names ?? []).join(', '),
    drivers: (c.competitors ?? []).map(x => ({
      id: x.id,
      name: x.athlete?.displayName ?? '',
      short: x.athlete?.shortName ?? x.athlete?.displayName ?? '',
      flag: x.athlete?.flag?.href ?? '',
      pos: Number(x.order) || null,
      winner: x.winner === true,
    })).sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99)),
  };
}

/** A Grand Prix weekend from a scoreboard event. */
function parseWeekend(ev) {
  const sessions = (ev.competitions ?? []).map(parseSession).sort((a, b) => a.date - b.date);
  const a = ev.circuit?.address ?? {};
  return {
    id: ev.id,
    name: ev.name ?? '',
    short: gpShort(ev.shortName || ev.name),
    circuit: ev.circuit?.fullName ?? '',
    where: [cap(a.city), a.country].filter(Boolean).join(', '),
    start: new Date(sessions[0]?.date ?? ev.date),
    end: new Date(sessions[sessions.length - 1]?.date ?? ev.endDate ?? ev.date),
    canceled: /cancel/i.test(ev.status?.type?.name ?? ''),
    sessions,
  };
}

/** The season from a whole-year scoreboard: weekends in date order, numbered by round (cancelled ones aren't). */
function parseSeason(events) {
  const weekends = (events ?? []).map(parseWeekend).filter(w => !isNaN(w.start)).sort((a, b) => a.start - b.start);
  let n = 0;
  weekends.forEach((w, i) => { w.idx = i; w.round = w.canceled ? null : ++n; });
  weekends.forEach(w => { w.total = n; });
  return weekends;
}

/** driverId → { number, team, color } from the core competitors list. */
function parseEntries(data) {
  const map = {};
  for (const c of data?.items ?? []) {
    map[c.id] = { number: c.vehicle?.number ?? '', team: c.vehicle?.manufacturer ?? '', color: color(c.vehicle?.teamColor) };
  }
  return map;
}

/** One driver's session numbers from the core statistics feed. */
function parseStats(data) {
  const general = data?.splits?.categories?.find(c => c.name === 'general')?.stats ?? [];
  const raw = k => general.find(s => s.name === k)?.displayValue;
  const str = k => { const v = String(raw(k) ?? '').trim(); return v && !/^0(\.0+)?$/.test(v) ? v : null; };
  const n = k => { const v = Number(raw(k)); return raw(k) == null || isNaN(v) ? null : v; };
  return {
    place: n('place'),
    laps: n('lapsCompleted'),
    time: str('totalTime'),               // practice / qualifying: best lap; race: race time
    behind: str('behindTime'),
    behindLaps: n('behindLaps') || 0,
    pts: n('championshipPts'),
    pits: n('pitsTaken'),
    grid: n('pole') || null,              // race / sprint: starting position
    fastest: str('fastestLap'),
    fastestLap: n('fastestLapNum'),
    q: ['qual1TimeMS', 'qual2TimeMS', 'qual3TimeMS'].map(str),
  };
}

/** DNF / DSQ / DNS from a driver's race status; null when classified. */
function parseStatus(data) {
  const t = data?.type ?? {};
  const name = String(t.name ?? '');
  if (!name || /CLASSIFIED|FINAL|SCHEDULED|IN_PROGRESS|RUNNING/.test(name)) return null;
  if (/DISQ|DSQ/.test(name)) return 'DSQ';
  if (/DNS|NOT_START/.test(name)) return 'DNS';
  if (/RETIRED|DNF|ACCIDENT|MECHANICAL/.test(name)) return 'DNF';
  return t.shortDetail || t.description || null;
}

/** A driver's bio from the core athlete feed. */
function parseBio(a) {
  const dob = a?.dateOfBirth ? new Date(a.dateOfBirth) : null;
  let age = null;
  if (dob && !isNaN(dob)) {
    const now = new Date();
    age = now.getFullYear() - dob.getFullYear() - (now < new Date(now.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0);
  }
  return {
    name: a?.displayName ?? '',
    headshot: a?.headshot?.href ?? '',
    age,
    country: a?.flag?.alt ?? '',
    flag: a?.flag?.href ?? '',
    hometown: cap(a?.birthPlace?.city ?? ''),
  };
}

/** A standings row's points per round, in calendar order ('' for rounds not run yet or cancelled). */
const roundPoints = stats => (stats ?? []).filter(s => !META_STATS.has(s.name)).map(s => String(s.displayValue ?? '').trim());

/** Drivers' and constructors' championships from the site standings feed. */
function parseStandings(data) {
  const out = { drivers: [], teams: [] };
  for (const ch of data?.children ?? []) {
    const entries = ch.standings?.entries ?? [];
    const stat = (e, n) => e.stats?.find(s => s.name === n)?.displayValue;
    if (/constructor|team/i.test(ch.name ?? '')) {
      out.teams = entries.map((e, i) => ({
        id: e.team?.id, name: e.team?.displayName ?? e.team?.name ?? '', color: color(e.team?.color),
        rank: Number(stat(e, 'rank')) || i + 1, pts: Number(stat(e, 'points') ?? stat(e, 'championshipPts')) || 0, rounds: roundPoints(e.stats),
      })).sort((a, b) => a.rank - b.rank);
    } else {
      out.drivers = entries.map((e, i) => ({
        id: e.athlete?.id, name: e.athlete?.displayName ?? '', short: e.athlete?.shortName ?? '', abbr: e.athlete?.abbreviation ?? '',
        flag: e.athlete?.flag?.href ?? '',
        rank: Number(stat(e, 'rank')) || i + 1, pts: Number(stat(e, 'championshipPts')) || 0, rounds: roundPoints(e.stats),
      })).sort((a, b) => a.rank - b.rank);
    }
  }
  return out;
}

/**
 * Season totals from a driver's Grand Prix results:
 * starts, wins, podiums, points finishes, P1 starts, fastest laps, DNFs, average grid / finish, best finish.
 */
function seasonTotals(results) {
  const ran = results.filter(r => r.finish);
  const classified = ran.filter(r => !r.status);
  const avg = (list, k) => { const v = list.map(r => r[k]).filter(Boolean); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '–'; };
  return {
    starts: ran.length,
    wins: classified.filter(r => r.finish === 1).length,
    podiums: classified.filter(r => r.finish <= 3).length,
    top10: classified.filter(r => r.finish <= 10).length,
    p1: ran.filter(r => r.grid === 1).length,
    fastest: ran.filter(r => r.fastestOverall).length,
    dnf: ran.filter(r => r.status).length,
    avgGrid: avg(ran, 'grid'),
    avgFinish: avg(classified, 'finish'),
    best: classified.length ? Math.min(...classified.map(r => r.finish)) : null,
  };
}

/* ═════════════════════════════ Card ═════════════════════════════ */

const STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; }
  .muted { color: var(--secondary-text-color); }

  /* card header */
  .top { display: flex; align-items: center; gap: 8px; padding: 12px 16px 4px; }
  .range { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; }
  .clock { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .nav { background: none; border: none; color: var(--secondary-text-color); cursor: pointer; padding: 2px 10px;
    font-size: 26px; line-height: 1; border-radius: 8px; font-family: inherit; }
  .nav:disabled { opacity: .3; cursor: default; }
  .nav:hover:not(:disabled), .today:hover { background: var(--secondary-background-color); }
  .today { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 14px; cursor: pointer;
    border: 1px solid var(--primary-color); background: none; color: var(--primary-color); white-space: nowrap; }
  .refresh { background: none; border: none; color: var(--secondary-text-color); cursor: pointer; font-size: 17px; padding: 2px 6px; }
  .wkt { display: flex; flex-direction: column; justify-content: center; min-width: 0; margin-left: 4px; line-height: 1.2; }
  .wkn { font-size: 17px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wk { font-size: 12px; font-weight: 500; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* body: weekend on the left, championship on the right; stacked when narrow */
  .body { container-type: inline-size; padding: 8px 16px 16px; touch-action: pan-y; }
  .grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: 24px; align-items: start; }
  .sec { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  @container (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); } }

  .rhead { display: flex; flex-direction: column; gap: 3px; padding-bottom: 12px; border-bottom: 1px solid var(--divider-color); }
  .rname { font-size: 20px; font-weight: 700; line-height: 1.2; }
  .rsub { font-size: 13px; color: var(--secondary-text-color); }
  .pill { align-self: flex-start; margin-top: 6px; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 12px;
    background: var(--secondary-background-color); }
  .pill.live { color: #fff; background: var(--error-color, #db4437); }

  /* session tabs */
  .sess { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
  .sess::-webkit-scrollbar { display: none; }
  .sess button { all: unset; box-sizing: border-box; cursor: pointer; flex: none; display: flex; flex-direction: column; gap: 1px;
    padding: 6px 12px; border-radius: 10px; background: var(--secondary-background-color); border: 1px solid transparent; }
  .sess button .a { font-size: 13px; font-weight: 700; white-space: nowrap; }
  .sess button .b { font-size: 11px; color: var(--secondary-text-color); white-space: nowrap; }
  .sess button.on { border-color: var(--primary-color); background: none; }
  .sess button.on .a { color: var(--primary-color); }
  .sess button.live .a::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px;
    background: var(--error-color, #db4437); vertical-align: 1px; }
  .sess button.pre .a { font-weight: 500; }
  .sess button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
  .shead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
  .shead .t { font-size: 15px; font-weight: 700; }
  .shead .pill { margin-top: 0; align-self: center; }

  .win { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 12px; background: var(--secondary-background-color);
    border-left: 4px solid var(--tc, transparent); }
  .win .flagc { font-size: 26px; line-height: 1; }
  .win .who { font-size: 17px; font-weight: 700; }
  .win .sub { font-size: 12px; color: var(--secondary-text-color); }
  .fav { font-size: 13px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--primary-color); }
  .fav b { font-weight: 700; }
  .empty { text-align: center; padding: 18px 4px; }

  h4 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--secondary-text-color); }
  .fold { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 8px; margin: 0 0 6px; cursor: pointer;
    font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--secondary-text-color); }
  .fold .hint { font-weight: 400; letter-spacing: 0; text-transform: none; opacity: .75; }
  .fold.closed { margin: 0; }
  .fold.closed::after { content: ''; flex: 1; border-top: 1px solid var(--divider-color); }
  .fold:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; border-radius: 4px; }

  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { padding: 0 4px 4px; font-size: 10px; font-weight: 500; color: var(--secondary-text-color); text-align: right; white-space: nowrap; }
  td { padding: 5px 4px; font-size: 13px; border-top: 1px solid var(--divider-color); text-align: right; white-space: nowrap; }
  th.l, td.l { text-align: left; }
  td.pos { width: 26px; font-weight: 700; }
  td.mv { width: 30px; font-size: 11px; color: var(--secondary-text-color); }
  td.mv.up { color: var(--success-color, #43a047); }
  td.mv.down { color: var(--error-color, #db4437); }
  td.car { width: 34px; text-align: center; }
  .num { display: inline-block; min-width: 24px; padding: 2px 3px; border-radius: 5px; font-size: 12px; font-weight: 800; text-align: center;
    color: var(--tx, #fff); background: var(--tc, var(--secondary-text-color)); box-shadow: inset 0 0 0 1px rgba(0,0,0,.18); }
  .bar { display: inline-block; width: 4px; height: 14px; border-radius: 2px; margin-right: 7px; vertical-align: -2px;
    background: var(--tc, var(--divider-color)); box-shadow: inset 0 0 0 1px rgba(0,0,0,.15); }
  td.drv { white-space: normal; max-width: 0; width: 100%; }
  td.drv .n { font-weight: 600; }
  td.drv .t { display: block; font-size: 11px; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.drv img { width: 14px; height: 10px; object-fit: cover; margin-left: 5px; vertical-align: 0; border-radius: 1px; }
  td.drv .ds { display: block; font-size: 11px; color: var(--secondary-text-color); white-space: normal; }
  td.pts { font-weight: 700; }
  td.best { font-weight: 700; }
  td.out { color: var(--secondary-text-color); font-weight: 600; }
  .fl { display: inline-block; margin-left: 5px; padding: 0 4px; border-radius: 4px; font-size: 10px; font-weight: 800; color: #fff; background: #9b30d9; vertical-align: 1px; }
  tr[data-driver] { cursor: pointer; }
  tr[data-driver]:hover td { background: var(--secondary-background-color); }
  tr.me td { background: var(--secondary-background-color); }
  tr.me td.drv .n { color: var(--primary-color); }
  /* qualifying knockout lines */
  tr.ko td { border-top: 2px solid var(--divider-color); }

  /* driver page */
  .back { font: inherit; font-size: 15px; background: none; border: none; color: var(--primary-color); cursor: pointer; padding: 6px 8px; border-radius: 8px; }
  .back:hover { background: var(--secondary-background-color); }
  .dv { display: flex; flex-direction: column; gap: 18px; }
  .dv-head { display: flex; align-items: center; gap: 14px; padding-bottom: 12px; border-bottom: 4px solid var(--tc, var(--divider-color)); }
  .dv-head img.hs { width: 76px; height: 76px; object-fit: cover; object-position: top; border-radius: 50%; background: var(--secondary-background-color); flex: none; }
  .dv-name { font-size: 22px; font-weight: 700; line-height: 1.2; }
  .dv-sub { font-size: 13px; color: var(--secondary-text-color); margin-top: 2px; }
  .dv-sub .num { margin-right: 6px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; }
  .tile { padding: 10px 8px; border-radius: 12px; background: var(--secondary-background-color); text-align: center; }
  .tile .v { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .tile .k { font-size: 11px; color: var(--secondary-text-color); margin-top: 3px; }
  .tile.hi .v { color: var(--primary-color); }
  .note { font-size: 11px; color: var(--secondary-text-color); }
  tr[data-gp] { cursor: pointer; }
  tr[data-gp]:hover td { background: var(--secondary-background-color); }
  td.fin { font-weight: 700; }
  td.fin.w { color: var(--primary-color); }
  .tabs { display: inline-flex; gap: 2px; padding: 2px; margin-bottom: 8px; border-radius: 10px; background: var(--secondary-background-color); }
  .tabs button { all: unset; cursor: pointer; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 8px; color: var(--secondary-text-color); }
  .tabs button.on { background: var(--card-background-color, var(--ha-card-background, #fff)); color: var(--primary-text-color); box-shadow: 0 1px 2px rgba(0,0,0,.15); }
  .tabs button:focus-visible { outline: 2px solid var(--primary-color); }
  .err { color: var(--error-color, #db4437); font-size: 13px; text-align: center; padding: 0 16px 8px; }
  .foot { font-size: 11px; color: var(--secondary-text-color); padding: 0 16px 12px; }
  @container (max-width: 420px) {
    .body { padding: 8px 12px 12px; }
    td.drv .t { display: none; }
    .hide-narrow { display: none; }
  }
`;

const VIEW_KEY = 'f1-scoreboard-card:view';
const FOLD_KEY = 'f1-scoreboard-card:folded';
const TAB_KEY = 'f1-scoreboard-card:standings';

class F1ScoreboardCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._season = [];                    // the season's Grand Prix weekends
    this._seasonAt = 0;
    this._idx = -1;                       // weekend on screen
    this._home = -1;                      // the weekend "Current GP" goes back to
    this._picked = {};                    // weekendId → session tab chosen by hand
    this._details = new Map();            // sessionId → { entries, stats, status, at, done }
    this._standings = null;               // { drivers, teams }
    this._standingsAt = 0;
    this._teamEntries = {};               // driverId → { number, team, color } from the latest session
    this._drivers = new Map();            // driverId → { bio, results, at } or { error }
    try { this._tab = localStorage.getItem(TAB_KEY) === 'teams' ? 'teams' : 'drivers'; } catch { this._tab = 'drivers'; }
    this._driverView = null;              // driver page open, if any
    this._todayKey = dayKey(new Date());
    this._error = null;
    this._loading = true;
    try { this._folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY)) || []); } catch { this._folded = new Set(); }
    try {
      const v = JSON.parse(sessionStorage.getItem(VIEW_KEY));
      if (v?.day === this._todayKey && v.id) {
        this._restore = v;
        this._driverView = v.driver ?? null;
        if (v.session) this._picked[v.id] = v.session;
      }
    } catch { /* start at the current Grand Prix */ }
  }

  setConfig(config) {
    this._config = { refresh_interval: 30, show_standings: true, ...config };
    this._config.driver = String(this._config.driver ?? '').trim().toLowerCase();
    this._render();
  }

  set hass(hass) { this._hass = hass; }

  connectedCallback() {
    this._tickClock();
    this._refresh();
  }

  disconnectedCallback() {
    clearTimeout(this._clockTimer);
    clearTimeout(this._timer);
  }

  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full', rows: 'auto', min_columns: 6 }; }

  static getConfigForm() {
    return {
      schema: [
        { name: 'driver', selector: { text: {} } },
        { name: 'show_standings', selector: { boolean: {} } },
        { name: 'refresh_interval', selector: { number: { min: 10, max: 300, step: 5, mode: 'box', unit_of_measurement: 's' } } },
      ],
      computeLabel: s => ({ driver: 'Favorite driver', show_standings: 'Show championship standings', refresh_interval: 'Refresh during a session' }[s.name]),
      computeHelper: s => ({ driver: 'Name, three-letter code or car number, e.g. Lewis Hamilton, HAM or 44. Highlighted in results and standings' }[s.name]),
    };
  }

  static getStubConfig() { return {}; }

  _tickClock() {
    clearTimeout(this._clockTimer);
    const now = new Date();
    const el = this.shadowRoot.getElementById('clock');
    if (el) el.textContent = fmtTime(now);
    this._todayKey = dayKey(now);
    this._clockTimer = setTimeout(() => this._tickClock(), 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }

  /* ── data ── */

  /** The weekend to open on: one that's on or just finished, else the next one, else the last. */
  _pickHome() {
    const now = Date.now();
    const s = this._season;
    const on = s.findIndex(w => !w.canceled && w.start - 3600e3 <= now && now - w.end < RECENT_GP_H * 3600e3);
    if (on >= 0) return on;
    const next = s.findIndex(w => !w.canceled && w.start > now);
    return next >= 0 ? next : s.length - 1;
  }

  /** The session shown for a weekend: the one picked by hand, else the live one, else the latest with results, else the first. */
  _sessionOf(w) {
    const ss = w?.sessions ?? [];
    return ss.find(s => s.id === this._picked[w.id]) ?? ss.find(s => s.state === 'in')
      ?? [...ss].reverse().find(s => s.state === 'post' && s.drivers.length) ?? ss[0] ?? null;
  }

  /** The qualifying session that sets a race's grid (Qualifying for the race, Sprint Qualifying for the sprint). */
  _gridSession(w, s) {
    return s?.grid ? w.sessions.find(x => x.abbr === s.grid) ?? null : null;
  }

  _isLive(w) {
    const now = Date.now();
    return !!w?.sessions.some(s => s.state === 'in' || (s.state === 'pre' && s.date - now < 15 * 60000 && now - s.date < 4 * 3600e3));
  }

  async _refresh() {
    clearTimeout(this._timer);
    if (!this._config) return;
    try {
      if (!this._season.length || Date.now() - this._seasonAt > SEASON_REFRESH_S * 1000) await this._loadSeason();
      else await this._loadWeekend(this._season[this._idx]);
      const w = this._season[this._idx];
      const s = this._sessionOf(w);
      const standingsDue = this._config.show_standings && Date.now() - this._standingsAt > STANDINGS_REFRESH_S * 1000;
      await Promise.all([
        s ? this._loadDetails(w, s.state === 'pre' && s.kind === 'race' ? this._gridSession(w, s) ?? s : s) : null,
        standingsDue ? getJSON(`${SITE}/v2/sports/racing/f1/standings`).then(d => {
          this._standings = parseStandings(d); this._standingsAt = Date.now();
        }).catch(() => {}) : null,
        standingsDue || !Object.keys(this._teamEntries).length ? this._loadTeams().catch(() => {}) : null,
      ]);
      if (this._driverView && !this._drivers.has(this._driverView)) this._loadDriver(this._driverView); // restored page
      this._error = null;
      this._updated = new Date();
    } catch (e) {
      this._error = `Couldn't load Formula 1 data (${e.message}). Retrying…`;
    }
    this._loading = false;
    this._render();
    this._scheduleNext();
  }

  /** Every weekend this season, with every session and its order, in one request. */
  async _loadSeason() {
    let year = new Date().getFullYear();
    let j = await getJSON(`${SITE}/site/v2/sports/racing/f1/scoreboard?dates=${year}`);
    if (!(j.events ?? []).length) j = await getJSON(`${SITE}/site/v2/sports/racing/f1/scoreboard?dates=${--year}`); // before this year's calendar is out
    const season = parseSeason(j.events);
    if (!season.length) throw new Error('no races found');
    const was = this._season[this._idx]?.id ?? this._restore?.id;
    this._season = season;
    this._seasonAt = Date.now();
    this._home = this._pickHome();
    const keep = was ? season.findIndex(w => w.id === was) : -1;
    this._idx = keep >= 0 ? keep : this._home;
    this._restore = null;
  }

  /** Between season reloads: the weekend on screen from that day's (much smaller) scoreboard, while it's on. */
  async _loadWeekend(w) {
    const now = Date.now();
    if (!w || w.canceled || now < w.start - 3600e3 || now > w.end.getTime() + 6 * 3600e3) return;
    const j = await getJSON(`${SITE}/site/v2/sports/racing/f1/scoreboard?dates=${ymd(etDate(new Date(Math.min(now, w.end))))}`);
    const ev = (j.events ?? []).find(e => e.id === w.id);
    if (ev) Object.assign(w, { ...parseWeekend(ev), idx: w.idx, round: w.round, total: w.total });
  }

  /** Cars, times and gaps for one session: one request for the entry list, then one per driver (two in a race, for DNFs). */
  async _loadDetails(w, s) {
    if (!s || s.state === 'pre' || !s.drivers.length) return;
    const have = this._details.get(s.id);
    if (have?.done) return;
    if (have && Date.now() - have.at < Math.max(LIVE_STATS_MIN_S, Number(this._config.refresh_interval) || 30) * 1000) return;
    const base = `${CORE}/leagues/f1/events/${w.id}/competitions/${s.id}/competitors`;
    const entries = have?.entries && Object.keys(have.entries).length ? have.entries
      : parseEntries(await getJSON(`${base}?limit=50`).catch(() => null));
    const ids = s.drivers.map(d => d.id);
    const [stats, status] = await Promise.all([
      pool(ids, STATS_CONCURRENCY, id => getJSON(`${base}/${id}/statistics`).then(parseStats).catch(() => null)),
      s.kind === 'race' ? pool(ids, STATS_CONCURRENCY, id => getJSON(`${base}/${id}/status`).then(parseStatus).catch(() => undefined)) : [],
    ]);
    this._details.set(s.id, {
      entries,
      stats: Object.fromEntries(ids.map((id, i) => [id, stats[i]])),
      status: Object.fromEntries(ids.map((id, i) => [id, status[i] ?? null])),
      at: Date.now(),
      // Results can still change (penalties) for a while after the flag
      done: s.state === 'post' && Date.now() - s.date > SETTLED_H * 3600e3 && stats.every(Boolean) && (s.kind !== 'race' || status.every(x => x !== undefined)),
    });
  }

  /** Each driver's number, team and color, from the latest session with results. */
  async _loadTeams() {
    for (const w of [...this._season].reverse()) {
      const s = [...w.sessions].reverse().find(x => x.state === 'post' && x.drivers.length);
      if (!s) continue;
      const entries = parseEntries(await getJSON(`${CORE}/leagues/f1/events/${w.id}/competitions/${s.id}/competitors?limit=50`));
      this._teamEntries = { ...this._teamEntries, ...entries };
      return;
    }
  }

  async _openDriver(id) {
    this._driverView = id;
    this._render();
    this.shadowRoot.querySelector('ha-card')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    await this._loadDriver(id);
  }

  /** A driver's bio and this season's Grand Prix results (two requests per race they ran). */
  async _loadDriver(id) {
    const have = this._drivers.get(id);
    if (have && !have.error && Date.now() - have.at < DRIVER_REFRESH_S * 1000) return;
    try {
      const year = (this._season[this._idx]?.start ?? new Date()).getFullYear();
      const lg = `${CORE}/leagues/f1`;
      const [athlete, log] = await Promise.all([
        getJSON(`${CORE}/athletes/${encodeURIComponent(id)}`).catch(() => null),
        getJSON(`${lg}/seasons/${year}/athletes/${encodeURIComponent(id)}/eventlog?limit=100`),
      ]);
      const weekends = new Map(this._season.map(w => [w.id, w]));
      const played = (log.events?.items ?? []).filter(x => x.played && weekends.has(String(x.eventId)));
      const results = await pool(played, STATS_CONCURRENCY, async x => {
        const w = weekends.get(String(x.eventId));
        const base = `${lg}/events/${x.eventId}/competitions/${x.competitionId}/competitors/${encodeURIComponent(id)}`;
        const [st, status] = await Promise.all([
          getJSON(`${base}/statistics`).then(parseStats).catch(() => null),
          getJSON(`${base}/status`).then(parseStatus).catch(() => null),
        ]);
        return { id: w.id, idx: w.idx, short: w.short, date: w.end, grid: st?.grid ?? null, finish: st?.place ?? null, pts: st?.pts ?? null,
          status, fastestOverall: !!st?.fastest };
      });
      this._drivers.set(id, { bio: parseBio(athlete), results: results.filter(r => r.finish).sort((a, b) => b.date - a.date), at: Date.now() });
    } catch (e) {
      this._drivers.set(id, { error: `Couldn't load this driver (${e.message}).`, at: Date.now() });
    }
    if (this._driverView === id) this._render();
  }

  _scheduleNext() {
    const s = this._error ? 30 : this._isLive(this._season[this._idx]) ? Math.max(10, Number(this._config.refresh_interval) || 30) : IDLE_REFRESH_S;
    this._timer = setTimeout(() => this._refresh(), s * 1000);
  }

  _go(i, dir) {
    if (i < 0 || i >= this._season.length || i === this._idx) return;
    this._idx = i;
    const s = this._sessionOf(this._season[i]);
    this._loading = !!s && s.state !== 'pre' && !this._details.has(s.id);
    this._slideDir = dir;
    this._render();
    this._refreshSoon();
  }

  /** Load after a short pause, so tapping through several weekends only loads the one you stop on. */
  _refreshSoon() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._refresh(), 350);
  }

  _pickSession(id) {
    const w = this._season[this._idx];
    if (!w) return;
    this._picked[w.id] = id;
    const s = w.sessions.find(x => x.id === id);
    this._loading = !!s && s.state !== 'pre' && !this._details.has(s.id);
    this._render();
    this._refreshSoon();
  }

  /* ── render ── */

  /** Number, team and color for a driver: from this session if it has them, else the latest known. */
  _car(id, det) { return det?.entries?.[id]?.number ? det.entries[id] : this._teamEntries[id] ?? {}; }

  _isFav(d) {
    const f = this._config?.driver;
    if (!f || !d) return false;
    const st = this._standings?.drivers.find(x => x.id === d.id);
    const num = this._teamEntries[d.id]?.number;
    return [d.name, d.short, st?.abbr].some(x => String(x ?? '').toLowerCase() === f) || (num && String(num) === f.replace(/^#/, ''));
  }

  _render() {
    if (!this._config) return;
    const w = this._season[this._idx];
    const title = w ? w.short : 'Formula 1';
    const sub = w ? [w.canceled ? 'Cancelled' : `Round ${w.round} of ${w.total}`, 'Formula 1'].join(' · ') : '';
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>
      <div class="top">
        <div class="range">${this._driverView ? '<button class="back" id="back">‹ Back</button>' : `
          <button class="nav" id="left" aria-label="Previous Grand Prix" title="Previous Grand Prix"${this._idx <= 0 ? ' disabled' : ''}>‹</button>
          <button class="nav" id="right" aria-label="Next Grand Prix" title="Next Grand Prix"${this._idx < 0 || this._idx >= this._season.length - 1 ? ' disabled' : ''}>›</button>
          <div class="wkt"><span class="wkn">${esc(title)}</span><span class="wk">${esc(sub)}</span></div>
          ${this._home >= 0 && this._idx !== this._home ? '<button class="today" id="today">Current GP</button>' : ''}`}
        </div>
        <div class="clock" id="clock">${fmtTime(new Date())}</div>
        <button class="refresh" id="refresh" title="Refresh now">↻</button>
      </div>
      ${this._error ? `<div class="err">${esc(this._error)}</div>` : ''}
      <div class="body">${this._driverView ? this._driverHTML(this._driverView) : `<div class="grid">
        <div class="sec">${w ? this._weekendHTML(w) : `<div class="empty muted">${this._loading ? 'Loading schedule…' : 'No races found.'}</div>`}</div>
        ${this._config.show_standings ? `<div class="sec">${this._standingsHTML()}</div>` : ''}
      </div>`}</div>
      ${this._updated ? `<div class="foot">Updated ${fmtTime(this._updated)}</div>` : ''}
    </ha-card>`;
    this._bind();
    this._animate();
    this._saveView();
  }

  _saveView() {
    const w = this._season[this._idx];
    if (!w) return;
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ day: this._todayKey, id: w.id, session: this._picked[w.id] ?? null, driver: this._driverView })); } catch { /* not remembered */ }
  }

  /** Slide the new weekend in from the side it came from. */
  _animate() {
    const dir = this._slideDir;
    this._slideDir = 0;
    const el = this.shadowRoot.querySelector('.grid');
    if (!dir || !el?.animate || reduceMotion()) return;
    el.animate([{ transform: `translateX(${dir * 40}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'ease-out' });
  }

  _weekendHTML(w) {
    const live = w.sessions.find(s => s.state === 'in');
    const next = w.sessions.find(s => s.state === 'pre' && s.date > Date.now() - 3600e3);
    let pill = '';
    if (w.canceled) pill = '<span class="pill">Cancelled</span>';
    else if (live) pill = `<span class="pill live">LIVE · ${esc(live.label)}</span>`;
    else if (next && next.date - Date.now() < 8 * 86400e3) pill = `<span class="pill">Next: ${esc(next.label)} · ${esc(fmtDay(next.date))} ${esc(fmtTime(next.date))}</span>`;
    else if (w.sessions.length && w.sessions.every(s => s.state === 'post')) pill = '<span class="pill">Final</span>';
    let html = `<div class="rhead">
      <div class="rname">${esc(w.name)}</div>
      <div class="rsub">${esc([w.circuit, w.where].filter(Boolean).join(' · '))}</div>
      <div class="rsub">${esc(fmtDate(w.start))} – ${esc(fmtDate(w.end))}</div>
      ${pill}
    </div>`;
    if (w.canceled) return html + '<div class="empty muted">This Grand Prix was cancelled.</div>';
    const s = this._sessionOf(w);
    html += `<div class="sess" role="tablist">${w.sessions.map(x => `<button role="tab" data-session="${esc(x.id)}" aria-selected="${x === s}"
      class="${x === s ? 'on ' : ''}${x.state}" title="${esc(x.label)}"><span class="a">${esc(x.tab)}</span><span class="b">${esc(fmtDay(x.date))} · ${esc(fmtTime(x.date))}</span></button>`).join('')}</div>`;
    return s ? html + this._sessionHTML(w, s) : html;
  }

  _sessionHTML(w, s) {
    let pill = '';
    if (s.state === 'in') pill = `<span class="pill live">LIVE${s.kind === 'race' && s.lap ? ` · Lap ${s.lap}` : ''}</span>`;
    else if (s.state === 'post') pill = `<span class="pill">${esc(/final/i.test(s.statusName) ? 'Final' : s.detail || 'Final')}${s.kind === 'race' && s.lap ? ` · ${s.lap} laps` : ''}</span>`;
    else if (/postponed|delayed|canceled|cancelled/i.test(s.statusName)) pill = `<span class="pill">${esc(s.detail)}</span>`;
    let html = `<div class="shead"><span class="t">${esc(s.label)}</span>
      <span class="muted">${esc(fmtDay(s.date))} · ${esc(fmtTime(s.date))}${s.tv ? ` · ${esc(s.tv)}` : ''}</span>${pill}</div>`;

    if (s.state === 'pre' || !s.drivers.length) {
      // Before a race: the grid as qualifying set it
      const q = s.kind === 'race' ? this._gridSession(w, s) : null;
      if (q?.state === 'post' && q.drivers.length) {
        return html + this._tableHTML(q, this._details.get(q.id), 'grid')
          + `<div class="note">Qualifying order. Grid penalties aren't included until the ${esc(s.label.toLowerCase())} starts.</div>`;
      }
      const mins = Math.round((s.date - Date.now()) / 60000);
      const when = mins > 0 && mins < 48 * 60 ? ` (in ${mins >= 60 ? `${Math.floor(mins / 60)}h ` : ''}${mins % 60}m)` : '';
      return html + `<div class="empty muted">${mins > 0 ? `Starts ${esc(fmtDay(s.date))} at ${esc(fmtTime(s.date))}${when}.` : 'Results aren\'t in yet.'}</div>`;
    }
    const det = this._details.get(s.id);
    if (!det) return html + `<div class="empty muted">${this._loading ? 'Loading results…' : ''}</div>` + this._tableHTML(s, null);
    return html + this._bannerHTML(s, det) + this._favHTML(s, det) + this._tableHTML(s, det);
  }

  /** A driver's best lap in practice or qualifying (their time from the last part they reached). */
  _best(st) { return st?.q?.filter(Boolean).pop() ?? st?.time ?? null; }

  /** Gap to the fastest driver, worked out from the lap times (ESPN's own gap is wrong in some sessions). */
  _gapTo(s, det, d) {
    if (d.pos === 1) return '';
    const lead = lapMs(this._best(det?.stats?.[s.drivers[0]?.id])), mine = lapMs(this._best(det?.stats?.[d.id]));
    return lead && mine ? fmtGap(Math.round(mine - lead)) ?? '' : '';
  }

  /** Winner, pole sitter or fastest driver of a session. */
  _bannerHTML(s, det) {
    if (s.state !== 'post') return '';
    const d = s.kind === 'race' ? s.drivers.find(x => x.winner) ?? s.drivers[0] : s.drivers[0];
    if (!d) return '';
    const st = det.stats[d.id] ?? {};
    const car = this._car(d.id, det);
    const [icon, what] = s.kind === 'race' ? ['🏁', s.abbr === 'SR' ? 'Sprint winner' : 'Winner'] : s.kind === 'qual' ? ['⏱', s.abbr === 'SS' ? 'Sprint pole' : 'Pole'] : ['⏱', 'Fastest'];
    const time = s.kind === 'race' ? st.time : this._best(st);
    return `<div class="win" style="--tc:${esc(car.color)}"><span class="flagc">${icon}</span><div><div class="who">${esc(d.name)}</div>
      <div class="sub">${[what, car.team, time].filter(Boolean).map(esc).join(' · ')}</div></div></div>`;
  }

  _favHTML(s, det) {
    const d = s.drivers.find(x => this._isFav(x));
    if (!d) return '';
    const st = det.stats[d.id] ?? {};
    const out = det.status?.[d.id];
    const pos = d.pos ? `P${d.pos}` : '–';
    const parts = s.kind === 'race'
      ? [out ? `<b>${esc(out)}</b>` : `${s.state === 'post' ? 'finished' : 'running'} <b>${pos}</b>`, st.grid && `started P${st.grid}`,
        s.state === 'post' && st.pts != null && `${st.pts} pts`]
      : [`${s.kind === 'qual' ? 'qualified' : ''} <b>${pos}</b>`, d.pos > 1 && this._gapTo(s, det, d), d.pos === 1 && this._best(st)];
    return `<div class="fav">★ <b>${esc(d.name)}</b> ${parts.filter(Boolean).join(' · ')}</div>`;
  }

  /** Results table for a session; `mode` 'grid' shows a qualifying session as the race's starting grid. */
  _tableHTML(s, det, mode) {
    const stats = det?.stats ?? {};
    const status = det?.status ?? {};
    const has = Object.values(stats).some(Boolean);
    const kind = s.kind;
    // Fastest lap of the race: the quickest of any driver ESPN credits with one
    let fl = null;
    if (kind === 'race') for (const [id, st] of Object.entries(stats)) if (st?.fastest && (!fl || lapMs(st.fastest) < lapMs(stats[fl].fastest))) fl = id;
    const qNames = SESSIONS[s.abbr]?.q ?? ['Q1', 'Q2', 'Q3'];
    // Qualifying knock-out lines: under the last driver through to each part
    const lastIn = k => Math.max(0, ...s.drivers.filter(d => stats[d.id]?.q?.[k]).map(d => d.pos ?? 0));
    const ko = kind === 'qual' && has ? [lastIn(1), lastIn(2)].filter(n => n > 0 && n < s.drivers.length) : [];

    const rows = s.drivers.map(d => {
      const st = stats[d.id] ?? {};
      const car = this._car(d.id, det);
      const out = status[d.id];
      const num = car.number ? `<span class="num" style="--tc:${esc(car.color)};--tx:${textOn(car.color)}" title="${esc(car.team)}">${esc(car.number)}</span>` : '';
      let cells = '';
      let mv = '';
      if (kind === 'race') {
        const moved = st.grid && d.pos && !out ? st.grid - d.pos : 0;
        mv = st.grid ? `<td class="mv${moved > 0 ? ' up' : moved < 0 ? ' down' : ''}" title="Started P${st.grid}">${moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : '–'}</td>` : '<td class="mv"></td>';
        const gap = out ? out : d.pos === 1 ? st.time : st.behindLaps ? `+${st.behindLaps} ${st.behindLaps === 1 ? 'lap' : 'laps'}` : st.behind;
        cells = has ? `<td class="${out ? 'out' : ''}">${esc(gap ?? '')}${fl === d.id ? `<span class="fl" title="Fastest lap ${esc(st.fastest)}${st.fastestLap ? ` (lap ${st.fastestLap})` : ''}">FL</span>` : ''}</td>
          <td class="hide-narrow">${st.laps ?? ''}</td><td class="hide-narrow">${st.pits ?? ''}</td><td class="pts">${s.state === 'post' && st.pts ? st.pts : ''}</td>` : '';
      } else if (kind === 'qual') {
        const best = this._best(st);
        cells = has ? st.q.map((t, i) => `<td class="${i < 2 ? 'hide-narrow' : ''}${t && t === best ? ' best' : ''}">${esc(t ?? '')}</td>`).join('')
          + `<td class="muted hide-narrow">${esc(this._gapTo(s, det, d))}</td>` : '';
      } else {
        cells = has ? `<td class="best">${esc(st.time ?? '')}</td><td class="muted">${esc(this._gapTo(s, det, d))}</td><td class="hide-narrow">${st.laps ?? ''}</td>` : '';
      }
      return `<tr class="${this._isFav(d) ? 'me' : ''}${ko.includes((d.pos ?? 0) - 1) ? ' ko' : ''}" data-driver="${esc(d.id)}" title="${esc(d.name)}: season stats">
        <td class="pos">${d.pos ?? ''}</td>${kind === 'race' ? mv : ''}<td class="car">${num}</td>
        <td class="l drv"><span class="n">${esc(d.name)}</span>${d.flag ? `<img src="${esc(d.flag)}" alt="" loading="lazy">` : ''}${car.team ? `<span class="t">${esc(car.team)}</span>` : ''}</td>${cells}</tr>`;
    }).join('');
    const heads = !has ? '' : kind === 'race' ? `<th>${s.state === 'post' ? 'Time / gap' : 'Gap'}</th><th class="hide-narrow">Laps</th><th class="hide-narrow">Pits</th><th>${s.state === 'post' ? 'Pts' : ''}</th>`
      : kind === 'qual' ? qNames.map((q, i) => `<th class="${i < 2 ? 'hide-narrow' : ''}">${q}</th>`).join('') + '<th class="hide-narrow">Gap</th>'
      : '<th>Best lap</th><th>Gap</th><th class="hide-narrow">Laps</th>';
    const head = `<tr><th class="l">${mode === 'grid' ? 'Grid' : 'Pos'}</th>${kind === 'race' ? '<th></th>' : ''}<th></th><th class="l">Driver</th>${heads}</tr>`;
    const label = mode === 'grid' ? 'Starting grid' : s.state === 'in' ? (kind === 'race' ? 'Running order' : 'Live timing') : 'Results';
    return this._foldHTML('results', label, `<table>${head}${rows}</table>`);
  }

  _standingsHTML() {
    const st = this._standings;
    if (!st?.drivers.length) return `<div class="empty muted">${this._loading || !this._standingsAt ? 'Loading standings…' : 'No standings yet.'}</div>`;
    const tabs = `<div class="tabs" role="tablist"><button role="tab" data-tab="drivers" class="${this._tab === 'drivers' ? 'on' : ''}" aria-selected="${this._tab === 'drivers'}">Drivers</button><button role="tab" data-tab="teams" class="${this._tab === 'teams' ? 'on' : ''}" aria-selected="${this._tab === 'teams'}">Constructors</button></div>`;
    let body;
    if (this._tab === 'teams' && st.teams.length) {
      const lead = st.teams[0].pts;
      const byTeam = {};
      for (const d of st.drivers) {
        const t = this._teamEntries[d.id]?.team;
        if (t) (byTeam[t.toLowerCase()] ??= []).push(d.name.replace(/^(\S)\S*\s+/, '$1. '));
      }
      const fav = st.drivers.find(d => this._isFav(d));
      const favTeam = fav && this._teamEntries[fav.id]?.team?.toLowerCase();
      body = `<table><tr><th class="l"></th><th class="l">Constructor</th><th>Pts</th><th>Gap</th></tr>${st.teams.map(t => `
        <tr class="${favTeam === t.name.toLowerCase() ? 'me' : ''}"><td class="pos">${t.rank}</td>
        <td class="l drv"><span class="n"><span class="bar" style="--tc:${esc(t.color)}"></span>${esc(t.name)}</span>${byTeam[t.name.toLowerCase()] ? `<span class="ds">${esc(byTeam[t.name.toLowerCase()].join(', '))}</span>` : ''}</td>
        <td class="pts">${t.pts}</td><td class="mv">${t.pts === lead ? '' : `−${lead - t.pts}`}</td></tr>`).join('')}</table>`;
    } else {
      const lead = st.drivers[0].pts;
      body = `<table><tr><th class="l"></th><th class="l">Driver</th><th>Pts</th><th>Gap</th></tr>${st.drivers.map(d => {
        const car = this._teamEntries[d.id] ?? {};
        return `<tr class="${this._isFav(d) ? 'me' : ''}" data-driver="${esc(d.id)}" title="${esc(d.name)}: season stats"><td class="pos">${d.rank}</td>
          <td class="l drv"><span class="n"><span class="bar" style="--tc:${esc(car.color)}"></span>${esc(d.name)}</span>${car.team ? `<span class="t">${esc(car.team)}</span>` : ''}</td>
          <td class="pts">${d.pts}</td><td class="mv">${d.pts === lead ? '' : `−${lead - d.pts}`}</td></tr>`;
      }).join('')}</table>`;
    }
    return this._foldHTML('standings', 'Championship', tabs + body);
  }

  _driverHTML(id) {
    const dv = this._drivers.get(id);
    const st = this._standings?.drivers.find(s => s.id === id);
    const fromSession = this._season.flatMap(w => w.sessions.flatMap(s => s.drivers)).find(d => d.id === id);
    const name = dv?.bio?.name || st?.name || fromSession?.name || '';
    const car = this._teamEntries[id] ?? {};
    const sub = [car.team, dv?.bio?.country, dv?.bio?.age != null && `Age ${dv.bio.age}`].filter(Boolean).map(esc).join(' · ');
    const standing = st ? `${st.rank === 1 ? 'Championship leader' : `${ordinal(st.rank)} in the championship`} · ${st.pts} pts` : '';
    let html = `<div class="dv"><div class="dv-head" style="--tc:${esc(car.color)}">
      ${dv?.bio?.headshot ? `<img class="hs" src="${esc(dv.bio.headshot)}" alt="">` : ''}
      <div><div class="dv-name">${esc(name)}</div>
        <div class="dv-sub">${car.number ? `<span class="num" style="--tc:${esc(car.color)};--tx:${textOn(car.color)}">${esc(car.number)}</span>` : ''}${sub}</div>
        ${standing ? `<div class="dv-sub">${esc(standing)}</div>` : ''}</div>
    </div>`;
    if (!dv || (!dv.results && !dv.error)) return html + '<div class="empty muted">Loading season stats…</div></div>';
    if (dv.error) return html + `<div class="err">${esc(dv.error)}</div></div>`;

    const year = (this._season[this._idx]?.start ?? new Date()).getFullYear();
    const t = seasonTotals(dv.results);
    const tile = (v, k, hi) => `<div class="tile${hi ? ' hi' : ''}"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`;
    html += `<div><h4>${year} season · Grands Prix</h4><div class="tiles">
      ${st ? tile(st.pts, 'Points', true) : ''}${tile(t.wins, t.wins === 1 ? 'Win' : 'Wins', t.wins > 0)}${tile(t.podiums, t.podiums === 1 ? 'Podium' : 'Podiums')}
      ${tile(t.top10, 'Points finishes')}${tile(t.p1, 'Started P1')}${tile(t.fastest, t.fastest === 1 ? 'Fastest lap' : 'Fastest laps')}
      ${tile(t.best ? `P${t.best}` : '–', 'Best finish')}${tile(t.avgGrid, 'Avg grid')}${tile(t.avgFinish, 'Avg finish')}
      ${tile(t.starts, 'Starts')}${tile(t.dnf, t.dnf === 1 ? 'DNF' : 'DNFs')}
    </div></div>`;
    // Points per weekend (sprint included) from the standings, matched to the calendar by position
    const rounds = st?.rounds?.length === this._season.length ? st.rounds : null;
    const rows = dv.results.map(x => {
      const pts = rounds ? rounds[x.idx] : x.pts;
      return `<tr data-gp="${esc(x.id)}" title="Open this Grand Prix">
        <td class="l">${esc(x.short.replace(/ GP$/, ''))}</td><td>${x.grid ?? ''}</td>
        <td class="fin${x.finish === 1 && !x.status ? ' w' : ''}">${x.status ? `<span class="muted" title="Classified P${x.finish}">${esc(x.status)}</span>` : `P${x.finish}`}${x.fastestOverall ? '<span class="fl" title="Fastest lap">FL</span>' : ''}</td>
        <td class="pts">${esc(pts && pts !== '-' ? pts : '')}</td></tr>`;
    }).join('');
    html += this._foldHTML('driver-results', 'Grand Prix results',
      `<table><tr><th class="l">Grand Prix</th><th>Grid</th><th>Finish</th><th>Pts</th></tr>${rows}</table>`);
    html += `<div class="note">Points include sprint races${rounds ? '' : ' where ESPN lists them'}. Career totals aren't available from ESPN.</div>`;
    return html + '</div>';
  }

  /** A section whose heading hides / shows it; remembered on this device. */
  _foldHTML(key, title, body) {
    const closed = this._folded.has(key);
    return `<div><button class="fold${closed ? ' closed' : ''}" data-fold="${key}" aria-expanded="${!closed}">
      ${esc(title)} <span class="hint">(tap to ${closed ? 'expand' : 'hide'})</span></button>${closed ? '' : body}</div>`;
  }

  _bind() {
    const $ = id => this.shadowRoot.getElementById(id);
    $('left')?.addEventListener('click', () => this._go(this._idx - 1, -1));
    $('right')?.addEventListener('click', () => this._go(this._idx + 1, 1));
    $('today')?.addEventListener('click', () => this._go(this._home, this._home > this._idx ? 1 : -1));
    $('refresh')?.addEventListener('click', () => {
      if (this._driverView) this._drivers.delete(this._driverView);
      const s = this._sessionOf(this._season[this._idx]);
      if (s) this._details.delete(s.id);
      this._seasonAt = 0;
      this._standingsAt = 0;
      this._refresh();
    });
    this.shadowRoot.querySelectorAll('[data-session]').forEach(el => el.addEventListener('click', () => this._pickSession(el.dataset.session)));
    this.shadowRoot.querySelector('.sess button.on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this.shadowRoot.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => {
      this._tab = el.dataset.tab;
      try { localStorage.setItem(TAB_KEY, this._tab); } catch { /* not remembered */ }
      this._render();
    }));
    $('back')?.addEventListener('click', () => { this._driverView = null; this._render(); });
    this.shadowRoot.querySelectorAll('tr[data-driver]').forEach(el => el.addEventListener('click', () => this._openDriver(el.dataset.driver)));
    this.shadowRoot.querySelectorAll('tr[data-gp]').forEach(el => el.addEventListener('click', () => {
      const i = this._season.findIndex(w => w.id === el.dataset.gp);
      this._driverView = null;
      if (i >= 0) this._picked[this._season[i].id] = this._season[i].sessions.find(s => s.abbr === 'Race')?.id;
      if (i >= 0 && i !== this._idx) this._go(i, i > this._idx ? 1 : -1); else { this._render(); this._refresh(); }
    }));
    this.shadowRoot.querySelectorAll('[data-fold]').forEach(el => el.addEventListener('click', () => {
      const k = el.dataset.fold;
      if (!this._folded.delete(k)) this._folded.add(k);
      try { localStorage.setItem(FOLD_KEY, JSON.stringify([...this._folded])); } catch { /* not remembered */ }
      this._render();
    }));
    // Swipe left / right to change Grand Prix
    const body = this.shadowRoot.querySelector('.body');
    let x0 = null, y0 = null;
    body?.addEventListener('touchstart', ev => {
      x0 = ev.target.closest?.('.sess') ? null : ev.touches[0].clientX; // the session tabs scroll sideways
      y0 = ev.touches[0].clientY;
    }, { passive: true });
    body?.addEventListener('touchend', ev => {
      if (x0 == null) return;
      const dx = ev.changedTouches[0].clientX - x0, dy = ev.changedTouches[0].clientY - y0;
      x0 = null;
      if (!this._driverView && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) this._go(this._idx + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    }, { passive: true });
  }
}

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, F1ScoreboardCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: 'F1 Scoreboard Card',
  description: 'Formula 1 practice, qualifying, sprint and race results with championship standings, one Grand Prix at a time.',
  preview: true,
  documentationURL: 'https://github.com/AOPW-llc/f1-scoreboard-card',
});

console.info(`%c F1-SCOREBOARD-CARD %c v${VERSION} `,
  'color:#fff;background:#e10600;font-weight:bold', 'color:#e10600;background:#fff');
