import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backtest, EXAMPLE_STRATEGIES, tradesCsv, magnifierTf } from '../public/lib/backtest.js';

const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));

test('fills on the next bar open, never the signal bar', () => {
  const r = backtest(bars, EXAMPLE_STRATEGIES['EMA cross (9/21)']);
  assert.ok(r.trades.length > 5);
  for (const t of r.trades) {
    const i = bars.findIndex((b) => b.time === t.entryTime);
    assert.ok(i > 0);
    assert.ok(Math.abs(t.entryPrice - bars[i].open * 1.0005) < 1e-6, 'entry = open x (1 + slippage)');
  }
});

test('equity curve accounts for every trade', () => {
  const s = EXAMPLE_STRATEGIES['RSI mean reversion (30/55)'];
  const r = backtest(bars, { ...s, initialCapital: 10000 });
  const sumPnl = r.trades.reduce((a, t) => a + t.pnl, 0);
  assert.ok(Math.abs(10000 + sumPnl - r.equity.at(-1).value) < 1e-6);
  assert.equal(r.stats.totalTrades, r.trades.length);
});

test('stops cap the loss of a losing trade', () => {
  const r = backtest(bars, { ...EXAMPLE_STRATEGIES['EMA cross (9/21)'], stopLossPct: 2, feePct: 0, slippagePct: 0 });
  const stopped = r.trades.filter((t) => t.exitReason === 'Stop');
  assert.ok(stopped.length > 0);
  for (const t of stopped) assert.ok(t.pnlPct >= -2 - 15, 'gap through the stop is the only way past -2%');
});

test('shorts make money when price falls', () => {
  const down = Array.from({ length: 60 }, (_, i) => ({ time: i * 86400, open: 100 - i, high: 101 - i, low: 99 - i, close: 100 - i, volume: 1 }));
  const r = backtest(down, { indicators: {}, entryShort: [{ left: 'close', op: '<', right: 95 }], exitShort: [{ left: 'close', op: '<', right: 50 }], feePct: 0, slippagePct: 0 });
  assert.equal(r.trades[0].side, 'short');
  assert.ok(r.trades[0].pnl > 0);
});

test('every example strategy runs and the trades export to CSV', () => {
  for (const [name, s] of Object.entries(EXAMPLE_STRATEGIES)) {
    const r = backtest(bars, s);
    assert.ok(r.equity.length === bars.length, name);
    assert.ok(tradesCsv(r.trades).startsWith('side,'));
  }
});

import { linePrice, conditionFn } from '../public/lib/backtest.js';

test('a drawn line gives its price at any time, within its reach', () => {
  const trend = linePrice({ t1: 100, p1: 10, t2: 200, p2: 20, extend: 'none' });
  assert.equal(trend(150), 15);
  assert.ok(Number.isNaN(trend(250)), 'a trend line stops at its second point');
  const ray = linePrice({ t1: 100, p1: 10, t2: 200, p2: 20, extend: 'right' });
  assert.equal(ray(300), 30);
  assert.ok(Number.isNaN(ray(50)), 'a ray has nothing behind its start');
  const ext = linePrice({ t1: 100, p1: 10, t2: 200, p2: 20, extend: 'both' });
  assert.equal(ext(0), 0);
});

test('price crossing a drawn line is detected bar by bar', () => {
  const series = [5, 6, 7, 12, 13].map((c, i) => ({ time: i * 10, open: c, high: c, low: c, close: c, volume: 1 }));
  const rising = { line: { t1: 0, p1: 8, t2: 40, p2: 12, extend: 'right' } }; // 8, 9, 10, 11, 12
  const test = conditionFn(series, {})({ left: 'close', op: 'crossesAbove', right: rising });
  assert.deepEqual(series.map((_, i) => test(i)), [false, false, false, true, false]);
});

// Jeff's asks: exit on whichever rule fires first, and a time exit when nothing else has.
const flat = (closes) => closes.map((c, i) => ({ time: 1700000000 + i * 86400, open: c, high: c, low: c, close: c, volume: 1 }));
const noCosts = { feePct: 0, slippagePct: 0 };

test('exitMatch any exits on whichever exit condition fires first; all waits for both', () => {
  const b = flat([100, 100, 120, 130, 125, 90, 80, 80]);
  const s = {
    ...noCosts,
    entryLong: [{ left: 'close', op: '>', right: 110 }],
    exitLong: [{ left: 'close', op: '<', right: 128 }, { left: 'close', op: '<', right: 100 }],
  };
  // Long from bar 3's open (signal on bar 2). Bar 4 closes at 125: only the first rule is true; bar 5 at 90: both.
  assert.equal(backtest(b, { ...s, exitMatch: 'any' }).trades[0].exitTime, b[5].time);
  assert.equal(backtest(b, s).trades[0].exitTime, b[6].time);
  assert.equal(backtest(b, { ...s, exitMatch: 'any' }).trades[0].exitReason, 'Exit long');
});

