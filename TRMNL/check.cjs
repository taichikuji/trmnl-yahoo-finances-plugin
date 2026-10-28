const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Liquid } = require('liquidjs');
const YAML = require('yaml');
const { loadPlugin } = require('../scripts/load-plugin.cjs');
const { sample, NOW } = require('./fixtures/sample.cjs');
class Clock extends Date { static now() { return NOW; } }
const ok = data => async () => ({ ok: true, json: async () => structuredClone(data) });
const load = (fetch = ok(sample()), extra = {}) => loadPlugin({ fetch, Date: Clock, ...extra });
const plain = object => JSON.parse(JSON.stringify(object));
const input = (fields = {}, state) => ({ trmnl: { plugin_settings: { custom_fields_values: fields }, ...(state ? { state } : {}) } });
const shared = fs.readFileSync(path.join(__dirname, 'src/shared.liquid'), 'utf8');
const liquid = new Liquid();
const layoutNames = ['full', 'half_horizontal', 'half_vertical', 'quadrant'];
const config = fields => load().settings(input(fields));

for (const [range, interval, seconds, count] of [
  ['1d|1', '1m', 60, 390], ['1m|30', '30m', 1800, 580], ['3m|60', '60m', 3600, 520],
  ['12m|1D', '1d', 86400, 262], ['60m|1W', '1wk', 604800, 261], ['all|1M', '1mo', 2678400, 900]
]) test(`${range} fetches its interval and saves a bounded, valid OHLCV chart`, async () => {
  const data = sample({ interval, seconds, count });
  const c = config({ dateRanges: range });
  const p = load(async (url, options) => {
    assert.ok(url.includes('range=' + c.range + '&interval=' + interval));
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.signal.aborted, false);
    return { ok: true, json: async () => data };
  });
  const out = await p.run(input({ dateRanges: range }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(p.validState(out.trmnl_state, NOW / 1000, c), true);
  assert.ok(p.bytes(out.trmnl_state) <= 8192);
  assert.equal(out.trmnl_state.source_count, count);
  assert.equal(out.stonks.price, data.chart.result[0].meta.regularMarketPrice);
  assert.notEqual(out.trmnl_state.market_at, out.trmnl_state.fetched_at);
  assert.doesNotMatch(out.stonks.path, /NaN|Infinity/);
});

test('symbols accept Yahoo and known TradingView exchanges without guessing unknown ones', () => {
  const cases = { NTNX: 'NTNX', 'NASDAQ%3ANTNX': 'NTNX', 'XETR:VWCE': 'VWCE.DE', 'LSE:VWRP': 'VWRP.L',
    'SP:SPX': '^GSPC', '^GSPC': '^GSPC', 'BTC-USD': 'BTC-USD', 'BINANCE:BTCUSDT': 'BTC-USD', 'FX:EURUSD': 'EURUSD=X' };
  for (const [from, to] of Object.entries(cases)) assert.equal(load().symbolFor(from), to);
  for (const bad of ['NOPE:ABC', 'https://example.com', 'A<B', '%broken', 'A:B:C']) assert.throws(() => load().symbolFor(bad));
});

test('malformed settings fail before fetching; numeric controls clamp to documented bounds', async () => {
  let calls = 0;
  const out = await load(async () => { calls++; }).run(input({ symbol: '<script>' }));
  assert.equal(calls, 0); assert.equal(out.stonks.has_data, false);
  assert.equal(config({ fontSize: 999 }).fontSize, 16);
  assert.equal(config({ lineWidth: -1 }).lineWidth, 1);
  assert.equal(config({ fontSize: '' }).fontSize, 10);
});

test('daily return uses first unadjusted close; 1D uses previous close', async () => {
  const data = sample();
  const out = await load(ok(data)).run({});
  assert.equal(out.stonks.change, data.chart.result[0].meta.regularMarketPrice - data.chart.result[0].indicators.quote[0].close[0]);
  delete data.chart.result[0].indicators.adjclose;
  assert.deepEqual(plain((await load(ok(data)).run({})).trmnl_state), plain(out.trmnl_state));
  const intraday = sample({ interval: '1m', seconds: 60, count: 390 });
  const one = await load(ok(intraday)).run(input({ dateRanges: '1d|1' }));
  assert.equal(one.stonks.change, intraday.chart.result[0].meta.regularMarketPrice - intraday.chart.result[0].meta.chartPreviousClose);
});

test('15m provider data is aggregated into actual 30m OHLCV bars', () => {
  const data = sample({ interval: '15m', seconds: 900, count: 100 });
  const parsed = load().parseYahoo(data, NOW / 1000, config({ dateRanges: '1m|30' }));
  assert.ok(parsed.bars.length >= 50 && parsed.bars.length <= 51);
  assert.equal(parsed.bars.reduce((n, b) => n + b[5], 0), data.chart.result[0].indicators.quote[0].volume.reduce((a, b) => a + b, 0));
});

test('null closes are skipped and absent OHLC/volume are never synthesized', async () => {
  const data = sample(); const q = data.chart.result[0].indicators.quote[0];
  q.close[0] = null; delete q.open; delete q.high; delete q.low; delete q.volume;
  const out = await load(ok(data)).run(input({ chartType: 'candles', showVolume: 'show' }));
  assert.equal(out.stonks.has_data, true);
  assert.equal(out.stonks.has_ohlc, false); assert.equal(out.stonks.has_volume, false);
  assert.ok(out.trmnl_state.bars.every(b => b[1] === null && b[5] === null));
  assert.match(out.stonks.chart_note, /OHLC unavailable/);
  const html = await liquid.parseAndRender(shared, out);
  assert.match(html, /data-stonks-line/); assert.doesNotMatch(html, /data-stonks-ohlc/);
});

for (const [label, change] of Object.entries({
  'wrong symbol': r => { r.meta.symbol = 'AAPL'; }, 'future quote': r => { r.meta.regularMarketTime += 5000; },
  'invalid time': r => { r.timestamp[1] = null; }, 'unordered': r => { r.timestamp[1] = r.timestamp[0]; },
  'empty prices': r => { r.indicators.quote[0].close.fill(null); }, 'wrong interval': r => { r.meta.dataGranularity = '1wk'; },
  'broken lengths': r => { r.timestamp.pop(); }
})) test(`${label} cannot become saved market data`, async () => {
  const data = sample(); change(data.chart.result[0]);
  const out = await load(ok(data)).run({});
  assert.equal(out.stonks.has_data, false); assert.equal(out.trmnl_state, undefined);
});

for (const [name, failure] of [
  ['429', async () => ({ ok: false, status: 429 })], ['network', async () => { throw new Error('Network unavailable'); }],
  ['JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('Bad JSON'); } })], ['invalid', ok({})]
]) test(`${name} keeps the exact saved chart and timestamps, marked stale`, async () => {
  const saved = plain((await load().run({})).trmnl_state);
  const out = await load(failure).run(input({}, saved));
  assert.deepEqual(plain(out.trmnl_state), saved); assert.equal(out.stonks.stale, true);
  assert.equal(out.stonks.market_at, saved.market_at);
});

test('saved fallback never crosses symbol, currency, range or session boundaries', async () => {
  const saved = plain((await load().run({})).trmnl_state);
  for (const f of [{ symbol: 'AAPL' }, { currency: 'EUR' }, { dateRanges: '1d|1' }, { extendedHours: 'show' }]) {
    const out = await load(async () => ({ ok: false, status: 429 })).run(input(f, saved));
    assert.equal(out.stonks.has_data, false); assert.equal(out.trmnl_state, undefined);
  }
});

test('presentation changes redraw cached data even when the provider is unavailable', async () => {
  const saved = plain((await load().run({})).trmnl_state);
  const out = await load(async () => ({ ok: false, status: 429 })).run(input({ chartType: 'candles', locale: 'es', showVolume: 'show' }, saved));
  assert.equal(out.stonks.has_data, true); assert.equal(out.stonks.has_volume, true);
  assert.equal(out.stonks.chart_type, 'candles'); assert.equal(out.stonks.labels.stale, 'DATOS ANTIGUOS');
});

test('one deadline bounds response bodies and chained FX requests without retries', async () => {
  let calls = 0, aborted = false;
  const out = await load(async (url, options) => {
    calls++; options.signal.addEventListener('abort', () => { aborted = true; });
    return { ok: true, json: () => new Promise(() => {}) };
  }, { setTimeout: fn => setTimeout(fn, 10) }).run({});
  assert.equal(calls, 1); assert.equal(aborted, true); assert.equal(out.stonks.detail, 'Request timed out');
});

test('real historical FX rates convert the curve, latest price and baseline', async () => {
  const market = sample();
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  const r = fx.chart.result[0];
  const out = await load(async url => ({ ok: true, json: async () => url.includes('USDEUR') ? fx : market })).run(input({ currency: 'EUR' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.stonks.currency, 'EUR');
  assert.equal(out.stonks.price, market.chart.result[0].meta.regularMarketPrice * r.meta.regularMarketPrice);
  assert.equal(out.trmnl_state.baseline, market.chart.result[0].indicators.quote[0].close[0] * r.indicators.quote[0].close[0]);
  assert.match(out.stonks.fx_label, /USD→EUR/);
  assert.ok(out.stonks.fx_iso);
});

test('BTC conversion divides by BTC-USD rather than pretending BTC is a fiat pair', async () => {
  const market = sample(); const btc = sample({ symbol: 'BTC-USD', startPrice: 60000 });
  const out = await load(async url => ({ ok: true, json: async () => url.includes('BTC-USD') ? btc : market })).run(input({ currency: 'BTC' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.stonks.price, market.chart.result[0].meta.regularMarketPrice / btc.chart.result[0].meta.regularMarketPrice);
  assert.equal(out.stonks.digits, 6);
});

test('unavailable, misaligned or stale FX cannot publish a misleading converted chart', async () => {
  for (const mutate of [r => { r.timestamp = r.timestamp.map(t => t + 1); r.meta.regularMarketTime += 1; },
    r => { r.meta.regularMarketTime -= 10 * 86400; r.timestamp = r.timestamp.map(t => t - 10 * 86400); }]) {
    const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 }); mutate(fx.chart.result[0]);
    const out = await load(async url => ({ ok: true, json: async () => url.includes('USDEUR') ? fx : sample() })).run(input({ currency: 'EUR' }));
    assert.equal(out.stonks.has_data, false); assert.equal(out.trmnl_state, undefined);
  }
});

test('pence are converted to pounds before display and FX', async () => {
  const data = sample({ symbol: 'VWRP.L', currency: 'GBp', startPrice: 10000 });
  const out = await load(ok(data)).run(input({ symbol: 'VWRP.L', currency: 'NATIVE' }));
  assert.equal(out.stonks.currency, 'GBP'); assert.equal(out.stonks.price, data.chart.result[0].meta.regularMarketPrice / 100);
});

test('extended-hours bars keep their latest price and timestamp', async () => {
  const data = sample({ interval: '1m', seconds: 60, count: 390 });
  data.chart.result[0].meta.regularMarketTime -= 3600;
  const out = await load(ok(data)).run(input({ dateRanges: '1d|1', extendedHours: 'show' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.stonks.market_at, data.chart.result[0].timestamp.at(-1));
  assert.equal(out.stonks.price, data.chart.result[0].indicators.quote[0].close.at(-1));
});

test('old quotes are stale; normal holiday closures are accepted; regressions preserve prior data', async () => {
  const saved = (await load().run({})).trmnl_state;
  for (const days of [3, 10]) {
    const data = sample(); const r = data.chart.result[0];
    r.timestamp = r.timestamp.map(t => t - days * 86400); r.meta.regularMarketTime -= days * 86400;
    const out = await load(ok(data)).run({});
    assert.equal(out.stonks.has_data, true); assert.equal(out.stonks.stale, days > 7);
    const older = await load(ok(data)).run(input({}, saved));
    assert.deepEqual(plain(older.trmnl_state), plain(saved)); assert.equal(older.stonks.stale, true);
  }
});

test('corrupt and oversized state is rejected before fallback', async () => {
  const saved = plain((await load().run({})).trmnl_state);
  for (const state of [{ ...saved, junk: '€'.repeat(4000) }, { ...saved, price: -1 },
    { ...saved, bars: [[123, 1, 0, 2, 3, null], ...saved.bars.slice(1)] }, { ...saved, timezone: 'invalid' }]) {
    assert.equal(load().validState(state, NOW / 1000), false);
    const out = await load(async () => ({ ok: false, status: 500 })).run(input({}, state));
    assert.equal(out.stonks.has_data, false);
  }
});

test('line styles use distinct paths; smooth cubic control points stay within segment bounds', () => {
  const p = load(); const points = [{ x: 4, y: 100 }, { x: 20, y: 10 }, { x: 80, y: 200 }, { x: 696, y: 50 }];
  assert.match(p.linePath(points, '0'), /L/); assert.match(p.linePath(points, '1'), /H.*V/);
  const smooth = p.linePath(points, '2'); assert.match(smooth, /C/);
  const segments = [...smooth.matchAll(/C([\d.]+),([\d.]+),([\d.]+),([\d.]+),([\d.]+),([\d.]+)/g)];
  segments.forEach((m, i) => { for (const y of [+m[2], +m[4]]) assert.ok(y >= Math.min(points[i].y, points[i + 1].y) && y <= Math.max(points[i].y, points[i + 1].y)); });
});

test('all locales format prices and dates, and every registered view renders once without network widgets', async () => {
  for (const locale of ['en', 'de_DE', 'fr', 'es', 'it', 'pl']) {
    for (const chartType of ['line', 'bars', 'candles']) {
      const out = await load().run(input({ locale, chartType, showVolume: 'show', showGridlines: 'show', showReference: 'show' }));
      for (const name of layoutNames) {
        const view = fs.readFileSync(path.join(__dirname, 'src', name + '.liquid'), 'utf8'); assert.ok(view.trim());
        const html = await liquid.parseAndRender(shared + '\n' + view, out);
        assert.equal((html.match(/data-stonks style=/g) || []).length, 1);
        assert.match(html, /class="title_bar"/); assert.match(html, /data-stonks-volume/);
        assert.equal(html.includes('data-stonks-ohlc'), chartType !== 'line');
        assert.doesNotMatch(html, /<script|<iframe|<img|NaN|Infinity|{{|{%/);
      }
    }
  }
});

test('form offers all recipe controls, with values matching runtime and static Node configuration', () => {
  const s = YAML.parse(fs.readFileSync(path.join(__dirname, 'src/settings.yml'), 'utf8'));
  assert.equal(s.strategy, 'static'); assert.equal(s.serverless_language, 'node'); assert.equal(s.no_screen_padding, 'no');
  const fields = Object.fromEntries(s.custom_fields.map(f => [f.keyname, f]));
  for (const key of ['symbol', 'currency', 'chartType', 'locale', 'dateRanges', 'lineWidth', 'lineType', 'showGridlines', 'showVolume', 'headerFontSize', 'fontSize']) assert.ok(fields[key]);
  assert.equal(fields.dateRanges.options.length, 6); assert.equal(fields.locale.options.length, 6);
});
