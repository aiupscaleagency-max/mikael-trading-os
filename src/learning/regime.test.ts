import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRegime, MIN_BARS } from "./regime.js";
import type { Kline } from "../types.js";

const BAR_MS = 4 * 60 * 60 * 1000;

/** Bygger syntetiska candles ur en prisserie, med en fast relativ bar-bredd. */
function candles(closes: number[], spreadPct = 0.002): Kline[] {
  return closes.map((c, i) => ({
    openTime: i * BAR_MS,
    closeTime: (i + 1) * BAR_MS - 1,
    open: i === 0 ? c : closes[i - 1]!,
    high: c * (1 + spreadPct),
    low: c * (1 - spreadPct),
    close: c,
    volume: 100,
  }));
}

test("monoton uppgång ger trend_up", () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.8);
  assert.equal(deriveRegime(candles(closes)).regime, "trend_up");
});

test("monoton nedgång ger trend_down", () => {
  const closes = Array.from({ length: 120 }, (_, i) => 200 - i * 0.8);
  assert.equal(deriveRegime(candles(closes)).regime, "trend_down");
});

test("sågtand kring ett medelvärde ger range", () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + (i % 2 === 0 ? 0.3 : -0.3));
  assert.equal(deriveRegime(candles(closes)).regime, "range");
});

test("volatilitetsexpansion ger high_vol och slår ut trendregimen", () => {
  // 110 lugna barer, sedan några barer med kraftigt vidgade spann.
  const lugn = candles(Array.from({ length: 110 }, (_, i) => 100 + i * 0.5), 0.001);
  const stökig = candles(Array.from({ length: 10 }, (_, i) => 155 + i * 0.5), 0.05).map((k, i) => ({
    ...k,
    openTime: (110 + i) * BAR_MS,
    closeTime: (111 + i) * BAR_MS - 1,
  }));
  const res = deriveRegime([...lugn, ...stökig]);
  assert.equal(res.regime, "high_vol");
  assert.ok(res.inputs.atrPct! > res.inputs.atrPctMedian!, "ATR% ska ligga över sin median");
});

test("för få barer ger unknown istället för en gissning", () => {
  const res = deriveRegime(candles(Array.from({ length: MIN_BARS - 1 }, () => 100)));
  assert.equal(res.regime, "unknown");
  assert.equal(res.inputs.atrPct, null);
});

test("tom serie kraschar inte", () => {
  assert.equal(deriveRegime([]).regime, "unknown");
});
