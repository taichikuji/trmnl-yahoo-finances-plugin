const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLiquid, loadPlugin } = require('../scripts/render-liquid.cjs');
const YAML = require('yaml');
const { sample, NOW } = require('./fixtures/sample.cjs');
class Clock extends Date { static now() { return NOW; } }
const ok = data => async () => ({ ok: true, json: async () => structuredClone(data) });
const load = (fetch = async () => { throw Error('Unexpected fetch'); }, extra = {}) => loadPlugin({ fetch, Date: Clock, ...extra });
const plain = object => JSON.parse(JSON.stringify(object));
const input = (fields = {}, state) => ({ trmnl: { plugin_settings: { custom_fields_values: fields }, ...(state ? { state } : {}) } });
const polled = (data = sample(), fields = {}, state) => ({ ...data, ...input(fields, state) });
const shared = fs.readFileSync(path.join(__dirname, 'src/shared.liquid'), 'utf8');
const liquid = createLiquid();
const render = (out, fields = {}, name = 'full') => liquid.parseAndRender(
  shared + '\n' + fs.readFileSync(path.join(__dirname, 'src', name + '.liquid'), 'utf8'), { ...out, ...input(fields) });
const layoutNames = ['full', 'half_horizontal', 'half_vertical', 'quadrant'];
const config = fields => load().settings(input(fields));

test('native polling URLs preserve Yahoo symbols, ranges and session choices', async () => {
  const source = YAML.parse(fs.readFileSync(path.join(__dirname, 'src/settings.yml'), 'utf8')).polling_url;
  assert.doesNotMatch(source, /[\r\n]/);
  for (const dateRanges of ['1d|1', '1m|30', '3m|60', '12m|1D', '60m|1W', 'all|1M', 'invalid']) {
    for (const symbol of ['NTNX', '%5ESTOXX50E', 'M%26M.NS']) for (const extendedHours of ['hide', 'show']) {
      const fields = { symbol, dateRanges, extendedHours };
      const url = await liquid.parseAndRender(source, fields);
      const expected = config(fields);
      assert.equal(url, 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(expected.symbol) +
        '?range=' + expected.range + '&interval=' + expected.interval + '&includePrePost=' + expected.extended);
    }
  }
});

test('native polling URL and Serverless agree on comma-separated rotation', async () => {
  const source = YAML.parse(fs.readFileSync(path.join(__dirname, 'src/settings.yml'), 'utf8')).polling_url;
  const fields = { symbol: ' NTNX , aapl , %5ESTOXX50E ' };
  for (const [last, expected] of [
    [null, 'NTNX'], ['NTNX', 'AAPL'], ['AAPL', '^STOXX50E'],
    ['^STOXX50E', 'NTNX'], ['MSFT', 'NTNX']
  ]) {
    const state = last ? { symbol: last } : undefined;
    const expectedConfig = load().settings(input(fields, state));
    assert.equal(expectedConfig.symbol, expected);
    const url = await liquid.parseAndRender(source, { ...fields, ...(state ? { trmnl: { state } } : {}) });
    assert.equal(url, 'https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(expected) + '?range=1y&interval=1d&includePrePost=false');
    assert.doesNotMatch(url, /\s/);
  }
});

test('multiple tickers rotate on successful native polls, then wrap without extra requests', async () => {
  const fields = { symbol: 'NTNX,AAPL,NVDA' };
  let saved;
  let requests = 0;
  const p = load(async () => { requests++; throw Error('Unexpected stock request'); });
  for (const symbol of ['NTNX', 'AAPL', 'NVDA', 'NTNX']) {
    assert.equal(p.settings(input(fields, saved)).symbol, symbol);
    const out = await p.run(polled(sample({ symbol }), fields, saved));
    assert.equal(out.stonks.has_data, true, out.stonks.detail);
    assert.equal(out.stonks.symbol, symbol);
    assert.equal(out.trmnl_state.symbol, symbol);
    assert.equal(p.validState(out.trmnl_state, NOW / 1000, p.settings(input(fields, saved))), true);
    assert.ok(p.bytes(out.trmnl_state) <= 8192);
    saved = plain(out.trmnl_state);
  }
  assert.equal(requests, 0);
});

test('failed rotating polls keep the last ticker labelled correctly and retry the same next ticker', async () => {
  const fields = { symbol: 'NTNX,AAPL' };
  const saved = plain((await load().run(polled(sample(), fields))).trmnl_state);
  const p = load(async () => { throw Error('Failed native poll must not fetch again'); });
  for (let i = 0; i < 2; i++) {
    assert.equal(p.settings(input(fields, saved)).symbol, 'AAPL');
    const failed = await p.run(input(fields, saved));
    assert.equal(failed.stonks.has_data, true);
    assert.equal(failed.stonks.stale, true);
    assert.equal(failed.stonks.symbol, 'NTNX');
    assert.equal(failed.stonks.detail, 'Yahoo polling failed');
    assert.deepEqual(plain(failed.trmnl_state), saved);
    assert.match(await render(failed, fields), />STALE DATA<\/span>/);
  }
  const recovered = await p.run(polled(sample({ symbol: 'AAPL' }), fields, saved));
  assert.equal(recovered.stonks.has_data, true, recovered.stonks.detail);
  assert.equal(recovered.stonks.stale, false);
  assert.equal(recovered.stonks.symbol, 'AAPL');
  assert.equal(p.settings(input(fields, recovered.trmnl_state)).symbol, 'NTNX');
});

test('rotation cannot reuse stale charts from removed symbols, changed options or corrupt state', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  for (const [fields, state] of [
    [{ symbol: 'AAPL,NVDA' }, saved],
    [{ symbol: 'NTNX,AAPL', currency: 'EUR' }, saved],
    [{ symbol: 'NTNX,AAPL' }, { ...saved, price: -1 }]
  ]) {
    const out = await load().run(input(fields, state));
    assert.equal(out.stonks.has_data, false);
    assert.equal(out.stonks.stale, true);
    assert.equal(out.trmnl_state, undefined);
  }
  for (const symbols of ['NTNX,,AAPL', ',NTNX', 'NTNX,']) {
    const out = await load().run(input({ symbol: symbols }, saved));
    assert.equal(out.stonks.has_data, false);
    assert.match(out.stonks.detail, /comma/);
  }
});

