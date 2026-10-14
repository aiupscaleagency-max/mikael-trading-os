#!/usr/bin/env node
// Print indicator values for one bar so you can check them against TradingView's legend.
//   node scripts/compare.js BTCUSDT 1D 2026-10-10
//   node scripts/compare.js AAPL 1D            (latest closed bar)
import { getCandles } from '../lib/providers.js';
import { compute } from '../public/lib/indicators.js';

const [symbol = 'BTCUSDT', tf = '1D', date] = process.argv.slice(2);
const { candles, provider, symbol: id } = await getCandles(symbol, tf, 3000);
let i = candles.length - 2; // last closed bar
if (date) i = candles.findIndex((b) => new Date(b.time * 1000).toISOString().startsWith(date));
if (i < 0) { console.error(`No bar on ${date}`); process.exit(1); }
const b = candles[i];
const f = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : '-');
const row = (name, id2, params = {}, keys) => {
  const r = compute(id2, candles, params);
  return [name, ...(keys || Object.keys(r).filter((k) => Array.isArray(r[k]) && typeof r[k][0] !== 'string')).map((k) => `${k} ${f(r[k][i])}`)].join('  ');
};
console.log(`\n${id} ${tf} from ${provider}, bar ${new Date(b.time * 1000).toISOString().slice(0, 16)}  O ${b.open} H ${b.high} L ${b.low} C ${b.close}\n`);
console.log(row('RSI 14      ', 'rsi', {}, ['value']));
console.log(row('EMA 21      ', 'ema', { length: 21 }, ['value']));
console.log(row('SMA 50      ', 'sma', { length: 50 }, ['value']));
console.log(row('MACD 12 26 9', 'macd', {}, ['macd', 'signal', 'hist']));
console.log(row('BB 20 2     ', 'bb', {}, ['upper', 'basis', 'lower']));
console.log(row('ATR 14      ', 'atr', {}, ['value']));
console.log(row('Stoch 14 1 3', 'stoch', {}, ['k', 'd']));
console.log(row('ADX 14      ', 'dmi', {}, ['adx', 'plus', 'minus']));
console.log(row('Supertrend  ', 'supertrend', {}, ['up', 'down']));
console.log('\nOn TradingView: same symbol and exchange, same timeframe, hover the same bar, add the same indicators with default settings.\n');
