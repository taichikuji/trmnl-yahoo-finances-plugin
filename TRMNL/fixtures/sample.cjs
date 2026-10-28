// Synthetic NTNX prices, using the shape of the recorded Yahoo response.
// These are deliberately NOT real NTNX prices or a historical backtest.
const recorded = require('./yahoo-chart-recorded.json');
const NOW = Date.parse('2026-10-28T20:00:00Z');

function sample() {
  const data = structuredClone(recorded);
  const result = data.chart.result[0];
  const times = [];
  const closes = [];
  for (let day = 0; day <= 365; day++) {
    const time = Date.parse('2025-10-28T13:30:00Z') / 1000 + day * 86400;
    const weekday = new Date(time * 1000).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    times.push(time);
    const trend = 43 + day * 0.052;
    const dip = 15 * Math.exp(-(((day - 238) / 23) ** 2));
    closes.push(+(trend + 3.4 * Math.sin(day / 13) + 1.2 * Math.sin(day * 1.7) - dip).toFixed(2));
  }
  Object.assign(result.meta, {
    symbol: 'NTNX', longName: 'Nutanix Inc.', shortName: 'Nutanix, Inc.',
    currency: 'USD', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS',
    regularMarketTime: NOW / 1000 - 300,
    regularMarketPrice: +(closes.at(-1) + 0.75).toFixed(2),
    range: '1y', dataGranularity: '1d'
  });
  result.timestamp = times;
  result.indicators = {
    quote: [{ close: closes }],
    // Intentionally different: tests must detect accidental adjusted/raw mixing.
    adjclose: [{ adjclose: closes.map(p => p * 0.5) }]
  };
  return data;
}

module.exports = { sample, NOW };
