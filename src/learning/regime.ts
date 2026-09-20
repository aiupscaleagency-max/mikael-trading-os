import { ema, atr } from "../indicators/ta.js";
import type { Kline } from "../types.js";
import type { Regime } from "./schema.js";

// ═══════════════════════════════════════════════════════════════════════════
//  REGIM-HÄRLEDNING — ren funktion, inga modeller, ingen I/O.
//
//  Regimen är statistikens andra axel (vid sidan av setup_type). Den måste
//  därför vara HÄRLEDD UR DATA och reproducerbar. Makro-analytikerns
//  `regime` (risk_on/risk_off/…) är en modellåsikt och sparas separat i
//  features_snapshot.macroRegime — den får aldrig bli den här axeln.
//
//  Trösklarna är exporterade så Fas 3 kan kalibrera dem mot faktiskt utfall.
//  ÄNDRAS de måste REGIME_VERSION bumpas, annars blandas två regim-
//  definitioner i samma statistik.
// ═══════════════════════════════════════════════════════════════════════════

export const REGIME_VERSION = "regime-v1";

/** Volatilitetsexpansion: ATR% över detta gånger sin egen median → high_vol. */
export const HIGH_VOL_MULTIPLIER = 2.0;
/** EMA20 vs EMA50 måste skilja mer än så här (andel) för att kallas trend. */
export const TREND_SPREAD_THRESHOLD = 0.01;
/** Antal barer som ATR%-medianen beräknas över. */
export const VOL_LOOKBACK_BARS = 50;
/** Färre barer än så här → vi vägrar gissa. */
export const MIN_BARS = 60;

export interface RegimeResult {
  regime: Regime;
  /** Mellanleden sparas i features_snapshot så ett utfall går att granska i efterhand. */
  inputs: {
    atrPct: number | null;
    atrPctMedian: number | null;
    emaSpread: number | null;
    close: number | null;
    bars: number;
    version: string;
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Härleder marknadsregimen ur candles.
 *
 * Ordningen är medveten: volatilitetsregimen prövas FÖRE trendregimen,
 * eftersom det är volatilitetsexpansionen som spränger stops. En brant
 * uppgång med exploderande ATR är farligare att handla än en lugn trend,
 * och ska inte etiketteras som samma sak.
 */
export function deriveRegime(klines: Kline[]): RegimeResult {
  const bars = klines.length;
  const unknown: RegimeResult = {
    regime: "unknown",
    inputs: { atrPct: null, atrPctMedian: null, emaSpread: null, close: null, bars, version: REGIME_VERSION },
  };
  if (bars < MIN_BARS) return unknown;

  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const closes = klines.map((k) => k.close);
  const close = closes[closes.length - 1]!;
  if (!Number.isFinite(close) || close <= 0) return unknown;

  // ── 1. Volatilitetsregim ──
  const atrNow = atr(highs, lows, closes, 14);
  if (atrNow === null) return unknown;
  const atrPct = atrNow / close;

  // ATR% historiskt: räkna om ATR på varje delfönster inom lookbacken.
  const atrPctHistory: number[] = [];
  const start = Math.max(15, bars - VOL_LOOKBACK_BARS);
  for (let i = start; i < bars; i++) {
    const a = atr(highs.slice(0, i + 1), lows.slice(0, i + 1), closes.slice(0, i + 1), 14);
    const c = closes[i]!;
    if (a !== null && c > 0) atrPctHistory.push(a / c);
  }
  const atrPctMedian = median(atrPctHistory);

  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const emaSpread = e20 !== null && e50 !== null && e50 !== 0 ? (e20 - e50) / e50 : null;
  const inputs = { atrPct, atrPctMedian, emaSpread, close, bars, version: REGIME_VERSION };

  if (atrPctMedian !== null && atrPctMedian > 0 && atrPct > HIGH_VOL_MULTIPLIER * atrPctMedian) {
    return { regime: "high_vol", inputs };
  }

  // ── 2. Trendregim ──
  if (emaSpread === null || e50 === null) return { regime: "unknown", inputs };
  if (emaSpread > TREND_SPREAD_THRESHOLD && close > e50) return { regime: "trend_up", inputs };
  if (emaSpread < -TREND_SPREAD_THRESHOLD && close < e50) return { regime: "trend_down", inputs };

  // ── 3. Allt annat ──
  return { regime: "range", inputs };
}
