# STONKS

A private TRMNL plugin for **Nutanix (NASDAQ:NTNX)**: latest regular-market price in USD, a one-year price return, and a native monochrome SVG chart. Inspired by the supplied TradingView screen, without its widget or branding.

No hosted backend, accounts, API keys, runtime dependencies, client-side JavaScript, or external chart assets. Source follows the `TRMNL/src/` convention used by [taichikuji's other plugins](https://github.com/taichikuji/trmnl-tamagotchi-plugin).

The display lives in `TRMNL/src/shared.liquid` and uses TRMNL Framework 3.4.3's Layout, Flex, Title, Value, Label, Description, spacing utilities, and standard Title Bar. The same markup wraps naturally in full, half horizontal, half vertical, and quadrant views. The four view files contain only registration comments; TRMNL may skip a completely blank view even when Shared contains markup.

The line is a scalable inline SVG. Its price and date labels use ordinary framework text outside the SVG so their fonts stay readable in small slots. The only inline CSS positions price labels at their calculated chart coordinates; there is no custom layout or typography stylesheet.

## Install

1. Build `dist/STONKS.zip` with `npm run build` (Python 3 only; no npm install needed for packaging).
2. In TRMNL, open **Plugins → Private Plugins → Import new** and upload **STONKS.zip**. Do not upload a ZIP of this repository.
3. Confirm **Static** strategy, Static Data **`{}`**, **Node** Serverless, and a **60-minute** refresh interval. The import includes these settings, the markup, and `transform.js`.
4. Choose full screen or any of the three mashup sizes, add it to your playlist, and **Force Refresh**. Enable Debug Logs when checking your first live run.

A Developer add-on or BYOD license and current TRMNL Serverless/Saved State support are required. Local previews cover **TRMNL OG** (original 1-bit and current 2-bit profiles), **TRMNL OG (B/W/R/Y)**, and **TRMNL X**, with all four views in landscape and portrait. Device dimensions, density, fonts, and palette classes come from the pinned framework's official profiles. X uses a 1040 × 780 CSS canvas at a 1.8 ratio, producing a 1872 × 1404 image; OG uses 800 × 480. The plugin keeps its monochrome chart on the color panel. It is a private import, not a published recipe.

To update an existing installation while retaining its saved fallback, replace Shared, all four view tabs, and Serverless in the existing markup editor and apply the settings from `settings.yml` (including normal screen padding). Do not clear Saved State. Import new creates a separate installation with empty state.

If the first fetch fails, `DATA UNAVAILABLE` is expected. Once a fetch succeeds, later failures keep the saved chart with a black **STALE DATA** badge and its original market timestamp. Force Refresh preserves Saved State; **Clear Saved State** removes your fallback.

## Data and reliability

- One request per refresh to `https://query1.finance.yahoo.com/v8/finance/chart/NTNX?range=1y&interval=1d`. The 2.8-second deadline covers the request and JSON body; there are no immediate retries or access workarounds.
- The chart and return use Yahoo's `quote.close` history plus `regularMarketPrice`. The latest quote replaces its session's daily bar, or is appended if that bar is absent. `adjclose` is never mixed in. This is a **price return**, excluding dividend reinvestment. Yahoo determines historical split treatment.
- Return = latest price minus the first valid daily price in the requested year; percentage = that difference divided by the first valid price. Missing opening bars move the baseline to the first remaining bar. Responses need at least 120 valid bars spanning 350–370 days, so an empty or substantially truncated history cannot replace the chart.
- Null/invalid closing prices are skipped, never converted to zero. Wrong instruments/currencies, invalid timestamps, HTTP errors, timeouts, invalid JSON, and older-than-saved quotes preserve the previous valid state exactly. A failed first run writes no state.
- `market_at` is Yahoo's `regularMarketTime`, displayed in **New York exchange time**. The footer uses a compact date including the year and `ET`, for example `28 Oct 26 15:15 ET`; its accessible label/tooltip includes the full timestamp and EST/EDT, and its `<time>` element includes the UTC ISO timestamp. `fetched_at` records when a response was validated; it is stored separately and never shown as a quote timestamp. Regular-market data may be delayed; this is not a live trading display.
- Every failed fetch marks the fallback stale immediately. A successful response is also stale if its market timestamp is over **seven calendar days** old. This conservative rule tolerates ordinary weekends and multi-day exchange holidays without a holiday calendar. It can take up to seven days to flag a provider that keeps returning unchanged data successfully.
- Saved State stores only a version, SVG path, scale/date labels, and price/timestamp metadata. Writes are checked against TRMNL's **8,192-byte** limit. Each install starts empty; sample data is never bundled into the import.

## Develop and verify

Node 20+ and Python 3:

```sh
npm ci --ignore-scripts
npm run check
```

The tests cover valid responses, missing prices, malformed/empty payloads, errors and timeouts (including stalled bodies), first-run failure, exact fallback preservation, stale timestamps, weekends/holidays, flat chart coordinates, state size, consistent return calculations, and Shared rendering exactly once in every registered view. Packaging verifies all seven root-level files, source bytes, file size limits, and ZIP CRCs. GitHub Actions runs the checks and retains the import ZIP as an artifact when this repository is hosted there.

To create **local sample previews**, install Chrome, then:

```sh
npm run preview
# Or select an existing executable:
CHROME_PATH=/path/to/chrome npm run preview
```

Open `dist/preview/index.html` for the **96-case gallery**: four device profiles × two orientations × four views × three states (fresh, stale, unavailable). Each case has HTML and a PNG; mashup PNGs show the individual slot, and full-view PNGs show the device canvas. `report.json` records measurements and errors. The short `{fresh,stale,unavailable}.{html,png}` names still point to the original OG full-screen cases.

LiquidJS processes Shared before each view, and Playwright captures the native device and mashup wrappers with JavaScript disabled. Checks include slot bounds, text overflow, minimum chart size, native Layout/Title Bar structure, actual font loading, and timestamp truncation. The first run downloads the pinned official stylesheet and required fonts into `.cache/framework/3.4.3/`; subsequent runs reuse the cache. The browser receives only these cached framework assets, and the preview fails if any required resource cannot load. Optionally set `TRMNL_CSS_PATH` to an existing local copy of the pinned stylesheet. Saved HTML references the official stylesheet for viewing online.

These are browser previews with synthetic prices labelled **SAMPLE DATA**. They do not reproduce TRMNL's hosted renderer, firmware, or device dithering. LiquidJS and Playwright are development-only dependencies and never ship inside the plugin ZIP. Physical-device verification is still needed, especially for the color panel.

For the official local tool, install [trmnlp](https://github.com/usetrmnl/trmnlp) separately and run `cd TRMNL && trmnlp serve`. Review its transform execution settings before using live network calls.

## Verification status and provider limits

During local development on 28 October 2026, a direct request to the specified NTNX endpoint returned **HTTP 429**, with a plain-text `Edge: Too Many Requests` body. No alternate endpoints, cookie/crumb workarounds, browser scraping, or proxy rotation were attempted.

Later that day, the user imported `STONKS.zip` into TRMNL and supplied a successful rendered screenshot: **72.38 USD**, **+3.31 (+4.79%)** over the requested year, with the market timestamp **Oct 28, 2026, 15:15 EDT**. This is user-provided evidence of a successful import, live data fetch, and TRMNL render. Quote accuracy was not independently checked; physical-device appearance and Saved State fallback during a real provider outage remain unverified. The automated tests exercise fallback locally.

The later Shared-based version is verified locally across the 96 device/view/state cases described above. The earlier user screenshot covers the original full-screen version; it does not verify the new mashup layouts on physical devices.

Before implementing the parser, the successful response structure was inspected in [yahoo-finance2's recorded AAPL chart response](https://github.com/gadicc/yahoo-finance2/blob/main/tests/fixtures/http/chart-AAPL.json). Its response body is retained in `TRMNL/fixtures/yahoo-chart-recorded.json`; request headers/cookies are omitted. The separate synthetic NTNX fixture uses that structure to exercise a complete year. Neither fixture is a real NTNX quote history.

Yahoo provides no supported public market-data API for this integration, and access can fail or change without notice. **Private or experimental use does not itself grant data rights.** [Yahoo's Terms of Service, section 1, Member Conduct](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) restrict automated access/collection without express prior permission and also restrict reuse. Obtain the required permission for the intended use, or replace the adapter with a licensed provider. There is no licensing clearance in this repository. Public distribution or commercial use requires a separate review of data access and display rights.

## References

- [TRMNL Serverless](https://help.trmnl.com/en/articles/14130649-serverless)
- [TRMNL Saved State](https://help.trmnl.com/en/articles/16777795-saved-state)
- [Private-plugin ZIP format and import](https://help.trmnl.com/en/articles/10542599-importing-and-exporting-private-plugins)
- [Inline images/SVG](https://help.trmnl.com/en/articles/12391781-creating-inline-images-for-plugins)
- [Reusing Markup with Shared](https://help.trmnl.com/en/articles/13216853-reusing-markup-with-shared)
- [Device profiles](https://trmnl.com/framework/docs/3.4/devices/), [views](https://trmnl.com/framework/docs/3.4/view), and [mashups](https://trmnl.com/framework/docs/3.4/mashup)
- [Responsive utilities](https://trmnl.com/framework/docs/3.4/responsive), [font families](https://trmnl.com/framework/docs/3.4/font_family), and [color palettes](https://trmnl.com/framework/docs/3.4/color_palettes)

The provided `private_plugin_522716.zip` was inspected: a flat six-file export, Static strategy, Framework 2.3.7, and TradingView's external embedding script inside an iframe in `shared.liquid`. No source or branding from that widget is shipped in STONKS.
