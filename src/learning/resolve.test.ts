import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSignal, liquidationPrice, isGeometryValid, type CostModel, type ResolveSignalInput } from "./resolve.js";
import type { Kline } from "../types.js";

const BAR_MS = 60 * 60 * 1000; // 1h
const T0 = 1_700_000_000_000;

const NO_COSTS: CostModel = { feeBps: 0, slippageBps: 0, fundingBpsPer8h: 0, mmr: 0.005, liqBufferPct: 0 };
const REAL_COSTS: CostModel = { feeBps: 10, slippageBps: 5, fundingBpsPer8h: 1, mmr: 0.005, liqBufferPct: 0.002 };

/** En bar med explicit OHLC. `n` = barens index efter signalen (1-baserad). */
function bar(n: number, o: number, h: number, l: number, c: number): Kline {
  return {
    openTime: T0 + n * BAR_MS,
    closeTime: T0 + (n + 1) * BAR_MS - 1,
    open: o, high: h, low: l, close: c, volume: 1,
  };
}

/** Long: entry 100, SL 95, TP 110 → R = 5. Utan hävstång om inte annat anges. */
function longSignal(over: Partial<ResolveSignalInput> = {}): ResolveSignalInput {
  return {
    ts: T0, direction: "long", entry: 100, stopLoss: 95, takeProfit: 110,
    horizonBars: 5, leverage: 1, assetClass: "crypto", isPerp: false,
    intervalMs: BAR_MS, ...over,
  };
}
/** Short: spegelbild — entry 100, SL 105, TP 90 → R = 5. */
function shortSignal(over: Partial<ResolveSignalInput> = {}): ResolveSignalInput {
  return { ...longSignal(), direction: "short", stopLoss: 105, takeProfit: 90, ...over };
}

test("1. TP-träff long", () => {
  const res = resolveSignal({
    signal: longSignal(),
    candles: [bar(1, 100, 102, 99, 101), bar(2, 101, 104, 100, 103), bar(3, 103, 112, 102, 111)],
    costs: NO_COSTS,
  });
  assert.ok(res);
  assert.equal(res!.outcome, "TP");
  assert.equal(res!.exitPrice, 110);
  assert.equal(res!.barsToResolution, 3);
  assert.equal(res!.rMultipleGross, 2); // (110-100)/5
});

test("2. SL-träff long — r_multiple sämre än -1 efter kostnader", () => {
  const res = resolveSignal({
    signal: longSignal(),
    candles: [bar(1, 100, 101, 94, 96)],
    costs: REAL_COSTS,
  });
  assert.ok(res);
  assert.equal(res!.outcome, "SL");
  assert.equal(res!.exitPrice, 95);
  assert.equal(res!.rMultipleGross, -1);
  assert.ok(res!.rMultiple < -1, `kostnader ska göra utfallet sämre än -1R, fick ${res!.rMultiple}`);
});

test("3. Utgången — exit på sista barens close", () => {
  const candles = [1, 2, 3, 4, 5].map((n) => bar(n, 100, 101, 99, 100.5));
  const res = resolveSignal({ signal: longSignal(), candles, costs: NO_COSTS });
  assert.ok(res);
  assert.equal(res!.outcome, "utgången");
  assert.equal(res!.exitPrice, 100.5);
  assert.equal(res!.barsToResolution, 5);
  assert.ok(Math.abs(res!.rMultiple) < 1);
});

test("4. ACCEPTANS: tvetydig bar (TP och SL i samma candle) antar SL", () => {
  const res = resolveSignal({
    signal: longSignal(),
    candles: [bar(1, 100, 112, 94, 105)], // rör både TP 110 och SL 95
    costs: NO_COSTS,
  });
  assert.ok(res);
  assert.equal(res!.outcome, "SL", "konservativt antagande");
  assert.equal(res!.ambiguousBar, true, "tvetydigheten måste loggas");
  assert.ok(res!.notes.some((n) => n.includes("samma bar")));
});

test("5. Lookahead: TP-träff FÖRE signalen får inte räknas", () => {
  const innan: Kline = {
    openTime: T0 - 2 * BAR_MS, closeTime: T0 - BAR_MS - 1,
    open: 100, high: 130, low: 99, close: 100, volume: 1, // skulle ha träffat TP
  };
  const res = resolveSignal({
    signal: longSignal(),
    candles: [innan, bar(1, 100, 101, 94, 96)],
    costs: NO_COSTS,
  });
  assert.ok(res);
  assert.equal(res!.outcome, "SL", "historik före signalen får inte läcka in");
});

test("6. Lookahead, subtil: bar med openTime === signal.ts ignoreras", () => {
  const samtidig: Kline = {
    openTime: T0, closeTime: T0 + BAR_MS - 1,
    open: 100, high: 130, low: 99, close: 100, volume: 1, // passerar TP
  };
  const res = resolveSignal({
    signal: longSignal(),
    candles: [samtidig, bar(1, 100, 101, 94, 96)],
    costs: NO_COSTS,
  });
  assert.ok(res);
  assert.equal(res!.outcome, "SL", "baren var redan påbörjad när signalen föddes");
  assert.equal(res!.barsToResolution, 1, "räkningen startar på nästa bar");
});

