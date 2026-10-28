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
const template = fs.readFileSync(path.join(__dirname, 'src/full.liquid'), 'utf8');
const liquid = new Liquid();

test('valid Yahoo-shaped year yields a complete chart, latest quote and price return', async () => {
  const payload = sample();
  const result = payload.chart.result[0];
  const first = result.indicators.quote[0].close[0];
  const latest = result.meta.regularMarketPrice;
  const plugin = load(ok(payload));
  const output = await plugin.run({});
  assert.equal(output.stonks.has_data, true);
  assert.equal(output.stonks.stale, false);
  assert.equal(output.trmnl_state.price, latest);
  assert.equal(output.trmnl_state.change, latest - first);
  assert.equal(output.trmnl_state.percent, (latest - first) / first * 100);
  assert.equal(output.trmnl_state.market_at, result.meta.regularMarketTime);
  assert.equal(output.trmnl_state.fetched_at, NOW / 1000);
  assert.notEqual(output.trmnl_state.market_at, output.trmnl_state.fetched_at);
  assert.equal(plugin.validState(output.trmnl_state, NOW / 1000), true);
  assert.equal(output.trmnl_state.path.match(/[ML]/g).length, result.timestamp.length);
  assert.equal(output.trmnl_state.ticks.length, 5);
  assert.match(output.stonks.market_label, /EDT/);
});

test('uses the expected Yahoo URL and performs one bounded request without retries', async () => {
  let calls = 0;
  await load(async (url, options) => {
    calls++;
    assert.equal(url, 'https://query1.finance.yahoo.com/v8/finance/chart/NTNX?range=1y&interval=1d');
    assert.equal(options.signal.aborted, false);
    assert.equal(options.headers.Accept, 'application/json');
    return { ok: true, json: async () => sample() };
  }).run({});
  assert.equal(calls, 1);
});

test('skips null/missing/invalid closing prices and uses first valid baseline', async () => {
  const data = sample();
  const closes = data.chart.result[0].indicators.quote[0].close;
  closes[0] = null;
  closes[10] = undefined;
  closes[20] = '54.0';
  closes[30] = -1;
  const output = await load(ok(data)).run({});
  assert.equal(output.stonks.has_data, true);
  assert.equal(output.trmnl_state.change, data.chart.result[0].meta.regularMarketPrice - closes[1]);
  assert.equal(output.trmnl_state.path.match(/[ML]/g).length, closes.length - 4);
  assert.doesNotMatch(output.trmnl_state.path, /NaN|Infinity/);
});

test('does not depend on adjusted close and never uses it to calculate returns', async () => {
  const data = sample();
  delete data.chart.result[0].indicators.adjclose;
  const a = await load(ok(data)).run({});
  const b = await load().run({});
  assert.deepEqual(plain(a.trmnl_state), plain(b.trmnl_state));
});

test('appends the latest quote when the daily series has not added its bar yet', async () => {
  const data = sample();
  data.chart.result[0].timestamp.pop();
  data.chart.result[0].indicators.quote[0].close.pop();
  const output = await load(ok(data)).run({});
  assert.equal(output.stonks.has_data, true);
  assert.equal(output.trmnl_state.price, data.chart.result[0].meta.regularMarketPrice);
  assert.equal(output.trmnl_state.path.match(/[ML]/g).length, data.chart.result[0].timestamp.length + 1);
});

test('malformed, incomplete, wrong-symbol/currency, and unordered data never write state', async t => {
  const variants = [null, {}, { chart: { result: [], error: null } },
    { chart: { result: null, error: { code: 'Not Found' } } }];
  for (const mutate of [
    r => { r.meta.symbol = 'AAPL'; },
    r => { r.meta.currency = 'EUR'; },
    r => { r.meta.regularMarketTime = NOW / 1000 + 3600; },
    r => { r.meta.regularMarketPrice = 0; },
    r => { r.timestamp[2] = r.timestamp[1]; },
    r => { r.timestamp[2] = null; },
    r => { r.indicators.quote[0].close = []; },
    r => { r.indicators.quote[0].close.fill(null); },
    r => { r.timestamp = r.timestamp.slice(-130); r.indicators.quote[0].close = r.indicators.quote[0].close.slice(-130); },
    r => { r.meta.dataGranularity = '1wk'; },
    r => { delete r.indicators; }
  ]) {
    const data = sample(); mutate(data.chart.result[0]); variants.push(data);
  }
  for (const [i, data] of variants.entries()) await t.test(`invalid response ${i + 1}`, async () => {
    const output = await load(ok(data)).run({});
    assert.equal(output.stonks.has_data, false);
    assert.equal(Object.hasOwn(output, 'trmnl_state'), false);
  });
});

test('HTTP 429/500, network failures, and invalid JSON preserve saved state exactly', async t => {
  const saved = plain((await load().run({})).trmnl_state);
  const failures = [
    async () => ({ ok: false, status: 429 }),
    async () => ({ ok: false, status: 500 }),
    async () => { throw new Error('Connection reset'); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError('Bad JSON'); } }),
    ok({})
  ];
  for (const [i, fetch] of failures.entries()) await t.test(`failure ${i + 1}`, async () => {
    const output = await load(fetch).run({ trmnl: { state: saved } });
    assert.deepEqual(plain(output.trmnl_state), saved);
    assert.equal(output.stonks.stale, true);
    assert.equal(output.stonks.has_data, true);
    assert.equal(output.stonks.market_at, saved.market_at);
  });
});

