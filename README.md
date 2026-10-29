# STONKS

Stocks, ETFs, indices, forex and crypto on your TRMNL, with native Yahoo Finance charts and a clear price and return. Supports lines, OHLC bars and candles without a remote widget or market-data API key.

![STONKS sample stock chart on TRMNL OG](TRMNL/media/preview_full.webp)

Synthetic sample prices. [All layout previews](TRMNL/README.md#previews).

## Settings

- **Symbol:** Yahoo Finance ticker, such as `NTNX`, `VWCE.DE`, `^GSPC` or `BTC-USD`. Common TradingView exchange symbols also work.
- **Currency:** native currency, available fiat pairs, BTC or ETH. Historical prices use historical exchange rates.
- **Chart:** six date ranges, line style and width, grid, volume, return baseline, extended hours and price precision.
- **Typography:** six languages and adjustable header and label sizes.

Full, half horizontal, half vertical and quadrant layouts support TRMNL OG, X and B/W/R/Y. Monochrome uses arrows and hollow/filled candles; color panels add gain/loss highlights. The default is **NTNX · USD · one year**, refreshed every 15 minutes.

For private installation and data behavior, see the [plugin guide](TRMNL/README.md#setup).

## Develop locally

Install [trmnlp](https://github.com/usetrmnl/trmnlp), then run from the repository root:

```sh
cd TRMNL
trmnlp serve
```

The local configuration uses synthetic prices without contacting Yahoo. Templates and settings live in [TRMNL/src/](TRMNL/src/); the [development guide](TRMNL/README.md#development) covers tests and device previews.

Data comes from Yahoo Finance's chart endpoint. Coverage and availability vary; quotes can be delayed. Failed requests retain the matching saved chart and mark it stale.

[Questions or ideas?](https://github.com/taichikuji/trmnl-yahoo-finances-plugin/issues) · [License](LICENSE)
