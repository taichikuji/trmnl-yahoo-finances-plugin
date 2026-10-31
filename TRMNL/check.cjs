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
const pollingURL = YAML.parse(fs.readFileSync(path.join(__dirname, 'src/settings.yml'), 'utf8')).polling_url;
const pollURL = (fields, state) => liquid.parseAndRender(pollingURL, { ...fields, ...input(fields, state) });

test('rotation persists across native polls and fresh Serverless instances, then wraps', async () => {
  const fields = { symbol: 'NTNX,AAPL,NVDA', currency: 'NATIVE' };
  let state;
  for (const symbol of ['NTNX', 'AAPL', 'NVDA', 'NTNX', 'AAPL', 'NVDA']) {
    const url = await pollURL(fields, state);
    assert.equal(url, 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=1y&interval=1d&includePrePost=false');
    const out = await load().run(polled(sample({ symbol }), fields, state));
    assert.equal(out.quote.has_data, true, out.quote.detail);
    assert.equal(out.quote.symbol, symbol);
    state = plain(out.trmnl_state);
    assert.equal(state.symbol, symbol);
    assert.ok(load().bytes(state) <= 8192);
    assert.deepEqual(Object.keys(state).filter(k => /charts|history|symbols/.test(k)), []);
  }
});

test('lists trim spaces, ignore empty entries and deduplicate without changing Yahoo notation', async () => {
  const fields = { symbol: ' ntnx, ,%5estoXX50e, ntnx, M%26M.NS, BTC-USD, EURUSD=X, ' };
  let state;
  for (const symbol of ['NTNX', '^STOXX50E', 'M&M.NS', 'BTC-USD', 'EURUSD=X', 'NTNX']) {
    assert.equal(new URL(await pollURL(fields, state)).pathname.split('/').at(-1), encodeURIComponent(symbol));
    const out = await load().run(polled(sample({ symbol }), fields, state));
    assert.equal(out.quote.has_data, true, out.quote.detail);
    assert.equal(out.quote.symbol, symbol);
    state = plain(out.trmnl_state);
  }
});

test('empty or effectively single-symbol lists preserve single-ticker snapshots and URLs', async () => {
  const expected = plain((await load().run(sample())).trmnl_state);
  for (const symbol of [undefined, '', '  ', ', ,', 'NTNX', ' ntnx,NTNX, ']) {
    const fields = { symbol };
    assert.equal(await pollURL(fields), await pollURL({ symbol: 'NTNX' }));
    const out = await load().run(polled(sample(), fields));
    assert.deepEqual(plain(out.trmnl_state), expected);
    assert.equal(out.trmnl_state.rotation, undefined);
  }
});

test('list edits restart at the first symbol, including changes after the current position', async () => {
  const original = { symbol: 'NTNX,AAPL,NVDA' };
  const state = plain((await load().run(polled(sample(), original))).trmnl_state);
  assert.match(await pollURL(original, state), /\/AAPL\?/);
  for (const symbol of ['NVDA,NTNX,AAPL', 'NTNX,AAPL,MSFT', 'NTNX,AAPL,NVDA,MSFT', 'NTNX,NVDA']) {
    const fields = { symbol };
    const first = symbol.split(',')[0];
    assert.match(await pollURL(fields, state), new RegExp('/' + first + '\\?'));
    const out = await load().run(polled(sample({ symbol: first }), fields, state));
    assert.equal(out.quote.has_data, true, out.quote.detail);
    assert.equal(out.trmnl_state.rotation.next, 1);
  }
  assert.match(await pollURL({ symbol: ' ntnx, aapl, ntnx, nvda, ' }, state), /\/AAPL\?/);
});

test('missing, legacy and damaged rotation state start safely at the first ticker', async () => {
  const fields = { symbol: 'NTNX,AAPL,NVDA' };
  const legacy = plain((await load().run(sample())).trmnl_state);
  const good = plain((await load().run(polled(sample(), fields))).trmnl_state);
  for (const state of [undefined, {}, legacy, { rotation: null },
    ...[undefined, null, -1, 1.5, '1', true, {}, 3, Number.MAX_SAFE_INTEGER].map(next => ({ ...good, rotation: { ...good.rotation, next } }))]) {
    assert.match(await pollURL(fields, state), /\/NTNX\?/);
    const out = await load().run(polled(sample(), fields, state));
    assert.equal(out.quote.has_data, true, out.quote.detail);
    assert.equal(out.trmnl_state.rotation.next, 1);
  }
});

test('successful HTTP responses advance past provider errors while retaining only the latest good chart', async () => {
  const fields = { symbol: 'NTNX,AAPL,NVDA' };
  const good = plain((await load().run(polled(sample(), fields))).trmnl_state);
  for (const chart of [null, {}, { result: null, error: { code: 'Not Found' } }]) {
    const failed = await load().run({ chart, ...input(fields, good) });
    assert.equal(failed.quote.symbol, 'AAPL');
    assert.equal(failed.quote.has_data, false);
    assert.equal(failed.trmnl_state.symbol, 'NTNX');
    assert.deepEqual(plain(failed.trmnl_state.bars), good.bars);
    assert.match(await pollURL(fields, plain(failed.trmnl_state)), /\/NVDA\?/);
    const recovered = await load().run(polled(sample({ symbol: 'NVDA' }), fields, plain(failed.trmnl_state)));
    assert.equal(recovered.quote.has_data, true, recovered.quote.detail);
    assert.equal(recovered.trmnl_state.symbol, 'NVDA');
    assert.equal(recovered.trmnl_state.rotation.next, 0);
  }
});

test('a rejected first response saves a cursor without inventing a successful chart', async () => {
  const fields = { symbol: 'NTNX,AAPL' };
  const failed = await load().run({ chart: { error: { code: 'Not Found' } }, ...input(fields) });
  assert.equal(failed.quote.has_data, false);
  assert.deepEqual(Object.keys(failed.trmnl_state), ['rotation']);
  assert.match(await pollURL(fields, plain(failed.trmnl_state)), /\/AAPL\?/);
  const recovered = await load().run(polled(sample({ symbol: 'AAPL' }), fields, plain(failed.trmnl_state)));
  assert.equal(recovered.quote.has_data, true, recovered.quote.detail);
});

test('invalid entry syntax does not erase the latest chart or trigger Serverless requests', async () => {
  for (const bad of ['NASDAQ:AAPL', '%broken', '<script>']) {
    const fields = { symbol: 'NTNX,' + bad + ',NVDA' };
    const saved = plain((await load().run(polled(sample(), fields))).trmnl_state);
    const failed = await load().run({ chart: { error: { code: 'Not Found' } }, ...input(fields, saved) });
    assert.equal(failed.quote.has_data, false);
    assert.match(failed.quote.detail, /Yahoo Finance symbol/);
    assert.equal(failed.trmnl_state.symbol, 'NTNX');
    assert.match(await pollURL(fields, plain(failed.trmnl_state)), /\/NVDA\?/);
  }
});

test('empty failed native polls hold their position with no stock or FX retry, including 429', async () => {
  const fields = { symbol: 'NTNX,AAPL', currency: 'EUR' };
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  const saved = plain((await load(ok(fx)).run(polled(sample(), fields))).trmnl_state);
  // TRMNL strips failed HTTP responses (including 429) and skips state writes.
  for (const state of [undefined, saved]) {
    const before = await pollURL(fields, state);
    for (let i = 0; i < 3; i++) {
      const failed = await load().run(input(fields, state));
      assert.equal(failed.quote.has_data, false);
      assert.equal(failed.quote.detail, 'Yahoo polling failed');
      assert.equal(await pollURL(fields, plain(failed.trmnl_state)), before);
      if (state) assert.deepEqual(plain(failed.trmnl_state), state);
    }
  }
});

test('rotation fallback only displays a matching ticker, currency, range and session', async () => {
  const original = { symbol: 'NTNX,AAPL', currency: 'NATIVE' };
  const saved = plain((await load().run(polled(sample(), original))).trmnl_state);
  for (const fields of [original, { ...original, symbol: 'NTNX,NVDA', currency: 'EUR' },
    { ...original, symbol: 'NTNX,NVDA', dateRanges: '1d|1' }, { ...original, symbol: 'NTNX,NVDA', extendedHours: 'show' }]) {
    const failed = await load().run(input(fields, saved));
    assert.equal(failed.quote.has_data, false);
    assert.equal(failed.trmnl_state.symbol, 'NTNX');
  }
  // Editing the list restarts at NTNX; the latest matching snapshot can be used.
  const restarted = await load().run(input({ ...original, symbol: 'NTNX,NVDA' }, saved));
  assert.equal(restarted.quote.has_data, true);
  assert.equal(restarted.quote.stale, true);
  assert.equal(restarted.quote.symbol, 'NTNX');
});

test('rotation retains Currency conversion and FX failures advance without retrying the stock', async () => {
  const fields = { symbol: 'NTNX,AAPL', currency: 'EUR' };
  const requested = [];
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  const saved = plain((await load(async url => { requested.push(url); return { ok: true, json: async () => fx }; })
    .run(polled(sample(), fields))).trmnl_state);
  assert.equal(saved.currency, 'EUR');
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/USDEUR%3DX\?/);
  const failed = await load(async url => { requested.push(url); return { ok: false, status: 429 }; })
    .run(polled(sample({ symbol: 'AAPL' }), fields, saved));
  assert.equal(failed.quote.has_data, false);
  assert.equal(failed.quote.detail, 'FX HTTP 429');
  assert.equal(requested.length, 2);
  assert.equal(failed.trmnl_state.symbol, 'NTNX');
  assert.match(await pollURL(fields, plain(failed.trmnl_state)), /\/NTNX\?/);
});

