import type { StrategyEngine, StrategySignal } from "./types.js";
import type { AlpacaBroker } from "../brokers/alpaca.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  MOTOR B: The Wheel Strategy (Optioner)
//
//  Fas 1 (Cash-Secured Puts):
//    - Sälj OTM puts (~0.30 delta, ~10% under nuvarande pris)
//    - Löptid 2-4 veckor
//    - Samla premium oavsett riktning
//    - Om assigned → vi äger aktierna (till discount!)
//
//  Fas 2 (Covered Calls):
//    - Om vi äger aktier (från assignment): sälj calls 10% över entry
//    - Samla ytterligare premium
//    - Om assigned → vi säljer med vinst
//    - Om inte assigned → behåll premium, upprepa
//
//  Regel: Stäng optionskontraktet i förtid om vi når 50% av max premium.
//
//  Kräver: Alpaca med options-godkännande aktiverat.
// ═══════════════════════════════════════════════════════════════════════════

interface WheelConfig {
  underlyings: string[];
  putDelta: number; // Mål-delta, t.ex. 0.30
  profitTargetPct: number; // 50 = stäng vid 50% vinst
  minDaysToExpiry: number;
  maxDaysToExpiry: number;
}

const DEFAULT_CONFIG: WheelConfig = {
  underlyings: ["TSLA", "NVDA"],
  putDelta: 0.3,
  profitTargetPct: 50,
  minDaysToExpiry: 14,
  maxDaysToExpiry: 35,
};

export class WheelEngine implements StrategyEngine {
  readonly name = "wheel_strategy";
  readonly description =
    "The Wheel Strategy: sälj cash-secured puts på starka underlyings → " +
    "om assigned, sälj covered calls. Genererar premium-inkomst.";

  private readonly cfg: WheelConfig;
  private readonly broker: AlpacaBroker;

  constructor(broker: AlpacaBroker, cfg?: Partial<WheelConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.broker = broker;
  }

