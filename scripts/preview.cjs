// Local-only preview matrix. The imported plugin uses no browser or chart library.
const fs = require('node:fs');
const path = require('node:path');
const { createLiquid, loadPlugin } = require('./render-liquid.cjs');
const { chromium } = require('playwright-core');
const YAML = require('yaml');
const { sample, NOW } = require('../TRMNL/fixtures/sample.cjs');

// Profiles from the pinned framework's db/data/framework_devices.yml.
// Original monochrome OG is included alongside current 2-bit OG and OG B/W/R/Y.
const devices = {
  og: { name: 'TRMNL OG (1-bit)', css: 'og', size: 'md', mode: '1bit', width: 800, height: 480, scale: 1 },
  ogv2: { name: 'TRMNL OG (2-bit)', css: 'ogv2', size: 'md', mode: '2bit', width: 800, height: 480, scale: 1 },
  bwry: { name: 'TRMNL OG (B/W/R/Y)', css: 'og', size: 'md', mode: 'color-4bwry', width: 800, height: 480, scale: 1 },
  x: { name: 'TRMNL X', css: 'v2', size: 'lg', mode: '4bit', width: 1040, height: 780, scale: 1.8 }
};
const layouts = { full: null, half_horizontal: '1Tx1B', half_vertical: '1Lx1R', quadrant: '2x2' };
// Match the user's review priority; X portrait is intentionally last.
const surfaces = [
  ['og', 'landscape'], ['ogv2', 'landscape'], ['x', 'landscape'], ['bwry', 'landscape'],
  ['og', 'portrait'], ['ogv2', 'portrait'], ['bwry', 'portrait'], ['x', 'portrait']
];
function pricesFixture(closes) {
  const data = sample({ count: closes.length });
  const r = data.chart.result[0];
  const open = closes.map((p, i) => i % 13 === 0 ? p : closes[Math.max(0, i - 1)]);
  r.indicators.quote[0] = { close: closes, open,
    high: closes.map((p, i) => Math.max(p, open[i]) * 1.01),
    low: closes.map((p, i) => Math.min(p, open[i]) * 0.99),
    volume: closes.map((_, i) => 1000000 + i * 1703) };
  r.meta.regularMarketPrice = closes.at(-1);
  return data;
}

