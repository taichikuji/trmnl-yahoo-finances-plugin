// TRMNL Node 20 Serverless. No imports, packages, browser code, or credentials.
const YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/NTNX?range=1y&interval=1d';
const REQUEST_TIMEOUT_MS = 2800;
const DAY = 86400;
const STATE_LIMIT = 8192;
// Conservative age limit: a normal weekend or US exchange holiday is not an outage.
// Fetch failures are marked stale immediately, independently of market age.
const MAX_MARKET_AGE = 7 * DAY;
const PLOT = { left: 4, right: 696, top: 12, bottom: 274 };

const positive = value => Number.isFinite(value) && value > 0;
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const marketDay = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(value * 1000));

// Provider-specific response parsing lives here. Keep charting/state independent.
function parseYahoo(payload, now) {
  const results = payload?.chart?.result;
  if (payload?.chart?.error || !Array.isArray(results) || results.length !== 1) {
    throw new Error('Invalid market response');
  }
  const { meta, timestamp: times, indicators } = results[0] || {};
  const closes = indicators?.quote?.[0]?.close;
  if (meta?.symbol !== 'NTNX' || meta.currency !== 'USD' ||
      meta.instrumentType !== 'EQUITY' || meta.dataGranularity !== '1d' ||
      !['NMS', 'NGM', 'NCM', 'NAS'].includes(meta.exchangeName) ||
      !positive(meta.regularMarketPrice) || !timestamp(meta.regularMarketTime) ||
      meta.regularMarketTime > now + 300 || !Array.isArray(times) ||
      !Array.isArray(closes) || times.length !== closes.length || times.length > 370) {
    throw new Error('Invalid market response');
  }
  const points = [];
  for (let i = 0; i < times.length; i++) {
    if (!timestamp(times[i]) || times[i] > now + 300 || (i > 0 && times[i] <= times[i - 1])) {
      throw new Error('Invalid market timestamps');
    }
    // Null daily bars occur in real chart responses. Never coerce null to zero.
    if (positive(closes[i])) points.push({ t: times[i], p: closes[i] });
  }
  if (points.length < 120) throw new Error('Incomplete year of prices');
  const first = points[0];
  const last = points[points.length - 1];
  const quoteTime = meta.regularMarketTime;
  if (last.t > quoteTime || quoteTime - last.t > MAX_MARKET_AGE ||
      quoteTime - first.t < 350 * DAY || quoteTime - first.t > 370 * DAY) {
    throw new Error('Incomplete year of prices');
  }
  // quote.close and regularMarketPrice share Yahoo's price basis. adjclose is
  // deliberately unused: mixing it with an unadjusted current quote skews returns.
  // Replace today's bar, or append the quote if today's historical bar is absent.
  const quote = { t: quoteTime, p: meta.regularMarketPrice };
  if (marketDay(last.t) === marketDay(quoteTime)) points[points.length - 1] = quote;
  else points.push(quote);
  return { points, market_at: quoteTime };
}

function chart(points) {
  if (points.length < 2 || points.some(p => !positive(p.p) || !timestamp(p.t)) ||
      points.some((p, i) => i > 0 && p.t <= points[i - 1].t)) {
    throw new Error('Not enough chart data');
  }
  const start = points[0].t;
  const end = points[points.length - 1].t;
  const prices = points.map(p => p.p);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const padding = Math.max((high - low) * 0.08, high * 0.01, 0.01);
  const min = Math.max(0, low - padding);
  const max = high + padding;
  const x = t => PLOT.left + (t - start) / (end - start) * (PLOT.right - PLOT.left);
  const y = p => PLOT.bottom - (p - min) / (max - min) * (PLOT.bottom - PLOT.top);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join('');
  const ticks = Array.from({ length: 5 }, (_, i) => ({
    y: +(PLOT.top + i * (PLOT.bottom - PLOT.top) / 4).toFixed(1),
    label: (max - i * (max - min) / 4).toFixed(2)
  }));
  const dates = Array.from({ length: 5 }, (_, i) => {
    const t = start + (end - start) * i / 4;
    return {
      x: +x(t).toFixed(1),
      label: new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', month: 'short', year: '2-digit'
      }).format(new Date(t * 1000))
    };
  });
  return { path, ticks, dates };
}

