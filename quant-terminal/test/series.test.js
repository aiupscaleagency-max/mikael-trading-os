import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTf, resample, bucketStart, nativeBase, heikinAshi, renko, lineBreak, toCsv } from '../public/lib/series.js';

const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));

test('parses timeframes', () => {
  assert.equal(parseTf('15m').seconds, 900);
  assert.equal(parseTf('4h').seconds, 14400);
  assert.equal(parseTf('1D').seconds, 86400);
  assert.throws(() => parseTf('banana'));
});

test('weekly buckets start on Monday 00:00 UTC', () => {
  const t = Date.UTC(2026, 9, 15, 13) / 1000; // Thursday 15 Oct 2026
  assert.equal(new Date(bucketStart(t, '1W') * 1000).toISOString(), '2026-10-12T00:00:00.000Z');
  assert.equal(new Date(bucketStart(t, '1M') * 1000).toISOString(), '2026-10-01T00:00:00.000Z');
});

test('resampling keeps OHLC semantics and sums volume', () => {
  const w = resample(bars, '1W');
  const first = w[1];
  const members = bars.filter((b) => bucketStart(b.time, '1W') === first.time);
  assert.equal(first.open, members[0].open);
  assert.equal(first.close, members.at(-1).close);
  assert.equal(first.high, Math.max(...members.map((b) => b.high)));
  assert.ok(Math.abs(first.volume - members.reduce((a, b) => a + b.volume, 0)) < 1e-6);
});

test('picks the right native base timeframe', () => {
  const n = ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M'];
  assert.equal(nativeBase('7m', n), '1m');
  assert.equal(nativeBase('2h', n), '1h');
  assert.equal(nativeBase('3D', n), '1D');
  assert.equal(nativeBase('1W', n), '1W');
  assert.equal(nativeBase('3M', n), '1M');
});

test('chart-type transforms produce strictly increasing times', () => {
  for (const out of [heikinAshi(bars), renko(bars), lineBreak(bars)]) {
    assert.ok(out.length > 10);
    for (let i = 1; i < out.length; i++) assert.ok(out[i].time > out[i - 1].time);
  }
});

test('CSV export has a header and one row per bar', () => {
  const csv = toCsv(bars.slice(0, 5), { rsi: [1, 2, 3, NaN, 5] });
  const lines = csv.split('\n');
  assert.equal(lines.length, 6);
  assert.ok(lines[0].endsWith('rsi'));
});

import { rangeBars, kagi, pointFigure } from '../public/lib/series.js';

test('range bars each span the set range, except the last one still forming', () => {
  const r = rangeBars(bars, 2000);
  assert.ok(r.length > 50);
  for (const b of r.slice(0, -1)) assert.ok(Math.abs(b.high - b.low - 2000) < 1e-6, `${b.high - b.low}`);
  for (let i = 1; i < r.length; i++) assert.ok(r[i].time > r[i - 1].time);
});

test('kagi turns alternate and only reverse by the reversal amount', () => {
  const k = kagi(bars, 3000);
  assert.ok(k.length > 10);
  for (let i = 1; i < k.length; i++) assert.ok(k[i].time > k[i - 1].time);
  for (let i = 2; i < k.length - 1; i++) {
    const a = k[i - 1].close - k[i - 2].close, b = k[i].close - k[i - 1].close;
    assert.ok(a * b < 0, 'consecutive moves change direction');
    assert.ok(Math.abs(b) >= 3000 - 1e-6);
  }
});

test('point and figure columns alternate and reverse by at least three boxes', () => {
  const p = pointFigure(bars, 1000, 3);
  assert.ok(p.length > 10);
  for (let i = 1; i < p.length; i++) {
    assert.notEqual(p[i].dir, p[i - 1].dir);
    assert.ok(p[i].time > p[i - 1].time);
  }
  for (const c of p.slice(1, -1)) assert.ok(c.boxes >= 3, `column of ${c.boxes} boxes`);
});

import { seasonals } from '../public/lib/seasonals.js';

test('seasonals: each year chains from the last close of the year before', () => {
  const s = seasonals(bars);
  assert.ok(s.years.length >= 3);
  const y = s.years.find((x) => x.complete);
  assert.ok(y, 'at least one complete year in the fixture');
  const rows = bars.filter((b) => new Date(b.time * 1000).getUTCFullYear() === y.year);
  const prevClose = bars.filter((b) => new Date(b.time * 1000).getUTCFullYear() === y.year - 1).at(-1).close;
  assert.ok(Math.abs(y.total - (rows.at(-1).close / prevClose - 1) * 100) < 1e-9);
  // compounding the twelve monthly moves gives the year's move
  const m = s.monthly.find((x) => x.year === y.year).months;
  const compounded = (m.reduce((acc, v) => acc * (1 + (v ?? 0) / 100), 1) - 1) * 100;
  assert.ok(Math.abs(compounded - y.total) < 1e-6);
  assert.equal(s.average.length, 366);
});
