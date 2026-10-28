// TRMNL Node 20 Serverless. Provider requests and rendering share a 3.8s deadline.
// All network access stays here; the Shared view contains no remote widget or JS.
const REQUEST_TIMEOUT_MS = 3800;
const DAY = 86400;
const STATE_LIMIT = 8192;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const MAX_MARKET_AGE = 7 * DAY;
const PLOT = { left: 4, right: 696, top: 12, bottom: 274 };
const RANGES = {
  '1d|1': { range: '1d', interval: '1m', seconds: 60, label: '1D' },
  '1m|30': { range: '1mo', interval: '30m', seconds: 1800, label: '1M' },
  '3m|60': { range: '3mo', interval: '60m', seconds: 3600, label: '3M' },
  '12m|1D': { range: '1y', interval: '1d', seconds: DAY, label: '1Y' },
  '60m|1W': { range: '5y', interval: '1wk', seconds: 7 * DAY, label: '5Y' },
  'all|1M': { range: 'max', interval: '1mo', seconds: 31 * DAY, label: 'ALL' }
};
const LOCALES = { en: 'en-US', de_DE: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', pl: 'pl-PL' };
const COPY = {
  en: ['DATA UNAVAILABLE', 'STALE DATA', 'Next refresh will try again.', 'Volume', 'Low', 'High', 'Market data', 'FX estimate', 'Extended', 'Regular', 'Saved chart', 'Invalid settings', 'No saved prices for this selection', 'from first bar'],
  de_DE: ['KEINE DATEN', 'ALTE DATEN', 'Erneuter Versuch beim nächsten Update.', 'Volumen', 'Tief', 'Hoch', 'Marktdaten', 'FX-Schätzung', 'Erweitert', 'Regulär', 'Gespeichert', 'Ungültige Einstellungen', 'Keine gespeicherten Kurse für diese Auswahl', 'ab erstem Kurs'],
  fr: ['DONNÉES INDISPONIBLES', 'DONNÉES ANCIENNES', 'Nouvel essai à la prochaine mise à jour.', 'Volume', 'Bas', 'Haut', 'Données du marché', 'Estimation FX', 'Étendue', 'Normale', 'Enregistré', 'Réglages invalides', 'Aucun cours enregistré pour cette sélection', 'depuis le premier cours'],
  es: ['DATOS NO DISPONIBLES', 'DATOS ANTIGUOS', 'Se intentará en la próxima actualización.', 'Volumen', 'Mín.', 'Máx.', 'Datos de mercado', 'Estimación FX', 'Extendida', 'Regular', 'Guardado', 'Ajustes no válidos', 'Sin precios guardados para esta selección', 'desde el primer precio'],
  it: ['DATI NON DISPONIBILI', 'DATI NON AGGIORNATI', 'Nuovo tentativo al prossimo aggiornamento.', 'Volume', 'Min.', 'Max.', 'Dati di mercato', 'Stima FX', 'Estesa', 'Regolare', 'Salvato', 'Impostazioni non valide', 'Nessun prezzo salvato per questa selezione', 'dal primo prezzo'],
  pl: ['BRAK DANYCH', 'NIEAKTUALNE DANE', 'Kolejna próba przy następnym odświeżeniu.', 'Wolumen', 'Min.', 'Maks.', 'Dane rynkowe', 'Szacunek FX', 'Rozszerzona', 'Zwykła', 'Zapisany', 'Nieprawidłowe ustawienia', 'Brak zapisanych cen dla tego wyboru', 'od pierwszej ceny']
};
const positive = n => Number.isFinite(n) && n > 0;
const stamp = n => Number.isSafeInteger(n) && n > 0;
const barStamp = n => Number.isSafeInteger(n) && n >= -62135596800;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const round = n => +n.toPrecision(9);
const choose = (v, list, fallback) => list.includes(String(v)) ? String(v) : fallback;
const bounded = (v, min, max, fallback) => v === '' || v == null || !Number.isFinite(+v) ? fallback : Math.min(max, Math.max(min, +v));

function symbolFor(value) {
  let text;
  try { text = decodeURIComponent(String(value || 'NTNX').trim()).toUpperCase(); }
  catch { throw new Error('Use a Yahoo Finance symbol, e.g. NTNX or VWCE.DE'); }
  if (text.includes(':')) {
    const [exchange, ticker, extra] = text.split(':');
    if (extra || !ticker) throw new Error('Invalid symbol');
    const indices = { 'SP:SPX': '^GSPC', 'NASDAQ:NDX': '^NDX', 'DJ:DJI': '^DJI', 'TVC:VIX': '^VIX' };
    if (indices[text]) return indices[text];
    const suffix = { NASDAQ: '', NYSE: '', AMEX: '', NYSEARCA: '', ARCA: '', CBOE: '', XETR: '.DE', XETRA: '.DE', LSE: '.L', EURONEXT: '.PA', BME: '.MC', MIL: '.MI', SIX: '.SW', TSX: '.TO', ASX: '.AX', TSE: '.T', HKEX: '.HK' };
    if (exchange === 'FX' || exchange === 'FX_IDC') {
      if (!/^[A-Z]{6}$/.test(ticker)) throw new Error('Use a Yahoo forex symbol, e.g. EURUSD=X');
      text = ticker + '=X';
    } else if (['BINANCE', 'COINBASE', 'BITSTAMP', 'KRAKEN'].includes(exchange)) {
      const pair = ticker.match(/^([A-Z0-9]+?)(USDT|USD|EUR|GBP|BTC)$/);
      if (!pair) throw new Error('Use a Yahoo crypto symbol, e.g. BTC-USD');
      text = pair[1] + '-' + (pair[2] === 'USDT' ? 'USD' : pair[2]);
    } else if (Object.hasOwn(suffix, exchange)) text = ticker + suffix[exchange];
    else throw new Error('Unknown exchange; enter the exact Yahoo Finance symbol');
  }
  if (!/^[A-Z0-9^][A-Z0-9.^=\-]{0,39}$/.test(text)) throw new Error('Invalid Yahoo Finance symbol');
  return text;
}

function settings(input) {
  const f = input?.trmnl?.plugin_settings?.custom_fields_values || {};
  const symbol = symbolFor(f.symbol);
  const currency = String(f.currency || 'USD').trim().toUpperCase();
  if (!/^(NATIVE|[A-Z]{3})$/.test(currency)) throw new Error('Use a currency code, e.g. USD, EUR, BTC or NATIVE');
  const dateRanges = choose(f.dateRanges, Object.keys(RANGES), '12m|1D');
  const extended = ['show', 'true', 'yes'].includes(String(f.extendedHours));
  return {
    symbol, currency, dateRanges, ...RANGES[dateRanges], extended,
    key: [symbol, currency, dateRanges, extended ? 'extended' : 'regular'].join('|'),
    chartType: choose(f.chartType, ['line', 'bars', 'candles'], 'line'),
    locale: choose(f.locale, Object.keys(LOCALES), 'en'),
    lineWidth: bounded(f.lineWidth, 1, 5, 2), lineType: choose(f.lineType, ['0', '1', '2'], '2'),
    grid: f.showGridlines === 'show', volume: f.showVolume === 'show',
    reference: f.showReference === 'show',
    header: choose(f.headerFontSize, ['small', 'medium', 'large'], 'medium'),
    fontSize: bounded(f.fontSize, 8, 16, 10), precision: choose(f.precision, ['auto', '0', '2', '4', '6'], 'auto')
  };
}

function yahooURL(symbol, config) {
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?range=' + config.range + '&interval=' + config.interval + '&includePrePost=' + config.extended;
}
function localDay(t, zone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000));
}
function validZone(zone) {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return zone; }
  catch { return 'UTC'; }
}