test('long lists keep a bounded cursor and one chart instead of storing the configuration', async () => {
  const symbols = Array.from({ length: 2000 }, (_, i) => 'T' + String(i).padStart(4, '0'));
  const fields = { symbol: symbols.join(',') };
  assert.ok(fields.symbol.length > 8192);
  const first = await load().run(polled(sample({ symbol: symbols[0] }), fields));
  const state = plain(first.trmnl_state);
  state.rotation.next = symbols.length - 1;
  assert.match(await pollURL(fields, state), /\/T1999\?/);
  const last = await load().run(polled(sample({ symbol: symbols.at(-1) }), fields, state));
  assert.equal(last.quote.has_data, true, last.quote.detail);
  assert.equal(last.trmnl_state.symbol, symbols.at(-1));
  assert.equal(last.trmnl_state.rotation.next, 0);
  assert.ok(load().bytes(last.trmnl_state) <= 8192);
  assert.ok(JSON.stringify(last.trmnl_state.rotation).length < 100);
});

test('a nearly full legacy snapshot makes room for rotation without losing its quote or OHLCV', async () => {
  const saved = plain((await load().run(sample({ count: 124 }))).trmnl_state);
  assert.ok(load().bytes(saved) > 8150);
  const fields = { symbol: 'NTNX,AAPL' };
  const out = await load().run({ chart: {}, ...input(fields, saved) });
  const state = plain(out.trmnl_state);
  assert.equal(out.quote.has_data, true);
  assert.equal(out.quote.stale, true);
  assert.ok(load().bytes(state) <= 8192);
  assert.equal(load().validState(state, NOW / 1000, config(fields)), true);
  for (const key of ['price', 'baseline', 'market_at', 'fetched_at', 'source_count']) assert.equal(state[key], saved[key]);
  assert.equal(state.bars.at(-1)[4], saved.bars.at(-1)[4]);
  assert.equal(state.bars.reduce((sum, b) => sum + b[5], 0), saved.bars.reduce((sum, b) => sum + b[5], 0));
  assert.match(await pollURL(fields, state), /\/AAPL\?/);
});

test('unexpected saved metadata cannot cause an oversized write or unbounded compaction', async () => {
  const saved = plain((await load().run(sample({ count: 2 }))).trmnl_state);
  saved.unexpected = 'x'.repeat(8192 - load().bytes(saved) - 18);
  assert.equal(load().validState(saved, NOW / 1000), true);
  const out = await load().run({ chart: {}, ...input({ symbol: 'NTNX,AAPL' }, saved) });
  assert.ok(load().bytes(out.trmnl_state) <= 8192);
  assert.deepEqual(Object.keys(out.trmnl_state), ['rotation']);
});

test('native polling URLs preserve Yahoo symbols, ranges and session choices', async () => {
  const source = YAML.parse(fs.readFileSync(path.join(__dirname, 'src/settings.yml'), 'utf8')).polling_url;
  assert.doesNotMatch(source, /[\r\n]/);
  for (const dateRanges of ['1d|1', '1m|30', '3m|60', '12m|1D', '60m|1W', 'all|1M', 'invalid']) {
    for (const symbol of ['NTNX', '%5ESTOXX50E', 'M%26M.NS']) for (const extendedHours of ['hide', 'show']) {
      const fields = { symbol, dateRanges, extendedHours };
      const url = await liquid.parseAndRender(source, fields);
      const expected = config(fields);
      const interval = expected.interval === '30m' ? '15m' : expected.interval;
      assert.equal(url, 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(expected.symbol) +
        '?range=' + expected.range + '&interval=' + interval + '&includePrePost=' + expected.extended);
    }
  }
});