test("7. Likvidation prövas före SL vid 5x", () => {
  // SL satt orimligt långt bort (-25 %), likvidation ligger närmare.
  const res = resolveSignal({
    signal: longSignal({ leverage: 5, stopLoss: 75, takeProfit: 130 }),
    candles: [bar(1, 100, 101, 79, 80)], // low under liq ≈ 80,5
    costs: NO_COSTS,
  });
  assert.ok(res);
  assert.equal(res!.outcome, "likviderad");
  assert.equal(res!.returnOnMarginPct, -100, "hela insatsen ska vara borta");
  assert.equal(res!.exitPrice, res!.liquidationPrice);
});

test("8. Likvidationsformeln, 5x long och short", () => {
  assert.ok(Math.abs(liquidationPrice(100, "long", 5, 0.005)! - 80.5) < 1e-9);
  assert.ok(Math.abs(liquidationPrice(100, "short", 5, 0.005)! - 119.5) < 1e-9);
  assert.equal(liquidationPrice(100, "long", 1, 0.005), null, "utan hävstång finns ingen likvidation");
});

test("9. Gap förbi SL fylls på open, inte på SL-nivån", () => {
  const res = resolveSignal({
    signal: longSignal(),
    candles: [bar(1, 88, 89, 86, 87)], // öppnar långt under SL 95
    costs: NO_COSTS,
  });
  assert.ok(res);
  assert.equal(res!.outcome, "SL");
  assert.equal(res!.exitPrice, 88, "fylls på öppningskursen");
  assert.equal(res!.gapFilled, true);
  assert.ok(res!.rMultiple < -1, "gapet ska kosta mer än 1R");
});

test("10. Short-symmetri ger identiska R-multiplar", () => {
  const tp = resolveSignal({
    signal: shortSignal(),
    candles: [bar(1, 100, 101, 88, 89)],
    costs: NO_COSTS,
  });
  assert.equal(tp!.outcome, "TP");
  assert.equal(tp!.rMultipleGross, 2, "samma som long-fallet");

  const sl = resolveSignal({
    signal: shortSignal(),
    candles: [bar(1, 100, 106, 99, 105)],
    costs: NO_COSTS,
  });
  assert.equal(sl!.outcome, "SL");
  assert.equal(sl!.rMultipleGross, -1);

  const tvetydig = resolveSignal({
    signal: shortSignal(),
    candles: [bar(1, 100, 106, 88, 95)],
    costs: NO_COSTS,
  });
  assert.equal(tvetydig!.outcome, "SL");
  assert.equal(tvetydig!.ambiguousBar, true);
});

test("11. Avgifter, slippage och funding sänker r_multiple men inte brutto", () => {
  const candles = [bar(1, 100, 112, 99, 111)];
  const utan = resolveSignal({ signal: longSignal(), candles, costs: NO_COSTS })!;
  const med = resolveSignal({ signal: longSignal(), candles, costs: REAL_COSTS })!;

  assert.equal(utan.rMultipleGross, med.rMultipleGross, "brutto är kostnadsfritt per definition");
  assert.ok(med.rMultiple < utan.rMultiple);
  assert.equal(utan.feesUsd, 0);
  assert.ok(med.feesUsd > 0 && med.slippageUsd > 0);
  assert.equal(med.fundingUsd, 0, "spot betalar ingen funding");

  // Perp med 24h hålltid → 3 funding-perioder.
  const perpCandles = [1, 2, 3].map((n) => bar(n, 100, 101, 99, 100));
  const sisteBar = bar(23, 100, 112, 99, 111); // stänger strax under 24h efter signalen
  const perp = resolveSignal({
    signal: longSignal({ isPerp: true, horizonBars: 30 }),
    candles: [...perpCandles, sisteBar],
    costs: REAL_COSTS,
  })!;
  const förväntadFunding = (100 * REAL_COSTS.fundingBpsPer8h * 3) / 10_000;
  assert.ok(Math.abs(perp.fundingUsd - förväntadFunding) < 1e-9,
    `knappt 24h hålltid ska ge 3 funding-perioder, fick ${perp.fundingUsd}`);
});

test("12. MFE/MAE: toppen syns trots att utfallet blev SL", () => {
  const res = resolveSignal({
    signal: longSignal({ horizonBars: 10, takeProfit: 115 }),
    candles: [bar(1, 100, 110, 99, 109), bar(2, 109, 109, 94, 95)],
    costs: NO_COSTS,
  })!;
  assert.equal(res.outcome, "SL");
  assert.ok(res.mfe >= 9, `mfe ska spegla toppen, fick ${res.mfe}`);
  assert.ok(res.mae >= 5, `mae ska spegla botten, fick ${res.mae}`);
});

test("13. null när horisonten inte är slut än", () => {
  const res = resolveSignal({
    signal: longSignal({ horizonBars: 5 }),
    candles: [bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100)],
    costs: NO_COSTS,
  });
  assert.equal(res, null, "raden ska förbli 'open' tills horisonten är slut");
});

test("14. Geometrivalidering avvisar orimliga nivåer", () => {
  assert.equal(isGeometryValid("long", 100, 95, 110), true);
  assert.equal(isGeometryValid("long", 100, 105, 110), false, "SL på fel sida");
  assert.equal(isGeometryValid("short", 100, 105, 90), true);
  assert.equal(isGeometryValid("short", 100, 95, 90), false);
  assert.equal(isGeometryValid("long", 100, 0, 110), false);
});
