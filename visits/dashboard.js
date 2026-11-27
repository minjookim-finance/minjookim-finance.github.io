'use strict';

const DATA_URL = 'https://website-visit-relay.minjoo-kim-06b.workers.dev/data';
const TIME_ZONE = 'America/Chicago';
const KEY_STORE = 'visit-dashboard-passphrase';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' });
const recentFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const axisFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const byId = (id) => document.getElementById(id);
let rangeDays = 7;
let passphrase = '';
let currentRequest;

function element(tag, value) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = String(value);
  return node;
}

function duration(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  return n < 60 ? n + 's' : Math.floor(n / 60) + 'm ' + (n % 60) + 's';
}

function cityName(row) {
  return row.city ? [row.city, row.region, row.country].filter(Boolean).join(', ') : '';
}

function localDays(timestamp, days) {
  const date = new Date(dayFormat.format(new Date(timestamp)) + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() - days + 1);
  return Array.from({ length: days }, () => {
    const key = date.toISOString().slice(0, 10);
    const label = axisFormat.format(date);
    date.setUTCDate(date.getUTCDate() + 1);
    return { key, label, count: 0 };
  });
}

function rowActions(row) {
  try {
    const actions = typeof row.actions === 'string' ? JSON.parse(row.actions) : row.actions;
    return Array.isArray(actions) ? actions.filter((a) => a && typeof a.label === 'string') : [];
  } catch { return []; }
}

function addCount(map, label, increment = 1) {
  if (label) map.set(label, (map.get(label) || 0) + increment);
}

function table(headers, rows, ranked = false) {
  const result = element('table');
  if (ranked) result.className = 'ranking';
  const header = result.createTHead().insertRow();
  for (const label of headers) {
    const cell = element('th', label);
    cell.scope = 'col';
    header.append(cell);
  }
  const body = result.createTBody();
  for (const values of rows) {
    const tr = body.insertRow();
    for (const value of values) tr.append(element('td', value));
  }
  return result;
}

function empty(container, message) {
  const note = element('p', message);
  note.className = 'empty';
  container.replaceChildren(note);
}

function ranking(id, name, counts, unit = 'Visits') {
  const rows = Array.from(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  if (!rows.length) return empty(byId(id), 'None in this period.');
  byId(id).replaceChildren(table([name, unit], rows, true));
}

function chart(id, name, bins) {
  const container = byId(id);
  const bars = element('div');
  bars.className = 'bars';
  bars.setAttribute('aria-hidden', 'true');
  const max = Math.max(1, ...bins.map((b) => b.count));
  for (const bin of bins) {
    const bar = element('span');
    bar.className = 'bar';
    bar.style.height = 100 * bin.count / max + '%';
    bar.title = bin.label + ' · ' + bin.count;
    bars.append(bar);
  }
  const axis = element('div');
  axis.className = 'axis';
  const ticks = [...new Set([0, Math.floor(bins.length / 2), bins.length - 1])];
  ticks.forEach((i) => axis.append(element('span', bins[i].label)));
  const details = element('details');
  details.append(element('summary', 'Table view'), table([name, 'Visits'], bins.map((b) => [b.label, b.count]), true));
  container.replaceChildren(bars, axis, details);
}

function cityMap(points) {
  const container = byId('dots');
  const info = byId('map-info');
  container.replaceChildren();
  const caption = points.size ? 'Point sizes show visit counts. Select a city for its total.' : 'No city locations in this period.';
  info.textContent = caption;
  // Basemap derived from Natural Earth 1:110m land, in the public domain.
  for (const [name, point] of points) {
    const marker = element('button');
    marker.type = 'button';
    marker.className = 'dot';
    marker.style.left = (point.lon + 180) * 100 / 360 + '%';
    marker.style.top = (90 - point.lat) * 100 / 180 + '%';
    const diameter = Math.min(28, 6 + 3 * Math.sqrt(point.count)) + 'px';
    marker.style.width = marker.style.height = diameter;
    const label = name + ' · ' + point.count + (point.count === 1 ? ' visit' : ' visits');
    marker.title = label;
    marker.setAttribute('aria-label', label);
    const show = () => { info.textContent = label; };
    marker.addEventListener('focus', show);
    marker.addEventListener('pointerenter', show);
    marker.addEventListener('click', show);
    container.append(marker);
  }
}

function showReport(data) {
  const visits = data.visits.filter((v) => v.referrer !== 'test.example' && Number.isFinite(v.ts));
  const days = localDays(data.generated, rangeDays);
  const byDay = new Map(days.map((b) => [b.key, b]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    label: (hour % 12 || 12) + (hour < 12 ? ' AM' : ' PM'), count: 0
  }));
  const cities = new Map(), networks = new Map(), sources = new Map(), actions = new Map(), points = new Map();
  const durations = [];
  const recent = [];
  let clicked = 0;
  for (const visit of visits) {
    const date = new Date(visit.ts);
    const day = byDay.get(visit.day || dayFormat.format(date));
    if (!day) continue;
    day.count++;
    hours[Number(hourFormat.format(date))].count++;
    durations.push(Math.max(0, Number(visit.seconds) || 0));
    const city = cityName(visit);
    addCount(cities, city);
    addCount(networks, visit.network || 'Unknown');
    addCount(sources, visit.referrer || 'Direct');
    const labels = rowActions(visit);
    if (labels.some((a) => /^(Opened PDF|Opened link|Clicked email link)/i.test(a.label))) clicked++;
    for (const action of labels) addCount(actions, action.label, Math.max(1, Number(action.count) || 1));
    if (city && Number.isFinite(visit.lat) && Number.isFinite(visit.lon)) {
      const point = points.get(city) || { lat: visit.lat, lon: visit.lon, count: 0 };
      point.count++;
      points.set(city, point);
    }
    if (recent.length < 50) {
      const scroll = visit.scroll == null ? '' : ' · ' + visit.scroll + '% scrolled';
      const reached = visit.reached ? ' · ' + visit.reached : '';
      recent.push([recentFormat.format(date), city || 'Unknown', visit.network || 'Unknown',
        visit.referrer || 'Direct', visit.device || 'Unknown', visit.path || '/',
        duration(visit.seconds) + scroll + reached, labels.map((a) => a.label + (a.count > 1 ? ' ×' + a.count : '')).join(' · ') || '—']);
    }
  }
  durations.sort((a, b) => a - b);
  const n = durations.length;
  const middle = Math.floor(n / 2);
  const median = n % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
  byId('total').textContent = n.toLocaleString();
  byId('city-count').textContent = cities.size.toLocaleString();
  byId('click-share').textContent = n ? Math.round(100 * clicked / n) + '%' : '—';
  byId('median').textContent = n ? duration(median) : '—';
  byId('range-note').textContent = visits.length >= data.maxRows ? 'Showing the most recent ' + data.maxRows.toLocaleString() + ' visits.' : '';
  cityMap(points);
  chart('daily', 'Date', days);
  chart('hourly', 'Hour', hours);
  ranking('sources', 'Source', sources);
  ranking('networks', 'Network', networks);
  ranking('cities', 'City', cities);
  ranking('actions', 'Action', actions, 'Times');
  if (recent.length) byId('recent').replaceChildren(table(['Arrival', 'City', 'Network', 'Source', 'Device', 'Entry page', 'Engagement', 'Actions'], recent));
  else empty(byId('recent'), 'No visits in this period.');
}