async function main() {
  const root = path.join(__dirname, '..');
  const outputDir = path.join(root, 'dist/preview');
  fs.mkdirSync(outputDir, { recursive: true });
  class Clock extends Date { static now() { return NOW; } }
  const plugin = fetch => loadPlugin({ fetch, Date: Clock });
  const noFetch = () => { throw new Error('Unexpected Yahoo request during preview'); };
  const fresh = await plugin(noFetch).run(sample());
  const offline = plugin(noFetch);
  const stale = await offline.run({ trmnl: { state: fresh.trmnl_state } });
  const unavailable = await offline.run({});
  const states = { fresh, stale, unavailable };
  async function scenario(fields, fixture = sample()) {
    const trmnl = { plugin_settings: { custom_fields_values: fields } };
    const result = await plugin(noFetch).run({ ...fixture, trmnl });
    if (!result.stonks.has_data) throw new Error('Invalid preview scenario: ' + result.stonks.detail);
    result.trmnl = trmnl;
    return result;
  }
  const sourceCloses = sample().chart.result[0].indicators.quote[0].close;
  const mixed = pricesFixture(sourceCloses);
  states.candles = await scenario({ chartType: 'candles', showVolume: true, showGridlines: true }, mixed);
  states.bars = await scenario({ chartType: 'bars', showVolume: true, showReference: true }, mixed);
  const losses = pricesFixture(sourceCloses.map(p => 100 - p));
  states.loss = await scenario({}, losses);
  const crossingCloses = Array.from({ length: 90 }, (_, i) => +(100 + 8 * Math.sin(i / 7) + i * 0.025).toFixed(2));
  states.baseline = await scenario({ showReference: 'show' }, pricesFixture(crossingCloses));
  states.baseline_loss = await scenario({ showReference: 'show' }, pricesFixture(crossingCloses.map((p, i) => p - i * 0.08)));
  states.flat = await scenario({ showReference: 'show', chartType: 'candles' }, pricesFixture(Array(30).fill(100)));
  states.step = await scenario({ lineType: '1', headerFontSize: 'small', locale: 'pl' });
  states.small = await scenario({ lineType: '0', lineWidth: 1, headerFontSize: 'small', fontSize: 8, precision: '0', locale: 'pl' });
  states.thick = await scenario({ lineType: '0', lineWidth: 5, precision: '4' });
  states.large = await scenario({ headerFontSize: 'large', fontSize: 'description--large', showVolume: true, chartType: 'candles', locale: 'de_DE' });
  states.weekly = await scenario({ dateRanges: '60m|1W', fontSize: 16, locale: 'fr' }, sample({ interval: '1wk', seconds: 7 * 86400 }));
  states.monthly = await scenario({ dateRanges: 'all|1M', precision: '2' }, sample({ interval: '1mo', seconds: 31 * 86400 }));
  const longSymbol = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.ABC';
  states.long_symbol = await scenario({ symbol: longSymbol, dateRanges: '3m|60', fontSize: 16 }, sample({ symbol: longSymbol, interval: '60m', seconds: 3600 }));
  const etf = sample({ symbol: 'VWCE.DE', currency: 'EUR' });
  etf.chart.result[0].meta.longName = 'Vanguard FTSE All-World UCITS ETF USD Accumulating';
  states.etf = await scenario({ symbol: 'VWCE.DE', locale: 'fr', fontSize: 12 }, etf);
  const longName = sample();
  longName.chart.result[0].meta.longName = 'A Very Long Company Name That Must Fit Without Overlapping the Ticker Symbol';
  states.long_name = await scenario({ fontSize: 'description--large' }, longName);
  states.crypto = await scenario({ symbol: 'BTC-USD', currency: 'NATIVE', locale: 'es' }, sample({ symbol: 'BTC-USD', startPrice: 65000 }));
  states.small_price = await scenario({ symbol: 'DOGE-USD', currency: 'NATIVE', locale: 'es', precision: '6' }, sample({ symbol: 'DOGE-USD', startPrice: 0.1 }));
  states.intraday = await scenario({ dateRanges: '1d|1', extendedHours: 'show', chartType: 'candles', showVolume: 'show', locale: 'it' }, sample({ interval: '1m', seconds: 60, count: 390 }));
  states.thirty_minute = await scenario({ dateRanges: '1m|30', chartType: 'candles', showVolume: 'show' }, sample({ interval: '15m', seconds: 900, count: 390 }));
  const agorot = sample({ symbol: 'TEVA.TA', currency: 'ILA', startPrice: 2000 });
  agorot.chart.result[0].meta.longName = 'Teva Pharmaceutical Industries · SAMPLE';
  states.agorot = await scenario({ symbol: 'TEVA.TA', currency: 'NATIVE' }, agorot);
  states.provider_error = await offline.run({ chart: { result: null, error: {
    description: 'Requested range must be within the last 60 days. Check the selected interval.'
  } } });
  states.stale_large = await offline.run({ trmnl: {
    state: states.large.trmnl_state,
    plugin_settings: { custom_fields_values: { headerFontSize: 'large', fontSize: 16, locale: 'de_DE', showVolume: 'show' } }
  } });
  states.stale_large.trmnl = { plugin_settings: { custom_fields_values: { headerFontSize: 'large', fontSize: 16, locale: 'de_DE', showVolume: 'show' } } };
  const fxMarket = sample({ interval: '1m', seconds: 60, count: 390 });
  const fxRates = sample({ symbol: 'USDEUR=X', currency: 'EUR', interval: '1m', seconds: 60, count: 1440, startPrice: 0.8 });
  states.converted_day = await plugin(async () => ({ ok: true, json: async () => fxRates })).run({ ...fxMarket,
    trmnl: { plugin_settings: { custom_fields_values: { currency: 'EUR', dateRanges: '1d|1', locale: 'es' } } }
  });
  if (!states.converted_day.stonks.has_data) throw new Error(states.converted_day.stonks.detail);
  states.converted_day.trmnl = { plugin_settings: { custom_fields_values: { currency: 'EUR', dateRanges: '1d|1', locale: 'es' } } };

  const rotationFields = { symbol: 'NTNX,NVDA' };
  const rotationSettings = { custom_fields_values: rotationFields };
  const first = await plugin(noFetch).run({ ...sample(), trmnl: { plugin_settings: rotationSettings } });
  const rotatedSample = sample({ symbol: 'NVDA' });
  rotatedSample.chart.result[0].meta.longName = 'NVIDIA Corp. · SAMPLE';
  states.rotation = await plugin(noFetch).run({ ...rotatedSample,
    trmnl: { state: first.trmnl_state, plugin_settings: rotationSettings } });
  states.rotation.trmnl = { plugin_settings: rotationSettings };
  states.rotation_unavailable = await plugin(noFetch).run({
    trmnl: { state: states.rotation.trmnl_state, plugin_settings: rotationSettings } });
  states.rotation_unavailable.trmnl = { plugin_settings: rotationSettings };
  const restartedSettings = { custom_fields_values: { symbol: 'NVDA,NTNX' } };
  states.rotation_stale = await plugin(noFetch).run({
    trmnl: { state: states.rotation.trmnl_state, plugin_settings: restartedSettings } });
  states.rotation_stale.trmnl = { plugin_settings: restartedSettings };
  for (const name of ['rotation', 'rotation_unavailable', 'rotation_stale']) {
    if (states[name].stonks.has_data !== (name !== 'rotation_unavailable')) throw new Error('Invalid rotation preview: ' + name);
  }

  const shared = fs.readFileSync(path.join(root, 'TRMNL/src/shared.liquid'), 'utf8');
  const settings = YAML.parse(fs.readFileSync(path.join(root, 'TRMNL/src/settings.yml'), 'utf8'));
  const frameworkURL = 'https://trmnl.com/css/' + settings.framework_version + '/plugins.css';
  const frameworkJSURL = 'https://trmnl.com/js/' + settings.framework_version + '/plugins.js';
  const cache = path.join(root, '.cache/framework', settings.framework_version);
  async function asset(url) {
    const parsed = new URL(url);
    const name = url === frameworkURL ? 'css/plugins.css' : url === frameworkJSURL ? 'js/plugins.js' :
      parsed.origin === 'https://trmnl.com' && /^\/fonts\/[\w.-]+$/.test(parsed.pathname) && !parsed.search ?
        parsed.pathname.slice(1) : null;
    if (!name) throw new Error('Unexpected preview resource: ' + url);
    const file = path.join(cache, name);
    if (!fs.existsSync(file)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Framework asset HTTP ' + response.status + ': ' + url);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    return fs.readFileSync(file);
  }
  await Promise.all([asset(frameworkURL), asset(frameworkJSURL)]);
  const liquid = createLiquid();
  const head = '<!doctype html><html lang="en"><meta charset="utf-8">' +
    '<title>STONKS · sample preview</title><link rel="stylesheet" href="' + frameworkURL + '">' +
    '<script defer src="' + frameworkJSURL + '"></script>' +
    '<style>html,body{margin:0;width:100vw;height:100vh;overflow:hidden}</style><body class="trmnl">';
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: process.env.TRMNL_BROWSER || 'chrome' }),
    headless: true, args: ['--no-sandbox']
  });
  const report = [];
  const problems = [];
  const figures = [];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const failedResources = [];
    page.on('pageerror', error => failedResources.push(error.message));
    await page.route('**/*', async route => {
      const url = route.request().url();
      try {
        await route.fulfill({ body: await asset(url),
          contentType: url === frameworkURL ? 'text/css' : url === frameworkJSURL ? 'text/javascript' :
            url.endsWith('.woff2') ? 'font/woff2' : url.endsWith('.woff') ? 'font/woff' : 'font/ttf' });
      } catch (error) {
        failedResources.push(error.message);
        await route.abort();
      }
    });
    // Keep the stylesheet loaded while testing each actual native wrapper.
    await page.setContent(head + '</body></html>');
    await page.evaluate(() => window.terminalize());
    for (const [device, orientation] of surfaces) {
      const profile = devices[device];
        const portrait = orientation === 'portrait';
        const width = Math.round((portrait ? profile.height : profile.width) * profile.scale);
        const height = Math.round((portrait ? profile.width : profile.height) * profile.scale);
        await page.setViewportSize({ width, height });
        const classes = 'screen screen--' + profile.css + ' screen--' + profile.size +
          ' screen--' + profile.mode + (profile.scale > 1 ? ' screen--density-2x' : '') +
          (portrait ? ' screen--portrait' : '') + (settings.no_screen_padding === 'yes' ? ' screen--no-bleed' : '');
        for (const [layout, mashup] of Object.entries(layouts)) {
          const viewSource = fs.readFileSync(path.join(root, 'TRMNL/src/' + layout + '.liquid'), 'utf8');
          if (!viewSource.trim()) throw new Error('TRMNL requires a nonempty view: ' + layout);
          for (const [state, model] of Object.entries(states)) {
            const id = [device, orientation, layout, state].join('-');
            const markup = (await liquid.parseAndRender(shared + '\n' + viewSource, model)).replace(/(<span\b[^>]*data-stonks-status[^>]*>)/, '$1SAMPLE · ');
            const view = '<div class="view view--' + layout + '">' + markup + '</div>';
            const surface = '<div class="' + classes + '">' +
              (mashup ? '<div class="mashup mashup--' + mashup + '">' + view + '</div>' : view) + '</div>';
            fs.writeFileSync(path.join(outputDir, id + '.html'), head + surface + '</body></html>');
            await page.evaluate(async surface => {
              document.body.innerHTML = surface;
              await window.terminalize();
            }, surface);
            const measurements = await page.evaluate(async () => {
              document.body.getBoundingClientRect(); // Resolve styles before waiting for fonts.
              await document.fonts.ready;
              const main = document.querySelector('.view');
              const layout = main.querySelector('.layout');
              const chart = [...main.querySelectorAll('[data-stonks-line], [data-stonks-ohlc] path')].find(el => el.getAttribute('d'));
              const svg = main.querySelector('[data-stonks-plot]')?.getBoundingClientRect();
              const bounds = main.getBoundingClientRect();
              const outside = r => r.width && r.height &&
                (r.left < bounds.left - 2 || r.top < bounds.top - 2 ||
                 r.right > bounds.right + 2 || r.bottom > bounds.bottom + 2);
              const overflow = [...main.querySelectorAll('*')].filter(el => outside(el.getBoundingClientRect()))
                .map(el => el.tagName + '.' + el.getAttribute('class'));
              const textOverflow = [];
              const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const node = walker.currentNode;
                if (!node.textContent.trim() || node.parentElement.closest('svg')) continue;
                const style = getComputedStyle(node.parentElement);
                if (style.textOverflow === 'ellipsis' && style.overflowX === 'hidden') continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                if ([...range.getClientRects()].some(outside)) textOverflow.push(node.textContent.trim());
              }
              const textOverlaps = [];
              const overlaps = (a, b) => a.width && b.width && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
              const dates = [...main.querySelectorAll('[data-stonks-date]')].map(el => el.getBoundingClientRect()).filter(r => r.width);
              if (dates.some((r, i) => dates.slice(i + 1).some(next => overlaps(r, next)))) textOverlaps.push('date labels');
              const heading = main.querySelector('[data-stonks-heading]');
              if (heading && overlaps(...[...heading.children].map(el => el.getBoundingClientRect()))) textOverlaps.push('company name and ticker');
              const price = main.querySelector('[data-stonks-price]');
              const currency = main.querySelector('[data-stonks-currency]');
              if (price && currency) {
                const a = document.createRange(), b = document.createRange();
                a.selectNodeContents(price); b.selectNodeContents(currency);
                if (overlaps(a.getBoundingClientRect(), b.getBoundingClientRect())) textOverlaps.push('price and currency');
              }
              const paint = selector => {
                const el = main.querySelector(selector);
                if (!el) return null;
                const style = getComputedStyle(el);
                return { color: style.color, background: style.backgroundColor, stroke: style.stroke, fill: style.fill };
              };
              const returnBadge = main.querySelector('[data-stonks-return]');
              const signals = { direction: returnBadge?.dataset.stonksReturn,
                badge: paint('[data-stonks-return]'), price: paint('[data-stonks-price]'),
                up: paint('[data-stonks-candle="up"]'), down: paint('[data-stonks-candle="down"]'),
                flat: paint('[data-stonks-candle="flat"]'), above: paint('[data-stonks-above]'), below: paint('[data-stonks-below]') };
              const marker = main.querySelector('[data-stonks-point]');
              const axis = main.querySelector('[data-stonks-axis]')?.getBoundingClientRect();
              const glyphOverhang = bounds.width / main.offsetWidth;
              const axisTicksFit = !axis || [...main.querySelectorAll('[data-stonks-tick]')].every(el => {
                const tick = el.getBoundingClientRect();
                return tick.left >= axis.left - glyphOverhang && tick.right <= axis.right + glyphOverhang;
              });
              let markerError = null;
              if (marker && chart?.hasAttribute('data-stonks-line')) {
                const last = chart.getPointAtLength(chart.getTotalLength()).matrixTransform(chart.getScreenCTM());
                const dot = marker.getBoundingClientRect();
                markerError = Math.hypot(last.x - dot.left - dot.width / 2, last.y - dot.top - dot.height / 2);
              }
              const time = main.querySelector('time');
              const timeRange = document.createRange();
              if (time) timeRange.selectNodeContents(time);
              const timeFits = !time || timeRange.getBoundingClientRect().width <=
                time.closest('.instance').getBoundingClientRect().width + 1;
              const fonts = [...new Set([...document.fonts].filter(f => f.status === 'loaded').map(f => f.family))];
              const fontSize = selector => { const el = main.querySelector(selector); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
              const typography = { heading: fontSize('[data-stonks] .title'), price: fontSize('[data-stonks-price]'), labels: fontSize('[data-stonks-date]') };
              const nativeLabelSizes = Object.fromEntries(['description', 'description--large'].map(className => {
                const probe = document.createElement('span');
                probe.className = className;
                layout.appendChild(probe);
                const size = parseFloat(getComputedStyle(probe).fontSize);
                probe.remove();
                return [className, size];
              }));
              return { width: bounds.width, height: bounds.height,
                svgWidth: svg?.width, svgHeight: svg?.height,
                nativeStructure: layout.nextElementSibling?.classList.contains('title_bar'),
                timeFits, axisTicksFit, overflow, textOverflow, textOverlaps, fonts, typography, nativeLabelSizes, signals, markerError,
                frameworkErrors: window.__TRMNL_LAST_STATS__?.errors || [],
                pathLength: chart?.getTotalLength() ?? null };
            });
            if (failedResources.length) throw new Error(failedResources.join('\n'));
            const errors = [];
            const cssWidth = portrait ? profile.height : profile.width;
            const cssHeight = portrait ? profile.width : profile.height;
            const expectedWidth = (['half_vertical', 'quadrant'].includes(layout) ? (cssWidth - 30) / 2 : cssWidth - 20) * profile.scale;
            const expectedHeight = (['half_horizontal', 'quadrant'].includes(layout) ? (cssHeight - 30) / 2 : cssHeight - 20) * profile.scale;
            if (Math.abs(measurements.width - expectedWidth) > 1 || Math.abs(measurements.height - expectedHeight) > 1) {
              errors.push('native slot dimensions');
            }
            if (!measurements.nativeStructure || !measurements.fonts.length) errors.push('native structure/fonts');
            const fontSetting = model.trmnl?.plugin_settings?.custom_fields_values?.fontSize;
            const fontClass = fontSetting === 'description--large' || Number(fontSetting) > 12 ? 'description--large' : 'description';
            const expectedLabelSize = measurements.nativeLabelSizes[fontClass];
            if (measurements.frameworkErrors.length) errors.push('Framework runtime error');
            if (model.stonks.has_data && Math.abs(measurements.typography.labels - expectedLabelSize) > 0.01) errors.push('chart label size differs from setting');
            if (layout === 'full' && model.trmnl?.plugin_settings?.custom_fields_values?.headerFontSize !== 'small' && measurements.typography.heading < 21) errors.push('full heading too small');
            if (measurements.overflow.length || measurements.textOverflow.length) errors.push('slot overflow');
            if (measurements.textOverlaps.length) errors.push('overlapping text');
            if (!measurements.timeFits) errors.push('market timestamp truncated');
            if (!measurements.axisTicksFit) errors.push('price labels clipped');
            if (measurements.markerError !== null && measurements.markerError > 1) errors.push('price marker misaligned');
            if (model.stonks.has_data && (!(measurements.pathLength > 100) ||
                measurements.svgWidth < 80 * profile.scale || measurements.svgHeight < 40 * profile.scale)) {
              errors.push('chart too small');
            }
            if (model.stonks.has_data) {
              const signals = measurements.signals;
              const gray = value => { const c = value?.match(/^rgb\((\d+), (\d+), (\d+)\)$/); return c && c[1] === c[2] && c[2] === c[3]; };
              if (!gray(signals.price?.color)) errors.push('price contrast');
              if (device === 'bwry') {
                if (signals.direction === 'up' && (signals.badge.background !== 'rgb(255, 255, 0)' || signals.badge.color !== 'rgb(0, 0, 0)')) errors.push('gain contrast on B/W/R/Y');
                if (signals.direction === 'down' && signals.badge.color !== 'rgb(255, 0, 0)') errors.push('loss ink on B/W/R/Y');
                if (signals.up && signals.up.fill !== (model.stonks.chart_type === 'candles' ? 'rgb(255, 255, 0)' : 'none')) errors.push('rising candle ink');
                if (signals.down && signals.down.stroke !== 'rgb(255, 0, 0)') errors.push('falling candle ink');
                if (signals.below && signals.below.stroke !== 'rgb(255, 0, 0)') errors.push('below-baseline ink');
              } else if ([signals.badge?.color, signals.up?.stroke, signals.down?.stroke, signals.above?.stroke, signals.below?.stroke].filter(Boolean).some(value => !gray(value))) errors.push('non-grayscale signal');
            }
            report.push({ id, device, orientation, layout, state, canvas: { width, height }, ...measurements, errors });
            if (errors.length) problems.push({ id, ...measurements, errors });
            const file = path.join(outputDir, id + '.png');
            if (layout === 'full') await page.screenshot({ path: file });
            else await page.locator('.view').screenshot({ path: file });
            if (device === 'og' && !portrait && layout === 'full') {
              fs.copyFileSync(file, path.join(outputDir, state + '.png'));
              fs.copyFileSync(path.join(outputDir, id + '.html'), path.join(outputDir, state + '.html'));
            }
            // Virtual full-color reference validates true green/red independently
            // of the target panels' grayscale and B/W/R/Y limits.
            if (device === 'bwry' && !portrait && layout === 'full' && ['candles', 'baseline', 'loss'].includes(state)) {
              const reference = await page.evaluate(() => {
                const screen = document.querySelector('.screen');
                screen.classList.replace('screen--color-4bwry', 'screen--color-full');
                const style = selector => { const el = document.querySelector(selector); return el ? getComputedStyle(el) : null; };
                return { up: style('[data-stonks-candle="up"]')?.stroke,
                  down: style('[data-stonks-candle="down"]')?.stroke,
                  above: style('[data-stonks-above]')?.stroke,
                  below: style('[data-stonks-below]')?.stroke,
                  badge: style('[data-stonks-return]')?.color };
              });
              const good = state === 'candles' ? reference.up === 'rgb(0, 136, 0)' && reference.down === 'rgb(170, 0, 0)' :
                state === 'baseline' ? reference.above === 'rgb(0, 136, 0)' && reference.below === 'rgb(170, 0, 0)' : reference.badge === 'rgb(170, 0, 0)';
              if (!good) throw new Error('Full-color ink mismatch: ' + JSON.stringify(reference));
              await page.screenshot({ path: path.join(outputDir, 'full-color-reference-' + state + '.png') });
            }
            figures.push('<figure><a href="' + id + '.html"><img loading="lazy" src="' + id +
              '.png" alt="' + id + '"></a><figcaption>' + profile.name + ' · ' + orientation +
              ' · ' + layout + ' · ' + state + '</figcaption></figure>');
          }
        }
        console.log(device + '/' + orientation + ': 4 views × ' + Object.keys(states).length + ' scenarios checked on ' + width + '×' + height);
    }
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(outputDir, 'index.html'),
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>STONKS preview matrix</title>' +
      '<style>body{font:14px system-ui;margin:24px;background:#eee}main{display:grid;grid-template-columns:' +
      'repeat(auto-fit,minmax(300px,1fr));gap:20px}figure{margin:0}img{display:block;max-width:100%;' +
      'max-height:400px;background:white}figcaption{padding:8px 0}</style>' +
      '<h1>STONKS · ' + report.length + ' local previews</h1><p>Synthetic sample prices. Four native device profiles, ' +
      'both orientations, four views, and ' + Object.keys(states).length + ' data/customization scenarios. Click a preview to open its markup.</p><main>' +
      figures.join('\n') + '</main></html>');
    if (problems.length) throw new Error(problems.length + ' preview failures:\n' + JSON.stringify(problems.slice(0, 8), null, 2));
    console.log('All ' + report.length + ' cases passed. Gallery: ' + path.join(outputDir, 'index.html'));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