test('Serverless enriches a native polling response without requesting the stock twice', async () => {
  for (const currency of ['USD', 'EUR', 'JPY']) for (const unset of [undefined, null, '', '   ']) {
    const data = sample({ currency });
    let requests = 0;
    const out = await load(async () => { requests++; throw Error('Unexpected provider request'); })
      .run(polled(data, { currency: unset }));
    assert.equal(requests, 0);
    assert.equal(out.quote.has_data, true, out.quote.detail);
    assert.equal(out.quote.currency, currency);
    assert.equal(out.chart, undefined);
    assert.ok(load().bytes(out) < load().bytes(data));
    assert.deepEqual(plain(out.trmnl_state), plain((await load().run(polled(data, { currency: 'NATIVE' }))).trmnl_state));
  }
});

test('malformed native responses retain the matching snapshot without another stock request', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  for (const chart of [null, {}, { error: { description: 'Unavailable' } }]) {
    let requests = 0;
    const out = await load(async () => { requests++; throw Error('Unexpected fetch'); }).run({ chart, ...input({}, saved) });
    assert.equal(requests, 0);
    assert.equal(out.quote.stale, true);
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
    assert.equal(out.quote.has_data, true);
    assert.equal(out.quote.stale, true);
    assert.equal(out.quote.detail, 'Yahoo polling failed');
    assert.equal(out.quote.price, fresh.quote.price);
    assert.equal(out.quote.market_iso, fresh.quote.market_iso);
    assert.deepEqual(plain(out.trmnl_state), saved);
    for (const name of layoutNames) {
      const html = await render(out, {}, name);
      assert.match(html, />STALE DATA<\/span>/);
      assert.match(html, /data-chart-line/);
    }
  }
  const recovered = await offline.run({ ...sample(), ...input({}, saved) });
  assert.equal(requests, 0);
  assert.equal(recovered.quote.stale, false);
  assert.equal(recovered.quote.detail, '');
  assert.doesNotMatch(await render(recovered), />STALE DATA<\/span>/);
});

test('failed polls never retry without usable saved state, including first installation', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  let requests = 0;
  const offline = load(async () => { requests++; return { ok: false, status: 429 }; });
  for (const state of [undefined, {}, { ...saved, price: -1 }, { ...saved, key: 'other selection' }]) {
    const out = await offline.run(input({}, state));
    assert.equal(requests, 0);
    assert.equal(out.quote.has_data, false);
    assert.equal(out.quote.detail, 'Yahoo polling failed');
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
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.quote.currency, 'EUR');
  assert.equal(out.quote.price, market.chart.result[0].meta.regularMarketPrice * rate.chart.result[0].meta.regularMarketPrice);
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
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(p.validState(out.trmnl_state, NOW / 1000, c), true);
  assert.ok(p.bytes(out.trmnl_state) <= 8192);
  assert.equal(out.trmnl_state.source_count, count);
  assert.equal(out.quote.price, data.chart.result[0].meta.regularMarketPrice);
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
    assert.equal(out.quote.has_data, true, out.quote.detail);
    assert.equal(out.quote.symbol, symbol);
    const fallback = await load(async () => ({ ok: false, status: 429 })).run(input({ symbol }, out.trmnl_state));
    assert.equal(fallback.quote.has_data, true);
    assert.equal(fallback.quote.stale, true);
    assert.deepEqual(plain(fallback.trmnl_state), plain(out.trmnl_state));
  }
});

test('malformed market settings fail before fetching; Liquid bounds display controls', async () => {
  let calls = 0;
  const out = await load(async () => { calls++; }).run(input({ symbol: '<script>' }));
  assert.equal(calls, 0); assert.equal(out.quote.has_data, false);
  const fresh = await load().run(sample());
  assert.match(await render(fresh, { fontSize: 999, lineWidth: -1 }), /data-label-class="description description--large"/);
  assert.match(await render(fresh, { fontSize: 999, lineWidth: -1 }), /stroke-width="1"/);
  assert.match(await render(fresh, { fontSize: '' }), /data-label-class="description"/);
});

test('native label presets and saved numeric sizes render in every view', async () => {
  const out = await load().run(sample());
  for (const name of layoutNames) {
    for (const [value, expected] of [['description', 'description'], ['description--large', 'description description--large'], [8, 'description'], ['12', 'description'], [16, 'description description--large'], ['invalid', 'description']]) {
      const html = await render(out, { fontSize: value }, name);
      assert.match(html, new RegExp('data-label-class="' + expected + '"'));
      assert.match(html, new RegExp('<text class="' + expected + '" data-price-tick'));
      assert.doesNotMatch(html, /--description-font-size:|--label-small-font-size:/);
    }
  }
});

test('boolean chart controls retain saved Show/Hide behavior in data and all views', async () => {
  for (const value of [true, 'true', 'show', false, 'false', 'hide', '', undefined]) {
    const enabled = [true, 'true', 'show'].includes(value);
    const fields = { showGridlines: value, showVolume: value, showReference: value };
    const out = await load().run(polled(sample(), fields));
    assert.equal(out.quote.has_volume, enabled);
    for (const name of layoutNames) {
      const html = await render(out, fields, name);
      assert.equal(html.includes('stroke-dasharray="1 6"'), enabled, 'grid lines: ' + value);
      assert.equal(html.includes('stroke-dasharray="6 4"'), enabled, 'return baseline: ' + value);
      assert.equal(html.includes('data-chart-above-baseline'), enabled, 'baseline colors: ' + value);
      assert.equal(html.includes('data-chart-volume'), enabled, 'volume: ' + value);
    }
    if (enabled) {
      const legacy = await load().run(polled(sample(), { showVolume: 'show', showReference: 'show' }));
      assert.deepEqual(plain(out.quote), plain(legacy.quote));
    }
  }
});

test('daily return uses first unadjusted close; 1D uses previous close', async () => {
  const data = sample();
  const out = await load().run(data);
  assert.equal(out.quote.change, data.chart.result[0].meta.regularMarketPrice - data.chart.result[0].indicators.quote[0].close[0]);
  delete data.chart.result[0].indicators.adjclose;
  assert.deepEqual(plain((await load().run(data)).trmnl_state), plain(out.trmnl_state));
  const intraday = sample({ interval: '1m', seconds: 60, count: 390 });
  const one = await load().run(polled(intraday, { dateRanges: '1d|1' }));
  assert.equal(one.quote.change, intraday.chart.result[0].meta.regularMarketPrice - intraday.chart.result[0].meta.chartPreviousClose);
});

