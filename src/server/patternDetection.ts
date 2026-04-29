// ═══════════════════════════════════════════════════════════════════════════
// Avancerad pattern-detection — vad agenterna ser i diagrammen
//
// Detekterar:
// - Candlestick: hammer, doji, engulfing, marubozu, shooting star, hanging man,
//   morning star, three soldiers, three crows
// - Reversal: head & shoulders, double top, double bottom
// - Continuation: flags, pennants, triangles, rectangles
// - Other: gaps, breakouts
//
// Källa: Mikes referenser (Binance Academy, Oanda, Alchemy Markets, Investtech)
// ═══════════════════════════════════════════════════════════════════════════

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type PatternType =
  // Candlestick (1-3 candles)
  | "hammer" | "inv_hammer" | "doji" | "marubozu_bull" | "marubozu_bear"
  | "bull_engulfing" | "bear_engulfing" | "shooting_star" | "hanging_man"
  | "morning_star" | "evening_star" | "three_soldiers" | "three_crows"
  // Reversal (multi-candle)
  | "head_shoulders" | "inv_head_shoulders" | "double_top" | "double_bottom"
  // Continuation
  | "bull_flag" | "bear_flag" | "ascending_triangle" | "descending_triangle"
  | "symmetrical_triangle" | "rectangle"
  // Other
  | "gap_up" | "gap_down";

export interface DetectedPattern {
  type: PatternType;
  bullish: boolean | null;
  strength: number;       // 1-5
  startIdx: number;
  endIdx: number;
  description: string;
}

const body = (k: Candle) => Math.abs(k.close - k.open);
const upperWick = (k: Candle) => k.high - Math.max(k.open, k.close);
const lowerWick = (k: Candle) => Math.min(k.open, k.close) - k.low;
const range = (k: Candle) => k.high - k.low;
const isBull = (k: Candle) => k.close > k.open;
const isBear = (k: Candle) => k.close < k.open;

