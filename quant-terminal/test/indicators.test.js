import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as I from '../public/lib/indicators.js';

const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));
const close = bars.map((b) => b.close);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// Independent, deliberately naive versions of the textbook formulas.
function naiveEma(src, n) {
  const out = []; let prev;
  for (let i = 0; i < src.length; i++) {
    if (i < n - 1) { out.push(NaN); continue; }
    if (i === n - 1) { prev = src.slice(0, n).reduce((a, b) => a + b) / n; out.push(prev); continue; }
    prev = (src[i] - prev) * (2 / (n + 1)) + prev; out.push(prev);
  }
  return out;
}
function naiveRsi(src, n) {
  // Wilder's original method: seed with simple averages, then smooth.
  const out = new Array(src.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = src[i] - src[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= n; l /= n; out[n] = 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = 100 - 100 / (1 + g / l);
  }
  return out;
}
function naiveAtr(b, n) {
  const trs = b.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low));
  const out = new Array(b.length).fill(NaN);
  let a = trs.slice(0, n).reduce((s, v) => s + v) / n; out[n - 1] = a;
  for (let i = n; i < b.length; i++) { a = (a * (n - 1) + trs[i]) / n; out[i] = a; }
  return out;
}

test('SMA matches a plain average', () => {
  const s = I.sma(close, 20);
  for (const i of [19, 100, 999]) assert.ok(near(s[i], close.slice(i - 19, i + 1).reduce((a, b) => a + b) / 20));
  assert.ok(Number.isNaN(s[18]));
});

test('EMA is seeded with the SMA and matches the textbook recursion', () => {
  const a = I.ema(close, 21), b = naiveEma(close, 21);
  for (const i of [20, 21, 500, 999]) assert.ok(near(a[i], b[i]), `i=${i}`);
});

test("RSI matches Wilder's method", () => {
  const a = I.compute('rsi', bars, { length: 14 }).value, b = naiveRsi(close, 14);
  assert.ok(Number.isNaN(a[13]));
  for (const i of [14, 15, 200, 999]) assert.ok(near(a[i], b[i]), `i=${i} ${a[i]} vs ${b[i]}`);
  assert.ok(a.slice(14).every((v) => v >= 0 && v <= 100));
});

test('ATR uses Wilder smoothing', () => {
  const a = I.atr(bars, 14), b = naiveAtr(bars, 14);
  for (const i of [13, 14, 500, 999]) assert.ok(near(a[i], b[i]), `i=${i}`);
});

test('MACD line is fast EMA minus slow EMA, histogram is MACD minus signal', () => {
  const m = I.compute('macd', bars);
  const f = naiveEma(close, 12), s = naiveEma(close, 26);
  assert.ok(near(m.macd[999], f[999] - s[999]));
  assert.ok(near(m.hist[999], m.macd[999] - m.signal[999]));
});

test('Bollinger bands use population standard deviation', () => {
  const r = I.compute('bb', bars, { length: 20, mult: 2 });
  const w = close.slice(980, 1000), mean = w.reduce((a, b) => a + b) / 20;
  const sd = Math.sqrt(w.reduce((a, v) => a + (v - mean) ** 2, 0) / 20);
  assert.ok(near(r.basis[999], mean));
  assert.ok(near(r.upper[999], mean + 2 * sd, 1e-5));
});

test('every built-in indicator runs on real data and returns full-length series', () => {
  for (const def of I.INDICATORS) {
    const out = I.compute(def.id, bars);
    for (const o of def.outputs) {
      assert.ok(Array.isArray(out[o.key]), `${def.id}.${o.key} missing`);
      assert.ok(out[o.key].length >= bars.length, `${def.id}.${o.key} too short`);
      const last = out[o.key].slice(0, bars.length).filter((v) => Number.isFinite(v));
      assert.ok(last.length > 0, `${def.id}.${o.key} has no values`);
    }
  }
  assert.ok(I.INDICATORS.length >= 50, `only ${I.INDICATORS.length} indicators`);
});

test('supertrend flips direction and stays on the right side of price', () => {
  const r = I.compute('supertrend', bars);
  const flips = r.direction.filter((d, i) => i && d !== r.direction[i - 1] && Number.isFinite(r.direction[i - 1])).length;
  assert.ok(flips > 3);
  bars.forEach((b, i) => { if (Number.isFinite(r.up[i])) assert.ok(r.up[i] <= b.high * 1.0001); });
});

test('custom indicators can be registered and computed', () => {
  I.registerIndicator({ id: 'custom:test', name: 'Test', calc: (b, p, ta) => ({ value: ta.sma(ta.source(b), 3) }) });
  const v = I.compute('custom:test', bars).value;
  assert.ok(near(v[2], (close[0] + close[1] + close[2]) / 3));
});
