// TRMNL Node 20 Serverless. FX requests share a 3.8s deadline; never retry a poll.
// Liquid owns SVG drawing, layout and captions; keep data, chart math and Intl here.
const REQUEST_TIMEOUT_MS = 3800;
const DAY = 86400;
const STATE_LIMIT = 8192;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const MAX_MARKET_AGE = 7 * DAY;
const PLOT = { left: 4, right: 696, top: 12, bottom: 274 };
const RANGES = {
  '1d|1': { range: '1d', interval: '1m', seconds: 60 },
  '1m|30': { range: '1mo', interval: '30m', seconds: 1800 },
  '3m|60': { range: '3mo', interval: '60m', seconds: 3600 },
  '12m|1D': { range: '1y', interval: '1d', seconds: DAY },
  '60m|1W': { range: '5y', interval: '1wk', seconds: 7 * DAY },
  'all|1M': { range: 'max', interval: '1mo', seconds: 31 * DAY }
};
const LOCALES = { en: 'en-US', de_DE: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', pl: 'pl-PL' };
const positive = n => Number.isFinite(n) && n > 0;
const stamp = n => Number.isSafeInteger(n) && n > 0;
const barStamp = n => Number.isSafeInteger(n) && n >= -62135596800;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const round = n => +n.toPrecision(9);
const choose = (v, list, fallback) => list.includes(String(v)) ? String(v) : fallback;

function symbolFor(value) {
  let text;
  try { text = decodeURIComponent(String(value || 'NTNX').trim()).toUpperCase(); }
  catch { throw new Error('Use a Yahoo Finance symbol, e.g. NTNX or %5ESTOXX50E'); }
  if (!/^[A-Z0-9^][A-Z0-9.^=+&\-]{0,39}$/.test(text)) throw new Error('Invalid Yahoo Finance symbol');
  return text;
}

// Match polling_url using core Liquid filters only. Keep the list out of Saved
// State: a small checksum and cursor leave room for the latest successful chart.
function selection(input) {
  const value = input?.trmnl?.plugin_settings?.custom_fields_values?.symbol;
  const symbols = [...new Set(String(value || 'NTNX').toUpperCase().split(',').map(s => s.trim()).filter(Boolean))];
  if (!symbols.length) symbols.push('NTNX');
  const list = symbols.join(',');
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^.=+&-%,';
  let checksum = 0;
  for (const char of list) {
    const code = alphabet.indexOf(char);
    checksum = (checksum * 131 + (code < 0 ? alphabet.length : code)) % 2147483647;
  }
  const key = list.length + ':' + checksum;
  const saved = input?.trmnl?.state?.rotation;
  const index = saved?.key === key && Number.isSafeInteger(saved.next) && saved.next >= 0 && saved.next < symbols.length ? saved.next : 0;
  return { symbol: symbols[index], index, rotation: symbols.length > 1 ? { key, next: (index + 1) % symbols.length } : null };
}

function settings(input, selected = selection(input)) {
  const f = input?.trmnl?.plugin_settings?.custom_fields_values || {};
  const symbol = symbolFor(selected.symbol);
  const currency = String(f.currency || '').trim().toUpperCase() || 'NATIVE';
  if (!/^(NATIVE|[A-Z]{3})$/.test(currency)) throw new Error('Use a currency code, e.g. USD, EUR, BTC or NATIVE');
  const dateRanges = choose(f.dateRanges, Object.keys(RANGES), '12m|1D');
  const extended = ['show', 'true', 'yes'].includes(String(f.extendedHours));
  return {
    symbol, currency, dateRanges, ...RANGES[dateRanges], extended,
    key: [symbol, currency, dateRanges, extended ? 'extended' : 'regular'].join('|'),
    chartType: choose(f.chartType, ['line', 'bars', 'candles'], 'line'),
    locale: choose(f.locale, Object.keys(LOCALES), 'en'),
    lineType: choose(f.lineType, ['0', '1', '2'], '2'),
    volume: f.showVolume === true || f.showVolume === 'true' || f.showVolume === 'show',
    reference: f.showReference === true || f.showReference === 'true' || f.showReference === 'show',
    precision: choose(f.precision, ['auto', '0', '2', '4', '6'], 'auto')
  };
}

function yahooURL(symbol, config) {
  // yfinance's 30m workaround: request 15m once, then aggregate locally.
  const interval = config.interval === '30m' ? '15m' : config.interval;
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?range=' + config.range + '&interval=' + interval + '&includePrePost=' + config.extended;
}
function localDay(t, zone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000));
}
function validZone(zone) {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return zone; }
  catch { return 'UTC'; }
}