// ─── 1. CANDLESTICK PATTERNS ───
function detectCandlestick(candles: Candle[]): DetectedPattern[] {
  if (candles.length < 3) return [];
  const out: DetectedPattern[] = [];
  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;
  const prev2 = candles[candles.length - 3]!;
  const lb = body(last);
  const lr = range(last);
  const idx = candles.length - 1;

  // Hammer: liten body, lower wick > 2x body, liten upper wick
  if (lb > 0 && lowerWick(last) > lb * 2 && upperWick(last) < lb * 0.5) {
    out.push({ type: "hammer", bullish: true, strength: Math.min(5, Math.round(lowerWick(last) / lb)), startIdx: idx, endIdx: idx, description: "Bullish reversal — köpare avvisade lägre priser" });
  }
  // Inverted hammer
  if (lb > 0 && upperWick(last) > lb * 2 && lowerWick(last) < lb * 0.5) {
    out.push({ type: "inv_hammer", bullish: true, strength: 3, startIdx: idx, endIdx: idx, description: "Möjlig bullish reversal" });
  }
  // Doji: body < 10% av range
  if (lr > 0 && lb / lr < 0.1) {
    out.push({ type: "doji", bullish: null, strength: 3, startIdx: idx, endIdx: idx, description: "Indecision — vänta på confirmation" });
  }
  // Marubozu: body > 90% av range, ingen wick
  if (lr > 0 && lb / lr > 0.9) {
    if (isBull(last)) {
      out.push({ type: "marubozu_bull", bullish: true, strength: 5, startIdx: idx, endIdx: idx, description: "Stark bullish momentum — inga wicks" });
    } else if (isBear(last)) {
      out.push({ type: "marubozu_bear", bullish: false, strength: 5, startIdx: idx, endIdx: idx, description: "Stark bearish momentum — inga wicks" });
    }
  }
  // Bullish engulfing
  if (isBear(prev) && isBull(last) && last.open <= prev.close && last.close >= prev.open) {
    out.push({ type: "bull_engulfing", bullish: true, strength: 4, startIdx: idx - 1, endIdx: idx, description: "Köpare tog över — full engulfing av föregående bear" });
  }
  // Bearish engulfing
  if (isBull(prev) && isBear(last) && last.open >= prev.close && last.close <= prev.open) {
    out.push({ type: "bear_engulfing", bullish: false, strength: 4, startIdx: idx - 1, endIdx: idx, description: "Säljare tog över — full engulfing av föregående bull" });
  }
  // Shooting star: liten body i botten, lång upper wick (efter uptrend)
  if (lb > 0 && upperWick(last) > lb * 2 && lowerWick(last) < lb * 0.5 && isBear(last)) {
    out.push({ type: "shooting_star", bullish: false, strength: 3, startIdx: idx, endIdx: idx, description: "Bearish reversal efter uptrend" });
  }
  // Hanging man: hammer-form efter uptrend
  if (lb > 0 && lowerWick(last) > lb * 2 && upperWick(last) < lb * 0.5 && isBear(last)) {
    out.push({ type: "hanging_man", bullish: false, strength: 3, startIdx: idx, endIdx: idx, description: "Bearish — hammer-form i topp" });
  }
  // Morning Star: bear → liten body → bull
  if (isBear(prev2) && body(prev) < body(prev2) * 0.3 && isBull(last) && last.close > (prev2.open + prev2.close) / 2) {
    out.push({ type: "morning_star", bullish: true, strength: 5, startIdx: idx - 2, endIdx: idx, description: "3-candle bottom-reversal" });
  }
  // Evening Star: bull → liten body → bear
  if (isBull(prev2) && body(prev) < body(prev2) * 0.3 && isBear(last) && last.close < (prev2.open + prev2.close) / 2) {
    out.push({ type: "evening_star", bullish: false, strength: 5, startIdx: idx - 2, endIdx: idx, description: "3-candle top-reversal" });
  }
  // Three White Soldiers
  if (isBull(prev2) && isBull(prev) && isBull(last) && last.close > prev.close && prev.close > prev2.close) {
    out.push({ type: "three_soldiers", bullish: true, strength: 5, startIdx: idx - 2, endIdx: idx, description: "3 gröna i rad — stark uptrend" });
  }
  // Three Black Crows
  if (isBear(prev2) && isBear(prev) && isBear(last) && last.close < prev.close && prev.close < prev2.close) {
    out.push({ type: "three_crows", bullish: false, strength: 5, startIdx: idx - 2, endIdx: idx, description: "3 röda i rad — stark downtrend" });
  }
  // Gap up: open > föregående high
  if (last.open > prev.high) {
    out.push({ type: "gap_up", bullish: true, strength: 3, startIdx: idx - 1, endIdx: idx, description: `Gap-up ${((last.open - prev.high) / prev.high * 100).toFixed(2)}% — stark bullish momentum` });
  }
  // Gap down: open < föregående low
  if (last.open < prev.low) {
    out.push({ type: "gap_down", bullish: false, strength: 3, startIdx: idx - 1, endIdx: idx, description: `Gap-down ${((prev.low - last.open) / prev.low * 100).toFixed(2)}% — stark bearish momentum` });
  }
  return out;
}

// ─── 2. SWING POINTS (för multi-candle patterns) ───
function findSwings(candles: Candle[], window = 3): { highs: Array<{ idx: number; price: number }>; lows: Array<{ idx: number; price: number }> } {
  const highs: Array<{ idx: number; price: number }> = [];
  const lows: Array<{ idx: number; price: number }> = [];
  for (let i = window; i < candles.length - window; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= window; j++) {
      if (candles[i - j]!.high >= candles[i]!.high) isHigh = false;
      if (candles[i + j]!.high >= candles[i]!.high) isHigh = false;
      if (candles[i - j]!.low <= candles[i]!.low) isLow = false;
      if (candles[i + j]!.low <= candles[i]!.low) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: candles[i]!.high });
    if (isLow) lows.push({ idx: i, price: candles[i]!.low });
  }
  return { highs, lows };
}

// ─── 3. DOUBLE TOP / DOUBLE BOTTOM ───
function detectDoubleTopBottom(candles: Candle[], swings: ReturnType<typeof findSwings>): DetectedPattern[] {
  const out: DetectedPattern[] = [];
  const tolerance = 0.005; // 0.5% pris-tolerans
  // Double top: två närliggande swing-highs på liknande pris
  for (let i = 1; i < swings.highs.length; i++) {
    const a = swings.highs[i - 1]!;
    const b = swings.highs[i]!;
    if (Math.abs(b.price - a.price) / a.price < tolerance && b.idx - a.idx >= 5) {
      out.push({ type: "double_top", bullish: false, strength: 4, startIdx: a.idx, endIdx: b.idx, description: `M-formation @ $${a.price.toFixed(4)} — bearish reversal` });
    }
  }
  // Double bottom: två närliggande swing-lows på liknande pris
  for (let i = 1; i < swings.lows.length; i++) {
    const a = swings.lows[i - 1]!;
    const b = swings.lows[i]!;
    if (Math.abs(b.price - a.price) / a.price < tolerance && b.idx - a.idx >= 5) {
      out.push({ type: "double_bottom", bullish: true, strength: 4, startIdx: a.idx, endIdx: b.idx, description: `W-formation @ $${a.price.toFixed(4)} — bullish reversal` });
    }
  }
  return out;
}

