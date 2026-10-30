# STONKS

A TRMNL Yahoo Finances plugin to display ETFs, Stocks and even Crypto!

Yahoo Finance prices and charts for your TRMNL. Track stocks, ETFs, indices, forex and crypto with lines, OHLC bars or candles. No market-data API key needed.

![STONKS sample stock chart on TRMNL OG](TRMNL/media/preview_full.webp)

Synthetic sample prices. [All layout previews](TRMNL/README.md#previews).

## Settings

- **Symbols:** One Yahoo Finance symbol, such as `NTNX` or `VWCE.DE`, or a rotation list such as `NTNX,AAPL,NVDA`.
- **Chart:** six date ranges, line style and width, grid, volume, return baseline, extended hours and price precision.
- **Text:** six languages and adjustable heading and label sizes.

Full, half horizontal, half vertical and quadrant layouts support TRMNL OG, X and B/W/R/Y. Monochrome uses arrows and hollow/filled candles; color panels add gain/loss highlights.

For private installation and data behavior, see the [plugin guide](TRMNL/README.md#setup).

## Develop locally

Install [trmnlp](https://github.com/usetrmnl/trmnlp), then run from the repository root:

```sh
cd TRMNL
trmnlp serve
```

The local configuration uses synthetic prices without contacting Yahoo. Templates and settings live in [TRMNL/src/](TRMNL/src/); the [development guide](TRMNL/README.md#development) covers tests and device previews.

Each instrument uses its original currency: AAPL in USD, VWCE.DE in EUR. Each refresh makes at most one request to Yahoo Finance's chart endpoint, with no retries. Coverage and availability vary; quotes can be delayed. Failed requests retain the matching saved chart and mark it stale.

[Questions or ideas?](https://github.com/taichikuji/trmnl-yahoo-finances-plugin/issues) · [License](LICENSE)
