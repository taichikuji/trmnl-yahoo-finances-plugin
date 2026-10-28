# STONKS

Native Yahoo Finance charts for TRMNL. STONKS offers the controls from the [TradingView recipe](https://trmnl.com/recipes/tradingview-157210), rendered with TRMNL Framework and inline SVG. Each view owns its layout; `shared.liquid` defines the common components. The display keeps the price prominent, places source details above the chart, and shows the ticker as plain text. No iframe, remote widget, browser JavaScript, runtime packages, or market-data API key. The default remains **NTNX · USD · one year**.

## Customize

Open [STONKS settings](https://trmnl.com/plugin_settings/522884/edit), change the form, save, and refresh. Each installation has its own selection.

| Control | Options |
| --- | --- |
| Symbol | Yahoo ticker; common TradingView exchange symbols also accepted |
| Currency | Native, available fiat FX pairs, BTC or ETH |
| Chart Type | Line, OHLC bars, candles |
| Locale | English, German, French, Spanish, Italian, Polish |
| Date Range | 1D/1 minute, 1M/30 minutes, 3M/1 hour, 1Y/daily, 5Y/weekly, all time/monthly |
| Line Width | 1–5 px, also applied to OHLC strokes |
| Line Type | Simple, step, monotone smooth |
| Grid Lines | Show/hide |
| Volume | Show/hide a separate volume strip, when available |
| Header Font Size | Small, normal, large |
| Font Size | 8–16 px for labels and supporting text |
| Extended Hours | Regular session or available intraday pre/post-market bars |
| Return Baseline | Optional dashed line |
| Price Precision | Automatic, 0, 2, 4 or 6 decimals |

Symbol examples: `NTNX`, `VWCE.DE`, `VWRP.L`, `^GSPC`, `BTC-USD`, `EURUSD=X`. `NASDAQ%3ANTNX`, `XETR:VWCE`, `SP:SPX`, and common exchange-qualified crypto/FX symbols are translated. Unknown TradingView exchange prefixes require the exact Yahoo ticker; Yahoo and TradingView do not have identical coverage. A valid ticker can still lack a particular range, interval, volume, or FX pair.

Direction stays readable on every panel: **↑** for a gain, **↓** for a loss, and a horizontal mark for unchanged prices. Arrows follow the displayed return over the selected range; each candle follows its own open-to-close move. A red falling candle can therefore appear inside an overall profitable period. Changes that round to zero in both displayed units use the neutral indicator.

| Display | Gains | Losses |
| --- | --- | --- |
| OG and X grayscale | Black arrow; hollow rising candles | Black downward arrow; filled falling candles |
| OG B/W/R/Y | Yellow badge with black text; yellow candles with black outlines | Red arrow, return and candles |
| Full-color reference | Dark green | Dark red |

The main price stays black for contrast. When the baseline is enabled, the curve below it uses the loss ink and the curve above it uses the gain ink. On B/W/R/Y the upper curve stays black so it remains legible against white. Grayscale curves stay black throughout. Exact viewport clipping preserves simple, stepped and smooth curves with TRMNL's native `append_random` filter keeping SVG clip IDs unique in mashups. Doji candles remain neutral. Color is automatic and adds no configuration controls.

The review priority is **OG first, X landscape second, B/W/R/Y third, X portrait last**. Large X landscape screens give the quote more prominence. Source information stays above the chart, and the ticker stays plain. OHLC bars have a left opening tick and right closing tick. Missing OHLC data stays missing: close-only bars use small marks, or the whole chart falls back to a line when no OHLC exists. Smooth curves keep control points within each adjacent price range. The x-axis spaces available bars evenly to remove overnight/weekend gaps.

## Data and saved state

TRMNL Node 20 Serverless requests Yahoo's chart endpoint for the selected ticker/range/interval. Asset fetching, any FX fetching, and JSON bodies share a **3.8-second deadline**, within TRMNL's five-second runtime. Each response is capped at **2 MiB** while streaming, before JSON parsing. Requests are not retried. HTTP failures, invalid data, timeouts, and quote regressions use the prior matching snapshot, marked stale, with its original timestamp. A first failed fetch shows an unavailable screen and does not write empty state.

The price and return use unadjusted `quote.close` and the current regular-market quote. The latest quote updates its bar or is appended when necessary. Intraday extended-hours data can use the last supplied bar and that bar's timestamp instead of the older regular-session quote. Native-currency 1D returns use the previous close when available; other returns use the first available close. These are price returns, excluding dividend reinvestment. Yahoo controls split treatment and data availability, including the available start date for recently listed instruments.

Currency selection **converts** the prices. Fiat conversion requests Yahoo's native/target FX pair; BTC and ETH conversion use their USD prices, with a native/USD leg where needed. Historical closes use the most recent exchange-rate bar at or before each asset bar. The current quote uses the current FX quote. Rates with missing alignment or excessive age are rejected. Pence and South African cents are normalized to pounds/rand first. Converted OHLC values are estimates using one FX rate per asset bar, not true intrabar converted extrema; the screen marks them **FX estimate** and the source tooltip includes the FX timestamp. **Converted 1D returns start at the first aligned converted close**, with a translated “from first bar” label. Yahoo does not provide a reliable previous-close timestamp here, so its price is never multiplied by an exchange rate from a different point in time. Volume remains in instrument units. Unsupported pairs show an error rather than a relabelled native price.

State v2 stores validated OHLCV data and metadata under TRMNL's **8,192-byte** limit. Long series are grouped in chronological buckets: first open, maximum high, minimum low, last close, summed volume. The source label shows the requested interval and grouping factor, such as `1d ×3`; it does not claim each displayed candle is one day. Grouping can change chart detail. Exact latest price, return baseline, and source extrema are retained independently. No sample prices are saved to production.

The fallback key includes symbol, requested currency, range, and session choice. Changing any of these prevents a previous selection's chart from appearing as the new one. Presentation changes can redraw the same saved data during an outage. Snapshot symbol/currency, grouped bar count, and FX metadata are validated together. Older FX quotes cannot replace newer saved rates, and either an old asset quote or an old FX quote marks data stale. Earlier converted 1D snapshots using the unverified previous-close FX baseline are rejected; existing native-currency v2 snapshots remain usable. State from the previous fixed-symbol v1 renderer remains on TRMNL until the first successful v2 fetch; it is not treated as OHLCV and is not rendered by v2. Do not clear Saved State routinely.

Market timestamps use the instrument's exchange timezone, with full timezone/year information in the footer tooltip and a UTC `<time datetime>` value. Fetch time is recorded separately and never presented as quote time. Failures mark data stale immediately. A successful response with a quote older than seven days is also stale; this tolerates ordinary holidays/weekends but is not an exchange calendar. This is a periodically refreshed display, and provider quotes can be delayed.

## TRMNL access

Use the registered **`trmnl` MCP server** to manage the existing STONKS installation, ID `522884`. The native MCP connection has been verified after restarting the client. The ignored `.env` contains `TRMNL_MCP_API_KEY`; `.env.example` has only its name. Codex registration is kept in private user configuration. Changing `.env` alone does not rotate the already registered credential. Never commit or log credentials or authenticated MCP URLs.

The plugin uses Static strategy, `{}` static data, Node Serverless, a 60-minute refresh, Framework 3.4.3, and normal screen padding. `full.liquid`, `half_horizontal.liquid`, `half_vertical.liquid` and `quadrant.liquid` each own their layout and typography choices. Full keeps the existing prominent quote, half vertical stacks the quote and return, half horizontal limits the largest quote, and quadrant uses compact type. `shared.liquid` defines named templates for the heading, price, return, status, chart, unavailable state and footer, called with explicit parameters through native `{% render %}`. These components use native Layout, Flex, Title, Value, Label, Description and Title Bar components. Small scoped CSS supplies numeric font sizes, and inline styles place axis labels and the last-price dot. A container query hides the middle date label in narrow slots to prevent large-font date collisions; the framework handles the layout and typography.

Use MCP to transfer the seven source files and preview/refresh the plugin. Keep local commits for each iteration. No automatic Git push or deploy-on-push is configured. Checks and CI do not create ZIP files. The historical manual `npm run build` command is retained only for an explicitly requested import archive.

## Develop and verify

```sh
npm ci --ignore-scripts
npm run check
CHROME_PATH=/path/to/chrome npm run preview
```

Chrome is the default local browser. To use the same pinned browser as CI:

```sh
npx playwright-core install --with-deps chromium
TRMNL_BROWSER=chromium npm run preview
```

CI runs data checks and the full visual matrix under Node 20, with a 15-minute job limit. It uses synthetic data and needs no TRMNL credential. It does not deploy anything. The pinned browser path and Node 20 checks were also exercised locally; GitHub-hosted CI awaits a repository push.

Node 20+ is required. **50 checks** cover every range, symbol normalization, return calculations, OHLCV grouping, missing values, FX/crypto conversion, pence, stale data, state isolation and corruption, FX regressions and return baselines, streamed response limits, bounded requests, smooth paths, all six locales, direction cues, neutral candles, unique SVG clipping all view registrations, isolated Shared templates, and generation of only the selected chart geometry. Runtime code has no package dependencies.

Open `dist/preview/index.html` for **512 local sample previews**: four profiles × two orientations × four views × sixteen scenarios. The scenarios include fresh/stale/unavailable states, candles with grid/volume, OHLC bars, step lines, large fonts, a long ETF name, crypto precision, intraday candles, large-font stale data, converted 1D data, losses, baseline crossings and unchanged prices. Candles use mixed up/down/doji bars. Each has HTML/PNG output; `report.json` records slot bounds, text overflow, overlapping date/price labels, chart size, fonts, native structure, timestamp fit, endpoint alignment and resolved palette colors. The short `fresh`, `stale`, and `unavailable` filenames point to OG landscape full-screen cases.

Profiles include original 1-bit OG, current 2-bit OG, OG B/W/R/Y, and X. X renders at 1040×780 CSS pixels with a 1.8 scale, producing 1872×1404 output. All four layouts run in portrait and landscape. The pinned framework and actual fonts are cached under `.cache/framework/3.4.3`; previews fail on missing resources. JavaScript is disabled in the preview browser. The B/W/R/Y panel uses native yellow/red highlights while retaining arrows and candle outlines. Additional virtual full-color captures check dark green/red inks; they are not OG/X hardware modes. Physical-device and dithering verification remain separate from browser or server previews.

Synthetic fixtures are clearly labelled in local previews and never sent to TRMNL. The recorded Yahoo AAPL response fixture originally came from [yahoo-finance2](https://github.com/gadicc/yahoo-finance2/blob/main/tests/fixtures/http/chart-AAPL.json); it is not a real NTNX history. Developer dependencies LiquidJS and Playwright stay local.

For the official local tool, install [trmnlp](https://github.com/usetrmnl/trmnlp) separately and run `cd TRMNL && trmnlp serve`. Review transform settings before making live requests.

## Rendering and Serverless boundaries

Liquid owns UI translations, range/session/source captions, direction indicators, header sizing, and bounded font/stroke controls. It derives the direction from the signed, rounded return labels, so a change that rounds to zero remains neutral. Serverless no longer produces those presentation fields or unused high/low/combined labels. The transform generates either a line or OHLC paths, rather than both, and leaves the saved-state v2 format unchanged.

Serverless still fetches and validates Yahoo/FX data, computes aligned conversions, writes Saved State, and handles outage recovery. Liquid cannot write Saved State. Chart coordinates and monotone interpolation stay in JavaScript because moving that arithmetic into Liquid would make the code longer and harder to verify. `Intl` retains exact numeric rounding, precision and exchange-timezone date formatting across six locales. Removing Node would lose these behaviors or require another service; this change reduces work within each invocation, not the number of invocations.

The [TRMNL chart documentation](https://trmnl.com/framework/docs/3.4/chart) permits any chart library; Highcharts is an example, not a requirement. Its examples need browser JavaScript and remote assets. The current SVG preserves the existing chart controls and exact full-screen render without those dependencies. No Highcharts, Chartkick or `highcharts-more` dependency was added.

The local LiquidJS harness implements native Shared template registration and isolated `render` scopes; those helpers are development-only. Previews use the exact seven files imported into TRMNL.

## Hosted verification

The view/Shared refactor passes **50 Node 20 checks**, **512 local previews**, and **12 hosted previews**: full, half horizontal, half vertical and quadrant on OG Plus, X and B/W/R/Y. The saved OG full, X landscape and B/W/R/Y candle PNGs are byte-for-byte identical to the pre-refactor renders; full-screen chart dimensions remain unchanged throughout the matrix. An offline check with the actual hosted v2 snapshot preserved state, selected chart geometry, formatted money and exchange timestamps exactly. For that snapshot, the `stonks` merge object decreased from 10,214 to 4,892 bytes by omitting unused geometry and presentation fields.

Final source was transferred through MCP and all six markup/Serverless files matched on readback. The plugin was healthy with fresh data, and the active NTNX/USD three-month line chart, visible grid, and complete custom field map were preserved. Saved State was retained. No Git push or deploy-on-push was configured.

The existing STONKS installation is updated through MCP without an archive or Saved State reset. Keep the user's current market and display selections. Read back all six markup/Serverless files after importing the seven source files; normalized hosted YAML can differ from the local settings file. Refresh and inspect new merge variables before starting previews so they use the current schema.

MCP form updates require string values, including numeric controls. Source updates use `importPluginSettingFiles`. The separate `writeMarkup` linter currently rejects a valid empty-array return in the FX planning helper; file import successfully executes the same Serverless code. Temporary display changes must restore the full original field map afterward. Never upload synthetic sample variables.

The MCP preview endpoint accepts `og_plus`, `v2` and `og_bwry` but rejects the catalog's legacy `og_png`; original 1-bit OG is covered locally. B/W/R/Y preview responses are grayscale PNG thumbnails, including with an explicit palette ID. They verify layout rather than physical ink. Colors are checked against the pinned framework's palette rules locally; physical ink and dithering still require a device check.

## Provider limitations

Yahoo's chart endpoint is undocumented and can fail or change. During initial local development it returned HTTP 429; the user subsequently supplied a successful original STONKS render from TRMNL. No cookie/crumb, scraping, proxy rotation, or access workaround is included. Yahoo and TradingView can differ in instrument coverage, historical availability, FX pairs, pricing and exchange delays.

Existing provider terms guidance remains applicable: [Yahoo Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html). This repository does not establish licensing clearance. Replace the isolated Yahoo adapter with a licensed provider when required for the intended use.

## References

- [TradingView recipe and its controls](https://trmnl.com/recipes/tradingview-157210)
- [TRMNL Serverless](https://help.trmnl.com/en/articles/14130649-serverless), [Saved State](https://help.trmnl.com/en/articles/16777795-saved-state), [custom form fields](https://help.trmnl.com/en/articles/10513740-custom-plugin-form-builder)
- [Shared markup](https://help.trmnl.com/en/articles/13216853-reusing-markup-with-shared), [inline SVG](https://help.trmnl.com/en/articles/12391781-creating-inline-images-for-plugins)
- [Devices](https://trmnl.com/framework/docs/3.4/devices/), [views](https://trmnl.com/framework/docs/3.4/view), [mashups](https://trmnl.com/framework/docs/3.4/mashup), [responsive utilities](https://trmnl.com/framework/docs/3.4/responsive)