test('timeout bounds both a stalled connection and a stalled response body', async t => {
  const saved = plain((await load().run({})).trmnl_state);
  for (const bodyStalls of [false, true]) await t.test(bodyStalls ? 'body' : 'connection', async () => {
    let signal;
    let timeout;
    const plugin = load(async (_, options) => {
      signal = options.signal;
      const never = () => new Promise(() => {});
      return bodyStalls ? { ok: true, json: never } : never();
    }, { setTimeout(fn, ms) { timeout = ms; return setTimeout(fn, 5); } });
    const output = await plugin.run({ trmnl: { state: saved } });
    assert.ok(timeout <= 3000);
    assert.equal(signal.aborted, true);
    assert.equal(output.stonks.detail, 'Request timed out');
    assert.deepEqual(plain(output.trmnl_state), saved);
  });
});

test('failure on first run or with corrupt state gives DATA UNAVAILABLE without a state write', async () => {
  for (const state of [undefined, {}, { v: 1, path: '<script>' }]) {
    const output = await load(async () => { throw new Error('Offline'); }).run({ trmnl: { state } });
    const html = await liquid.parseAndRender(template, output);
    assert.match(html, /DATA UNAVAILABLE/);
    assert.doesNotMatch(html, /data-stonks-line/);
    assert.equal(Object.hasOwn(output, 'trmnl_state'), false);
  }
});

test('flat and extreme finite price series have a visible path inside SVG bounds', () => {
  const plugin = load();
  for (const prices of [[50, 50, 50], [0.00001, 0.00002, 0.00001], [1, 999999, 2]]) {
    const data = plugin.chart(prices.map((p, i) => ({ t: 1700000000 + i * 86400, p })));
    const pairs = [...data.path.matchAll(/[ML]([\d.]+),([\d.]+)/g)];
    assert.equal(pairs.length, 3);
    assert.equal(+pairs[0][1], 4);
    assert.equal(+pairs.at(-1)[1], 696);
    for (const p of pairs) assert.ok(+p[2] >= 12 && +p[2] <= 274);
    assert.doesNotMatch(data.path, /NaN|Infinity/);
  }
  assert.throws(() => plugin.chart([{ t: 1700000000, p: 1 }]));
  assert.throws(() => plugin.chart([{ t: 1700000000, p: 1 }, { t: 1700000000, p: 2 }]));
});

test('Saved State remains within 8192 UTF-8 bytes for a full daily year', async () => {
  const output = await load().run({});
  assert.ok(Buffer.byteLength(JSON.stringify(output.trmnl_state)) < 8192);
  const oversized = { ...plain(output.trmnl_state), junk: '\u20ac'.repeat(4000) };
  const invalid = { ...plain(output.trmnl_state), path: 'M4.0,10.0L9999.0,20.0' };
  assert.equal(load().validState(oversized, NOW / 1000), false);
  assert.equal(load().validState(invalid, NOW / 1000), false);
});

test('normal weekends and multi-day holiday closures do not make successful data stale', async () => {
  for (const age of [2, 3, 4, 6]) {
    const data = sample();
    const r = data.chart.result[0];
    const cutoff = NOW / 1000 - age * 86400;
    while (r.timestamp.at(-1) > cutoff) { r.timestamp.pop(); r.indicators.quote[0].close.pop(); }
    r.meta.regularMarketTime = cutoff;
    const output = await load(ok(data)).run({});
    assert.equal(output.stonks.has_data, true);
    assert.equal(output.stonks.stale, false);
  }
});

test('old market data is stale even after a successful fresh API request', async () => {
  const data = sample();
  const r = data.chart.result[0];
  r.timestamp = r.timestamp.map(t => t - 10 * 86400);
  r.meta.regularMarketTime -= 10 * 86400;
  const output = await load(ok(data)).run({});
  assert.equal(output.stonks.has_data, true);
  assert.equal(output.stonks.stale, true);
  assert.equal(output.trmnl_state.fetched_at, NOW / 1000);
  assert.match(output.stonks.detail, /7 days/);
});

test('a regressing provider response cannot replace a newer saved quote', async () => {
  const saved = plain((await load().run({})).trmnl_state);
  const data = sample();
  const r = data.chart.result[0];
  r.timestamp = r.timestamp.map(t => t - 86400);
  r.meta.regularMarketTime -= 86400;
  const output = await load(ok(data)).run({ trmnl: { state: saved } });
  assert.deepEqual(plain(output.trmnl_state), saved);
  assert.equal(output.stonks.stale, true);
});

test('fresh/stale Liquid renders a completed inline chart and actual market timestamp', async () => {
  const fresh = await load().run({});
  const stale = await load(async () => ({ ok: false, status: 429 })).run({ trmnl: { state: fresh.trmnl_state } });
  for (const output of [fresh, stale]) {
    const html = await liquid.parseAndRender(template, output);
    assert.match(html, /data-stonks-line d="M/);
    assert.match(html, /Market data:/);
    assert.ok(html.includes(output.stonks.market_label));
    assert.doesNotMatch(html, /<script|<iframe|<img|https?:\/\/[^" ]*(?:\.js|\.css)|NaN|Infinity|{{|{%/);
    assert.equal(html.includes('STALE DATA'), output.stonks.stale);
  }
});

test('settings select native static/Node Serverless and have no unnecessary options', () => {
  const settings = YAML.parse(fs.readFileSync(path.join(__dirname, 'src/settings.yml'), 'utf8'));
  assert.equal(settings.name, 'STONKS');
  assert.equal(settings.strategy, 'static');
  assert.equal(settings.static_data, '{}');
  assert.equal(settings.serverless_language, 'node');
  assert.equal(settings.refresh_interval, 60);
  assert.equal(settings.no_screen_padding, 'yes');
  assert.equal(settings.custom_fields, undefined);
});