// Each candle is [time, open, high, low, close, volume]. Never invent OHLC/volume.
function parseYahoo(payload, now, config, expectedSymbol = config.symbol, fx = false) {
  const results = payload?.chart?.result;
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
  const unit = ['GBp', 'GBX', 'ZAc'].includes(m.currency) ? 0.01 : 1;
  const currency = ['GBp', 'GBX'].includes(m.currency) ? 'GBP' : m.currency === 'ZAc' ? 'ZAR' : m.currency.toUpperCase();
  const bars = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!barStamp(t) || t > now + 300 || (i && t <= times[i - 1])) throw new Error('Invalid market timestamps');
    if (!positive(q.close[i])) continue;
    const c = q.close[i] * unit;
    const o = positive(q.open?.[i]) ? q.open[i] * unit : null;
    const h = positive(q.high?.[i]) ? q.high[i] * unit : null;
    const l = positive(q.low?.[i]) ? q.low[i] * unit : null;
    const ohlc = positive(o) && positive(h) && positive(l) && h >= Math.max(o, c) - 1e-7 && l <= Math.min(o, c) + 1e-7;
    bars.push([t, ohlc ? o : null, ohlc ? Math.max(h, o, c) : null, ohlc ? Math.min(l, o, c) : null, c,
      Number.isFinite(q.volume?.[i]) && q.volume[i] >= 0 ? q.volume[i] : null]);
  }
  if (bars.length < 2) throw new Error('Not enough prices for this range');
  const price = m.regularMarketPrice * unit;
  const quoteTime = m.regularMarketTime;
  const last = bars.at(-1);
  // Extended-hours bars may be newer than the regular-session quote. Keep those
  // bars and quote their last close with its own timestamp; never rewind the path.
  let market_at = quoteTime;
  let latest = price;
  if (config.extended && last[0] > quoteTime) { latest = last[4]; market_at = last[0]; }
  else {
    if (last[0] > quoteTime || quoteTime - last[0] > Math.max(MAX_MARKET_AGE, config.seconds * 2)) throw new Error('Quote and history are out of sync');
    const same = config.interval === '1d' ? localDay(last[0], timezone) === localDay(quoteTime, timezone) :
      config.interval === '1mo' ? localDay(last[0], timezone).slice(0, 7) === localDay(quoteTime, timezone).slice(0, 7) :
      quoteTime - last[0] < config.seconds;
    if (same) {
      last[4] = price;
      if (last[1] !== null) { last[2] = Math.max(last[2], price); last[3] = Math.min(last[3], price); }
    } else bars.push([quoteTime, null, null, null, price, null]);
  }
  // Yahoo occasionally answers 30m with 15m bars. Aggregate rather than relabel.
  const normalized = !fx && config.interval === '30m' && m.dataGranularity === '15m' ? aggregateByTime(bars, 1800) : bars;
  return { bars: normalized, symbol: expectedSymbol, name: String(m.longName || m.shortName || expectedSymbol).slice(0, 140),
    currency, native_currency: currency, timezone, price: latest, market_at,
    previous_close: positive(m.chartPreviousClose || m.previousClose) ? (m.chartPreviousClose || m.previousClose) * unit : null };
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