function makeState(data, now) {
  const first = data.points[0];
  const price = data.points[data.points.length - 1].p;
  const change = price - first.p;
  const state = {
    v: 1, price, change, percent: change / first.p * 100,
    start_at: first.t, market_at: data.market_at, fetched_at: now,
    ...chart(data.points)
  };
  if (bytes(state) > STATE_LIMIT) throw new Error('Saved state too large');
  return state;
}

function validState(state, now) {
  if (!state || state.v !== 1 || !positive(state.price) ||
      !Number.isFinite(state.change) || !Number.isFinite(state.percent) ||
      !timestamp(state.start_at) || !timestamp(state.market_at) || !timestamp(state.fetched_at) ||
      state.start_at >= state.market_at || state.market_at > now + 300 ||
      state.fetched_at > now + 300 || bytes(state) > STATE_LIMIT ||
      !Array.isArray(state.ticks) || state.ticks.length !== 5 ||
      !state.ticks.every(t => Number.isFinite(t.y) && t.y >= PLOT.top && t.y <= PLOT.bottom &&
        typeof t.label === 'string' && /^\d+\.\d{2}$/.test(t.label)) ||
      !Array.isArray(state.dates) || state.dates.length !== 5 ||
      !state.dates.every(d => Number.isFinite(d.x) && d.x >= PLOT.left && d.x <= PLOT.right &&
        typeof d.label === 'string' && /^[A-Z][a-z]{2} \d{2}$/.test(d.label)) ||
      typeof state.path !== 'string' || !/^M\d+\.\d,\d+\.\d(?:L\d+\.\d,\d+\.\d)+$/.test(state.path)) return false;
  const coordinates = [...state.path.matchAll(/[ML](\d+\.\d),(\d+\.\d)/g)];
  return coordinates.length >= 2 && coordinates.length <= 371 &&
    coordinates.every((p, i) => +p[1] >= PLOT.left && +p[1] <= PLOT.right &&
      +p[2] >= PLOT.top && +p[2] <= PLOT.bottom && (i === 0 || +p[1] >= +coordinates[i - 1][1]));
}

function display(state, stale, detail) {
  if (!state) return { has_data: false, stale: true, detail };
  const signed = value => `${value < 0 ? '\u2212' : '+'}${Math.abs(value).toFixed(2)}`;
  return {
    ...state, has_data: true, stale, detail,
    price_label: state.price.toFixed(2),
    change_label: `${signed(state.change)} (${signed(state.percent)}%)`,
    market_label: new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: 'short', day: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short'
    }).format(new Date(state.market_at * 1000))
  };
}

async function run(input) {
  const now = Math.floor(Date.now() / 1000);
  const saved = input?.trmnl?.state;
  const previous = validState(saved, now) ? saved : null;
  const controller = new AbortController();
  let timer;
  try {
    // Deadline includes connection, response body, and JSON, not just headers.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Request timed out'));
      }, REQUEST_TIMEOUT_MS);
    });
    const request = (async () => {
      const response = await fetch(YAHOO_URL, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
      return await response.json();
    })();
    const payload = await Promise.race([request, deadline]);
    const state = makeState(parseYahoo(payload, now), now);
    if (!validState(state, now)) throw new Error('Invalid processed prices');
    if (previous && (state.market_at < previous.market_at || state.start_at < previous.start_at - 7 * DAY)) {
      throw new Error('Provider returned older data');
    }
    const stale = now - state.market_at > MAX_MARKET_AGE;
    return {
      stonks: display(state, stale, stale ? 'Provider prices are over 7 days old' : 'Yahoo Finance \u00b7 daily prices'),
      trmnl_state: state
    };
  } catch (error) {
    const message = error?.message || '';
    const detail = controller.signal.aborted ? 'Request timed out' :
      /^Provider HTTP \d{3}$/.test(message) ? message :
      ['Provider returned older data', 'Incomplete year of prices'].includes(message) ? message :
      'Market data could not be validated';
    // Explicitly write back exactly the previous valid state, with no error flags
    // or new fetch timestamps. A failed first run never writes an empty state.
    return {
      stonks: display(previous, true, detail),
      ...(previous ? { trmnl_state: previous } : {})
    };
  } finally {
    clearTimeout(timer);
  }
}