test('new quote bars preserve exact seconds through saved-state compaction', async () => {
  const data = sample({ count: 4, interval: '1m', seconds: 60 });
  const r = data.chart.result[0];
  r.meta.regularMarketTime += 66;
  const out = await load().run(polled(data, { dateRanges: '1d|1' }));
  assert.equal(out.quote.has_data, true, out.quote.detail);
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
    assert.equal(out.quote.has_data, true, out.quote.detail);
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

test('30-minute native polling requests 15-minute bars and keeps the displayed interval', async () => {
  const fields = { symbol: 'NTNX,AAPL', dateRanges: '1m|30', currency: 'NATIVE' };
  const data = sample({ interval: '15m', seconds: 900, count: 6 });
  const r = data.chart.result[0];
  r.timestamp = Array.from({ length: 6 }, (_, i) => Date.parse('2026-10-28T18:30Z') / 1000 + i * 900);
  const url = new URL(await pollURL(fields));
  assert.equal(url.searchParams.get('interval'), '15m');
  assert.equal(url.searchParams.get('range'), '1mo');
  const out = await load().run(polled(data, fields));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.quote.interval, '30m');
  assert.equal(out.trmnl_state.source_count, 3);
  assert.equal(out.trmnl_state.bars[0][1], +r.indicators.quote[0].open[0].toPrecision(9));
  assert.equal(out.trmnl_state.bars[0][4], +r.indicators.quote[0].close[1].toPrecision(9));
  assert.equal(out.trmnl_state.bars[0][5], r.indicators.quote[0].volume[0] + r.indicators.quote[0].volume[1]);
  const next = new URL(await pollURL(fields, plain(out.trmnl_state)));
  assert.match(next.pathname, /\/AAPL$/);
  assert.equal(next.searchParams.get('interval'), '15m');
});

test('30-minute conversion requests and aggregates the FX series at the same resolution', async () => {
  const fields = { dateRanges: '1m|30', currency: 'EUR' };
  const market = sample({ interval: '30m', seconds: 1800, count: 3 });
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', interval: '15m', seconds: 900, count: 6, startPrice: 0.8 });
  const start = Date.parse('2026-10-28T18:30Z') / 1000;
  market.chart.result[0].timestamp = [start, start + 1800, start + 3600];
  fx.chart.result[0].timestamp = Array.from({ length: 6 }, (_, i) => start + i * 900);
  let calls = 0;
  const out = await load(async url => {
    calls++;
    assert.equal(new URL(url).searchParams.get('interval'), '15m');
    return { ok: true, json: async () => fx };
  }).run(polled(market, fields));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(calls, 1);
  const expected = market.chart.result[0].indicators.quote[0].close[0] * fx.chart.result[0].indicators.quote[0].close[1];
  assert.equal(out.trmnl_state.baseline, expected);
  assert.equal(out.trmnl_state.source_count, 3);
});

test('Yahoo interval errors retain the matching chart and expose the reason without another stock request', async () => {
  const fields = { dateRanges: '1m|30' };
  const saved = plain((await load().run(polled(sample({ interval: '30m', seconds: 1800 }), fields))).trmnl_state);
  const chart = { result: null, error: { code: 'Bad Request', description: '  Requested range\n  must be within the last 60 days.  ' } };
  const out = await load().run({ chart, ...input(fields, saved) });
  assert.equal(out.quote.detail, 'Yahoo: Requested range must be within the last 60 days.');
  assert.equal(out.quote.stale, true);
  assert.deepEqual(plain(out.trmnl_state), saved);
});

test('Yahoo error descriptions remain bounded, escaped text in every layout', async () => {
  const chart = { error: { description: '<script>unsafe</script> & ' + 'x'.repeat(250) }, result: null };
  const out = await load().run({ chart, ...input() });
  assert.match(out.quote.detail, /^Yahoo: /);
  assert.ok(out.quote.detail.length <= 160);
  for (const name of layoutNames) {
    const html = await render(out, {}, name);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt; &amp;/);
  }
});

test('schema-valid empty Yahoo histories use fallback without inventing prices or fetching again', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  for (const timestamp of [undefined, []]) {
    const data = sample();
    data.chart.result[0].timestamp = timestamp;
    data.chart.result[0].indicators.quote = [{}];
    for (const state of [undefined, saved]) {
      const out = await load().run(polled(data, {}, state));
      assert.equal(out.quote.has_data, !!state);
      assert.equal(out.quote.stale, true);
      if (state) assert.deepEqual(plain(out.trmnl_state), saved);
    }
  }
});

test('a separate live daily row replaces the earlier daily snapshot without double-counting volume', async () => {
  const data = sample({ count: 4 });
  const r = data.chart.result[0];
  r.timestamp[2] = Date.parse('2026-10-28T13:30Z') / 1000;
  const out = await load().run(data);
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.trmnl_state.source_count, 3);
  assert.equal(out.trmnl_state.bars.at(-1)[5], r.indicators.quote[0].volume[3]);
  assert.equal(out.trmnl_state.bars.at(-1)[1], +r.indicators.quote[0].open[3].toPrecision(9));
});

for (const [dateRanges, interval, dates] of [
  ['60m|1W', '1wk', ['2026-10-12T13:30Z', '2026-10-19T13:30Z', '2026-10-26T13:30Z', '2026-10-28T19:55Z']],
  ['all|1M', '1mo', ['2026-08-03T13:30Z', '2026-09-01T13:30Z', '2026-10-01T13:30Z', '2026-10-28T19:55Z']]
]) test(`${interval} merges Yahoo's separate live row into its existing candle`, async () => {
  const data = sample({ count: 4, interval });
  const r = data.chart.result[0];
  r.timestamp = dates.map(s => Date.parse(s) / 1000);
  const out = await load().run(polled(data, { dateRanges }));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.trmnl_state.source_count, 3);
  const last = out.trmnl_state.bars.at(-1);
  const q = r.indicators.quote[0];
  assert.equal(last[0], r.timestamp[2]);
  assert.equal(last[1], +q.open[2].toPrecision(9));
  assert.equal(last[2], +Math.max(q.high[2], q.high[3]).toPrecision(9));
  assert.equal(last[3], +Math.min(q.low[2], q.low[3]).toPrecision(9));
  assert.equal(last[4], +r.meta.regularMarketPrice.toPrecision(9));
  assert.equal(last[5], q.volume[2] + q.volume[3]);
  assert.equal(out.quote.market_at, r.meta.regularMarketTime);
});