// ─── 4. HEAD & SHOULDERS ───
function detectHeadShoulders(candles: Candle[], swings: ReturnType<typeof findSwings>): DetectedPattern[] {
  const out: DetectedPattern[] = [];
  // Behöver 3 swing-highs där mitten är högst
  if (swings.highs.length >= 3) {
    for (let i = 2; i < swings.highs.length; i++) {
      const ls = swings.highs[i - 2]!;
      const head = swings.highs[i - 1]!;
      const rs = swings.highs[i]!;
      if (head.price > ls.price * 1.015 && head.price > rs.price * 1.015 && Math.abs(rs.price - ls.price) / ls.price < 0.02) {
        out.push({ type: "head_shoulders", bullish: false, strength: 5, startIdx: ls.idx, endIdx: rs.idx, description: `Head & Shoulders top — bearish reversal vid $${head.price.toFixed(4)}` });
      }
    }
  }
  // Inverted: 3 swing-lows där mitten är lägst
  if (swings.lows.length >= 3) {
    for (let i = 2; i < swings.lows.length; i++) {
      const ls = swings.lows[i - 2]!;
      const head = swings.lows[i - 1]!;
      const rs = swings.lows[i]!;
      if (head.price < ls.price * 0.985 && head.price < rs.price * 0.985 && Math.abs(rs.price - ls.price) / ls.price < 0.02) {
        out.push({ type: "inv_head_shoulders", bullish: true, strength: 5, startIdx: ls.idx, endIdx: rs.idx, description: `Inverted H&S — bullish reversal vid $${head.price.toFixed(4)}` });
      }
    }
  }
  return out;
}

// ─── 5. TRIANGLES & RECTANGLES (continuation) ───
function detectTriangles(candles: Candle[], swings: ReturnType<typeof findSwings>): DetectedPattern[] {
  const out: DetectedPattern[] = [];
  if (swings.highs.length < 2 || swings.lows.length < 2) return out;
  const recentHighs = swings.highs.slice(-3);
  const recentLows = swings.lows.slice(-3);
  if (recentHighs.length < 2 || recentLows.length < 2) return out;

  const highTrend = (recentHighs[recentHighs.length - 1]!.price - recentHighs[0]!.price) / recentHighs[0]!.price;
  const lowTrend = (recentLows[recentLows.length - 1]!.price - recentLows[0]!.price) / recentLows[0]!.price;
  const startIdx = Math.min(recentHighs[0]!.idx, recentLows[0]!.idx);
  const endIdx = candles.length - 1;

  // Ascending triangle: flat top, stigande bottom
  if (Math.abs(highTrend) < 0.005 && lowTrend > 0.01) {
    out.push({ type: "ascending_triangle", bullish: true, strength: 4, startIdx, endIdx, description: "Ascending triangle — bullish continuation, väntar breakout" });
  }
  // Descending triangle: fallande top, flat bottom
  else if (highTrend < -0.01 && Math.abs(lowTrend) < 0.005) {
    out.push({ type: "descending_triangle", bullish: false, strength: 4, startIdx, endIdx, description: "Descending triangle — bearish continuation" });
  }
  // Symmetrical triangle: höjdar fallande, bottnar stigande
  else if (highTrend < -0.005 && lowTrend > 0.005) {
    out.push({ type: "symmetrical_triangle", bullish: null, strength: 3, startIdx, endIdx, description: "Symmetrical triangle — väntar på breakout (riktning okänd)" });
  }
  // Rectangle: båda flat
  else if (Math.abs(highTrend) < 0.005 && Math.abs(lowTrend) < 0.005) {
    out.push({ type: "rectangle", bullish: null, strength: 3, startIdx, endIdx, description: "Rectangle — sidledes range, väntar på breakout" });
  }
  return out;
}

// ─── HUVUDFUNKTION ───
export function detectAllPatterns(candles: Candle[]): DetectedPattern[] {
  if (!candles || candles.length < 5) return [];
  const swings = findSwings(candles);
  return [
    ...detectCandlestick(candles),
    ...detectDoubleTopBottom(candles, swings),
    ...detectHeadShoulders(candles, swings),
    ...detectTriangles(candles, swings),
  ];
}