function makeState(data, config, now) {
  const baseline = config.range === '1d' && positive(data.previous_close) ? data.previous_close : data.bars[0][4];
  const high = Math.max(...data.bars.map(b => b[2] ?? b[4]));
  const low = Math.min(...data.bars.map(b => b[3] ?? b[4]));
  let group = 1;
  let state;
  do {
    const bars = [];
    for (let i = 0; i < data.bars.length; i += group) bars.push(combine(data.bars.slice(i, i + group)).map(n => n === null ? null : round(n)));
    state = { v: 2, key: config.key, symbol: data.symbol, name: data.name, currency: data.currency,
      native_currency: data.native_currency, timezone: data.timezone, market_at: data.market_at, fetched_at: now,
      price: data.price, baseline, high, low,
      return_basis: config.range === '1d' && positive(data.previous_close) ? 'previous_close' : 'first_close', fx_at: data.fx_at || null, fx_rate: data.fx_rate || null,
      group, source_count: data.bars.length, bars };
    group++;
  } while ((state.bars.length > 360 || bytes(state) > STATE_LIMIT) && group < data.bars.length);
  if (!validState(state, now, config)) throw new Error('Saved chart could not be validated');
  return state;
}

function validState(s, now, config) {
  return !!s && s.v === 2 && (!config || s.key === config.key) && typeof s.key === 'string' && s.key.length < 150 &&
    typeof s.symbol === 'string' && (!config || (s.symbol === config.symbol &&
      s.currency === (config.currency === 'NATIVE' ? s.native_currency : config.currency) &&
      (config.range !== '1d' || s.fx_at === null || s.return_basis === 'first_close'))) && typeof s.name === 'string' && s.name.length <= 140 &&
    /^[A-Z]{3}$/.test(s.currency) && /^[A-Z]{3}$/.test(s.native_currency) &&
    typeof s.timezone === 'string' && validZone(s.timezone) === s.timezone &&
    stamp(s.market_at) && stamp(s.fetched_at) && s.market_at <= now + 300 && s.fetched_at <= now + 300 &&
    positive(s.price) && positive(s.baseline) && positive(s.high) && positive(s.low) && s.high >= s.low &&
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
  bars.at(-1)[4] = data.price * current;
  if (bars.at(-1)[1] !== null) {
    bars.at(-1)[2] = Math.max(bars.at(-1)[2], bars.at(-1)[4]);
    bars.at(-1)[3] = Math.min(bars.at(-1)[3], bars.at(-1)[4]);
  }
  return { ...data, bars, price: data.price * current, currency: config.currency,
    // The quote has no reliable previous-close timestamp. A converted 1D
    // return therefore starts at its first aligned bar, labelled in the view.
    previous_close: null,
    fx_at: Math.min(...rates.map(r => r.data.market_at)), fx_rate: current };
}

