// Local-only screenshot tool; no browser is used by the imported plugin.
const fs = require('node:fs');
const path = require('node:path');
const { Liquid } = require('liquidjs');
const { chromium } = require('playwright-core');
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
  const framework = process.env.TRMNL_CSS_PATH ? fs.readFileSync(process.env.TRMNL_CSS_PATH, 'utf8') : '';
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
    let requests = 0;
    await page.route('**/*', route => { requests++; return route.abort(); });
    for (const [name, model] of Object.entries({ fresh, stale, unavailable })) {
      const markup = await liquid.parseAndRender(source, model);
      const html = '<!doctype html><html lang="en"><meta charset="utf-8">' +
        '<title>STONKS local sample preview</title>' +
        `<style>${framework}</style>` +
        '<style>html,body{margin:0;width:800px;height:480px;overflow:hidden}.screen,.view{width:800px;height:480px}</style>' +
        '<body class="trmnl"><div class="screen screen--og screen--no-bleed"><div class="view view--full">' +
        markup + '</div></div></body></html>';
      fs.writeFileSync(path.join(outputDir, `${name}.html`), html);
      await page.setContent(html);
      const measurements = await page.evaluate(() => {
        const main = document.querySelector('.stonks');
        const chart = document.querySelector('.stonks-line');
        const footer = document.querySelector('.stonks-footer').getBoundingClientRect();
        const bad = [...main.querySelectorAll('*')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width && r.height && (r.left < -1 || r.top < -1 || r.right > 801 || r.bottom > 481);
        }).map(el => el.tagName + '.' + el.className);
        return { width: main.clientWidth, height: main.clientHeight, footerBottom: footer.bottom,
          pathLength: chart?.getTotalLength() ?? null, overflow: bad,
          text: main.textContent.replace(/\s+/g, ' ').trim() };
      });
      if (measurements.width !== 800 || measurements.height !== 480 || measurements.overflow.length ||
          (name !== 'unavailable' && !(measurements.pathLength > 600))) {
        throw new Error(`${name} layout failed: ${JSON.stringify(measurements)}`);
      }
      await page.screenshot({ path: path.join(outputDir, `${name}.png`) });
      console.log(`${name}: 800x480; overflow=${measurements.overflow.length}; SVG length=${measurements.pathLength ?? 'unavailable screen'}`);
    }
    if (requests !== 0) throw new Error(`Preview made ${requests} unexpected network requests`);
    console.log(`No external resources requested. Local sample previews: ${outputDir}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