function sameBar(start, time, config, timezone) {
  if (['1d', '1wk', '1mo'].includes(config.interval)) {
    const a = localDay(start, timezone), b = localDay(time, timezone);
    if (config.interval === '1mo') return a.slice(0, 7) === b.slice(0, 7);
    // Compare exchange calendar days so a DST change does not shorten a week.
    if (config.interval === '1wk') return Date.parse(b) - Date.parse(a) < 7 * DAY * 1000;
    return a === b;
  }
  return time - start < config.seconds;
}

// Each candle is [time, open, high, low, close, volume]. Never invent OHLC/volume.
function parseYahoo(payload, now, config, expectedSymbol = config.symbol, fx = false) {
  const results = payload?.chart?.result;
  const reason = payload?.chart?.error?.description;
  if (payload?.chart?.error && typeof reason === 'string' && reason.trim()) {
    throw new Error(`${fx ? 'FX' : 'Yahoo'}: ${reason.trim().replace(/\s+/g, ' ').slice(0, 140)}`);
  }
  if (payload?.chart?.error || !Array.isArray(results) || results.length !== 1) throw new Error('Symbol or range unavailable from Yahoo');
  const { meta: m, timestamp: times, indicators } = results[0] || {};
  const q = indicators?.quote?.[0];
  const accepted = config.interval === '30m' ? ['15m', '30m'] : config.interval === '60m' ? ['60m', '1h'] : [config.interval];
  if (String(m?.symbol).toUpperCase() !== expectedSymbol) throw new Error('Provider returned a different symbol');
  if (!positive(m.regularMarketPrice) || !stamp(m.regularMarketTime) || m.regularMarketTime > now + 300) throw new Error('Invalid provider quote or timestamp');
  if (!accepted.includes(m.dataGranularity)) throw new Error(`${fx ? 'FX' : 'Provider'} interval ${String(m.dataGranularity).slice(0, 10)} unavailable for ${config.interval}`);
  if (!Array.isArray(times) || !Array.isArray(q?.close) || times.length !== q.close.length || times.length > 30000) throw new Error('Invalid provider price series');
  if (typeof m.currency !== 'string' || !/^[A-Za-z]{3}$/.test(m.currency)) throw new Error('Provider currency unavailable');
  const timezone = validZone(m.exchangeTimezoneName || 'UTC');
  const major = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ILA: 'ILS' }[m.currency];
  const unit = major ? 0.01 : 1;
  const currency = major || m.currency.toUpperCase();
  const bars = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!barStamp(t) || t > now + 300 || (i && (t < times[i - 1] || (t === times[i - 1] && i !== times.length - 1)))) throw new Error('Invalid market timestamps');
    if (!positive(q.close[i])) continue;
    const c = q.close[i] * unit;
    const o = positive(q.open?.[i]) ? q.open[i] * unit : null;
    const h = positive(q.high?.[i]) ? q.high[i] * unit : null;
    const l = positive(q.low?.[i]) ? q.low[i] * unit : null;
    const ohlc = positive(o) && positive(h) && positive(l) && h >= Math.max(o, c) - 1e-7 && l <= Math.min(o, c) + 1e-7;
    bars.push([t, ohlc ? o : null, ohlc ? Math.max(h, o, c) : null, ohlc ? Math.min(l, o, c) : null, c,
      Number.isFinite(q.volume?.[i]) && q.volume[i] >= 0 ? q.volume[i] : null]);
  }
  const historyTime = bars.at(-1)?.[0];
  // Yahoo can append a separate live row for the current day/week/month.
  // Daily/identical-time rows are revised snapshots; longer candles accumulate.
  if (bars.length > 1) {
    const a = bars.at(-2), b = bars.at(-1);
    if (a[0] === b[0] || (config.seconds >= DAY && sameBar(a[0], b[0], config, timezone))) {
      bars.splice(-2, 2, a[0] === b[0] || config.interval === '1d' ? b : combine([a, b]));
    }
  }
  if (bars.length < 2) throw new Error('Not enough prices for this range');
  const price = m.regularMarketPrice * unit;
  const quoteTime = m.regularMarketTime;
  const last = bars.at(-1);
  // Extended-hours bars may be newer than the regular-session quote. Keep those
  // bars and quote their last close with its own timestamp; never rewind the path.
  let market_at = quoteTime;
  let latest = price;
  if (config.extended && historyTime > quoteTime) { latest = last[4]; market_at = historyTime; }
  else {
    if (historyTime > quoteTime || quoteTime - historyTime > Math.max(MAX_MARKET_AGE, config.seconds * 2)) throw new Error('Quote and history are out of sync');
    if (sameBar(last[0], quoteTime, config, timezone)) {
      last[4] = price;
      if (last[1] !== null) { last[2] = Math.max(last[2], price); last[3] = Math.min(last[3], price); }
    } else bars.push([quoteTime, null, null, null, price, null]);
  }
  // Both asset and FX requests use 15m bars for the displayed 30m interval.
  const normalized = config.interval === '30m' && m.dataGranularity === '15m' ? aggregateByTime(bars, 1800) : bars;
  const previous = positive(m.chartPreviousClose) ? m.chartPreviousClose : m.previousClose;
  return { bars: normalized, symbol: expectedSymbol, name: String(m.longName || m.shortName || expectedSymbol).slice(0, 140),
    currency, native_currency: currency, timezone, price: latest, market_at,
    previous_close: positive(previous) ? previous * unit : null };
}