function linePath(points, type) {
  if (!points.length) return '';
  const f = n => n.toFixed(1);
  let path = `M${f(points[0].x)},${f(points[0].y)}`;
  // A monotone cubic stays inside each pair's price range: smoothing must not
  // manufacture highs/lows. Zero the tangent at every local extremum.
  const slopes = points.slice(1).map((p, i) => (p.y - points[i].y) / (p.x - points[i].x));
  const tangents = points.map((_, i) => !i ? slopes[0] : i === points.length - 1 ? slopes.at(-1) :
    slopes[i - 1] * slopes[i] <= 0 ? 0 : 2 / (1 / slopes[i - 1] + 1 / slopes[i]));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (type === '1') path += `H${f(b.x)}V${f(b.y)}`;
    else if (type === '2') {
      const dx = (b.x - a.x) / 3;
      // Clamp the control points too, including the end tangents.
      const clamp = v => Math.max(Math.min(a.y, b.y), Math.min(Math.max(a.y, b.y), v));
      path += `C${f(a.x + dx)},${f(clamp(a.y + tangents[i - 1] * dx))},${f(b.x - dx)},${f(clamp(b.y - tangents[i] * dx))},${f(b.x)},${f(b.y)}`;
    } else path += `L${f(b.x)},${f(b.y)}`;
  }
  return path;
}