test('Serverless enriches a native polling response without requesting the stock twice', async () => {
  const data = sample();
  let requests = 0;
  const out = await load(async () => { requests++; throw Error('Unexpected provider request'); }).run(data);
  assert.equal(requests, 0);
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.chart, undefined);
  assert.ok(load().bytes(out) < load().bytes(data));
  assert.deepEqual(plain(out.trmnl_state), plain((await load().run(sample())).trmnl_state));
});

test('malformed native responses retain the matching snapshot without another stock request', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  for (const chart of [null, {}, { error: { description: 'Unavailable' } }]) {
    let requests = 0;
    const out = await load(async () => { requests++; throw Error('Unexpected fetch'); }).run({ chart, ...input({}, saved) });
    assert.equal(requests, 0);
    assert.equal(out.stonks.stale, true);
    assert.deepEqual(plain(out.trmnl_state), saved);
  }
});

test('empty failed polls immediately reuse saved state, survive repeated failures and recover', async () => {
  const fresh = await load().run(sample());
  const saved = plain(fresh.trmnl_state);
  let requests = 0;
  const offline = load(async () => { requests++; return { ok: false, status: 429 }; });
  for (let i = 0; i < 3; i++) {
    // TRMNL strips the failed HTTP response; Force Refresh also clears merge variables.
    const failed = input({}, saved);
    failed.trmnl.previous_merge_variables = {};
    const out = await offline.run(failed);
    assert.equal(requests, 0, 'A failed native poll must not request Yahoo again');
    assert.equal(out.stonks.has_data, true);
    assert.equal(out.stonks.stale, true);
    assert.equal(out.stonks.detail, 'Yahoo polling failed');
    assert.equal(out.stonks.price, fresh.stonks.price);
    assert.equal(out.stonks.market_iso, fresh.stonks.market_iso);
    assert.deepEqual(plain(out.trmnl_state), saved);
    for (const name of layoutNames) {
      const html = await render(out, {}, name);
      assert.match(html, />STALE DATA<\/span>/);
      assert.match(html, /data-stonks-line/);
    }
  }
  const recovered = await offline.run({ ...sample(), ...input({}, saved) });
  assert.equal(requests, 0);
  assert.equal(recovered.stonks.stale, false);
  assert.equal(recovered.stonks.detail, '');
  assert.doesNotMatch(await render(recovered), />STALE DATA<\/span>/);
});

test('failed polls never retry without usable saved state, including first installation', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  let requests = 0;
  const offline = load(async () => { requests++; return { ok: false, status: 429 }; });
  for (const state of [undefined, {}, { ...saved, price: -1 }, { ...saved, key: 'other selection' }]) {
    const out = await offline.run(input({}, state));
    assert.equal(requests, 0);
    assert.equal(out.stonks.has_data, false);
    assert.equal(out.stonks.detail, 'Yahoo polling failed');
    assert.equal(out.trmnl_state, undefined);
  }
});

test('native stock data requests only the FX pair for a converted quote', async () => {
  const market = sample();
  const rate = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  const requested = [];
  const out = await load(async url => {
    requested.push(url);
    return { ok: true, json: async () => rate };
  }).run({ ...market, ...input({ currency: 'EUR' }) });
  assert.equal(requested.length, 1);
  assert.ok(requested[0].includes('/USDEUR%3DX?'));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.stonks.currency, 'EUR');
  assert.equal(out.stonks.price, market.chart.result[0].meta.regularMarketPrice * rate.chart.result[0].meta.regularMarketPrice);
});

