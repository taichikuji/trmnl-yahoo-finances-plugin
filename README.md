# STONKS

A private TRMNL plugin for **Nutanix (NASDAQ:NTNX)**: latest regular-market price in USD, a one-year price return, and a native monochrome SVG chart. Inspired by the supplied TradingView screen, without its widget or branding.

No hosted backend, accounts, API keys, runtime dependencies, client-side JavaScript, or external chart assets. Source follows the `TRMNL/src/` convention used by [taichikuji's other plugins](https://github.com/taichikuji/trmnl-tamagotchi-plugin).

## Install

1. Build `dist/STONKS.zip` with `npm run build` (Python 3 only; no npm install needed for packaging).
2. In TRMNL, open **Plugins → Private Plugins → Import new** and upload **STONKS.zip**. Do not upload a ZIP of this repository.
3. Confirm **Static** strategy, Static Data **`{}`**, **Node** Serverless, and a **60-minute** refresh interval. The import includes these settings, the markup, and `transform.js`.
4. Use the **full-screen** layout, add it to your playlist, and **Force Refresh**. Enable Debug Logs when checking your first live run.

A Developer add-on or BYOD license and current TRMNL Serverless/Saved State support are required. This release targets the **800 × 480 full-screen** display; no mashup layouts are included. It is a private import, not a published recipe.

If the first fetch fails, `DATA UNAVAILABLE` is expected. Once a fetch succeeds, later failures keep the saved chart with a black **STALE DATA** badge and its original market timestamp. Force Refresh preserves Saved State; **Clear Saved State** removes your fallback.

## Data and reliability

- One request per refresh to `https://query1.finance.yahoo.com/v8/finance/chart/NTNX?range=1y&interval=1d`. The 2.8-second deadline covers the request and JSON body; there are no immediate retries or access workarounds.
- The chart and return use Yahoo's `quote.close` history plus `regularMarketPrice`. The latest quote replaces its session's daily bar, or is appended if that bar is absent. `adjclose` is never mixed in. This is a **price return**, excluding dividend reinvestment. Yahoo determines historical split treatment.
- Return = latest price minus the first valid daily price in the requested year; percentage = that difference divided by the first valid price. Missing opening bars move the baseline to the first remaining bar. Responses need at least 120 valid bars spanning 350–370 days, so an empty or substantially truncated history cannot replace the chart.
- Null/invalid closing prices are skipped, never converted to zero. Wrong instruments/currencies, invalid timestamps, HTTP errors, timeouts, invalid JSON, and older-than-saved quotes preserve the previous valid state exactly. A failed first run writes no state.
- `market_at` is Yahoo's `regularMarketTime`, displayed in **New York exchange time (EST/EDT)**. `fetched_at` records when a response was validated; it is stored separately and never shown as a quote timestamp. Regular-market data may be delayed; this is not a live trading display.
- Every failed fetch marks the fallback stale immediately. A successful response is also stale if its market timestamp is over **seven calendar days** old. This conservative rule tolerates ordinary weekends and multi-day exchange holidays without a holiday calendar. It can take up to seven days to flag a provider that keeps returning unchanged data successfully.
- Saved State stores only a version, SVG path, scale/date labels, and price/timestamp metadata. Writes are checked against TRMNL's **8,192-byte** limit. Each install starts empty; sample data is never bundled into the import.

## Develop and verify

Node 20+ and Python 3:

```sh
npm ci --ignore-scripts
npm run check
```

The tests cover valid responses, missing prices, malformed/empty payloads, errors and timeouts (including stalled bodies), first-run failure, exact fallback preservation, stale timestamps, weekends/holidays, flat chart coordinates, state size, and consistent return calculations. Packaging verifies the flat file list, source bytes, file size limits, and ZIP CRCs. GitHub Actions runs the checks and retains the import ZIP as an artifact when this repository is hosted there.

To create **local sample previews**, install Chrome, then:

```sh
npm run preview
# Or select an existing executable:
CHROME_PATH=/path/to/chrome npm run preview
```

Outputs are `dist/preview/{fresh,stale,unavailable}.{html,png}`. LiquidJS renders the actual template and Playwright captures it at 800 × 480 with JavaScript disabled and external requests blocked. Both are development-only dependencies; neither ships inside the plugin. The prices are synthetic and labelled **SAMPLE DATA**. These previews use browser/system fonts, not TRMNL's hosted renderer or device dithering. For an additional framework compatibility check, set `TRMNL_CSS_PATH` to a local copy of the pinned [3.4.3 stylesheet](https://trmnl.com/css/3.4.3/plugins.css); the preview uses TRMNL's `screen--no-bleed` wrapper to match the import's no-padding setting. That local stylesheet check was also performed successfully.

For the official local tool, install [trmnlp](https://github.com/usetrmnl/trmnlp) separately and run `cd TRMNL && trmnlp serve`. Review its transform execution settings before using live network calls.

## Verification status and provider limits

On 28 October 2026, a direct request to the specified NTNX endpoint returned **HTTP 429**, with a plain-text `Edge: Too Many Requests` body. No alternate endpoints, cookie/crumb workarounds, browser scraping, or proxy rotation were attempted. A successful live NTNX response and a live TRMNL import/device render are **not verified**.

Before implementing the parser, the successful response structure was inspected in [yahoo-finance2's recorded AAPL chart response](https://github.com/gadicc/yahoo-finance2/blob/main/tests/fixtures/http/chart-AAPL.json). Its response body is retained in `TRMNL/fixtures/yahoo-chart-recorded.json`; request headers/cookies are omitted. The separate synthetic NTNX fixture uses that structure to exercise a complete year. Neither fixture is a real NTNX quote history.

Yahoo provides no supported public market-data API for this integration, and access can fail or change without notice. **Private or experimental use does not itself grant data rights.** [Yahoo's Terms of Service, section 1, Member Conduct](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) restrict automated access/collection without express prior permission and also restrict reuse. Obtain the required permission for the intended use, or replace the adapter with a licensed provider. There is no licensing clearance in this repository. Public distribution or commercial use requires a separate review of data access and display rights.

## References

- [TRMNL Serverless](https://help.trmnl.com/en/articles/14130649-serverless)
- [TRMNL Saved State](https://help.trmnl.com/en/articles/16777795-saved-state)
- [Private-plugin ZIP format and import](https://help.trmnl.com/en/articles/10542599-importing-and-exporting-private-plugins)
- [Inline images/SVG](https://help.trmnl.com/en/articles/12391781-creating-inline-images-for-plugins)

The provided `private_plugin_522716.zip` was inspected: a flat six-file export, Static strategy, Framework 2.3.7, and TradingView's external embedding script inside an iframe in `shared.liquid`. No source or branding from that widget is shipped in STONKS.
