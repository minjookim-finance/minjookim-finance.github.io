// Cloudflare Worker: visit notifications for a personal website.
//
// The site (assets/js/visit.js) sends a small POST when a visit starts and another
// when the visitor leaves, listing what they clicked. This Worker adds what Cloudflare
// knows about the request (city, country, network name), drops obvious bots,
// and forwards a push notification through ntfy.
//
// If a D1 database is bound as DB, each visit is also saved there (one row per visit:
// time, city and its approximate coordinates, network name, referrer, device, actions;
// no IP address). Callers who know STATS_KEY can then POST /stats for today's visit count
// and top city, or POST /data for the saved visits (used by the site's /visits/ dashboard).
//
// Required setting (Worker > Settings > Variables and Secrets):
//   NTFY_TOPIC   secret   the private ntfy channel name your phone subscribes to
// Optional:
//   NTFY_SERVER  text     defaults to https://ntfy.sh
//   NTFY_TOKEN   secret   an ntfy access token, if ntfy rate-limits unauthenticated messages
//   STATS_KEY    secret   passphrase required by POST /stats and /data (closed without it)
// Optional binding (Worker > Settings > Bindings):
//   DB           D1 database; the visits table is created automatically on first use
//
// Every accepted ping is answered with 204 and two headers:
//   X-Relay-Result: sent | sent-on-attempt-<n> | ntfy-refused-<status>[-after-6-attempts] |
//                   ntfy-unreachable-after-6-attempts
//   X-Relay-Store:  saved | no-database | error
// (both are absent for filtered bots)

// Origins served by the academic website.
const ALLOWED_ORIGINS = ['https://minjookim-finance.github.io'];

const MAX_ATTEMPTS = 6;
const RETRY_STEP_MS = 1500; // pauses of 1.5s, 3s, 4.5s, 6s, 7.5s between attempts

const BOT_PATTERN =
  /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|uptime|curl|wget|python|scrapy|httpclient|go-http|axios|node-fetch/i;

const clean = (value, max) =>
  String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function describeDevice(ua) {
  const device = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|iPhone|Android/i.test(ua) ? 'mobile' : 'desktop';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'other browser';
  const os = /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return [device, browser, os].filter(Boolean).join(', ');
}

function describeReferrer(referrer) {
  if (!referrer) return 'direct (typed URL or untraceable link)';
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'unknown';
    if (ALLOWED_ORIGINS.includes(url.origin)) return 'another page on the site';
    return clean(url.hostname.replace(/^www\./, ''), 120);
  } catch (e) {
    return 'unknown';
  }
}

function localTime(timeZone, date) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit',
    }).format(date) + ' (' + timeZone + ')';
  } catch (e) {
    return '';
  }
}

function describeDuration(seconds) {
  seconds = Math.max(0, Math.min(86400, Math.round(Number(seconds) || 0)));
  const minutes = Math.floor(seconds / 60);
  return minutes ? minutes + 'm ' + (seconds % 60) + 's' : seconds + 's';
}

// What the visitor did, as reported by assets/js/visit.js: [{ t: label, n: count }, ...].
function readActions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 25)
    .map((item) => ({
      label: clean(item && item.t, 100),
      count: Math.max(1, Math.min(99, Math.round(Number(item && item.n) || 1))),
    }))
    .filter((item) => item.label);
}

// Two kinds of ping: "arrive" at the start of a visit, and "update" when the visitor leaves
// or switches away. Both carry the same visit id, used as ntfy's sequence id so that apps
// which support it replace the earlier notification instead of adding a new one.
function buildNotification(request, visit) {
  const cf = request.cf || {};
  const ua = request.headers.get('User-Agent') || '';
  const isUpdate = visit.kind === 'update';
  const place = [cf.city, cf.region, cf.country].map((part) => clean(part, 60)).filter(Boolean).join(', ');
  const timeZone = clean(cf.timezone, 60);
  const lines = [
    'Network: ' + (clean(cf.asOrganization, 100) || 'unknown'),
    'From: ' + describeReferrer(clean(visit.referrer, 300)),
    'Page: ' + (clean(visit.path, 120) || '/') + (visit.returning ? ' (returning visitor)' : ' (first visit from this browser)'),
    'Device: ' + describeDevice(ua),
  ];

  let title = 'Visit from ' + (place || 'unknown location');
  let tag = 'eyes';
  let priority = 3; // ntfy default

  if (!isUpdate) {
    const time = localTime(timeZone, new Date());
    if (time) lines.push('Their local time: ' + time);
  } else {
    const start = Number(visit.start);
    const age = Date.now() - start;
    if (age >= 0 && age < 86400000) {
      const arrived = localTime(timeZone, new Date(start));
      if (arrived) lines.push('Arrived: ' + arrived);
    }

    let reading = 'Time on site: ' + describeDuration(visit.seconds);
    const scroll = Number(visit.scroll);
    if (scroll >= 0 && scroll <= 100) reading += ', scrolled ' + Math.round(scroll) + '%';
    const reached = clean(visit.reached, 80);
    if (reached) reading += ', down to ' + reached;
    lines.push(reading);

    const actions = readActions(visit.actions);
    if (actions.length) {
      lines.push('Actions:');
      for (const action of actions) {
        lines.push('- ' + action.label + (action.count > 1 ? ' (x' + action.count + ')' : ''));
      }
      title += ': ' + actions.length + (actions.length === 1 ? ' action' : ' actions');
      tag = 'link';
    } else {
      lines.push('Actions: none');
      title += ': no clicks';
      tag = 'door';
      priority = 2; // low: listed in the app without sound or vibration
    }
  }

  const id = clean(visit.id, 40);
  return {
    title,
    message: lines.join('\n'),
    tag,
    priority,
    sequenceId: /^[A-Za-z0-9]{6,32}$/.test(id) ? id : '',
  };
}

