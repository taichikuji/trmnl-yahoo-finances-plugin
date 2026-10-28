// Local-only screenshot tool; no browser is used by the imported plugin.
const fs = require('node:fs');
const path = require('node:path');
const { Liquid } = require('liquidjs');
const { chromium } = require('playwright-core');
const YAML = require('yaml');
const { loadPlugin } = require('./load-plugin.cjs');
const { sample, NOW } = require('../TRMNL/fixtures/sample.cjs');

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
  fresh.stonks.detail = 'SAMPLE DATA \u00b7 synthetic prices, not a live quote';
  stale.stonks.detail = 'SAMPLE DATA \u00b7 Provider HTTP 429';
  const source = fs.readFileSync(path.join(root, 'TRMNL/src/full.liquid'), 'utf8');
  const settings = YAML.parse(fs.readFileSync(path.join(root, 'TRMNL/src/settings.yml'), 'utf8'));
  const frameworkURL = `https://trmnl.com/css/${settings.framework_version}/plugins.css`;
  const cache = path.join(root, '.cache/framework', settings.framework_version);
  async function asset(url) {
    const parsed = new URL(url);
    const name = url === frameworkURL ? 'css/plugins.css' :
      parsed.origin === 'https://trmnl.com' && /^\/fonts\/[\w.-]+$/.test(parsed.pathname) && !parsed.search ?
        parsed.pathname.slice(1) : null;
    if (!name) throw new Error(`Unexpected preview resource: ${url}`);
    if (url === frameworkURL && process.env.TRMNL_CSS_PATH) return fs.readFileSync(process.env.TRMNL_CSS_PATH);
    const file = path.join(cache, name);
    if (!fs.existsSync(file)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Framework asset HTTP ${response.status}: ${url}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    return fs.readFileSync(file);
  }
  await asset(frameworkURL); // Never silently preview the plugin without its framework.
  const liquid = new Liquid();
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 800, height: 480 }, deviceScaleFactor: 1, javaScriptEnabled: false
    });
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
    for (const [name, model] of Object.entries({ fresh, stale, unavailable })) {
      const markup = await liquid.parseAndRender(source, model);
      const html = '<!doctype html><html lang="en"><meta charset="utf-8">' +
        '<title>STONKS local sample preview</title>' +
        `<link rel="stylesheet" href="${frameworkURL}">` +
        '<style>html,body{margin:0;width:800px;height:480px;overflow:hidden}</style>' +
        '<body class="trmnl"><div class="screen screen--og screen--sm screen--1bit screen--no-bleed"><div class="view view--full">' +
        markup + '</div></div></body></html>';
      fs.writeFileSync(path.join(outputDir, `${name}.html`), html);
      await page.setContent(html);
      const measurements = await page.evaluate(async () => {
        await document.fonts.ready;
        const main = document.querySelector('.view');
        const layout = main.querySelector('.layout');
        const chart = document.querySelector('[data-stonks-line]');
        const footer = document.querySelector('.title_bar').getBoundingClientRect();
        const bad = [...main.querySelectorAll('*')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width && r.height && (r.left < -1 || r.top < -1 || r.right > 801 || r.bottom > 481);
        }).map(el => el.tagName + '.' + el.className);
        const fonts = [...new Set([...document.fonts].filter(font => font.status === 'loaded').map(font => font.family))];
        return { width: main.clientWidth, height: main.clientHeight, footerBottom: footer.bottom,
          nativeStructure: layout.nextElementSibling?.classList.contains('title_bar'), fonts,
          pathLength: chart?.getTotalLength() ?? null, overflow: bad,
          text: main.textContent.replace(/\s+/g, ' ').trim() };
      });
      if (failedResources.length) throw new Error(failedResources.join('\n'));
      if (measurements.width !== 800 || measurements.height !== 480 || measurements.overflow.length ||
          !measurements.nativeStructure || !measurements.fonts.length ||
          (name !== 'unavailable' && !(measurements.pathLength > 600))) {
        throw new Error(`${name} layout failed: ${JSON.stringify(measurements)}`);
      }
      await page.screenshot({ path: path.join(outputDir, `${name}.png`) });
      console.log(`${name}: 800x480; overflow=${measurements.overflow.length}; SVG length=${measurements.pathLength ?? 'unavailable screen'}; fonts=${measurements.fonts.join(', ')}`);
    }
    console.log(`Official framework and fonts served from local cache. No unexpected resources. Previews: ${outputDir}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