  async scan(): Promise<StrategySignal[]> {
    log.info("[Motor B] Skannar Wheel Strategy-möjligheter…");
    const signals: StrategySignal[] = [];

    for (const underlying of this.cfg.underlyings) {
      try {
        const signal = await this.evaluateUnderlying(underlying);
        if (signal) signals.push(signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[Motor B] Kunde inte utvärdera ${underlying}: ${msg}`);
      }
    }

    return signals;
  }

  private async evaluateUnderlying(
    underlying: string,
  ): Promise<StrategySignal | null> {
    // 1. Kolla om vi redan äger aktier → Fas 2 (covered calls)
    const positions = await this.broker.getPositions();
    const stockPosition = positions.find((p) => p.symbol === underlying);

    if (stockPosition && stockPosition.quantity >= 100) {
      return this.evaluateCoveredCall(underlying, stockPosition);
    }

    // 2. Ingen position → Fas 1 (cash-secured puts)
    return this.evaluateCashSecuredPut(underlying);
  }

  private async evaluateCashSecuredPut(
    underlying: string,
  ): Promise<StrategySignal | null> {
    // Hämta aktuellt pris
    const ticker = await this.broker.getTicker(underlying);
    const currentPrice = ticker.price;

    // Beräkna strike-intervall (~10% under, ger ~0.30 delta)
    const strikeMax = Math.floor(currentPrice * 0.92);
    const strikeMin = Math.floor(currentPrice * 0.85);

    // Beräkna expiration-intervall (2-4 veckor ut)
    const now = new Date();
    const minDate = new Date(now.getTime() + this.cfg.minDaysToExpiry * 86400000);
    const maxDate = new Date(now.getTime() + this.cfg.maxDaysToExpiry * 86400000);

    // Hämta options chain
    const contracts = await this.broker.getOptionsChain(underlying, {
      optionType: "put",
      strikeGte: strikeMin,
      strikeLte: strikeMax,
      expirationDateGte: minDate.toISOString().slice(0, 10),
      expirationDateLte: maxDate.toISOString().slice(0, 10),
      limit: 20,
    });

    if (contracts.length === 0) {
      log.info(`[Motor B] Inga lämpliga put-kontrakt för ${underlying}`);
      return null;
    }

    // Hämta greeks/priser för kontrakten
    const symbols = contracts.map((c) => c.symbol);
    const snapshots = await this.broker.getOptionsSnapshots(symbols);

    // Hitta kontraktet med delta närmast vår target
    let bestContract = contracts[0]!;
    let bestSnap = snapshots.find((s) => s.symbol === bestContract.symbol);
    let bestDeltaDiff = Infinity;

    for (const contract of contracts) {
      const snap = snapshots.find((s) => s.symbol === contract.symbol);
      if (!snap?.delta) continue;
      const deltaDiff = Math.abs(Math.abs(snap.delta) - this.cfg.putDelta);
      if (deltaDiff < bestDeltaDiff) {
        bestDeltaDiff = deltaDiff;
        bestContract = contract;
        bestSnap = snap;
      }
    }

    if (!bestSnap || bestSnap.bidPrice <= 0) {
      return null;
    }

    const premium = bestSnap.bidPrice * 100; // 1 kontrakt = 100 aktier
    const maxRisk = bestContract.strikePrice * 100; // Cash-secured = max risk om assigned

    return {
      engine: this.name,
      action: "sell_put",
      symbol: bestContract.symbol,
      reasoning:
        `Wheel Fas 1: Sälj Cash-Secured Put på ${underlying}. ` +
        `Strike: $${bestContract.strikePrice} (${((1 - bestContract.strikePrice / currentPrice) * 100).toFixed(1)}% OTM), ` +
        `Expiration: ${bestContract.expirationDate}, ` +
        `Bid: $${bestSnap.bidPrice.toFixed(2)} (premium ≈ $${premium.toFixed(0)}), ` +
        `Delta: ${bestSnap.delta?.toFixed(3) ?? "?"}, ` +
        `Max cash needed: $${maxRisk.toFixed(0)}. ` +
        `Om assigned köper vi ${underlying} till $${bestContract.strikePrice} — ` +
        `en ${((1 - bestContract.strikePrice / currentPrice) * 100).toFixed(1)}% discount.`,
      confidence: bestDeltaDiff < 0.05 ? "high" : "medium",
      suggestedSizeUsd: maxRisk,
      metadata: {
        underlying,
        contractSymbol: bestContract.symbol,
        strikePrice: bestContract.strikePrice,
        expiration: bestContract.expirationDate,
        delta: bestSnap.delta,
        bidPrice: bestSnap.bidPrice,
        premium,
        currentPrice,
      },
    };
  }

  private async evaluateCoveredCall(
    underlying: string,
    position: { avgEntryPrice: number; quantity: number; currentPrice: number },
  ): Promise<StrategySignal | null> {
    // Vi äger aktier → sälj calls 10% över entry
    const targetStrike = Math.ceil(position.avgEntryPrice * 1.10);

    const now = new Date();
    const minDate = new Date(now.getTime() + this.cfg.minDaysToExpiry * 86400000);
    const maxDate = new Date(now.getTime() + this.cfg.maxDaysToExpiry * 86400000);

    const contracts = await this.broker.getOptionsChain(underlying, {
      optionType: "call",
      strikeGte: targetStrike,
      strikeLte: Math.ceil(position.avgEntryPrice * 1.20),
      expirationDateGte: minDate.toISOString().slice(0, 10),
      expirationDateLte: maxDate.toISOString().slice(0, 10),
      limit: 20,
    });

    if (contracts.length === 0) return null;

    const symbols = contracts.map((c) => c.symbol);
    const snapshots = await this.broker.getOptionsSnapshots(symbols);

    // Välj kontraktet med bäst premium (högst bid)
    let bestContract = contracts[0]!;
    let bestSnap = snapshots.find((s) => s.symbol === bestContract.symbol);

    for (const contract of contracts) {
      const snap = snapshots.find((s) => s.symbol === contract.symbol);
      if (!snap) continue;
      if (!bestSnap || snap.bidPrice > bestSnap.bidPrice) {
        bestContract = contract;
        bestSnap = snap;
      }
    }

    if (!bestSnap || bestSnap.bidPrice <= 0) return null;

    const numContracts = Math.floor(position.quantity / 100);
    if (numContracts <= 0) return null;

    const totalPremium = bestSnap.bidPrice * 100 * numContracts;

    return {
      engine: this.name,
      action: "sell_call",
      symbol: bestContract.symbol,
      reasoning:
        `Wheel Fas 2: Sälj Covered Call på ${underlying}. ` +
        `Vi äger ${position.quantity} aktier (entry $${position.avgEntryPrice.toFixed(2)}). ` +
        `Strike: $${bestContract.strikePrice} (+${((bestContract.strikePrice / position.avgEntryPrice - 1) * 100).toFixed(1)}% över entry), ` +
        `Expiration: ${bestContract.expirationDate}, ` +
        `Bid: $${bestSnap.bidPrice.toFixed(2)} x ${numContracts} kontrakt = $${totalPremium.toFixed(0)} premium. ` +
        `Om called säljer vi till $${bestContract.strikePrice} med vinst.`,
      confidence: "high",
      suggestedSizeUsd: totalPremium,
      metadata: {
        underlying,
        contractSymbol: bestContract.symbol,
        strikePrice: bestContract.strikePrice,
        expiration: bestContract.expirationDate,
        numContracts,
        bidPrice: bestSnap.bidPrice,
        totalPremium,
        entryPrice: position.avgEntryPrice,
      },
    };
  }
}
