import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normCdf, normInv, psr, expectedMaxSharpe, pbo, monteCarlo, quantChecks } from '../public/lib/quant.js';
import { EXAMPLE_STRATEGIES } from '../public/lib/backtest.js';

const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));

test('normal distribution helpers match known values', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.9750021) < 1e-6);
  assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-6);
  for (const p of [0.001, 0.2, 0.5, 0.8, 0.999]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6);
});

test('PSR: a strong steady series is near certain, noise around zero is a coin flip', () => {
  const steady = Array.from({ length: 500 }, (_, i) => 0.002 + 0.001 * Math.sin(i));
  assert.ok(psr(steady) > 0.999);
  const seeded = (s) => () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const r = seeded(42), noise = Array.from({ length: 2000 }, () => r() * 0.02);
  const p = psr(noise);
  assert.ok(p > 0.05 && p < 0.95, `noise PSR ${p}`);
});

test('the expected best Sharpe of many noise trials grows with the number of trials', () => {
  assert.ok(expectedMaxSharpe(100, 0.01) > expectedMaxSharpe(10, 0.01));
  assert.equal(expectedMaxSharpe(1, 0.01), 0);
});

test('PBO: a variant that is better everywhere is not overfit; pure noise is about a coin flip', () => {
  const T = 400;
  const good = Array.from({ length: T }, (_, i) => 0.01 + 0.002 * Math.sin(i));
  const others = Array.from({ length: 5 }, (_, k) => Array.from({ length: T }, (_, i) => 0.001 * Math.sin(i * (k + 2))));
  assert.ok(pbo([good, ...others]).pbo < 0.1);
  let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const noise = Array.from({ length: 12 }, () => Array.from({ length: T }, () => r()));
  const p = pbo(noise).pbo;
  assert.ok(p > 0.2 && p < 0.8, `noise PBO ${p}`);
  assert.equal(pbo([good]), null, 'needs at least two variants');
});

test('Monte Carlo is reproducible and its percentiles are ordered', () => {
  const trades = [5, -2, 3, -1, 8, -4, 2, 1, -3, 6];
  const a = monteCarlo(trades), b = monteCarlo(trades);
  assert.deepEqual(a, b);
  assert.ok(a.p5 <= a.p50 && a.p50 <= a.p95);
  assert.ok(a.lossProb >= 0 && a.lossProb <= 100);
});

test('quant checks run on a real strategy and report every gate', () => {
  const r = quantChecks(bars, EXAMPLE_STRATEGIES['EMA cross (9/21)'], { mcRuns: 300 });
  assert.equal(r.variants.length, 25, 'two lengths x five settings');
  assert.deepEqual(r.gates.map((g) => g.key).sort(), ['cost', 'dsr', 'pbo', 'robust', 'wf']);
  assert.ok(r.pbo.pbo >= 0 && r.pbo.pbo <= 1);
  assert.equal(r.pbo.splits, 70);
  assert.equal(r.walkForward.folds.length, 5);
  assert.ok(r.dsr <= r.psr + 1e-12, 'deflating for 25 tries can only lower the probability');
});

test('a strategy with no tunable lengths still gets the checks that apply', () => {
  const r = quantChecks(bars, { indicators: {}, entryLong: [{ left: 'close', op: 'crossesAbove', right: 30000 }], exitLong: [{ left: 'close', op: 'crossesBelow', right: 30000 }] }, { mcRuns: 100 });
  assert.equal(r.variants.length, 1);
  assert.ok(r.gates.some((g) => g.key === 'cost'));
  assert.equal(r.pbo, null);
});

test('Monte Carlo scales trades by position size, and cost stress adds slippage when it is set to 0', () => {
  const strat = { ...EXAMPLE_STRATEGIES['EMA cross (9/21)'], slippagePct: 0 };
  const full = quantChecks(bars, { ...strat, positionPct: 100 }, { mcRuns: 300 });
  const part = quantChecks(bars, { ...strat, positionPct: 20 }, { mcRuns: 300 });
  assert.ok(Math.abs(part.monteCarlo.ddP50) < Math.abs(full.monteCarlo.ddP50) * 0.4, '20% sizing gives a much smaller drawdown');
  const noCostStress = quantChecks(bars, { ...strat, feePct: 0 }, { mcRuns: 100 });
  assert.ok(noCostStress.costStress < noCostStress.base.netPct, 'stress still costs something with zero fees and slippage');
  assert.match(noCostStress.gates.find((g) => g.key === 'cost').value, /0\.05% slippage/);
});