for (const [range, interval, seconds, count] of [
  ['1d|1', '1m', 60, 390], ['1m|30', '30m', 1800, 580], ['3m|60', '60m', 3600, 520],
  ['12m|1D', '1d', 86400, 262], ['60m|1W', '1wk', 604800, 261], ['all|1M', '1mo', 2678400, 900]
]) test(`${range} saves a bounded, valid OHLCV chart without fetching the stock again`, async () => {
  const data = sample({ interval, seconds, count });
  const c = config({ dateRanges: range });
  let requests = 0;
  const p = load(async () => { requests++; throw Error('Unexpected stock request'); });
  const out = await p.run(polled(data, { dateRanges: range }));
  assert.equal(requests, 0);
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(p.validState(out.trmnl_state, NOW / 1000, c), true);
  assert.ok(p.bytes(out.trmnl_state) <= 8192);
  assert.equal(out.trmnl_state.source_count, count);
  assert.equal(out.stonks.price, data.chart.result[0].meta.regularMarketPrice);
  assert.notEqual(out.trmnl_state.market_at, out.trmnl_state.fetched_at);
  assert.doesNotMatch(await render(out), /NaN|Infinity/);
});

test('symbols accept plain and URL-encoded Yahoo tickers without exchange mappings', () => {
  const cases = { NTNX: 'NTNX', ' ntnx ': 'NTNX', 'VWCE.DE': 'VWCE.DE', 'VWRP.L': 'VWRP.L',
    '^STOXX50E': '^STOXX50E', '%5ESTOXX50E': '^STOXX50E', '^GSPC': '^GSPC', 'BTC-USD': 'BTC-USD',
    'EURUSD%3DX': 'EURUSD=X', 'CL=F': 'CL=F', 'M&M.NS': 'M&M.NS', 'M%26M.NS': 'M&M.NS' };
  for (const [from, to] of Object.entries(cases)) assert.equal(load().symbolFor(from), to);
  for (const bad of ['NASDAQ:NTNX', 'NASDAQ%3ANTNX', 'XETR:VWCE', 'SP:SPX', 'BINANCE:BTCUSDT', 'FX:EURUSD',
    'https://finance.yahoo.com/quote/NTNX/', 'A<B', '%broken', '%255ESTOXX50E', '%2FNTNX', 'A B']) assert.throws(() => load().symbolFor(bad));
});

test('encoded Yahoo symbols share saved state with plain symbols without another request', async () => {
  for (const [encoded, symbol] of [['%5ESTOXX50E', '^STOXX50E'], ['M%26M.NS', 'M&M.NS']]) {
    let calls = 0;
    const data = sample({ symbol });
    const out = await load(async () => {
      calls++;
      throw Error('Unexpected stock request');
    }).run(polled(data, { symbol: encoded }));
    assert.equal(calls, 0);
    assert.equal(out.stonks.has_data, true, out.stonks.detail);
    assert.equal(out.stonks.symbol, symbol);
    const fallback = await load(async () => ({ ok: false, status: 429 })).run(input({ symbol }, out.trmnl_state));
    assert.equal(fallback.stonks.has_data, true);
    assert.equal(fallback.stonks.stale, true);
    assert.deepEqual(plain(fallback.trmnl_state), plain(out.trmnl_state));
  }
});

test('malformed market settings fail before fetching; Liquid clamps numeric display controls', async () => {
  let calls = 0;
  const out = await load(async () => { calls++; }).run(input({ symbol: '<script>' }));
  assert.equal(calls, 0); assert.equal(out.stonks.has_data, false);
  const fresh = await load().run(sample());
  assert.match(await render(fresh, { fontSize: 999, lineWidth: -1 }), /--stonks-font: 16px/);
  assert.match(await render(fresh, { fontSize: 999, lineWidth: -1 }), /stroke-width="1"/);
  assert.match(await render(fresh, { fontSize: '' }), /--stonks-font: 12px/);
});

test('daily return uses first unadjusted close; 1D uses previous close', async () => {
  const data = sample();
  const out = await load().run(data);
  assert.equal(out.stonks.change, data.chart.result[0].meta.regularMarketPrice - data.chart.result[0].indicators.quote[0].close[0]);
  delete data.chart.result[0].indicators.adjclose;
  assert.deepEqual(plain((await load().run(data)).trmnl_state), plain(out.trmnl_state));
  const intraday = sample({ interval: '1m', seconds: 60, count: 390 });
  const one = await load().run(polled(intraday, { dateRanges: '1d|1' }));
  assert.equal(one.stonks.change, intraday.chart.result[0].meta.regularMarketPrice - intraday.chart.result[0].meta.chartPreviousClose);
});

