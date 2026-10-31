# STONKS

A TRMNL Yahoo Finances plugin to display ETFs, Stocks and even Crypto!

Yahoo Finance prices and charts for your TRMNL. Track stocks, ETFs, indices, forex and crypto with lines, OHLC bars or candles. No market-data API key needed.

![STONKS sample stock chart on TRMNL OG](TRMNL/media/preview_full.webp)

Synthetic sample prices. [All layout previews](TRMNL/README.md#previews).

## Settings

- **Symbol:** Yahoo Finance symbol, such as `NTNX`, `VWCE.DE`, `%5ESTOXX50E` or `BTC-USD`.
- **Currency:** native currency, available fiat pairs, BTC or ETH. Historical prices use historical exchange rates.
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

Data comes from Yahoo Finance's chart endpoint. Coverage and availability vary; quotes can be delayed. Failed requests retain the matching saved chart and mark it stale.

Community API references: [yahoo-finance2 chart implementation](https://github.com/gadicc/yahoo-finance2/blob/dev/src/modules/chart.ts) · [yfinance history implementation](https://github.com/ranaroussi/yfinance/blob/main/yfinance/scrapers/history.py) · [yfinance repository](https://github.com/ranaroussi/yfinance) · [yfinance documentation](https://ranaroussi.github.io/yfinance/).

[Questions or ideas?](https://github.com/taichikuji/trmnl-yahoo-finances-plugin/issues) · [License](LICENSE)