function combine(group) {
  const complete = group.every(b => b[1] !== null);
  const volume = group.every(b => b[5] !== null);
  return [group[0][0], complete ? group[0][1] : null,
    complete ? Math.max(...group.map(b => b[2])) : null,
    complete ? Math.min(...group.map(b => b[3])) : null, group.at(-1)[4],
    volume ? group.reduce((sum, b) => sum + b[5], 0) : null];
}
function aggregateByTime(bars, seconds) {
  const groups = [];
  for (const bar of bars) {
    const bucket = Math.floor(bar[0] / seconds);
    if (groups.at(-1)?.bucket !== bucket) groups.push({ bucket, rows: [] });
    groups.at(-1).rows.push(bar);
  }
  return groups.map(g => combine(g.rows));
}

function makeState(data, config, now, rotation = null) {
  const baseline = config.range === '1d' && positive(data.previous_close) ? data.previous_close : data.bars[0][4];
  let group = Math.max(1, Math.ceil(data.bars.length / 360));
  let state;
  do {
    const bars = [];
    // Keep timestamps exact: rounding can move an appended quote after market_at.
    for (let i = 0; i < data.bars.length; i += group) bars.push(combine(data.bars.slice(i, i + group)).map((n, j) => n === null || j === 0 ? n : round(n)));
    state = { v: 2, key: config.key, symbol: data.symbol, name: data.name, currency: data.currency,
      native_currency: data.native_currency, timezone: data.timezone, market_at: data.market_at, fetched_at: now,
      price: data.price, baseline,
      return_basis: config.range === '1d' && positive(data.previous_close) ? 'previous_close' : 'first_close', fx_at: data.fx_at || null, fx_rate: data.fx_rate || null,
      group, source_count: data.bars.length, bars, ...(rotation ? { rotation } : {}) };
    group++;
  } while ((state.bars.length > 360 || bytes(state) > STATE_LIMIT) && group < data.bars.length);
  if (!validState(state, now, config)) throw new Error('Saved chart could not be validated');
  return state;
}

function rotateState(latest, rotation) {
  if (!rotation) return latest;
  const state = { ...latest, rotation };
  // An old single-ticker snapshot may already occupy all 8 KB. Group it just
  // enough to fit the cursor, without accumulating charts or losing OHLCV.
  for (let factor = 2; bytes(state) > STATE_LIMIT && factor < latest?.bars.length; factor++) {
    state.bars = [];
    for (let i = 0; i < latest.bars.length; i += factor) state.bars.push(combine(latest.bars.slice(i, i + factor)));
    state.group = latest.group * factor;
  }
  return bytes(state) <= STATE_LIMIT ? state : { rotation };
}