test('an exact duplicate tail row is replaced while unordered history remains invalid', async () => {
  const data = sample({ count: 4 });
  const r = data.chart.result[0];
  r.timestamp[2] = r.timestamp[3];
  const out = await load().run(data);
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.trmnl_state.source_count, 3);
  assert.equal(out.trmnl_state.bars.at(-1)[5], r.indicators.quote[0].volume[3]);
  assert.equal(load().validState(out.trmnl_state, NOW / 1000, config({})), true);
});

test('weekly quote alignment uses exchange calendar days across daylight saving changes', async () => {
  const data = sample({ interval: '1wk', count: 3 });
  const r = data.chart.result[0];
  r.timestamp = ['2026-02-16T14:30Z', '2026-02-23T14:30Z', '2026-03-02T14:30Z'].map(s => Date.parse(s) / 1000);
  r.meta.regularMarketTime = Date.parse('2026-03-09T13:30Z') / 1000;
  r.meta.regularMarketPrice = 123;
  const out = await load().run(polled(data, { dateRanges: '60m|1W' }));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.trmnl_state.source_count, 4);
  assert.equal(out.trmnl_state.bars.at(-1)[0], r.meta.regularMarketTime);
  assert.equal(out.trmnl_state.bars.at(-1)[1], null);
  assert.equal(out.trmnl_state.bars.at(-2)[4], +r.indicators.quote[0].close.at(-1).toPrecision(9));
});

test('hourly quotes stay anchored to the exchange bar rather than a whole UTC hour', async () => {
  for (const [time, count] of [['2026-10-28T07:10Z', 4], ['2026-10-28T07:45Z', 5]]) {
    const data = sample({ symbol: '^NSEI', interval: '60m', count: 4, timezone: 'Asia/Kolkata' });
    const r = data.chart.result[0];
    r.timestamp = ['2026-10-28T03:45Z', '2026-10-28T04:45Z', '2026-10-28T05:45Z', '2026-10-28T06:45Z'].map(s => Date.parse(s) / 1000);
    r.meta.regularMarketTime = Date.parse(time) / 1000;
    const out = await load().run(polled(data, { symbol: '^NSEI', dateRanges: '3m|60', currency: 'NATIVE' }));
    assert.equal(out.quote.has_data, true, out.quote.detail);
    assert.equal(out.trmnl_state.source_count, count);
    assert.equal(out.trmnl_state.bars.at(-1)[0], count === 4 ? r.timestamp.at(-1) : r.meta.regularMarketTime);
  }
});

test('merging a live candle retains its actual timestamp and cannot hide an out-of-sync quote', async () => {
  const data = sample({ count: 4, interval: '1wk' });
  const r = data.chart.result[0];
  r.timestamp = ['2026-10-12T13:30Z', '2026-10-19T13:30Z', '2026-10-26T13:30Z', '2026-10-28T19:55Z'].map(s => Date.parse(s) / 1000);
  r.meta.regularMarketTime -= 3600;
  const rejected = await load().run(polled(data, { dateRanges: '60m|1W' }));
  assert.equal(rejected.quote.has_data, false);
  assert.equal(rejected.quote.detail, 'Quote and history are out of sync');
  const extended = await load().run(polled(data, { dateRanges: '60m|1W', extendedHours: 'show' }));
  assert.equal(extended.quote.has_data, true, extended.quote.detail);
  assert.equal(extended.quote.market_at, r.timestamp.at(-1));
  assert.equal(extended.trmnl_state.bars.at(-1)[0], r.timestamp[2]);
});

test('null closes are skipped and absent OHLC/volume are never synthesized', async () => {
  const data = sample(); const q = data.chart.result[0].indicators.quote[0];
  q.close[0] = null; delete q.open; delete q.high; delete q.low; delete q.volume;
  const out = await load().run(polled(data, { chartType: 'candles', showVolume: 'show' }));
  assert.equal(out.quote.has_data, true);
  assert.equal(out.quote.has_ohlc, false); assert.equal(out.quote.has_volume, false);
  assert.ok(out.trmnl_state.bars.every(b => b[1] === null && b[5] === null));
  const html = await render(out);
  assert.match(html, /OHLC unavailable/);
  assert.match(html, /data-chart-line/); assert.doesNotMatch(html, /data-chart-ohlc/);
});

for (const [label, change] of Object.entries({
  'wrong symbol': r => { r.meta.symbol = 'AAPL'; }, 'future quote': r => { r.meta.regularMarketTime += 5000; },
  'invalid time': r => { r.timestamp[1] = null; }, 'unordered': r => { r.timestamp[1] = r.timestamp[0]; },
  'empty prices': r => { r.indicators.quote[0].close.fill(null); }, 'wrong interval': r => { r.meta.dataGranularity = '1wk'; },
  'broken lengths': r => { r.timestamp.pop(); }
})) test(`${label} cannot become saved market data`, async () => {
  const data = sample(); change(data.chart.result[0]);
  const out = await load().run(data);
  assert.equal(out.quote.has_data, false); assert.equal(out.trmnl_state, undefined);
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
  assert.deepEqual(plain(out.trmnl_state), saved); assert.equal(out.quote.stale, true);
  assert.equal(out.quote.market_at, saved.market_at);
  if (name === '429') assert.equal(out.quote.detail, 'FX HTTP 429');
});

test('saved fallback never crosses symbol, currency, range or session boundaries', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  for (const f of [{ symbol: 'AAPL' }, { currency: 'EUR' }, { dateRanges: '1d|1' }, { extendedHours: 'show' }]) {
    const out = await load(async () => ({ ok: false, status: 429 })).run(input(f, saved));
    assert.equal(out.quote.has_data, false); assert.equal(out.trmnl_state, undefined);
  }
});

test('presentation changes redraw cached data even when the provider is unavailable', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  const out = await load(async () => ({ ok: false, status: 429 })).run(input({ chartType: 'candles', locale: 'es', showVolume: 'show' }, saved));
  assert.equal(out.quote.has_data, true); assert.equal(out.quote.has_volume, true);
  assert.equal(out.quote.chart_type, 'candles'); assert.match(await render(out, { locale: 'es' }), /DATOS ANTIGUOS/);
});