// ---- Storage and stats (only when a D1 database is bound as DB) ----

// Group visits by the calendar date in Austin.
const SITE_TIME_ZONE = 'America/Chicago';

// en-CA formats a date as YYYY-MM-DD.
const siteDay = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: SITE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      day TEXT NOT NULL,
      city TEXT, region TEXT, country TEXT, lat REAL, lon REAL, network TEXT,
      referrer TEXT, path TEXT, device TEXT, is_returning INTEGER,
      seconds INTEGER, scroll INTEGER, reached TEXT, actions TEXT
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS visits_day ON visits (day)'),
  ]);
  schemaReady = true;
}

// Cloudflare's estimate of the visitor's city location, kept so visits can be drawn on a map.
function coordinate(value, limit) {
  const number = Number(value);
  return value != null && value !== '' && Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

// One row per visit. The "arrive" ping creates it; "update" pings fill in what the visitor did.
async function storeVisit(db, request, visit) {
  const cf = request.cf || {};
  const isUpdate = visit.kind === 'update';
  let id = clean(visit.id, 40);
  if (!/^[A-Za-z0-9]{6,32}$/.test(id)) id = crypto.randomUUID().replace(/-/g, '');
  const now = Date.now();
  const start = Number(visit.start);
  const ts = start > now - 86400000 && start <= now + 60000 ? Math.round(start) : now;
  const scroll = Number(visit.scroll);

  await ensureSchema(db);
  await db.prepare(
    `INSERT INTO visits (id, ts, day, city, region, country, lat, lon, network, referrer, path,
                         device, is_returning, seconds, scroll, reached, actions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO ` + (isUpdate
      ? 'UPDATE SET seconds = excluded.seconds, scroll = excluded.scroll, reached = excluded.reached, actions = excluded.actions WHERE excluded.seconds >= visits.seconds'
      : 'NOTHING')
  ).bind(
    id, ts, siteDay(new Date(ts)),
    clean(cf.city, 60), clean(cf.region, 60), clean(cf.country, 10),
    coordinate(cf.latitude, 90), coordinate(cf.longitude, 180), clean(cf.asOrganization, 100),
    describeReferrer(clean(visit.referrer, 300)), clean(visit.path, 120) || '/',
    describeDevice(request.headers.get('User-Agent') || ''), visit.returning ? 1 : 0,
    isUpdate ? Math.max(0, Math.min(86400, Math.round(Number(visit.seconds) || 0))) : 0,
    isUpdate && scroll >= 0 && scroll <= 100 ? Math.round(scroll) : null,
    isUpdate ? clean(visit.reached, 80) : '',
    JSON.stringify(isUpdate ? readActions(visit.actions) : [])
  ).run();
}

async function readStats(db) {
  await ensureSchema(db);
  const day = siteDay(new Date());
  const [total, top] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM visits WHERE day = ? AND referrer != 'test.example'").bind(day),
    db.prepare(`SELECT city, COUNT(*) AS n FROM visits WHERE day = ? AND referrer != 'test.example' AND city != ''
                GROUP BY city, region, country ORDER BY n DESC, MAX(ts) DESC LIMIT 1`).bind(day),
  ]);
  const best = top.results[0];
  return {
    day,
    visits: total.results[0] ? total.results[0].n : 0,
    topCity: best ? best.city : '',
    topCityVisits: best ? best.n : 0,
  };
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

// The saved visits of the last <days> days, newest first, for the owner's dashboard page.
const MAX_ROWS = 5000;
async function readVisits(db, days) {
  await ensureSchema(db);
  const span = Math.max(1, Math.min(400, Math.round(Number(days) || 30)));
  // Use local calendar dates, so Today and seven-day ranges also span daylight-saving changes.
  const firstDay = new Date(siteDay(new Date()) + 'T12:00:00Z');
  firstDay.setUTCDate(firstDay.getUTCDate() - span + 1);
  const found = await db.prepare(
    `SELECT ts, day, city, region, country, lat, lon, network, referrer, path, device,
            is_returning, seconds, scroll, reached, actions
     FROM visits WHERE day >= ? AND referrer != 'test.example' ORDER BY ts DESC LIMIT ${MAX_ROWS}`
  ).bind(firstDay.toISOString().slice(0, 10)).all();
  return { generated: Date.now(), timeZone: SITE_TIME_ZONE, days: span, maxRows: MAX_ROWS, visits: found.results };
}

