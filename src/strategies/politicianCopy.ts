import type { StrategyEngine, StrategySignal } from "./types.js";
import {
  getRecentPoliticianTrades,
  filterTopPerformers,
  filterPurchasesOnly,
} from "../data/capitol.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  MOTOR A: Politician Copy Trading
//
//  Logik:
//  1. Hämta senaste politician-transaktioner
//  2. Filtrera till top performers (Pelosi, McCaul, etc.)
//  3. Filtrera till bara köp (purchases)
//  4. Returnera som signaler — agenten/risk managern bestämmer execution
//
//  OBS: STOCK Act disclosure delay = 1-45 dagar. Vi handlar på fördröjd data.
//  Edge existerar historiskt men minskar ju mer uppmärksamhet det får.
// ═══════════════════════════════════════════════════════════════════════════

interface PoliticianCopyConfig {
  /** Max antal dagar sedan trade-datum att fortfarande betrakta som "aktuell" */
  maxAgeDays: number;
  /** Min belopp-range att bry sig om (filtrerar bort $1k-trades) */
  minAmountFilter: string;
  /** Vilka symboler som är tillåtna (om tom = alla) */
  allowedSymbols: string[];
}

const DEFAULT_CONFIG: PoliticianCopyConfig = {
  maxAgeDays: 30,
  minAmountFilter: "$15,001",
  allowedSymbols: [],
};

export class PoliticianCopyEngine implements StrategyEngine {
  readonly name = "politician_copy";
  readonly description =
    "Spårar US Congress-medlemmars aktieköp och genererar copy-trade-signaler. " +
    "Fokuserar på högpresterande politiker (Pelosi, McCaul m.fl.) och filtrerar " +
    "bort småbelopp.";

  private readonly cfg: PoliticianCopyConfig;

  constructor(cfg?: Partial<PoliticianCopyConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  async scan(): Promise<StrategySignal[]> {
    log.info("[Motor A] Skannar politiker-trades…");

    const allTrades = await getRecentPoliticianTrades(50);
    if (allTrades.length === 0) {
      log.warn("[Motor A] Kunde inte hämta politician-data. Skippar.");
      return [];
    }

    // Filtrera till top performers + bara köp
    let trades = filterTopPerformers(allTrades);
    trades = filterPurchasesOnly(trades);

    // Filtrera på ålder
    trades = trades.filter((t) => t.daysSinceTraded <= this.cfg.maxAgeDays);

    // Filtrera på belopp (grov: kolla att beloppet inte bara är $1,001 - $15,000)
    trades = trades.filter((t) => {
      const low = this.cfg.minAmountFilter;
      // Om min-filter är "$15,001" filtrera bort allt under det
      if (low === "$15,001") {
        return !t.amountRange.includes("$1,001 -");
      }
      return true;
    });

    // Filtrera på tillåtna symboler om satt
    if (this.cfg.allowedSymbols.length > 0) {
      trades = trades.filter((t) =>
        this.cfg.allowedSymbols.includes(t.ticker),
      );
    }

    log.info(`[Motor A] ${trades.length} kvalificerade politician-trades hittade.`);

    return trades.map((t) => ({
      engine: this.name,
      action: "buy" as const,
      symbol: t.ticker,
      reasoning:
        `${t.politician} (${t.party}, ${t.chamber}) köpte ${t.ticker} ` +
        `för ${t.amountRange} den ${t.tradedAt} ` +
        `(disclosed ${t.disclosedAt}, ${t.daysSinceTraded} dagar sedan). ` +
        `Källa: ${t.source}`,
      confidence: t.daysSinceTraded <= 7 ? "high" as const : "medium" as const,
      metadata: {
        politician: t.politician,
        party: t.party,
        amountRange: t.amountRange,
        daysSinceTraded: t.daysSinceTraded,
      },
    }));
  }
}