test('one deadline bounds FX response bodies without retries', async () => {
  let calls = 0, aborted = false;
  const out = await load(async (url, options) => {
    calls++; options.signal.addEventListener('abort', () => { aborted = true; });
    return { ok: true, json: () => new Promise(() => {}) };
  }, { setTimeout: fn => setTimeout(fn, 10) }).run(polled(sample(), { currency: 'EUR' }));
  assert.equal(calls, 1); assert.equal(aborted, true); assert.equal(out.quote.detail, 'Request timed out');
});

test('real historical FX rates convert the curve, latest price and baseline', async () => {
  const market = sample();
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 });
  const r = fx.chart.result[0];
  const out = await load(async url => ({ ok: true, json: async () => url.includes('USDEUR') ? fx : market })).run(polled(market, { currency: 'EUR' }));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.quote.currency, 'EUR');
  assert.equal(out.quote.price, market.chart.result[0].meta.regularMarketPrice * r.meta.regularMarketPrice);
  assert.equal(out.trmnl_state.baseline, market.chart.result[0].indicators.quote[0].close[0] * r.indicators.quote[0].close[0]);
  assert.match(await render(out), /USD→EUR/);
  assert.ok(out.quote.fx_iso);
});

test('BTC conversion divides by BTC-USD rather than pretending BTC is a fiat pair', async () => {
  const market = sample(); const btc = sample({ symbol: 'BTC-USD', startPrice: 60000 });
  const out = await load(async url => ({ ok: true, json: async () => url.includes('BTC-USD') ? btc : market })).run(polled(market, { currency: 'BTC' }));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.quote.price, market.chart.result[0].meta.regularMarketPrice / btc.chart.result[0].meta.regularMarketPrice);
  assert.equal(out.quote.digits, 6);
});

test('unavailable, misaligned or stale FX cannot publish a misleading converted chart', async () => {
  for (const mutate of [r => { r.timestamp = r.timestamp.map(t => t + 1); r.meta.regularMarketTime += 1; },
    r => { r.meta.regularMarketTime -= 10 * 86400; r.timestamp = r.timestamp.map(t => t - 10 * 86400); }]) {
    const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', startPrice: 0.8 }); mutate(fx.chart.result[0]);
    const out = await load(async url => ({ ok: true, json: async () => url.includes('USDEUR') ? fx : sample() })).run(polled(sample(), { currency: 'EUR' }));
    assert.equal(out.quote.has_data, false); assert.equal(out.trmnl_state, undefined);
  }
});

test('pence are converted to pounds before display and FX', async () => {
  const data = sample({ symbol: 'VWRP.L', currency: 'GBp', startPrice: 10000 });
  const out = await load().run(polled(data, { symbol: 'VWRP.L', currency: 'NATIVE' }));
  assert.equal(out.quote.currency, 'GBP'); assert.equal(out.quote.price, data.chart.result[0].meta.regularMarketPrice / 100);
});

test('Israeli agorot normalize to shekels before quote, OHLC and previous-close formatting', async () => {
  const fields = { symbol: 'TEVA.TA', currency: 'NATIVE', dateRanges: '1d|1' };
  const data = sample({ symbol: 'TEVA.TA', currency: 'ILA', startPrice: 2000, interval: '1m', seconds: 60, count: 8 });
  const r = data.chart.result[0];
  const out = await load().run(polled(data, fields));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.quote.currency, 'ILS');
  assert.equal(out.quote.price, r.meta.regularMarketPrice * 0.01);
  assert.equal(out.trmnl_state.baseline, r.meta.chartPreviousClose * 0.01);
  assert.equal(out.trmnl_state.bars[0][1], +(r.indicators.quote[0].open[0] * 0.01).toPrecision(9));
  assert.equal(out.trmnl_state.bars[0][5], r.indicators.quote[0].volume[0]);
});

test('agorot use the ILS exchange-rate pair rather than a fabricated ILA pair', async () => {
  const data = sample({ symbol: 'TEVA.TA', currency: 'ILA', startPrice: 2000 });
  const fx = sample({ symbol: 'ILSUSD=X', currency: 'USD', startPrice: 0.27 });
  let calls = 0;
  const out = await load(async url => {
    calls++;
    assert.match(new URL(url).pathname, /\/ILSUSD%3DX$/);
    return { ok: true, json: async () => fx };
  }).run(polled(data, { symbol: 'TEVA.TA', currency: 'USD' }));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(calls, 1);
  assert.equal(out.quote.native_currency, 'ILS');
  assert.equal(out.quote.price, data.chart.result[0].meta.regularMarketPrice * 0.01 * fx.chart.result[0].meta.regularMarketPrice);
});

test('extended-hours bars keep their latest price and timestamp', async () => {
  const data = sample({ interval: '1m', seconds: 60, count: 390 });
  data.chart.result[0].meta.regularMarketTime -= 3600;
  const out = await load().run(polled(data, { dateRanges: '1d|1', extendedHours: 'show' }));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.quote.market_at, data.chart.result[0].timestamp.at(-1));
  assert.equal(out.quote.price, data.chart.result[0].indicators.quote[0].close.at(-1));
});

test('old quotes are stale; normal holiday closures are accepted; regressions preserve prior data', async () => {
  const saved = (await load().run(sample())).trmnl_state;
  for (const days of [3, 10]) {
    const data = sample(); const r = data.chart.result[0];
    r.timestamp = r.timestamp.map(t => t - days * 86400); r.meta.regularMarketTime -= days * 86400;
    const out = await load().run(data);
    assert.equal(out.quote.has_data, true); assert.equal(out.quote.stale, days > 7);
    const older = await load(ok(data)).run({ ...data, ...input({}, saved) });
    assert.deepEqual(plain(older.trmnl_state), plain(saved)); assert.equal(older.quote.stale, true);
    assert.equal(older.quote.detail, 'Provider returned older data');
  }
});

test('corrupt and oversized state is rejected before fallback', async () => {
  const saved = plain((await load().run(sample())).trmnl_state);
  for (const state of [{ ...saved, junk: '€'.repeat(4000) }, { ...saved, price: -1 },
    { ...saved, bars: [[123, 1, 0, 2, 3, null], ...saved.bars.slice(1)] }, { ...saved, timezone: 'invalid' }]) {
    assert.equal(load().validState(state, NOW / 1000), false);
    const out = await load(async () => ({ ok: false, status: 500 })).run(input({}, state));
    assert.equal(out.quote.has_data, false);
  }
});