function validState(s, now, config) {
  return !!s && s.v === 2 && (!config || s.key === config.key) && typeof s.key === 'string' && s.key.length < 150 &&
    typeof s.symbol === 'string' && (!config || (s.symbol === config.symbol &&
      s.currency === (config.currency === 'NATIVE' ? s.native_currency : config.currency) &&
      (config.range !== '1d' || s.fx_at === null || s.return_basis === 'first_close'))) && typeof s.name === 'string' && s.name.length <= 140 &&
    /^[A-Z]{3}$/.test(s.currency) && /^[A-Z]{3}$/.test(s.native_currency) &&
    typeof s.timezone === 'string' && validZone(s.timezone) === s.timezone &&
    stamp(s.market_at) && stamp(s.fetched_at) && s.market_at <= now + 300 && s.fetched_at <= now + 300 &&
    positive(s.price) && positive(s.baseline) &&
    (s.fx_at === null ? s.fx_rate === null && s.currency === s.native_currency :
      stamp(s.fx_at) && s.fx_at <= now + 300 && positive(s.fx_rate) && s.currency !== s.native_currency) &&
    (s.return_basis === undefined || ['previous_close', 'first_close'].includes(s.return_basis)) &&
    Number.isSafeInteger(s.group) && s.group >= 1 && Number.isSafeInteger(s.source_count) &&
    Array.isArray(s.bars) && s.bars.length >= 2 && s.bars.length <= 360 && s.source_count >= s.bars.length && s.source_count <= 30001 &&
    Math.ceil(s.source_count / s.group) === s.bars.length &&
    s.bars.every((b, i) => Array.isArray(b) && b.length === 6 && barStamp(b[0]) && b[0] <= s.market_at &&
      (!i || b[0] > s.bars[i - 1][0]) && positive(b[4]) &&
      ((b[1] === null && b[2] === null && b[3] === null) ||
        (positive(b[1]) && positive(b[2]) && positive(b[3]) && b[2] >= Math.max(b[1], b[4]) && b[3] <= Math.min(b[1], b[4]))) &&
      (b[5] === null || (Number.isFinite(b[5]) && b[5] >= 0))) && bytes(s) <= STATE_LIMIT;
}

function conversionPlan(from, to) {
  if (to === 'NATIVE' || to === from) return [];
  if (['BTC', 'ETH'].includes(to)) return [
    ...(from === 'USD' ? [] : [{ symbol: from + 'USD=X', divide: false }]),
    { symbol: to + '-USD', divide: true }
  ];
  return [{ symbol: from + to + '=X', divide: false }];
}
function convert(data, rates, config) {
  if (!rates.length) return data;
  const at = (series, t) => {
    let left = 0, right = series.bars.length - 1, found = -1;
    while (left <= right) { const mid = (left + right) >> 1; if (series.bars[mid][0] <= t) { found = mid; left = mid + 1; } else right = mid - 1; }
    if (found < 0 || t - series.bars[found][0] > Math.max(MAX_MARKET_AGE, config.seconds * 2)) throw new Error('Historical exchange rate unavailable');
    return series.bars[found][4];
  };
  const factorAt = t => rates.reduce((v, r) => r.divide ? v / at(r.data, t) : v * at(r.data, t), 1);
  const current = rates.reduce((v, r) => r.divide ? v / r.data.price : v * r.data.price, 1);
  if (!positive(current) || rates.some(r => Math.abs(r.data.market_at - data.market_at) > MAX_MARKET_AGE)) throw new Error('Exchange rate is out of date');
  const bars = data.bars.map(b => {
    const factor = factorAt(b[0]);
    return b.map((n, i) => i >= 1 && i <= 4 && n !== null ? n * factor : n);
  });
  const last = bars.at(-1);
  last[4] = data.price * current;
  if (last[1] !== null) {
    last[2] = Math.max(last[2], last[4]);
    last[3] = Math.min(last[3], last[4]);
  }
  return { ...data, bars, price: data.price * current, currency: config.currency,
    // The quote has no reliable previous-close timestamp. A converted 1D
    // return therefore starts at its first aligned bar, labelled in the view.
    previous_close: null,
    fx_at: Math.min(...rates.map(r => r.data.market_at)), fx_rate: current };
}

function curveSegments(points) {
  if (points.length < 2) return [];
  const segments = [];
  // A monotone cubic stays inside each pair's price range: smoothing must not
  // manufacture highs/lows. Zero the tangent at every local extremum.
  const slopes = points.slice(1).map((p, i) => (p.y - points[i].y) / (p.x - points[i].x));
  const tangents = points.map((_, i) => !i ? slopes[0] : i === points.length - 1 ? slopes.at(-1) :
    slopes[i - 1] * slopes[i] <= 0 ? 0 : 2 / (1 / slopes[i - 1] + 1 / slopes[i]));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = (b.x - a.x) / 3;
    // Clamp the control points too, including the end tangents.
    const clamp = v => Math.max(Math.min(a.y, b.y), Math.min(Math.max(a.y, b.y), v));
    segments.push([a.x + dx, clamp(a.y + tangents[i - 1] * dx), b.x - dx, clamp(b.y - tangents[i] * dx), b.x, b.y]
      .map(n => +n.toFixed(1)));
  }
  return segments;
}