function remember(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
  } catch { /* The dashboard also works when browser storage is unavailable. */ }
}

function lock() {
  currentRequest?.abort();
  passphrase = '';
  remember('');
  byId('key').value = '';
  byId('report').hidden = true;
  for (const id of ['total', 'city-count', 'click-share', 'median', 'dots', 'map-info', 'daily', 'hourly', 'sources', 'networks', 'cities', 'actions', 'recent', 'range-note', 'test-status']) {
    byId(id).replaceChildren();
  }
  byId('lock').hidden = true;
  byId('unlock').hidden = false;
  byId('status').textContent = '';
  byId('key').focus();
}

async function refresh() {
  currentRequest?.abort();
  const request = new AbortController();
  currentRequest = request;
  byId('status').textContent = 'Loading visits…';
  try {
    const response = await fetch(DATA_URL, { method: 'POST', body: JSON.stringify({ key: passphrase, days: rangeDays }),
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: request.signal });
    if (response.status === 403) {
      lock();
      byId('status').textContent = 'The passphrase was not accepted. Try again.';
      return;
    }
    if (response.status === 404 || response.status === 503) throw new Error('Finish deploying the visit Worker and its DB and STATS_KEY settings, then try again.');
    if (!response.ok) throw new Error('The Worker could not load visits. Please try again.');
    const data = await response.json();
    if (request.signal.aborted) return;
    if (!Array.isArray(data.visits)) throw new Error('The Worker returned an unexpected response.');
    showReport(data);
    remember(passphrase);
    byId('key').value = '';
    byId('status').textContent = '';
    byId('lock').hidden = false;
    byId('report').hidden = false;
    byId('unlock').hidden = true;
    for (const button of byId('ranges').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.days) === rangeDays));
    }
  } catch (error) {
    if (request.signal.aborted) return;
    byId('status').textContent = error instanceof TypeError ? 'Could not reach the visit Worker. Check the connection and try again.' : error.message;
  }
}

async function sendTest() {
  const button = byId('test-notification');
  const status = byId('test-status');
  button.disabled = true;
  status.textContent = 'Sending a test visit…';
  try {
    const start = Date.now();
    const visit = { kind: 'arrive', id: crypto.randomUUID().replace(/-/g, ''), path: '/', referrer: 'https://test.example/', returning: false, start };
    const response = await fetch(new URL('/', DATA_URL), { method: 'POST', body: JSON.stringify(visit), credentials: 'omit', referrerPolicy: 'no-referrer' });
    const delivery = response.headers.get('X-Relay-Result') || '';
    const storage = response.headers.get('X-Relay-Store') || '';
    if (response.ok && delivery.startsWith('sent') && storage === 'saved') {
      status.textContent = 'ntfy accepted the test notification and D1 saved the test visit. Check your phone. The test is excluded from these totals.';
    } else {
      status.textContent = 'Test result: HTTP ' + response.status + ', notification ' + (delivery || 'unconfirmed') + ', database ' + (storage || 'unconfirmed') + '.';
    }
  } catch { status.textContent = 'The test could not reach the Worker. Try again.'; }
  finally { button.disabled = false; }
}

byId('test-notification').addEventListener('click', sendTest);
byId('unlock').addEventListener('submit', (e) => {
  e.preventDefault();
  passphrase = byId('key').value;
  if (passphrase) refresh();
});
byId('lock').addEventListener('click', lock);
for (const button of byId('ranges').querySelectorAll('button')) {
  button.addEventListener('click', () => { rangeDays = Number(button.dataset.days); refresh(); });
}
const linkKey = new URLSearchParams(location.hash.slice(1)).get('statskey');
if (linkKey) {
  passphrase = linkKey;
  history.replaceState(null, '', location.pathname + location.search);
} else {
  try { passphrase = localStorage.getItem(KEY_STORE) || ''; } catch { /* Manual entry is available. */ }
}
if (passphrase) refresh();
