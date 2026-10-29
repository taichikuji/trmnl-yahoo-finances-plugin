# STONKS

Yahoo Finance prices and charts for TRMNL, rendered with Framework 3.4.3 and inline SVG.

## Icon

<div align="center">
  <img src="media/icon.svg" alt="STONKS icon" width="90">
</div>

The original [icon.svg](media/icon.svg) shows a rising stock line on a transparent background, using the same orange (`#E76F55`) as HTTP Pets, TMB and TRMNLGotchi. It is included under the project's [MIT license](../LICENSE).

## Previews

Synthetic sample prices rendered from the actual templates with Framework 3.4.3.

| Full View | Half Horizontal View |
| --- | --- |
| ![Sample chart in the full view](media/preview_full.webp) | ![Sample chart in the half horizontal view](media/preview_half_horizontal.webp) |

| Half Vertical View | Quadrant View |
| --- | --- |
| ![Sample chart in the half vertical view](media/preview_half_vertical.webp) | ![Sample chart in the quadrant view](media/preview_quadrant.webp) |

| TRMNL X Landscape | TRMNL X Portrait |
| --- | --- |
| ![Sample chart on TRMNL X landscape](media/preview_trmnl_x.webp) | ![Sample chart on TRMNL X portrait](media/preview_trmnl_x_portrait.webp) |

![Sample candles with yellow and red highlights on B/W/R/Y](media/preview_bwry.webp)

## Setup

Create a Private Plugin with **Static** data `{}`, **Node** Serverless and Framework **3.4.3**. Keep normal screen padding.

Copy the form and plugin settings from [settings.yml](src/settings.yml). Paste [shared.liquid](src/shared.liquid) into Shared, each layout into its matching markup tab, and the complete [transform.js](src/transform.js) into Serverless. Save, refresh and add the plugin to your playlist.

Upload [media/icon.svg](media/icon.svg) in the plugin's icon field. MCP source imports do not upload icon assets.

The existing private installation is managed through TRMNL MCP. Repository pushes run checks; hosted updates still use MCP. Keep MCP credentials in the client's private configuration.

## Settings

| Control | Options |
| --- | --- |
| Symbol | Yahoo ticker or a supported TradingView exchange symbol |
| Currency | `NATIVE`, available fiat pairs, BTC or ETH |
| Date range | 1D/minute, 1M/30 minutes, 3M/hour, 1Y/day, 5Y/week, all time/month |
| Chart type | Line, OHLC bars or candles |
| Line style and width | Straight, stepped or smooth; 1–5 px strokes |
| Grid, volume, baseline | Show/hide; volume requires provider data |
| Extended hours | Available intraday pre/post-market bars |
| Language | English, German, French, Spanish, Italian or Polish |
| Heading and label size | Small/normal/large heading; 8–16 px supporting text, default 12 px |
| Decimal places | Automatic, 0, 2, 4 or 6 decimals |

Examples: `NTNX`, `VWCE.DE`, `VWRP.L`, `^GSPC`, `BTC-USD`, `EURUSD=X`, `NASDAQ:NTNX`, `XETR:VWCE`. Unknown exchange prefixes require the exact Yahoo ticker. Some instruments lack particular ranges, FX pairs, OHLC or volume.

## Templates

- **shared.liquid:** shared UI preparation, palette styles and reusable heading, quote, status, chart and footer components.
- **full.liquid:** prominent price and a full-size chart.
- **half_horizontal.liquid:** short layout with a cap on the largest quote size.
- **half_vertical.liquid:** stacked quote and return above the chart.
- **quadrant.liquid:** compact typography for the smallest slot.
- **transform.js:** Yahoo/FX requests, validation, conversion, saved-state recovery, chart coordinates and exact numeric/date formatting. No runtime packages or browser scripts.

OG and X use black arrows and hollow rising/filled falling candles. B/W/R/Y adds yellow gains and red losses; full-color palettes use green/red. The main price stays black. The return indicator follows the selected baseline, while each candle follows its own open-to-close move.

On OG full screen, the normal company name uses the native 21 px title and the price remains 38 px. Labels and supporting text default to 12 px, matching TRMNL's small pixel font. Smaller slots retain compact headings, and X uses the framework's device scaling.

## Data and saved state

Yahoo and FX requests share a 3.8-second deadline, with each response limited to 2 MiB. Failures and quote regressions retain the matching saved snapshot and original market timestamp, marked stale. A selection without a valid snapshot shows unavailable data. Source quotes older than seven days are also stale; this is not an exchange calendar.

Saved State is limited to 8,192 bytes. Long histories are grouped into OHLCV buckets; `×N` shows the grouping factor. Market timestamps retain their exact seconds. Changing symbol, currency, range or session prevents reuse of a different selection's chart. Display changes can redraw saved data during an outage. Do not clear Saved State routinely.

Prices and returns use unadjusted closes, excluding reinvested dividends. Native-currency 1D returns use the previous close when available; other returns use the first close. Currency conversion aligns historical rates at or before each asset bar. Converted OHLC values are estimates, labelled **FX estimate**; converted 1D returns start at the first aligned bar, labelled **from first bar**. Unsupported or stale FX pairs are rejected. Market times use the exchange timezone.

## Development

[.trmnlp.yml](.trmnlp.yml) supplies a fixed, clearly labelled synthetic quote with Serverless disabled for local preview. It contains no credentials or live market history. Use `trmnlp serve` from this directory for native local rendering.

For the adapter tests and full device matrix, run from the repository root with Node 20+:

```sh
npm install --no-save --package-lock=false --ignore-scripts liquidjs@10.30.1 playwright-core@1.64.1 yaml@2.9.1
node --test TRMNL/check.cjs
npx playwright-core install --with-deps chromium
TRMNL_BROWSER=chromium node scripts/preview.cjs
```

These packages are development tools only. The test suite covers market data, FX, saved-state isolation, failures, chart geometry, locales and Liquid rendering. GitHub Actions runs the same checks on `main` pushes and pull requests.

Open `dist/preview/index.html` for 512 sample previews: four device profiles, both orientations, all four layouts and sixteen data/chart scenarios. The script uses the pinned framework and actual fonts, checks bounds, overlapping text, chart endpoints and palette colors, and caches assets under `.cache/`. Native B/W/R/Y server thumbnails are grayscale; physical ink and dithering require a device check.

The repository previews are lossless WebP exports of those PNGs. To update one, keep the sample label and existing media filenames:

```sh
magick dist/preview/og-landscape-full-fresh.png -define webp:lossless=true TRMNL/media/preview_full.webp
```

## Provider limitations

Yahoo's chart endpoint is undocumented and can fail or change. Instrument coverage, history, FX pairs and pricing can differ from TradingView. Review [Yahoo's terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) for your intended use.

Stock logos are not included in the chart response used by STONKS. Yahoo exposes logo fields on a separate [quote endpoint](https://github.com/gadicc/yahoo-finance2/blob/634e594b30ce962d8b85f92fc1657d9a30a27398/src/modules/quote.ts); the plugin does not add a second request or authentication flow for logos.

[TRMNL Shared templates](https://help.trmnl.com/en/articles/13216853-reusing-markup-with-shared) · [Charts](https://trmnl.com/framework/docs/3.4/chart) · [Serverless](https://help.trmnl.com/en/articles/14130649-serverless) · [Saved State](https://help.trmnl.com/en/articles/16777795-saved-state)
