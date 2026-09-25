import { computeIndicators } from "../indicators/ta.js";
import { subscribeClosedCandles, getClosedCandles, msUntilClose, type Candle } from "./klineStream.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Signal-motor — gör indikatorer till LONG/SHORT-förslag
//
// Räknar ENDAST på stängda ljus. Ett ohalvfärdigt ljus ändrar värden flera
// gånger per sekund, och en signal som bygger på det uppstår och försvinner
// inom samma ljus.
//
// Varje signal MÅSTE ha en stop-loss. Saknas den förkastas signalen i stället
// för att skickas vidare utan skydd. Stoppen räknas ur ATR, så den anpassar
// sig till hur mycket paret faktiskt rör sig — en fast procentsats är för
// snäv i hög volatilitet och för vid i låg.
//
// Motorn LÄGGER INGA ORDRAR. Den producerar förslag med skäl. Beslutet, och
// knapptryckningen, är Mikes.
// ═══════════════════════════════════════════════════════════════════════════

export type Direction = "LONG" | "SHORT" | "NEUTRAL";

export interface Signal {
  symbol: string;
  interval: string;
  direction: Direction;
  /** -100 (starkt short) … +100 (starkt long). Summan av delskälen. */
  score: number;
  entry: number;
  stopLoss: number;
  target: number;
  /** Risk/reward. Under MIN_RISK_REWARD förkastas signalen. */
  riskReward: number;
  /** Avstånd till stop i procent — visar hur mycket som riskeras per enhet. */
  riskPct: number;
  reasons: string[];
  indicators: ReturnType<typeof computeIndicators>;
  candleCloseTime: number;
  /** Millisekunder kvar till nästa ljusstängning. Nedräkningen i gränssnittet. */
  msUntilNextClose: number | null;
  generatedAt: number;
}

/** Under detta förhållande är trejden inte värd risken. */
const MIN_RISK_REWARD = 1.5;
/** Hur många ATR stoppen läggs ifrån entry. */
const ATR_STOP_MULTIPLIER = 1.5;
/** Hur många ATR targeten läggs ifrån entry. Ger R:R = 3.0 / 1.5 = 2.0. */
const ATR_TARGET_MULTIPLIER = 3.0;
/** Under detta |score| är signalen för svag för att visa som actionable. */
const MIN_SCORE = 30;

const latest = new Map<string, Signal>();
const subscribers = new Set<(s: Signal) => void>();

function key(symbol: string, interval: string): string {
  return `${symbol}:${interval}`;
}

/**
 * Väger ihop indikatorerna till ett score.
 *
 * Varje delskäl bidrar med poäng och en förklaring på svenska. Summan blir
 * riktningen. Poängen är medvetet enkla och läsbara — en svart låda går inte
 * att felsöka när den har fel, och den går inte att lita på när den har rätt.
 */
function scoreIndicators(ind: ReturnType<typeof computeIndicators>): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // Trend: pris mot glidande medelvärden
  if (ind.sma20 !== null && ind.sma50 !== null) {
    if (ind.sma20 > ind.sma50) {
      score += 25;
      reasons.push(`SMA20 över SMA50 — stigande trend (+25)`);
    } else if (ind.sma20 < ind.sma50) {
      score -= 25;
      reasons.push(`SMA20 under SMA50 — fallande trend (−25)`);
    }
  }

  if (ind.ema20 !== null && ind.lastClose > 0) {
    if (ind.lastClose > ind.ema20) {
      score += 15;
      reasons.push(`Pris över EMA20 (+15)`);
    } else {
      score -= 15;
      reasons.push(`Pris under EMA20 (−15)`);
    }
  }

  // Momentum: MACD-histogram
  if (ind.macd?.histogram != null) {
    if (ind.macd.histogram > 0) {
      score += 20;
      reasons.push(`MACD-histogram positivt — momentum uppåt (+20)`);
    } else if (ind.macd.histogram < 0) {
      score -= 20;
      reasons.push(`MACD-histogram negativt — momentum nedåt (−20)`);
    }
  }

  // RSI: överköpt/översålt drar ÅT MOTSATT håll — extremer är varningar,
  // inte bekräftelser.
  if (ind.rsi14 !== null) {
    if (ind.rsi14 > 70) {
      score -= 20;
      reasons.push(`RSI ${ind.rsi14.toFixed(1)} — överköpt, risk för rekyl (−20)`);
    } else if (ind.rsi14 < 30) {
      score += 20;
      reasons.push(`RSI ${ind.rsi14.toFixed(1)} — översålt, studsläge (+20)`);
    } else if (ind.rsi14 > 55) {
      score += 10;
      reasons.push(`RSI ${ind.rsi14.toFixed(1)} — styrka utan överköp (+10)`);
    } else if (ind.rsi14 < 45) {
      score -= 10;
      reasons.push(`RSI ${ind.rsi14.toFixed(1)} — svaghet utan översålt (−10)`);
    }
  }

  return { score: Math.max(-100, Math.min(100, score)), reasons };
}

