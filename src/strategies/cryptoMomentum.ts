import type { StrategyEngine, StrategySignal } from "./types.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { computeIndicators } from "../indicators/ta.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  MOTOR C: Krypto Momentum
//
//  Övervakar BTC/USDT (och andra krypto-par) på 4h-intervall.
//  Vid tydlig trenduppgång → signalerar lång position med leverage.
//
//  Entry-regler (alla måste gälla):
//    1. SMA20 > SMA50 (trend är uppåt)
//    2. RSI14 mellan 40-70 (inte översålt, inte överköpt)
//    3. MACD histogram > 0 och stigande (momentum positivt)
//    4. Volym senaste 4h > genomsnittsvolym (bekräftar intresse)
//
//  Exit-regler:
//    - Trailing stop-loss: 2% (config)
//    - Take-profit-stege: 5%, 10%, 20% (ta hem 1/3 vid varje steg)
//    - Hård SL: 3% under entry
//
//  Kräver: Blofin eller Binance med futures/margin.
// ═══════════════════════════════════════════════════════════════════════════

interface CryptoMomentumConfig {
  symbols: string[];
  interval: string;
  leverage: number;
  trailingStopPct: number;
  takeProfitSteps: number[];
}

const DEFAULT_CONFIG: CryptoMomentumConfig = {
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  interval: "4h",
  leverage: 5,
  trailingStopPct: 2,
  takeProfitSteps: [5, 10, 20],
};

export class CryptoMomentumEngine implements StrategyEngine {
  readonly name = "crypto_momentum";
  readonly description =
    "Momentum-trading på krypto med leverage. Analyserar trend (SMA), " +
    "momentum (RSI, MACD) och volym på 4h-intervall. Trailing stop + " +
    "take-profit-stege.";

  private readonly cfg: CryptoMomentumConfig;
  private readonly broker: BrokerAdapter;

  constructor(broker: BrokerAdapter, cfg?: Partial<CryptoMomentumConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.broker = broker;
  }

  // Cooldown vid IP-ban — pausa skanning i 10 min efter 418/429
  private static cooldownUntil = 0;