function chart(state, config, formatNumber, limit = 96) {
  const factor = config.chartType !== 'line' && state.bars.some(b => b[1] !== null) ? Math.max(1, Math.ceil(state.bars.length / limit)) : 1;
  if (factor > 1) {
    const bars = [];
    for (let i = 0; i < state.bars.length; i += factor) bars.push(combine(state.bars.slice(i, i + factor)));
    state = { ...state, bars, group: state.group * factor };
  }
  const hasOHLC = state.bars.some(b => b[1] !== null);
  const candles = config.chartType !== 'line' && hasOHLC;
  const values = state.bars.flatMap(b => candles && b[1] !== null ? [b[2], b[3]] : [b[4]]);
  if (config.reference) values.push(state.baseline);
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max((high - low) * 0.08, high * 0.005, 1e-9);
  const min = Math.max(0, low - padding), max = high + padding;
  const hasVolume = config.volume && state.bars.some(b => b[5] !== null && b[5] > 0);
  const bottom = hasVolume ? 216 : PLOT.bottom;
  const y = p => bottom - (p - min) / (max - min) * (bottom - PLOT.top);
  // Session spacing removes overnight/weekend voids, as a market chart should.
  const width = Math.max(0.8, Math.min(candles ? 18 : 9, 500 / state.bars.length));
  const inset = candles ? Math.max(PLOT.left, width / 2 + 1) : PLOT.left;
  const x = i => inset + i / (state.bars.length - 1) * (700 - 2 * inset);
  const points = state.bars.map((b, i) => ({ x: x(i), y: y(b[4]) }));
  const f = n => +n.toFixed(1);
  // Candle coordinates: center, left, right, open, high, low, close, height, change.
  const candlePoints = candles ? state.bars.map((b, i) => [f(x(i)), f(x(i) - width / 2), f(x(i) + width / 2),
    ...[b[1], b[2], b[3], b[4]].map(p => p === null ? null : f(y(p))),
    b[1] === null ? null : f(Math.max(0.8, Math.abs(y(b[1]) - y(b[4])))),
    b[1] === null ? null : b[4] - b[1]]) : [];
  const maxVolume = Math.max(1, ...state.bars.map(b => b[5] || 0));
  const volumes = hasVolume ? state.bars.flatMap((b, i) => b[5] === null ? [] : [[f(x(i)), f(274 - b[5] / maxVolume * 40)]]) : [];
  const date = new Intl.DateTimeFormat(LOCALES[config.locale], {
    timeZone: state.timezone, ...(config.range === '1d' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } :
      config.range === '1mo' || config.range === '3mo' ? { month: 'short', day: 'numeric' } : { month: 'short', year: '2-digit' })
  });
  const dates = [0, Math.round((state.bars.length - 1) / 2), state.bars.length - 1].map(i => ({
    x: x(i), label: date.format(new Date(state.bars[i][0] * 1000))
  }));
  return { points: candles ? [] : points.map(p => [f(p.x), f(p.y)]),
    curves: !candles && config.lineType === '2' ? curveSegments(points) : [], candles: candlePoints, volumes,
    body_width: f(width), volume_width: width,
    reference_y: y(state.baseline), last_y: points.at(-1).y,
    ticks: [0, 0.5, 1].map(r => ({ y: PLOT.top + r * (bottom - PLOT.top), label: formatNumber(max - r * (max - min)) })), dates,
    has_ohlc: hasOHLC, has_volume: hasVolume, group: state.group };
}