test('maxBarsInTrade closes a trade after that many bars unless an exit fires first', () => {
  const b = flat(Array.from({ length: 30 }, (_, i) => 100 + i));
  const s = { ...noCosts, entryLong: [{ left: 'close', op: '>', right: 0 }], maxBarsInTrade: 5 };
  const r = backtest(b, s);
  assert.ok(r.trades.length > 2);
  for (const t of r.trades.slice(0, -1)) {
    assert.equal(t.bars, 5);
    assert.equal(t.exitReason, 'Time exit');
  }
  const early = backtest(b, { ...s, exitLong: [{ left: 'close', op: '>=', right: 103 }] }).trades[0];
  assert.equal(early.exitReason, 'Exit long');
  assert.ok(early.bars < 5);
  assert.ok(backtest(b, { ...s, maxBarsInTrade: 0 }).trades.length === 1, '0 turns it off');
});

// @mats8038: real tick and spread simulation.
const day = (i, o, h, l, c) => ({ time: 1700000000 + i * 86400, open: o, high: h, low: l, close: c, volume: 1 });

test('the spread fills buys at the ask and sells at the bid', () => {
  const b = [day(0, 100, 100, 100, 100), day(1, 100, 100, 100, 100), day(2, 100, 100, 100, 100), day(3, 100, 100, 100, 100)];
  const s = { ...noCosts, spreadPct: 0.2, entryLong: [{ left: 'close', op: '>', right: 0 }], exitLong: [{ left: 'close', op: '>', right: 0 }] };
  const t = backtest(b, s).trades[0];
  assert.ok(Math.abs(t.entryPrice - 100.1) < 1e-9);
  assert.ok(Math.abs(t.exitPrice - 99.9) < 1e-9);
  assert.match(backtest(b, s).stats.feesAndSlippage, /0.2% spread/);
});

test("a long's stop triggers on the bid, so the spread can set it off when the mid doesn't", () => {
  const b = [day(0, 100, 100, 100, 100), day(1, 100, 100, 98.15, 99), day(2, 99, 99, 99, 99)];
  const s = { ...noCosts, stopLossPct: 2, entryLong: [{ left: 'close', op: '>', right: 0 }] };
  assert.equal(backtest(b, s).trades[0].exitReason, 'End of data');
  assert.equal(backtest(b, { ...s, spreadPct: 0.2 }).trades[0].exitReason, 'Stop'); // bid 98.05 < stop 98.098
});

test('fills inside a bar: cautious, TradingView path, and the bar magnifier', () => {
  // Bar 1 touches both the 2% stop (98) and the 2% target (102); its high is nearer the open than its low.
  const b = [day(0, 100, 100, 100, 100), day(1, 100, 102.5, 97, 100), day(2, 100, 100, 100, 100)];
  const s = { ...noCosts, stopLossPct: 2, takeProfitPct: 2, entryLong: [{ left: 'close', op: '>', right: 0 }] };
  assert.equal(backtest(b, s).trades[0].exitReason, 'Stop');
  assert.equal(backtest(b, { ...s, intrabar: 'ohlc' }).trades[0].exitReason, 'Target');
  // The real lower-timeframe bars show it fell first.
  const subBars = [
    { time: b[1].time, open: 100, high: 100, low: 97, close: 97.5 },
    { time: b[1].time + 43200, open: 97.5, high: 102.5, low: 97.5, close: 100 },
  ];
  const m = backtest(b, { ...s, intrabar: 'magnifier' }, { subBars });
  assert.equal(m.trades[0].exitReason, 'Stop');
  assert.equal(m.trades[0].exitPrice, 98);
  assert.equal(m.stats.intrabarCovered, 1);
  assert.match(m.stats.fills, /inside 1 of 3 bars, the rest on the OHLC path/);
  // Rising first inside the bar: the target fills.
  const up = [
    { time: b[1].time, open: 100, high: 102.5, low: 100, close: 101 },
    { time: b[1].time + 43200, open: 101, high: 101, low: 97, close: 100 },
  ];
  assert.equal(backtest(b, { ...s, intrabar: 'magnifier' }, { subBars: up }).trades[0].exitReason, 'Target');
});

test('a bar that opens past the stop fills at the open on every fill setting', () => {
  const b = [day(0, 100, 100, 100, 100), day(1, 100, 100, 99, 99), day(2, 95, 96, 94, 95), day(3, 95, 95, 95, 95)];
  const s = { ...noCosts, stopLossPct: 2, entryLong: [{ left: 'close', op: '>', right: 0 }] };
  for (const intrabar of ['worst', 'ohlc', 'magnifier']) {
    const t = backtest(b, { ...s, intrabar }).trades[0];
    assert.equal(t.exitReason, 'Stop');
    assert.equal(t.exitPrice, 95, intrabar);
  }
});

test('the magnifier picks the finest timeframe that covers the test in 20,000 bars', () => {
  assert.equal(magnifierTf(14400, 1000 * 14400).tf, '15m');
  assert.equal(magnifierTf(86400, 1000 * 86400).tf, '4h');
  assert.equal(magnifierTf(3600, 300 * 3600).tf, '1m');
  assert.equal(magnifierTf(3600, 500 * 3600).tf, '5m');
  assert.equal(magnifierTf(60, 1000 * 60), null);
});
