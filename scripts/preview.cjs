// Local-only preview matrix. The imported plugin uses no browser or chart library.
const fs = require('node:fs');
const path = require('node:path');
const { Liquid } = require('liquidjs');
const { chromium } = require('playwright-core');
const YAML = require('yaml');
const { loadPlugin } = require('./load-plugin.cjs');
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

async function main() {
  const root = path.join(__dirname, '..');
  const outputDir = path.join(root, 'dist/preview');
  fs.mkdirSync(outputDir, { recursive: true });
  class Clock extends Date { static now() { return NOW; } }
  const plugin = fetch => loadPlugin({ fetch, Date: Clock });
  const fresh = await plugin(async () => ({ ok: true, json: async () => sample() })).run({});
  const offline = plugin(async () => ({ ok: false, status: 429 }));
  const stale = await offline.run({ trmnl: { state: fresh.trmnl_state } });
  const unavailable = await offline.run({});
  fresh.stonks.detail = 'SAMPLE DATA';
  stale.stonks.detail = 'SAMPLE · HTTP 429';
  const states = { fresh, stale, unavailable };
  const shared = fs.readFileSync(path.join(root, 'TRMNL/src/shared.liquid'), 'utf8');
  const settings = YAML.parse(fs.readFileSync(path.join(root, 'TRMNL/src/settings.yml'), 'utf8'));
  const frameworkURL = 'https://trmnl.com/css/' + settings.framework_version + '/plugins.css';
  const cache = path.join(root, '.cache/framework', settings.framework_version);
  async function asset(url) {
    const parsed = new URL(url);
    const name = url === frameworkURL ? 'css/plugins.css' :
      parsed.origin === 'https://trmnl.com' && /^\/fonts\/[\w.-]+$/.test(parsed.pathname) && !parsed.search ?
        parsed.pathname.slice(1) : null;
    if (!name) throw new Error('Unexpected preview resource: ' + url);
    if (url === frameworkURL && process.env.TRMNL_CSS_PATH) return fs.readFileSync(process.env.TRMNL_CSS_PATH);
    const file = path.join(cache, name);
    if (!fs.existsSync(file)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Framework asset HTTP ' + response.status + ': ' + url);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    return fs.readFileSync(file);
  }
  await asset(frameworkURL);
  const liquid = new Liquid();
  const head = '<!doctype html><html lang="en"><meta charset="utf-8">' +
    '<title>STONKS · sample preview</title><link rel="stylesheet" href="' + frameworkURL + '">' +
    '<style>html,body{margin:0;width:100vw;height:100vh;overflow:hidden}</style><body class="trmnl">';
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true, args: ['--no-sandbox']
  });
  const report = [];
  const problems = [];
  const figures = [];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, javaScriptEnabled: false });
    const failedResources = [];
    await page.route('**/*', async route => {
      const url = route.request().url();
      try {
        await route.fulfill({ body: await asset(url),
          contentType: url === frameworkURL ? 'text/css' :
            url.endsWith('.woff2') ? 'font/woff2' : url.endsWith('.woff') ? 'font/woff' : 'font/ttf' });
      } catch (error) {
        failedResources.push(error.message);
        await route.abort();
      }
    });
    // Keep the stylesheet loaded while testing each actual native wrapper.
    await page.setContent(head + '</body></html>');
    for (const [device, profile] of Object.entries(devices)) {
      for (const orientation of ['landscape', 'portrait']) {
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
            const markup = await liquid.parseAndRender(shared + '\n' + viewSource, model);
            const view = '<div class="view view--' + layout + '">' + markup + '</div>';
            const surface = '<div class="' + classes + '">' +
              (mashup ? '<div class="mashup mashup--' + mashup + '">' + view + '</div>' : view) + '</div>';
            fs.writeFileSync(path.join(outputDir, id + '.html'), head + surface + '</body></html>');
            await page.evaluate(surface => { document.body.innerHTML = surface; }, surface);
            const measurements = await page.evaluate(async () => {
              document.body.getBoundingClientRect(); // Resolve styles before waiting for fonts.
              await document.fonts.ready;
              const main = document.querySelector('.view');
              const layout = main.querySelector('.layout');
              const chart = main.querySelector('[data-stonks-line]');
              const svg = chart?.closest('svg').getBoundingClientRect();
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
                const range = document.createRange();
                range.selectNodeContents(node);
                if ([...range.getClientRects()].some(outside)) textOverflow.push(node.textContent.trim());
              }
              const time = main.querySelector('time');
              const timeRange = document.createRange();
              if (time) timeRange.selectNodeContents(time);
              const timeFits = !time || timeRange.getBoundingClientRect().width <=
                time.closest('.instance').getBoundingClientRect().width + 1;
              const fonts = [...new Set([...document.fonts].filter(f => f.status === 'loaded').map(f => f.family))];
              return { width: bounds.width, height: bounds.height,
                svgWidth: svg?.width, svgHeight: svg?.height,
                nativeStructure: layout.nextElementSibling?.classList.contains('title_bar'),
                timeFits, overflow, textOverflow, fonts,
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
            if (measurements.overflow.length || measurements.textOverflow.length) errors.push('slot overflow');
            if (!measurements.timeFits) errors.push('market timestamp truncated');
            if (state !== 'unavailable' && (!(measurements.pathLength > 600) ||
                measurements.svgWidth < 80 * profile.scale || measurements.svgHeight < 40 * profile.scale)) {
              errors.push('chart too small');
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
            figures.push('<figure><a href="' + id + '.html"><img loading="lazy" src="' + id +
              '.png" alt="' + id + '"></a><figcaption>' + profile.name + ' · ' + orientation +
              ' · ' + layout + ' · ' + state + '</figcaption></figure>');
          }
        }
        console.log(device + '/' + orientation + ': 4 views × 3 states checked on ' + width + '×' + height);
      }
    }
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(outputDir, 'index.html'),
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>STONKS preview matrix</title>' +
      '<style>body{font:14px system-ui;margin:24px;background:#eee}main{display:grid;grid-template-columns:' +
      'repeat(auto-fit,minmax(300px,1fr));gap:20px}figure{margin:0}img{display:block;max-width:100%;' +
      'max-height:400px;background:white}figcaption{padding:8px 0}</style>' +
      '<h1>STONKS · 96 local previews</h1><p>Synthetic sample prices. Four native device profiles, ' +
      'both orientations, four views, and three data states. Click a preview to open its markup.</p><main>' +
      figures.join('\n') + '</main></html>');
    if (problems.length) throw new Error(problems.length + ' preview failures:\n' + JSON.stringify(problems.slice(0, 8), null, 2));
    console.log('All ' + report.length + ' cases passed. Gallery: ' + path.join(outputDir, 'index.html'));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