function display(state, stale, detail, config) {
  const base = { has_data: false, stale: true, detail, symbol: config.symbol, currency: config.currency,
    range: config.range, interval: config.interval, extended: config.extended,
    chart_type: config.chartType };
  if (!state) return base;
  const digits = config.precision === 'auto' ? (state.currency === 'BTC' || state.currency === 'ETH' || state.price < 1 ? 6 : state.currency === 'JPY' ? 0 : 2) : +config.precision;
  const formatter = new Intl.NumberFormat(LOCALES[config.locale], { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const signed = (n, digits) => new Intl.NumberFormat(LOCALES[config.locale], {
    minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: 'exceptZero'
  }).format(n).replace('-', '−');
  const date = new Date(state.market_at * 1000);
  const marketLabel = options => date.toLocaleString(LOCALES[config.locale], {
    timeZone: state.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...options });
  const change = state.price - state.baseline;
  const percent = change / state.baseline * 100;
  const result = { ...base, ...chart(state, config, formatter.format), has_data: true, stale, detail, name: state.name, currency: state.currency,
    price: state.price, change, percent, digits,
    price_label: formatter.format(state.price),
    percent_label: signed(percent, 2),
    absolute_change_label: signed(change, digits),
    market_at: state.market_at, market_iso: date.toISOString(), market_label: marketLabel({ year: 'numeric', timeZoneName: 'short' }), market_label_compact: marketLabel(),
    native_currency: state.native_currency, return_basis: state.return_basis,
    fx_iso: state.fx_at ? new Date(state.fx_at * 1000).toISOString() : '' };
  if (config.chartType !== 'line' && result.has_ohlc) result.charts = {
    compact: { ...result, ...chart(state, config, formatter.format, 32) },
    detailed: { ...result, ...chart(state, config, formatter.format, 192) }
  };
  return result;
}

// Limit each body before JSON parsing so a provider error page or unexpectedly
// large history cannot consume the VM's memory/runtime budget.
async function readResponse(response) {
  if (Number(response.headers?.get?.('content-length')) > RESPONSE_LIMIT) throw new Error('Provider response exceeds 2 MiB');
  if (!response.body?.getReader) {
    const payload = await response.json();
    if (bytes(payload) > RESPONSE_LIMIT) throw new Error('Provider response exceeds 2 MiB');
    return payload;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, body = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error('Provider response exceeds 2 MiB');
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally { reader.releaseLock(); }
}

async function run(input) {
  const now = Math.floor(Date.now() / 1000);
  const selected = selection(input);
  // Native failed polls have no payload, and TRMNL skips their state writes.
  const rotation = selected.rotation && { ...selected.rotation, next: input?.chart === undefined ? selected.index : selected.rotation.next };
  const latest = validState(input?.trmnl?.state, now) ? input.trmnl.state : null;
  let config;
  try { config = settings(input, selected); }
  catch (error) {
    return { stonks: display(null, true, error.message, { ...settings({}), symbol: selected.symbol.slice(0, 40) }),
      ...(rotation ? { trmnl_state: rotateState(latest, rotation) } : {}) };
  }
  const previous = latest && validState(latest, now, config) ? latest : null;
  const controller = new AbortController();
  let timer;
  try {
    // Failed native polls arrive without chart or HTTP status. Never request
    // the stock again, even on a fresh install without saved data.
    if (input?.chart === undefined) throw new Error('Yahoo polling failed');
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Request timed out')); }, REQUEST_TIMEOUT_MS);
    });
    const request = async (symbol, c) => {
      const response = await fetch(yahooURL(symbol, c), { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) throw new Error(`FX HTTP ${response.status}`);
      return parseYahoo(await readResponse(response), now, c, symbol, true);
    };
    const work = (async () => {
      const data = parseYahoo(input, now, config);
      const plan = conversionPlan(data.currency, config.currency);
      // A five-day FX window also covers gaps before the first intraday bar.
      const fxConfig = { ...config, range: config.range === '1d' ? '5d' : config.range, extended: false };
      const rates = await Promise.all(plan.map(async p => ({ ...p, data: await request(p.symbol, fxConfig) })));
      return makeState(convert(data, rates, config), config, now, rotation);
    })();
    const state = await Promise.race([work, deadline]);
    if (previous && state.market_at < previous.market_at) throw new Error('Provider returned older data');
    if (previous?.fx_at && state.fx_at && state.fx_at < previous.fx_at) throw new Error('Provider returned older exchange rate');
    const detail = now - state.market_at > MAX_MARKET_AGE ? 'Provider prices are over 7 days old' :
      state.fx_at && now - state.fx_at > MAX_MARKET_AGE ? 'Exchange rate is over 7 days old' : '';
    return { stonks: display(state, !!detail, detail, config), trmnl_state: state };
  } catch (error) {
    const detail = controller.signal.aborted ? 'Request timed out' : String(error?.message || 'Market data unavailable').slice(0, 160);
    const state = rotateState(rotation ? latest : previous, rotation);
    return { stonks: display(previous, true, detail, config), ...(state ? { trmnl_state: state } : {}) };
  } finally { clearTimeout(timer); controller.abort(); }
}