/** Bygger en signal, eller null om den inte går att skydda med en stop. */
export function buildSignal(symbol: string, interval: string, candles: Candle[]): Signal | null {
  if (candles.length < 50) return null; // för lite historik för SMA50

  const ind = computeIndicators(candles);
  const { score, reasons } = scoreIndicators(ind);
  const entry = ind.lastClose;

  // Utan ATR går ingen vettig stop att räkna — och utan stop skickas ingen
  // signal. Det är regeln, inte en rekommendation.
  if (!ind.atr14 || ind.atr14 <= 0 || entry <= 0) {
    log.warn(`[signal] ${symbol}: ingen ATR — signal förkastad (stop-loss kan inte beräknas)`);
    return null;
  }

  const direction: Direction = score >= MIN_SCORE ? "LONG" : score <= -MIN_SCORE ? "SHORT" : "NEUTRAL";

  const stopDistance = ind.atr14 * ATR_STOP_MULTIPLIER;
  const targetDistance = ind.atr14 * ATR_TARGET_MULTIPLIER;

  const stopLoss = direction === "SHORT" ? entry + stopDistance : entry - stopDistance;
  const target = direction === "SHORT" ? entry - targetDistance : entry + targetDistance;

  const riskReward = targetDistance / stopDistance;
  const riskPct = (stopDistance / entry) * 100;

  if (direction !== "NEUTRAL" && riskReward < MIN_RISK_REWARD) {
    log.info(`[signal] ${symbol}: R:R ${riskReward.toFixed(2)} under ${MIN_RISK_REWARD} — förkastad`);
    return null;
  }

  return {
    symbol, interval, direction, score,
    entry, stopLoss, target, riskReward, riskPct,
    reasons,
    indicators: ind,
    candleCloseTime: candles[candles.length - 1]!.closeTime,
    msUntilNextClose: msUntilClose(symbol, interval),
    generatedAt: Date.now(),
  };
}

/** Startar motorn. Räknar om vid varje stängt ljus. */
export function startSignalEngine(): () => void {
  log.info("[signal] motorn startad — räknar vid varje ljusstängning");
  return subscribeClosedCandles((symbol, interval, _candle, history) => {
    const signal = buildSignal(symbol, interval, history);
    if (!signal) return;
    latest.set(key(symbol, interval), signal);
    for (const cb of subscribers) {
      try { cb(signal); } catch (err) {
        log.warn(`[signal] subscriber kastade: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

/** Prenumerera på nya signaler — används av Telegram-utskicket. */
export function subscribeSignals(cb: (s: Signal) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Senaste signalen per par, med färsk nedräkning. */
export function getSignals(): Signal[] {
  return Array.from(latest.values()).map((s) => ({
    ...s,
    msUntilNextClose: msUntilClose(s.symbol, s.interval),
  }));
}

/** Räknar om direkt ur bufferten — för när gränssnittet laddas mitt i ett ljus. */
export function refreshSignal(symbol: string, interval: string): Signal | null {
  const s = buildSignal(symbol, interval, getClosedCandles(symbol, interval));
  if (s) latest.set(key(symbol, interval), s);
  return s;
}
