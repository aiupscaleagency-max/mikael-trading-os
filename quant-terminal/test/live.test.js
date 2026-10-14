// Hits the real free data sources. Run with: npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCandles, getQuotes, probeAll } from '../lib/providers.js';

test('at least one crypto source returns BTC daily bars', async () => {
  const r = await getCandles('BTCUSDT', '1D', 200);
  assert.ok(r.candles.length >= 100, `${r.provider} returned ${r.candles.length}`);
  console.log(`crypto via ${r.provider}`);
});

test('US stock daily bars load', async () => {
  const r = await getCandles('AAPL', '1D', 200);
  assert.ok(r.candles.length >= 100);
  console.log(`stocks via ${r.provider}`);
});

test('forex loads', async () => {
  const r = await getCandles('EURUSD', '1h', 100);
  assert.ok(r.candles.length >= 50);
  console.log(`forex via ${r.provider}`);
});

test('quotes come back for a mixed watchlist', async () => {
  const q = await getQuotes(['BTCUSDT', 'AAPL', 'EURUSD']);
  for (const v of Object.values(q)) assert.ok(v.price > 0, JSON.stringify(q));
});

test('source report', async () => {
  console.log(JSON.stringify(await probeAll(), null, 2));
});
