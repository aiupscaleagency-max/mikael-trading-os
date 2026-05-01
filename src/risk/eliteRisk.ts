// ═══════════════════════════════════════════════════════════════════════════
// Elite Risk Module — dynamisk position-sizing + ATR-baserad SL/TP
//
// Filosofi:
//  - Position-storlek = % av equity (ej fixt $-belopp). Default 2% (Kelly-lite).
//  - SL = max(2 × ATR, 1.5% av entry). TP = 3 × SL-distance (R:R 3:1).
//  - Slippage-cap: avbryt order om förväntad slippage > 25 bps.
//  - Daglig loss-cap: pausar trading vid X% drawdown.
//  - LIVE har hårda golv: max-stake-cap respekteras alltid.
// ═══════════════════════════════════════════════════════════════════════════

export interface PositionSizeInput {
  equityUsd: number;        // total kontoekvivalent i USD
  cashUsd: number;          // tillgängligt cash (USDT/USDC)
  riskPctOfEquity?: number; // default 2% per trade
  minNotionalUsd: number;   // Binance MIN_NOTIONAL för symbolen
  maxStakeUsd?: number;     // hård cap (LIVE = $5 default)
  atrPct?: number;          // ATR/price * 100, om känd → sänker storlek vid hög vol
  conviction?: number;      // 0–1, agentens conviction (default 0.5)
}

export interface PositionSizeResult {
  sizeUsd: number;
  reason: string;
  blocked: boolean;
}

export function computePositionSize(input: PositionSizeInput): PositionSizeResult {
  const riskPct = input.riskPctOfEquity ?? 2;
  const conviction = clamp(input.conviction ?? 0.5, 0.1, 1.0);
  const atrPct = input.atrPct ?? 1.5;

  if (input.equityUsd <= 0 || input.cashUsd <= 0) {
    return { sizeUsd: 0, blocked: true, reason: "Inget cash tillgängligt" };
  }

  // Bas: % av equity, justerat för conviction (0.5 = neutral)
  let size = (input.equityUsd * riskPct / 100) * (0.5 + conviction);

  // Vol-justering: dämpa storlek vid hög ATR (>3% = halva storleken)
  const volMultiplier = clamp(1.5 / Math.max(0.5, atrPct), 0.4, 1.5);
  size *= volMultiplier;

  // Hård cap (LIVE-säkerhetslås)
  if (input.maxStakeUsd && size > input.maxStakeUsd) size = input.maxStakeUsd;

  // Cash-tak: kan inte handla mer än vi har
  if (size > input.cashUsd) size = input.cashUsd;

  // Min-notional (Binance avvisar annars)
  if (size < input.minNotionalUsd) {
    if (input.cashUsd >= input.minNotionalUsd && (!input.maxStakeUsd || input.maxStakeUsd >= input.minNotionalUsd)) {
      size = input.minNotionalUsd;
    } else {
      return { sizeUsd: 0, blocked: true, reason: `Position $${size.toFixed(2)} < min_notional $${input.minNotionalUsd}` };
    }
  }

  return {
    sizeUsd: round2(size),
    blocked: false,
    reason: `${riskPct}% av equity · conviction ${(conviction * 100).toFixed(0)}% · vol-mult ${volMultiplier.toFixed(2)}`,
  };
}

export interface RiskValidationInput {
  sizeUsd: number;
  slippageBps: number;
  maxSlippageBps?: number;  // default 25 bps
  liveDailyLossUsd?: number;
  maxLiveDailyLossUsd?: number;
  isLive: boolean;
}

export interface RiskValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateOrderRisk(input: RiskValidationInput): RiskValidationResult {
  const maxSlip = input.maxSlippageBps ?? 25;
  if (input.slippageBps > maxSlip) {
    return { ok: false, reason: `Slippage ${input.slippageBps.toFixed(0)} bps > cap ${maxSlip} bps — orderbok för tunn` };
  }
  if (input.isLive && input.maxLiveDailyLossUsd && input.liveDailyLossUsd !== undefined) {
    if (input.liveDailyLossUsd >= input.maxLiveDailyLossUsd) {
      return { ok: false, reason: `Daglig loss-cap nådd ($${input.liveDailyLossUsd.toFixed(2)}/$${input.maxLiveDailyLossUsd}) — paus till midnatt UTC` };
    }
  }
  if (input.sizeUsd <= 0) {
    return { ok: false, reason: "Order-storlek 0 efter risk-kalk" };
  }
  return { ok: true };
}

// ATR-baserad SL/TP — Wilder-style. Returnerar pris-nivåer.
export function computeStopLossTakeProfit(
  entry: number,
  atr: number,
  side: "BUY" | "SELL",
  rrRatio = 3,
  minSlPct = 1.5,
): { stopLoss: number; takeProfit: number; riskPct: number; rewardPct: number } {
  // SL = max(2 × ATR, minSlPct% av entry)
  const slDistance = Math.max(2 * atr, entry * (minSlPct / 100));
  const tpDistance = slDistance * rrRatio;
  const stopLoss = side === "BUY" ? entry - slDistance : entry + slDistance;
  const takeProfit = side === "BUY" ? entry + tpDistance : entry - tpDistance;
  return {
    stopLoss: round2Smart(stopLoss),
    takeProfit: round2Smart(takeProfit),
    riskPct: (slDistance / entry) * 100,
    rewardPct: (tpDistance / entry) * 100,
  };
}

// Trailing stop: höjer SL när priset rör sig i vår favör.
// Returnerar nytt SL-pris (>=originalSL för BUY, <=originalSL för SELL).
export function trailingStop(
  currentPrice: number,
  currentSL: number,
  side: "BUY" | "SELL",
  trailPct = 2,
): number {
  if (side === "BUY") {
    const trail = currentPrice * (1 - trailPct / 100);
    return Math.max(currentSL, trail);
  }
  const trail = currentPrice * (1 + trailPct / 100);
  return Math.min(currentSL, trail);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// "Smart" rounding: 2 decimaler för stora pris (>$100), 6 för små (<$1)
function round2Smart(n: number): number {
  if (n >= 1000) return Math.round(n * 100) / 100;
  if (n >= 1) return Math.round(n * 10000) / 10000;
  return Math.round(n * 100000000) / 100000000;
}
