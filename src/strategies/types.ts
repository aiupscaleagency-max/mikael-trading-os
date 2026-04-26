// ═══════════════════════════════════════════════════════════════════════════
//  Strategy Engine Interface
//
//  Varje motor (A, B, C) implementerar detta. Agentkoden vet inget om
//  strategiernas interna logik — den anropar bara scan() och execute().
// ═══════════════════════════════════════════════════════════════════════════

export interface StrategySignal {
  engine: string;
  action: "buy" | "sell" | "hold" | "sell_put" | "sell_call" | "close";
  symbol: string;
  reasoning: string;
  confidence: "low" | "medium" | "high";
  suggestedSizeUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface StrategyEngine {
  readonly name: string;
  readonly description: string;

  /**
   * Scan = analysera marknaden och returnera 0-N signaler.
   * Ska INTE lägga order — bara ge rekommendationer.
   */
  scan(): Promise<StrategySignal[]>;
}