test('Liquid draws distinct line styles; smooth control points stay within segment bounds', async () => {
  const p = load(); const points = [{ x: 4, y: 100 }, { x: 20, y: 10 }, { x: 80, y: 200 }, { x: 696, y: 50 }];
  for (const [lineType, pattern] of [['0', /L/], ['1', /H.*V/], ['2', /C/]]) {
    const out = await load().run(polled(sample(), { lineType }));
    const html = await render(out, { lineType });
    assert.match(html.match(/data-chart-line d="([^"]+)"/)[1], pattern);
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
        assert.equal((html.match(/data-market-view data-label-class=/g) || []).length, 1);
        assert.match(html, /class="title_bar"/); assert.match(html, /data-chart-volume/);
        assert.equal(html.includes('data-chart-ohlc'), chartType !== 'line');
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
  for (const key of ['showGridlines', 'showVolume', 'showReference']) {
    assert.equal(fields[key].field_type, 'boolean');
    assert.equal(fields[key].default, false);
  }
  assert.equal(fields.fontSize.field_type, 'select');
  assert.equal(fields.fontSize.default, 'description');
  assert.deepEqual(fields.fontSize.options, [{ Normal: 'description' }, { Large: 'description--large' }]);
});

test('converted 1D returns start at the first aligned price and label that baseline', async () => {
  const market = sample({ interval: '1m', seconds: 60, count: 390 });
  const fx = sample({ symbol: 'USDEUR=X', currency: 'EUR', interval: '1m', seconds: 60, count: 1440, startPrice: 0.8 });
  const out = await load(async url => ({ ok: true, json: async () => url.includes('USDEUR') ? fx : market }))
    .run(polled(market, { currency: 'EUR', dateRanges: '1d|1', showReference: 'show' }));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  const first = market.chart.result[0].timestamp[0];
  const rateIndex = fx.chart.result[0].timestamp.findLastIndex(t => t <= first);
  const baseline = market.chart.result[0].indicators.quote[0].close[0] * fx.chart.result[0].indicators.quote[0].close[rateIndex];
  assert.equal(out.trmnl_state.baseline, baseline);
  assert.equal(out.trmnl_state.return_basis, 'first_close');
  assert.equal(out.quote.change, out.quote.price - baseline);
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
  assert.equal(out.quote.stale, true);
  assert.equal(out.quote.detail, 'Provider returned older exchange rate');
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
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.quote.stale, true);
  assert.equal(out.quote.detail, 'Exchange rate is over 7 days old');
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
  assert.equal(offline.quote.has_data, true);
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
    assert.equal(out.quote.detail, 'Provider response exceeds 2 MiB');
    assert.equal(out.quote.stale, true);
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
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.quote.price, sample().chart.result[0].meta.regularMarketPrice * data.chart.result[0].meta.regularMarketPrice);
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
  assert.equal(calls, 1); assert.equal(out.quote.has_data, false);
  assert.equal(out.quote.detail, 'Request timed out');
});

test('tiny provider rounding differences do not discard otherwise valid OHLC data', async () => {
  const data = sample(); const q = data.chart.result[0].indicators.quote[0];
  q.high[20] = q.close[20] - 1e-8;
  const out = await load().run(polled(data, { chartType: 'candles' }));
  assert.equal(out.quote.has_data, true, out.quote.detail);
  assert.equal(out.quote.has_ohlc, true);
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
  assert.equal(out.quote.percent_label, '+6.00');
  const last = out.trmnl_state.bars.at(-1);
  assert.ok(last[4] < last[1]);
  const html = await render(out);
  for (const direction of ['up', 'down', 'flat']) assert.match(html, new RegExp('data-chart-candle="' + direction + '" d="M'));
  assert.match(html, /data-quote-return="up"/);
  assert.match(html, /data-chart-candle="down"/);
});

test('falling and unchanged returns have distinct accessible indicators', async () => {
  const down = await load().run(polled(signalFixture({ price: 90 }), { locale: 'es' }));
  assert.match(await render(down, { locale: 'es' }), /data-quote-return="down" aria-label="Baja /);
  assert.equal(down.quote.percent_label, '−10,00');
  const flat = await load().run(polled(signalFixture({ price: 100, flat: true }), { chartType: 'candles' }));
  assert.match(await render(flat), /data-quote-return="flat"/);
  assert.equal(flat.quote.percent_label, '0.00');
  const html = await render(flat);
  assert.match(html, /data-chart-candle="up" d=""/);
  assert.match(html, /data-chart-candle="down" d=""/);
  assert.match(html, /data-chart-candle="flat" d="M/);
  assert.match(html, /aria-label="Unchanged 0.00%/);
});

test('title-bar logo follows the selected return, including stale fallback', async () => {
  const rising = 'M18 42l12-12 10 7 14-20 M42 17h12v12';
  const falling = 'M18 22l12 12 10-7 14 20 M42 47h12V35';
  const logo = async (out, name = 'full') => {
    const html = await render(out, {}, name);
    const base64 = html.match(/src="data:image\/svg\+xml;base64,([^"]+)"/)?.[1];
    assert.ok(base64);
    return Buffer.from(base64, 'base64').toString('utf8');
  };
  for (const [data, expected] of [
    [signalFixture(), rising],
    [signalFixture({ price: 90 }), falling],
    [signalFixture({ price: 100, flat: true }), rising]
  ]) {
    const out = await load().run(polled(data));
    for (const name of layoutNames) assert.ok((await logo(out, name)).includes(expected));
  }
  const down = await load().run(polled(signalFixture({ price: 90 })));
  const stale = await load(async () => ({ ok: false, status: 429 })).run(input({}, down.trmnl_state));
  assert.equal(stale.quote.stale, true);
  assert.ok((await logo(stale)).includes(falling));
});

test('changes that round to zero do not show negative zero or a misleading direction', async () => {
  for (const price of [100 + 1e-7, 100 - 1e-7]) {
    const out = await load().run(signalFixture({ price, flat: true }));
    assert.match(await render(out), /data-quote-return="flat"/);
    assert.equal(out.quote.percent_label, '0.00');
    assert.equal(out.quote.absolute_change_label, '0.00');
  }
});

test('baseline clipping preserves the complete curve with unique SVG fragment ids', async () => {
  for (const lineType of ['0', '1', '2']) {
    const out = await load().run(polled(signalFixture(), { showReference: 'show', lineType }));
    const fields = { showReference: 'show', lineType };
    const html = await render(out, fields);
    const above = html.match(/data-chart-above-baseline d="([^"]+)"/);
    const below = html.match(/data-chart-below-baseline d="([^"]+)"/);
    assert.ok(above?.[1].startsWith('M')); assert.equal(below?.[1], above?.[1]);
    const second = await render(out, fields);
    const ids = [...(html + second).matchAll(/<clipPath id="([^"]+)"/g)].map(m => m[1]);
    assert.equal(ids.length, 4); assert.equal(new Set(ids).size, 4);
    for (const id of ids.slice(0, 2)) assert.ok(html.includes('url(#' + id + ')'));
    assert.ok(out.quote.reference_y > 0 && out.quote.reference_y < 286);
  }
});

