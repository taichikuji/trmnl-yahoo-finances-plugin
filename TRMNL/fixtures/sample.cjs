// Synthetic provider-shaped data, never a historical backtest or real quote.
const NOW = Date.parse('2026-10-28T20:00:00Z');
function sample(options = {}) {
  const { symbol = 'NTNX', currency = 'USD', interval = '1d', count = 262, seconds = 86400,
    startPrice = 43, timezone = 'America/New_York' } = options;
  const end = NOW / 1000 - 300;
  const times = [], closes = [];
  for (let i = 0; i < count; i++) {
    times.push(end - (count - i - 1) * seconds);
    const trend = startPrice * (1 + i / count * 0.25);
    closes.push(+(trend + startPrice * (0.07 * Math.sin(i / 13) + 0.025 * Math.sin(i * 1.7))).toPrecision(8));
  }
  const meta = {
    symbol, longName: symbol === 'NTNX' ? 'Nutanix Inc.' : symbol + ' sample', shortName: symbol,
    currency, instrumentType: 'EQUITY', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS',
    exchangeTimezoneName: timezone, regularMarketTime: end,
    regularMarketPrice: closes.at(-1), chartPreviousClose: closes[0] * 0.99,
    range: '1y', dataGranularity: interval
  };
  const indicators = {
    quote: [{ close: closes, open: closes.map(p => p * 0.997), high: closes.map(p => p * 1.02),
      low: closes.map(p => p * 0.98), volume: closes.map((_, i) => 1000000 + i * 1703) }],
    // Different by design: tests catch accidental adjusted/raw mixing.
    adjclose: [{ adjclose: closes.map(p => p * 0.5) }]
  };
  return { chart: { result: [{ meta, timestamp: times, indicators }], error: null } };
}
module.exports = { sample, NOW };