  async scan(): Promise<StrategySignal[]> {
    if (Date.now() < CryptoMomentumEngine.cooldownUntil) {
      const sec = Math.ceil((CryptoMomentumEngine.cooldownUntil - Date.now()) / 1000);
      log.info(`[Motor C] I cooldown ${sec}s pga rate-limit. Skippar.`);
      return [];
    }
    log.info("[Motor C] Skannar krypto-momentum…");
    const signals: StrategySignal[] = [];

    for (const symbol of this.cfg.symbols) {
      try {
        const signal = await this.evaluateSymbol(symbol);
        if (signal) signals.push(signal);
        // Liten paus mellan symbols så vi inte burst:ar API-weight
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[Motor C] Kunde inte analysera ${symbol}: ${msg}`);
        // Trigga 10-min cooldown om vi får ban-status
        if (msg.includes("418") || msg.includes("429") || msg.includes("IP banned")) {
          CryptoMomentumEngine.cooldownUntil = Date.now() + 10 * 60 * 1000;
          log.warn(`[Motor C] IP-ban upptäckt — pausar skanning i 10 min`);
          break;
        }
      }
    }

    return signals;
  }

  private async evaluateSymbol(symbol: string): Promise<StrategySignal | null> {
    // Hämta klines
    const klines = await this.broker.getKlines(symbol, this.cfg.interval, 100);
    if (klines.length < 50) {
      log.info(`[Motor C] För lite data för ${symbol} (${klines.length} candles)`);
      return null;
    }

    const indicators = computeIndicators(klines);
    const ticker = await this.broker.getTicker(symbol);
    const currentPrice = ticker.price;

    // Kolla om vi redan har en position — om så, utvärdera exit
    const positions = await this.broker.getPositions();
    const existing = positions.find((p) => p.symbol === symbol || p.symbol === symbol.replace("USDT", "-USDT"));

    if (existing && existing.quantity > 0) {
      return this.evaluateExit(symbol, existing, indicators, currentPrice);
    }

    // Entry-analys
    return this.evaluateEntry(symbol, indicators, currentPrice, klines);
  }

  private evaluateEntry(
    symbol: string,
    ind: ReturnType<typeof computeIndicators>,
    currentPrice: number,
    klines: { close: number; volume: number }[],
  ): StrategySignal | null {
    const reasons: string[] = [];
    let score = 0;

    // 1. Trend: SMA20 > SMA50
    if (ind.sma20 !== null && ind.sma50 !== null) {
      if (ind.sma20 > ind.sma50) {
        reasons.push(`SMA20 (${ind.sma20.toFixed(1)}) > SMA50 (${ind.sma50.toFixed(1)}) ✓ trend upp`);
        score += 2;
      } else {
        reasons.push(`SMA20 < SMA50 ✗ trend ner`);
        score -= 2;
      }
    }

    // 2. RSI mellan 40-70
    if (ind.rsi14 !== null) {
      if (ind.rsi14 >= 40 && ind.rsi14 <= 70) {
        reasons.push(`RSI14 = ${ind.rsi14.toFixed(1)} ✓ sund zon`);
        score += 1;
      } else if (ind.rsi14 > 70) {
        reasons.push(`RSI14 = ${ind.rsi14.toFixed(1)} ✗ överköpt`);
        score -= 1;
      } else {
        reasons.push(`RSI14 = ${ind.rsi14.toFixed(1)} — översålt, avvaktar`);
        score -= 1;
      }
    }

    // 3. MACD histogram positivt
    if (ind.macd !== null) {
      if (ind.macd.histogram > 0) {
        reasons.push(`MACD histogram = ${ind.macd.histogram.toFixed(2)} ✓ momentum positivt`);
        score += 1;
      } else {
        reasons.push(`MACD histogram = ${ind.macd.histogram.toFixed(2)} ✗ momentum negativt`);
        score -= 1;
      }
    }

    // 4. Pris över EMA20
    if (ind.ema20 !== null) {
      if (currentPrice > ind.ema20) {
        reasons.push(`Pris (${currentPrice.toFixed(1)}) > EMA20 (${ind.ema20.toFixed(1)}) ✓`);
        score += 1;
      } else {
        reasons.push(`Pris < EMA20 ✗`);
        score -= 1;
      }
    }

    // 5. Volym-bekräftelse: senaste candle vs 20-period genomsnitt
    if (klines.length >= 20) {
      const recentVol = klines[klines.length - 1]!.volume;
      const avgVol =
        klines.slice(-20).reduce((sum, k) => sum + k.volume, 0) / 20;
      if (recentVol > avgVol * 1.2) {
        reasons.push(`Volym ${((recentVol / avgVol) * 100).toFixed(0)}% av snitt ✓ bekräftad`);
        score += 1;
      } else {
        reasons.push(`Volym under snitt — svag bekräftelse`);
      }
    }

    // Beslut: score >= 4 = stark entry
    if (score >= 4) {
      const atr = ind.atr14 ?? currentPrice * 0.02;
      const slPrice = currentPrice - atr * 1.5;
      const tpLevels = this.cfg.takeProfitSteps.map(
        (pct) => currentPrice * (1 + pct / 100),
      );

      return {
        engine: this.name,
        action: "buy",
        symbol,
        reasoning:
          `Momentum-entry ${symbol} (${this.cfg.interval}, ${this.cfg.leverage}x leverage):\n` +
          reasons.join("\n") +
          `\nScore: ${score}/6. ` +
          `Stop-loss: $${slPrice.toFixed(2)} (${((1 - slPrice / currentPrice) * 100).toFixed(1)}% ner). ` +
          `TP-stege: $${tpLevels.map((p) => p.toFixed(0)).join(" → $")}. ` +
          `Trailing stop: ${this.cfg.trailingStopPct}%.`,
        confidence: score >= 5 ? "high" : "medium",
        suggestedSizeUsd: undefined, // Risk managern bestämmer
        metadata: {
          score,
          leverage: this.cfg.leverage,
          stopLoss: slPrice,
          takeProfitLevels: tpLevels,
          trailingStopPct: this.cfg.trailingStopPct,
          indicators: {
            sma20: ind.sma20,
            sma50: ind.sma50,
            rsi14: ind.rsi14,
            macd: ind.macd,
            atr14: ind.atr14,
          },
        },
      };
    }

    // Score < 4 = hold (logga varför)
    log.info(
      `[Motor C] ${symbol} score=${score}/6 → HOLD. ${reasons.slice(0, 3).join("; ")}`,
    );
    return null;
  }

  private evaluateExit(
    symbol: string,
    position: { avgEntryPrice: number; quantity: number; currentPrice: number },
    ind: ReturnType<typeof computeIndicators>,
    currentPrice: number,
  ): StrategySignal | null {
    const entry = position.avgEntryPrice;
    const pnlPct = ((currentPrice - entry) / entry) * 100;

    // Hård stop-loss: 3% under entry
    if (pnlPct <= -3) {
      return {
        engine: this.name,
        action: "sell",
        symbol,
        reasoning:
          `Hård stop-loss på ${symbol}! Pris ${currentPrice.toFixed(2)} = ` +
          `${pnlPct.toFixed(1)}% under entry (${entry.toFixed(2)}). Stäng positionen.`,
        confidence: "high",
        metadata: { pnlPct, trigger: "hard_stop" },
      };
    }

    // Trend-reversal: SMA20 kryssar under SMA50
    if (ind.sma20 !== null && ind.sma50 !== null && ind.sma20 < ind.sma50) {
      return {
        engine: this.name,
        action: "sell",
        symbol,
        reasoning:
          `Trend-reversal på ${symbol}: SMA20 (${ind.sma20.toFixed(1)}) < SMA50 (${ind.sma50.toFixed(1)}). ` +
          `Pris: ${currentPrice.toFixed(2)}, PnL: ${pnlPct.toFixed(1)}%. Stäng.`,
        confidence: "medium",
        metadata: { pnlPct, trigger: "trend_reversal" },
      };
    }

    // RSI > 80 + positiv PnL = ta hem vinst
    if (ind.rsi14 !== null && ind.rsi14 > 80 && pnlPct > 5) {
      return {
        engine: this.name,
        action: "sell",
        symbol,
        reasoning:
          `Överköpt + i vinst på ${symbol}: RSI14=${ind.rsi14.toFixed(1)}, ` +
          `PnL=${pnlPct.toFixed(1)}%. Ta hem vinst.`,
        confidence: "medium",
        metadata: { pnlPct, trigger: "overbought_profit" },
      };
    }

    // Take-profit-stege: kolla om vi passerat första steget
    if (pnlPct >= this.cfg.takeProfitSteps[0]!) {
      const passedSteps = this.cfg.takeProfitSteps.filter((s) => pnlPct >= s);
      const highestStep = passedSteps[passedSteps.length - 1]!;
      log.info(
        `[Motor C] ${symbol} har passerat TP-steg ${highestStep}% (PnL: ${pnlPct.toFixed(1)}%)`,
      );
      // Agenten (Claude) bestämmer om partial close; vi signalerar hold med info
    }

    return null;
  }
}