test('direction formatting retains Intl rounding at fractional currency boundaries', async () => {
  const data = signalFixture({ price: 2.005, lastOpen: 3 });
  const q = data.chart.result[0].indicators.quote[0];
  q.close[0] = 1; q.open[0] = 1; q.low[0] = 0.9; q.high[0] = 1.1;
  const out = await load().run(data);
  const formatted = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(out.quote.change);
  assert.equal(out.quote.absolute_change_label, '+' + formatted);
  assert.match(await render(out), /data-quote-return="up"/);
});

test('cached data from the former key renders until the next refresh; current quotes take precedence', async () => {
  const fresh = await load().run(sample());
  assert.equal(Object.hasOwn(fresh, 'stonks'), false);
  const legacy = { stonks: fresh.quote };
  const unavailable = await load().run({});
  for (const view of layoutNames) {
    assert.equal(await render(legacy, {}, view), await render(fresh, {}, view));
    assert.equal(await render({ ...legacy, ...unavailable }, {}, view), await render(unavailable, {}, view));
  }
});

test('Shared defines reusable components and only the selected view emits content', async () => {
  const out = await load().run(sample());
  const definitions = await liquid.parseAndRender(shared, out);
  assert.doesNotMatch(definitions, /class="layout|class="title_bar"|data-quote-price/);
  for (const name of layoutNames) {
    const html = await render(out, { headerFontSize: 'large', fontSize: 12, lineWidth: 4 }, name);
    assert.equal((html.match(/data-quote-price/g) || []).length, 1);
    assert.equal((html.match(/data-quote-header/g) || []).length, 1);
    assert.match(html, /data-label-class="description"/);
    assert.match(html, /stroke-width="4"/);
  }
  // Match native render isolation: undeclared variables must not leak into a partial.
  assert.equal(await liquid.parseAndRender("{% assign secret = 'outer' %}{% template isolated %}{{ secret }}{{ value }}{% endtemplate %}{% render 'isolated', value: 'passed' %}"), 'passed');
});

test('compact OHLC charts group complete candles and volume without changing the saved history', async () => {
  const data = sample();
  const line = await load().run(data);
  for (const chartType of ['candles', 'bars']) {
    const fields = { chartType, showVolume: true };
    const out = await load().run(polled(data, fields));
    assert.deepEqual(plain(out.trmnl_state), plain(line.trmnl_state));
    assert.ok(out.quote.candles.length <= 96);
    assert.ok(out.quote.charts.compact?.candles.length <= 32);
    const factor = Math.ceil(out.trmnl_state.bars.length / 32);
    const grouped = [];
    for (let i = 0; i < out.trmnl_state.bars.length; i += factor) {
      const rows = out.trmnl_state.bars.slice(i, i + factor);
      grouped.push([rows[0][0], rows[0][1], Math.max(...rows.map(b => b[2])),
        Math.min(...rows.map(b => b[3])), rows.at(-1)[4], rows.reduce((sum, b) => sum + b[5], 0)]);
    }
    const expected = structuredClone(data);
    const result = expected.chart.result[0];
    result.timestamp = grouped.map(b => b[0]);
    result.indicators.quote[0] = Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map((key, i) => [key, grouped.map(b => b[i + 1])]));
    const manual = await load().run(polled(expected, fields));
    for (const key of ['candles', 'volumes', 'ticks', 'dates', 'body_width']) assert.deepEqual(plain(out.quote.charts.compact[key]), plain(manual.quote[key]), key);
    assert.equal(out.quote.charts.compact.group, out.trmnl_state.group * factor);
    assert.equal(out.quote.charts.compact.price_label, out.quote.price_label);
    assert.equal(out.quote.charts.compact.percent_label, out.quote.percent_label);
    const cached = await load().run(input(fields, out.trmnl_state));
    assert.equal(cached.quote.stale, true);
    assert.deepEqual(plain(cached.quote.charts.compact.candles), plain(out.quote.charts.compact.candles));
    for (const view of layoutNames) {
      const html = await render(out, fields, view);
      const geometry = out.quote.charts.compact;
      assert.match(html, new RegExp('1d ×' + geometry.group));
      assert.match(html, /data-chart-ohlc stroke="currentColor" stroke-width="1"/);
    }
  }
  const dense = sample({ count: 390, startPrice: 100 });
  const quote = dense.chart.result[0].indicators.quote[0];
  quote.open.fill(100); quote.close.fill(100); quote.high.fill(101); quote.low.fill(99); quote.volume.fill(1);
  dense.chart.result[0].meta.regularMarketPrice = 100;
  const out = await load().run(polled(dense, { chartType: 'candles' }));
  assert.ok(out.quote.charts.compact.candles.length < out.quote.candles.length);
  assert.ok(out.quote.candles.length < out.quote.charts.detailed.candles.length);
  assert.ok(out.quote.charts.detailed.candles.length <= 192);
});

test('the transform returns numeric geometry and Liquid draws it without changing saved data', async () => {
  const line = await load().run(sample());
  const candles = await load().run(polled(sample(), { chartType: 'candles' }));
  assert.deepEqual(plain(line.trmnl_state), plain(candles.trmnl_state));
  assert.ok(line.quote.points.length > 0);
  assert.equal(line.quote.candles.length, 0);
  assert.equal(candles.quote.points.length, 0);
  assert.ok(candles.quote.candles.length > 0);
  for (const out of [line, candles]) for (const key of ['path', 'up', 'down', 'flat', 'missing_path', 'volume_path', 'grid', 'reference']) assert.equal(key in out.quote, false);
  assert.match(await render(line), /data-chart-line d="M/);
  assert.match(await render(candles), /data-chart-candle="up" d="M/);
});

test('trmnlp supplies an offline sample that renders all native views', async () => {
  const local = YAML.parse(fs.readFileSync(path.join(__dirname, '.trmnlp.yml'), 'utf8'));
  assert.equal(local.transform_runtime, 'disabled');
  assert.equal(local.variables.quote.has_data, true);
  assert.match(local.variables.quote.name, /SAMPLE/);
  for (const name of layoutNames) {
    const html = await render(local.variables, local.custom_fields, name);
    assert.match(html, /data-quote-price/);
    assert.match(html, /data-chart-line/);
    assert.doesNotMatch(html, /NaN|Infinity|{{|{%/);
  }
});