function chart(state, config) {
  const candles = config.chartType !== 'line';
  const values = state.bars.flatMap(b => candles && b[1] !== null ? [b[2], b[3]] : [b[4]]);
  if (config.reference) values.push(state.baseline);
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max((high - low) * 0.08, high * 0.005, 1e-9);
  const min = Math.max(0, low - padding), max = high + padding;
  const hasVolume = config.volume && state.bars.some(b => b[5] !== null && b[5] > 0);
  const bottom = hasVolume ? 216 : PLOT.bottom;
  const y = p => bottom - (p - min) / (max - min) * (bottom - PLOT.top);
  // Session spacing removes overnight/weekend voids, as a market chart should.
  const x = i => PLOT.left + i / (state.bars.length - 1) * (PLOT.right - PLOT.left);
  const width = Math.max(0.8, Math.min(9, 500 / state.bars.length));
  const points = state.bars.map((b, i) => ({ x: x(i), y: y(b[4]) }));
  let up = '', down = '', missing = '';
  const f = n => n.toFixed(1);
  for (const [i, b] of state.bars.entries()) {
    if (b[1] === null) { missing += `M${f(x(i) - width / 2)},${f(y(b[4]))}h${f(width)}`; continue; }
    const cx = x(i), half = width / 2;
    let p = `M${f(cx)},${f(y(b[2]))}V${f(y(b[3]))}`;
    if (config.chartType === 'bars') p += `M${f(cx - half)},${f(y(b[1]))}H${f(cx)}M${f(cx)},${f(y(b[4]))}H${f(cx + half)}`;
    else {
      const top = Math.min(y(b[1]), y(b[4]));
      const height = Math.max(0.8, Math.abs(y(b[1]) - y(b[4])));
      p += `M${f(cx - half)},${f(top)}h${f(width)}v${f(height)}h-${f(width)}Z`;
    }
    if (b[4] >= b[1]) up += p; else down += p;
  }
  const maxVolume = Math.max(1, ...state.bars.map(b => b[5] || 0));
  const volume = hasVolume ? state.bars.map((b, i) => b[5] === null ? '' : `M${f(x(i))},274V${f(274 - b[5] / maxVolume * 40)}`).join('') : '';
  const digits = config.precision === 'auto' ? (state.currency === 'BTC' || state.currency === 'ETH' || state.price < 1 ? 6 : state.currency === 'JPY' ? 0 : 2) : +config.precision;
  const number = n => new Intl.NumberFormat(LOCALES[config.locale], { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  const dates = [0, Math.round((state.bars.length - 1) / 2), state.bars.length - 1].map(i => ({
    x: x(i), label: new Intl.DateTimeFormat(LOCALES[config.locale], {
      timeZone: state.timezone, ...(config.range === '1d' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } :
        config.range === '1mo' || config.range === '3mo' ? { month: 'short', day: 'numeric' } : { month: 'short', year: '2-digit' })
    }).format(new Date(state.bars[i][0] * 1000))
  }));
  return { path: linePath(points, config.lineType), up, down, volume_path: volume, volume_width: width,
    reference_y: y(state.baseline), last_y: points.at(-1).y,
    ticks: [0, 0.5, 1].map(r => ({ y: PLOT.top + r * (bottom - PLOT.top), label: number(max - r * (max - min)) })), dates,
    missing_path: missing, has_ohlc: state.bars.some(b => b[1] !== null), has_volume: hasVolume, digits };
}

function display(state, stale, detail, config) {
  const text = COPY[config.locale];
  const base = { has_data: false, stale: true, detail, symbol: config.symbol, currency: config.currency,
    range_label: config.label, chart_type: config.chartType, line_width: config.lineWidth,
    grid: config.grid, reference: config.reference, header: config.header, font_size: config.fontSize,
    labels: { unavailable: text[0], stale: text[1], retry: text[2], volume: text[3], low: text[4], high: text[5], market: text[6], fx: text[7], no_saved: text[12] } };
  if (!state) return base;
  const graphics = chart(state, config);
  const formatter = new Intl.NumberFormat(LOCALES[config.locale], { minimumFractionDigits: graphics.digits, maximumFractionDigits: graphics.digits });
  const signed = (n, digits) => (n < 0 ? '−' : '+') + new Intl.NumberFormat(LOCALES[config.locale], { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(n));
  const date = new Date(state.market_at * 1000);
  const compact = new Intl.DateTimeFormat(LOCALES[config.locale], { timeZone: state.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const full = new Intl.DateTimeFormat(LOCALES[config.locale], { timeZone: state.timezone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  const change = state.price - state.baseline;
  return { ...base, ...graphics, has_data: true, stale, detail, name: state.name, currency: state.currency,
    price: state.price, change, percent: change / state.baseline * 100,
    price_label: formatter.format(state.price),
    percent_label: signed(change / state.baseline * 100, 2) + '%',
    absolute_change_label: signed(change, graphics.digits),
    change_label: `${signed(change, graphics.digits)} (${signed(change / state.baseline * 100, 2)}%)`,
    high_label: formatter.format(state.high), low_label: formatter.format(state.low),
    market_at: state.market_at, market_iso: date.toISOString(), market_label: full.format(date), market_label_compact: compact.format(date),
    baseline_label: config.range === '1d' && state.return_basis === 'first_close' ? text[13] : '',
    fx_label: state.fx_at ? `${state.native_currency}→${state.currency} · ${text[7]}` : '',
    fx_iso: state.fx_at ? new Date(state.fx_at * 1000).toISOString() : '',
    source_label: `Yahoo · ${config.interval}${state.group > 1 ? ' ×' + state.group : ''}`,
    session_label: config.extended ? text[8] : text[9],
    chart_note: config.chartType !== 'line' && !graphics.has_ohlc ? 'OHLC unavailable · line shown' : '' };
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
  let config;
  try { config = settings(input); }
  catch (error) { return { stonks: display(null, true, error.message, settings({})) }; }
  const previous = validState(input?.trmnl?.state, now, config) ? input.trmnl.state : null;
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Request timed out')); }, REQUEST_TIMEOUT_MS);
    });
    const request = async (symbol, c, fx = false) => {
      const response = await fetch(yahooURL(symbol, c), { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`${fx ? 'FX' : 'Provider'} HTTP ${response.status}`);
      return parseYahoo(await readResponse(response), now, c, symbol, fx);
    };
    const work = (async () => {
      const data = await request(config.symbol, config);
      const plan = conversionPlan(data.currency, config.currency);
      // A five-day FX window also covers gaps before the first intraday bar.
      const fxConfig = { ...config, range: config.range === '1d' ? '5d' : config.range, extended: false };
      const rates = await Promise.all(plan.map(async p => ({ ...p, data: await request(p.symbol, fxConfig, true) })));
      return makeState(convert(data, rates, config), config, now);
    })();
    const state = await Promise.race([work, deadline]);
    if (previous && state.market_at < previous.market_at) throw new Error('Provider returned older data');
    if (previous?.fx_at && state.fx_at && state.fx_at < previous.fx_at) throw new Error('Provider returned older exchange rate');
    const detail = now - state.market_at > MAX_MARKET_AGE ? 'Provider prices are over 7 days old' :
      state.fx_at && now - state.fx_at > MAX_MARKET_AGE ? 'Exchange rate is over 7 days old' : '';
    return { stonks: display(state, !!detail, detail, config), trmnl_state: state };
  } catch (error) {
    const detail = controller.signal.aborted ? 'Request timed out' : String(error?.message || 'Market data unavailable').slice(0, 160);
    return { stonks: display(previous, true, detail, config), ...(previous ? { trmnl_state: previous } : {}) };
  } finally { clearTimeout(timer); controller.abort(); }
}