// Owner-only requests, both POST with body {"key": "<STATS_KEY>"}:
//   /stats  today's visit count and top city
//   /data   the saved visits of the last {"days": n} days (shown on the dashboard page)
async function handleOwnerRequest(request, env, cors, path) {
  const json = (body, status) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  if (!env.STATS_KEY || !env.DB) return json({ error: 'stats are not set up' }, 503);
  let body = {};
  try {
    const text = await request.text();
    if (text.length <= 500) body = JSON.parse(text) || {};
  } catch (e) {}
  const key = String(body.key || '');
  if (!key || !sameText(key, String(env.STATS_KEY))) return json({ error: 'wrong key' }, 403);
  try {
    return json(path === '/data' ? await readVisits(env.DB, body.days) : await readStats(env.DB), 200);
  } catch (e) {
    return json({ error: 'database error' }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };

    const url = new URL(request.url);
    const path = url.pathname;
    if (url.search || !['/', '/visit', '/stats', '/data'].includes(path)) {
      return new Response('Not found', { status: 404 });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
    if (!allowed) return new Response('Forbidden', { status: 403 });
    if (path === '/stats' || path === '/data') return handleOwnerRequest(request, env, cors, path);

    // Bots get the same empty reply as real visits, but no notification is sent.
    const ua = request.headers.get('User-Agent') || '';
    if (!ua || BOT_PATTERN.test(ua)) return new Response(null, { status: 204, headers: cors });

    if (!env.NTFY_TOPIC) return new Response('NTFY_TOPIC is not set', { status: 500, headers: cors });

    // The existing Cloudflare rate limiter uses the address transiently. D1 stores city-level data.
    if (!env.VISIT_LIMITER) return new Response('Rate limiter unavailable', { status: 503, headers: cors });
    const rateKey = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.VISIT_LIMITER.limit({ key: rateKey });
    if (!success) return new Response(null, { status: 429, headers: cors });

    let visit;
    try {
      const text = await request.text();
      if (text.length > 8000) return new Response('Payload too large', { status: 413, headers: cors });
      // Cached versions of the original tracker send an empty POST to /visit.
      visit = !text && path === '/visit'
        ? { kind: 'arrive', id: crypto.randomUUID().replace(/-/g, ''), path: '/' }
        : JSON.parse(text);
    } catch (e) {
      return new Response('Invalid visit', { status: 400, headers: cors });
    }
    if (!visit || !['arrive', 'update'].includes(visit.kind) || !/^[A-Za-z0-9]{6,32}$/.test(visit.id || '')) {
      return new Response('Invalid visit', { status: 400, headers: cors });
    }

    // Save the visit first, so it is recorded even when ntfy refuses the notification.
    let stored = 'no-database';
    if (env.DB) {
      try {
        await storeVisit(env.DB, request, visit);
        stored = 'saved';
      } catch (e) {
        stored = 'error';
      }
    }

    const note = buildNotification(request, visit);
    const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    // Optional ntfy access token: authenticated messages are rate-limited per account
    // instead of per sending address, which Cloudflare shares between many customers.
    if (env.NTFY_TOKEN) headers.Authorization = 'Bearer ' + env.NTFY_TOKEN;

    // JSON publishing keeps non-ASCII city names intact (HTTP headers would not).
    const message = { topic: env.NTFY_TOPIC, title: note.title, message: note.message, tags: [note.tag], priority: note.priority };
    if (note.sequenceId) message.sequence_id = note.sequenceId;
    const payload = JSON.stringify(message);

    // ntfy.sh rate-limits by sending address, and Cloudflare shares its addresses between
    // many customers, so a message is sometimes refused with 429 through no fault of ours.
    // Retry with growing pauses: up to 6 attempts over about 22 seconds.
    const deliver = async () => {
      let outcome = 'ntfy-unreachable';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const reply = await fetch(server + '/', { method: 'POST', headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(8000) });
          if (reply.ok) return attempt === 1 ? 'sent' : 'sent-on-attempt-' + attempt;
          outcome = 'ntfy-refused-' + reply.status;
          // Only rate limits and server errors are worth retrying.
          if (reply.status !== 429 && reply.status < 500) return outcome;
        } catch (e) {
          outcome = 'ntfy-unreachable';
        }
        if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * RETRY_STEP_MS));
      }
      return outcome + '-after-' + MAX_ATTEMPTS + '-attempts';
    };

    // waitUntil keeps the retries running even if the visitor closes the page.
    const delivery = deliver();
    ctx.waitUntil(delivery);
    const result = await delivery;

    // The headers say whether ntfy accepted the message and whether the visit was saved;
    // they carry no visitor data.
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'X-Relay-Result': result,
        'X-Relay-Store': stored,
        'Access-Control-Expose-Headers': 'X-Relay-Result, X-Relay-Store',
      },
    });
  },
};