test('new quote bars preserve exact seconds through saved-state compaction', async () => {
  const data = sample({ count: 4, interval: '1m', seconds: 60 });
  const r = data.chart.result[0];
  r.meta.regularMarketTime += 66;
  const out = await load().run(polled(data, { dateRanges: '1d|1' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.trmnl_state.bars.at(-1)[0], r.meta.regularMarketTime);
  assert.equal(out.trmnl_state.market_at, r.meta.regularMarketTime);
  const fallback = await load(async () => ({ ok: false, status: 429 })).run(input({ dateRanges: '1d|1' }, out.trmnl_state));
  assert.deepEqual(plain(fallback.trmnl_state), plain(out.trmnl_state));
});

test('1D uses a valid previous close when the preferred provider field is invalid', async () => {
  for (const invalid of [0, -1, 'missing']) {
    const data = sample({ interval: '1m', seconds: 60 });
    data.chart.result[0].meta.chartPreviousClose = invalid;
    data.chart.result[0].meta.previousClose = 42;
    const out = await load().run(polled(data, { dateRanges: '1d|1' }));
    assert.equal(out.stonks.has_data, true, out.stonks.detail);
    assert.equal(out.trmnl_state.baseline, 42);
    assert.equal(out.trmnl_state.return_basis, 'previous_close');
  }
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
  const out = await load().run(polled(data, { chartType: 'candles', showVolume: 'show' }));
  assert.equal(out.stonks.has_data, true);
  assert.equal(out.stonks.has_ohlc, false); assert.equal(out.stonks.has_volume, false);
  assert.ok(out.trmnl_state.bars.every(b => b[1] === null && b[5] === null));
  const html = await render(out);
  assert.match(html, /OHLC unavailable/);
  assert.match(html, /data-stonks-line/); assert.doesNotMatch(html, /data-stonks-ohlc/);
});

for (const [label, change] of Object.entries({
  'wrong symbol': r => { r.meta.symbol = 'AAPL'; }, 'future quote': r => { r.meta.regularMarketTime += 5000; },
  'invalid time': r => { r.timestamp[1] = null; }, 'unordered': r => { r.timestamp[1] = r.timestamp[0]; },
  'empty prices': r => { r.indicators.quote[0].close.fill(null); }, 'wrong interval': r => { r.meta.dataGranularity = '1wk'; },
  'broken lengths': r => { r.timestamp.pop(); }
})) test(`${label} cannot become saved market data`, async () => {
  const data = sample(); change(data.chart.result[0]);
  const out = await load().run(data);
  assert.equal(out.stonks.has_data, false); assert.equal(out.trmnl_state, undefined);
});

for (const [name, failure] of [
  ['429', async () => ({ ok: false, status: 429 })], ['network', async () => { throw new Error('Network unavailable'); }],
  ['JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('Bad JSON'); } })], ['invalid', ok({})]
]) test(`${name} keeps a saved converted chart on FX failure without retries`, async () => {
  let requests = 0;
  const failing = load(async (...args) => { requests++; return failure(...args); });
  const fields = { currency: 'EUR' };
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  const saved = plain((await load(ok(fx)).run({ ...sample(), ...input(fields) })).trmnl_state);
  const out = await failing.run({ ...sample(), ...input(fields, saved) });
  assert.equal(requests, 1);
  assert.deepEqual(plain(out.trmnl_state), saved); assert.equal(out.stonks.stale, true);
  assert.equal(out.stonks.market_at, saved.market_at);
  if (name === '429') assert.equal(out.stonks.detail, 'FX HTTP 429');
});

test('saved fallback never crosses symbol, currency, range or session boundaries', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  for (const f of [{ symbol: 'AAPL' }, { currency: 'EUR' }, { dateRanges: '1d|1' }, { extendedHours: 'show' }]) {
    const out = await load(async () => ({ ok: false, status: 429 })).run(input(f, saved));
    assert.equal(out.stonks.has_data, false); assert.equal(out.trmnl_state, undefined);
  }
});

test('presentation changes redraw cached data even when the provider is unavailable', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  const out = await load(async () => ({ ok: false, status: 429 })).run(input({ chartType: 'candles', locale: 'es', showVolume: 'show' }, saved));
  assert.equal(out.stonks.has_data, true); assert.equal(out.stonks.has_volume, true);
  assert.equal(out.stonks.chart_type, 'candles'); assert.match(await render(out, { locale: 'es' }), /DATOS ANTIGUOS/);
});

test('one deadline bounds FX response bodies without retries', async () => {
  let calls = 0, aborted = false;
  const out = await load(async (url, options) => {
    calls++; options.signal.addEventListener('abort', () => { aborted = true; });
    return { ok: true, json: () => new Promise(() => {}) };
  }, { setTimeout: fn => setTimeout(fn, 10) }).run(polled(sample(), { currency: 'EUR' }));
  assert.equal(calls, 1); assert.equal(aborted, true); assert.equal(out.stonks.detail, 'Request timed out');
});

test('real historical FX rates convert the curve, latest price and baseline', async () => {
  const market = sample();
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  const r = fx.chart.result[0];
  const out = await load(async url => ({ ok: true, json: async () => url.includes('USDEUR') ? fx : market })).run(polled(market, { currency: 'EUR' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.stonks.currency, 'EUR');
  assert.equal(out.stonks.price, market.chart.result[0].meta.regularMarketPrice * r.meta.regularMarketPrice);
  assert.equal(out.trmnl_state.baseline, market.chart.result[0].indicators.quote[0].close[0] * r.indicators.quote[0].close[0]);
  assert.match(await render(out), /USD→EUR/);
  assert.ok(out.stonks.fx_iso);
});

test('BTC conversion divides by BTC-USD rather than pretending BTC is a fiat pair', async () => {
  const market = sample(); const btc = sample({ symbol: 'BTC-USD', startPrice: 60000 });
  const out = await load(async url => ({ ok: true, json: async () => url.includes('BTC-USD') ? btc : market })).run(polled(market, { currency: 'BTC' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.stonks.price, market.chart.result[0].meta.regularMarketPrice / btc.chart.result[0].meta.regularMarketPrice);
  assert.equal(out.stonks.digits, 6);
});

test('unavailable, misaligned or stale FX cannot publish a misleading converted chart', async () => {
  for (const mutate of [r => { r.timestamp = r.timestamp.map(t => t + 1); r.meta.regularMarketTime += 1; },
    r => { r.meta.regularMarketTime -= 10 * 86400; r.timestamp = r.timestamp.map(t => t - 10 * 86400); }]) {
    const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 }); mutate(fx.chart.result[0]);
    const out = await load(async url => ({ ok: true, json: async () => url.includes('USDEUR') ? fx : sample() })).run(polled(sample(), { currency: 'EUR' }));
    assert.equal(out.stonks.has_data, false); assert.equal(out.trmnl_state, undefined);
  }
});

test('pence are converted to pounds before display and FX', async () => {
  const data = sample({ symbol: 'VWRP.L', currency: 'GBp', startPrice: 10000 });
  const out = await load().run(polled(data, { symbol: 'VWRP.L', currency: 'NATIVE' }));
  assert.equal(out.stonks.currency, 'GBP'); assert.equal(out.stonks.price, data.chart.result[0].meta.regularMarketPrice / 100);
});

test('extended-hours bars keep their latest price and timestamp', async () => {
  const data = sample({ interval: '1m', seconds: 60, count: 390 });
  data.chart.result[0].meta.regularMarketTime -= 3600;
  const out = await load().run(polled(data, { dateRanges: '1d|1', extendedHours: 'show' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.stonks.market_at, data.chart.result[0].timestamp.at(-1));
  assert.equal(out.stonks.price, data.chart.result[0].indicators.quote[0].close.at(-1));
});

test('old quotes are stale; normal holiday closures are accepted; regressions preserve prior data', async () => {
  const saved = (await load().run(sample())).trmnl_state;
  for (const days of [3, 10]) {
    const data = sample(); const r = data.chart.result[0];
    r.timestamp = r.timestamp.map(t => t - days * 86400); r.meta.regularMarketTime -= days * 86400;
    const out = await load().run(data);
    assert.equal(out.stonks.has_data, true); assert.equal(out.stonks.stale, days > 7);
    const older = await load(ok(data)).run({ ...data, ...input({}, saved) });
    assert.deepEqual(plain(older.trmnl_state), plain(saved)); assert.equal(older.stonks.stale, true);
    assert.equal(older.stonks.detail, 'Provider returned older data');
  }
});

test('corrupt and oversized state is rejected before fallback', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  for (const state of [{ ...saved, junk: '€'.repeat(4000) }, { ...saved, price: -1 },
    { ...saved, bars: [[123, 1, 0, 2, 3, null], ...saved.bars.slice(1)] }, { ...saved, timezone: 'invalid' }]) {
    assert.equal(load().validState(state, NOW / 1000), false);
    const out = await load(async () => ({ ok: false, status: 500 })).run(input({}, state));
    assert.equal(out.stonks.has_data, false);
  }
});

test('Liquid draws distinct line styles; smooth control points stay within segment bounds', async () => {
  const p = load(); const points = [{ x: 4, y: 100 }, { x: 20, y: 10 }, { x: 80, y: 200 }, { x: 696, y: 50 }];
  for (const [lineType, pattern] of [['0', /L/], ['1', /H.*V/], ['2', /C/]]) {
    const out = await load().run(polled(sample(), { lineType }));
    const html = await render(out, { lineType });
    assert.match(html.match(/data-stonks-line d="([^"]+)"/)[1], pattern);
  }
  const segments = p.curveSegments(points);
  segments.forEach((m, i) => { for (const y of [m[1], m[3]]) assert.ok(y >= Math.min(points[i].y, points[i + 1].y) && y <= Math.max(points[i].y, points[i + 1].y)); });
});

test('all locales format prices and dates, and every registered view renders once without network widgets', async () => {
  for (const locale of ['en', 'de_DE', 'fr', 'es', 'it', 'pl']) {
    for (const chartType of ['line', 'bars', 'candles']) {
      const out = await load().run(polled(sample(), { locale, chartType, showVolume: 'show', showGridlines: 'show', showReference: 'show' }));
      for (const name of layoutNames) {
        const view = fs.readFileSync(path.join(__dirname, 'src', name + '.liquid'), 'utf8'); assert.ok(view.trim());
        const html = await render(out, { locale, chartType }, name);
        assert.equal((html.match(/data-stonks style=/g) || []).length, 1);
        assert.match(html, /class="title_bar"/); assert.match(html, /data-stonks-volume/);
        assert.equal(html.includes('data-stonks-ohlc'), chartType !== 'line');
        assert.doesNotMatch(html, /<script|<iframe|NaN|Infinity|{{|{%/);
        const images = [...html.matchAll(/<img\b[^>]*src="([^"]+)"/g)];
        assert.equal(images.length, 1);
        assert.match(images[0][1], /^data:image\/svg\+xml;base64,/);
        const svg = Buffer.from(images[0][1].split(',')[1], 'base64').toString('utf8');
        assert.match(svg, /^<svg\b[^>]*>[\s\S]*<path\b[\s\S]*<\/svg>$/);
      }
    }
  }
});

test('form offers all recipe controls, with values matching runtime and native polling configuration', () => {
  const s = YAML.parse(fs.readFileSync(path.join(__dirname, 'src/settings.yml'), 'utf8'));
  assert.equal(s.strategy, 'polling'); assert.equal(s.serverless_language, 'node'); assert.equal(s.no_screen_padding, 'no');
  const fields = Object.fromEntries(s.custom_fields.map(f => [f.keyname, f]));
  for (const key of ['symbol', 'currency', 'chartType', 'locale', 'dateRanges', 'lineWidth', 'lineType', 'showGridlines', 'showVolume', 'headerFontSize', 'fontSize']) assert.ok(fields[key]);
  assert.equal(fields.dateRanges.options.length, 6); assert.equal(fields.locale.options.length, 6);
});

test('converted 1D returns start at the first aligned price and label that baseline', async () => {
  const market = sample({ interval: '1m', seconds: 60, count: 390 });
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', interval: '1m', seconds: 60, count: 1440, startPrice: 0.8 });
  const out = await load(async url => ({ ok: true, json: async () => url.includes('USDEUR') ? fx : market }))
    .run(polled(market, { currency: 'EUR', dateRanges: '1d|1', showReference: 'show' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  const first = market.chart.result[0].timestamp[0];
  const rateIndex = fx.chart.result[0].timestamp.findLastIndex(t => t <= first);
  const baseline = market.chart.result[0].indicators.quote[0].close[0] * fx.chart.result[0].indicators.quote[0].close[rateIndex];
  assert.equal(out.trmnl_state.baseline, baseline);
  assert.equal(out.trmnl_state.return_basis, 'first_close');
  assert.equal(out.stonks.change, out.stonks.price - baseline);
  const html = await render(out);
  assert.match(html, /from first bar/);
  // A v2 snapshot using the former, unaligned converted previous-close baseline
  // must not silently survive as a valid 1D fallback after this correction.
  const old = { ...plain(out.trmnl_state), return_basis: 'previous_close' };
  assert.equal(load().validState(old, NOW / 1000, config({ currency: 'EUR', dateRanges: '1d|1' })), false);
});

test('an older FX quote cannot replace a matching saved converted chart', async () => {
  const market = sample();
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  const fetch = async url => ({ ok: true, json: async () => url.includes('USDEUR') ? fx : market });
  const saved = plain((await load(fetch).run(polled(market, { currency: 'EUR' }))).trmnl_state);
  fx.chart.result[0].meta.regularMarketTime -= 60;
  fx.chart.result[0].timestamp = fx.chart.result[0].timestamp.map(t => t - 60);
  const out = await load(fetch).run({ ...market, ...input({ currency: 'EUR' }, saved) });
  assert.equal(out.stonks.stale, true);
  assert.equal(out.stonks.detail, 'Provider returned older exchange rate');
  assert.deepEqual(plain(out.trmnl_state), saved);
});

test('old FX is marked stale even when the asset quote is within the age limit', async () => {
  const market = sample();
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  for (const [data, days] of [[market, 6], [fx, 8]]) {
    const r = data.chart.result[0]; r.meta.regularMarketTime -= days * 86400;
    r.timestamp = r.timestamp.map(t => t - days * 86400);
  }
  const out = await load(async url => ({ ok: true, json: async () => url.includes('USDEUR') ? fx : market })).run(polled(market, { currency: 'EUR' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.stonks.stale, true);
  assert.equal(out.stonks.detail, 'Exchange rate is over 7 days old');
});

test('cached metadata must agree with the selection, FX state and grouped bar count', async () => {
  const p = load(); const saved = plain((await p.run(sample())).trmnl_state);
  for (const corrupted of [{ ...saved, symbol: 'AAPL' }, { ...saved, currency: 'EUR' },
    { ...saved, fx_rate: 1.2 }, { ...saved, source_count: saved.bars.length * saved.group + 1 },
    { ...saved, return_basis: 'unknown' }]) {
    assert.equal(p.validState(corrupted, NOW / 1000, config({})), false);
  }
  // Existing native v2 snapshots remain usable during the first deployed outage.
  saved.high = Math.max(...saved.bars.map(b => b[2]));
  saved.low = Math.min(...saved.bars.map(b => b[3]));
  delete saved.return_basis;
  const offline = await load(async () => ({ ok: false, status: 429 })).run(input({}, saved));
  assert.equal(offline.stonks.has_data, true);
  assert.deepEqual(plain(offline.trmnl_state), saved);
});

test('oversized declared or streamed bodies preserve fallback within the response budget', async () => {
  const fields = { currency: 'EUR' };
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  const saved = plain((await load(ok(fx)).run({ ...sample(), ...input(fields) })).trmnl_state);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); },
    cancel() { cancelled = true; }
  });
  for (const response of [new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }), new Response(stream)]) {
    const out = await load(async () => response).run({ ...sample(), ...input(fields, saved) });
    assert.equal(out.stonks.detail, 'Provider response exceeds 2 MiB');
    assert.equal(out.stonks.stale, true);
    assert.deepEqual(plain(out.trmnl_state), saved);
  }
  assert.equal(cancelled, true);
});

test('streamed JSON preserves multibyte names split between response chunks', async () => {
  const data = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  data.chart.result[0].meta.longName = 'FX · 日本株';
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const split = encoded.findIndex(byte => byte === 0xe6) + 1;
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(encoded.slice(0, split)); controller.enqueue(encoded.slice(split)); controller.close();
  } });
  const out = await load(async () => new Response(stream)).run(polled(sample(), { currency: 'EUR' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.stonks.price, sample().chart.result[0].meta.regularMarketPrice * data.chart.result[0].meta.regularMarketPrice);
});

test('provider text remains escaped content in every native view', async () => {
  const data = sample();
  data.chart.result[0].meta.longName = '<script>alert("quote")</script> & {{ 7 | plus: 1 }}';
  const out = await load().run(data);
  for (const name of layoutNames) {
    const html = await render(out, {}, name);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /{{ 7 \| plus: 1 }}/);
  }
});

test('the shared deadline also covers an FX stream that stops responding', async () => {
  let calls = 0;
  const market = sample();
  const out = await load(async () => {
    calls++;
    return new Response(new ReadableStream({ start() {} }));
  }, { setTimeout: fn => setTimeout(fn, 30) }).run(polled(market, { currency: 'EUR' }));
  assert.equal(calls, 1); assert.equal(out.stonks.has_data, false);
  assert.equal(out.stonks.detail, 'Request timed out');
});

test('tiny provider rounding differences do not discard otherwise valid OHLC data', async () => {
  const data = sample(); const q = data.chart.result[0].indicators.quote[0];
  q.high[20] = q.close[20] - 1e-8;
  const out = await load().run(polled(data, { chartType: 'candles' }));
  assert.equal(out.stonks.has_data, true, out.stonks.detail);
  assert.equal(out.stonks.has_ohlc, true);
  assert.equal(load().validState(out.trmnl_state, NOW / 1000, config({ chartType: 'candles' })), true);
});

function signalFixture({ price = 106, lastOpen = 108, flat = false } = {}) {
  const data = sample({ count: 4 });
  const r = data.chart.result[0];
  const close = flat ? [100, 100, 100, price] : [100, 110, 108, price];
  const open = flat ? [100, 100, 100, 100] : [100, 100, 112, lastOpen];
  r.meta.regularMarketPrice = price;
  r.indicators.quote[0] = { close, open, high: close.map((c, i) => Math.max(c, open[i]) + 1),
    low: close.map((c, i) => Math.min(c, open[i]) - 1), volume: [1000, 2000, 1800, 1500] };
  return data;
}

test('the return indicator follows the selected baseline even when the latest candle falls', async () => {
  const out = await load().run(polled(signalFixture(), { chartType: 'candles' }));
  assert.match(await render(out), /aria-label="Up /);
  assert.equal(out.stonks.percent_label, '+6.00');
  const last = out.trmnl_state.bars.at(-1);
  assert.ok(last[4] < last[1]);
  const html = await render(out);
  for (const direction of ['up', 'down', 'flat']) assert.match(html, new RegExp('data-stonks-candle="' + direction + '" d="M'));
  assert.match(html, /data-stonks-return="up"/);
  assert.match(html, /data-stonks-candle="down"/);
});

test('falling and unchanged returns have distinct accessible indicators', async () => {
  const down = await load().run(polled(signalFixture({ price: 90 }), { locale: 'es' }));
  assert.match(await render(down, { locale: 'es' }), /data-stonks-return="down" aria-label="Baja /);
  assert.equal(down.stonks.percent_label, '−10,00');
  const flat = await load().run(polled(signalFixture({ price: 100, flat: true }), { chartType: 'candles' }));
  assert.match(await render(flat), /data-stonks-return="flat"/);
  assert.equal(flat.stonks.percent_label, '0.00');
  const html = await render(flat);
  assert.match(html, /data-stonks-candle="up" d=""/);
  assert.match(html, /data-stonks-candle="down" d=""/);
  assert.match(html, /data-stonks-candle="flat" d="M/);
  assert.match(html, /aria-label="Unchanged 0.00%/);
});

test('changes that round to zero do not show negative zero or a misleading direction', async () => {
  for (const price of [100 + 1e-7, 100 - 1e-7]) {
    const out = await load().run(signalFixture({ price, flat: true }));
    assert.match(await render(out), /data-stonks-return="flat"/);
    assert.equal(out.stonks.percent_label, '0.00');
    assert.equal(out.stonks.absolute_change_label, '0.00');
  }
});

test('baseline clipping preserves the complete curve with unique SVG fragment ids', async () => {
  for (const lineType of ['0', '1', '2']) {
    const out = await load().run(polled(signalFixture(), { showReference: 'show', lineType }));
    const fields = { showReference: 'show', lineType };
    const html = await render(out, fields);
    const above = html.match(/data-stonks-above d="([^"]+)"/);
    const below = html.match(/data-stonks-below d="([^"]+)"/);
    assert.ok(above?.[1].startsWith('M')); assert.equal(below?.[1], above?.[1]);
    const second = await render(out, fields);
    const ids = [...(html + second).matchAll(/<clipPath id="([^"]+)"/g)].map(m => m[1]);
    assert.equal(ids.length, 4); assert.equal(new Set(ids).size, 4);
    for (const id of ids.slice(0, 2)) assert.ok(html.includes('url(#' + id + ')'));
    assert.ok(out.stonks.reference_y > 0 && out.stonks.reference_y < 286);
  }
});

test('direction formatting retains Intl rounding at fractional currency boundaries', async () => {
  const data = signalFixture({ price: 2.005, lastOpen: 3 });
  const q = data.chart.result[0].indicators.quote[0];
  q.close[0] = 1; q.open[0] = 1; q.low[0] = 0.9; q.high[0] = 1.1;
  const out = await load().run(data);
  const formatted = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(out.stonks.change);
  assert.equal(out.stonks.absolute_change_label, '+' + formatted);
  assert.match(await render(out), /data-stonks-return="up"/);
});

test('Shared defines reusable components and only the selected view emits content', async () => {
  const out = await load().run(sample());
  const definitions = await liquid.parseAndRender(shared, out);
  assert.doesNotMatch(definitions, /class="layout|class="title_bar"|data-stonks-price/);
  for (const name of layoutNames) {
    const html = await render(out, { headerFontSize: 'large', fontSize: 12, lineWidth: 4 }, name);
    assert.equal((html.match(/data-stonks-price/g) || []).length, 1);
    assert.match(html, /--stonks-font: 12px/);
    assert.match(html, /stroke-width="4"/);
  }
  // Match native render isolation: undeclared variables must not leak into a partial.
  assert.equal(await liquid.parseAndRender("{% assign secret = 'outer' %}{% template isolated %}{{ secret }}{{ value }}{% endtemplate %}{% render 'isolated', value: 'passed' %}"), 'passed');
});

test('the transform returns numeric geometry and Liquid draws it without changing saved data', async () => {
  const line = await load().run(sample());
  const candles = await load().run(polled(sample(), { chartType: 'candles' }));
  assert.deepEqual(plain(line.trmnl_state), plain(candles.trmnl_state));
  assert.ok(line.stonks.points.length > 0);
  assert.equal(line.stonks.candles.length, 0);
  assert.equal(candles.stonks.points.length, 0);
  assert.ok(candles.stonks.candles.length > 0);
  for (const out of [line, candles]) for (const key of ['path', 'up', 'down', 'flat', 'missing_path', 'volume_path', 'grid', 'reference']) assert.equal(key in out.stonks, false);
  assert.match(await render(line), /data-stonks-line d="M/);
  assert.match(await render(candles), /data-stonks-candle="up" d="M/);
});

test('trmnlp supplies an offline sample that renders all native views', async () => {
  const local = YAML.parse(fs.readFileSync(path.join(__dirname, '.trmnlp.yml'), 'utf8'));
  assert.equal(local.transform_runtime, 'disabled');
  assert.equal(local.variables.stonks.has_data, true);
  assert.match(local.variables.stonks.name, /SAMPLE/);
  for (const name of layoutNames) {
    const html = await render(local.variables, local.custom_fields, name);
    assert.match(html, /data-stonks-price/);
    assert.match(html, /data-stonks-line/);
    assert.doesNotMatch(html, /NaN|Infinity|{{|{%/);
  }
});
