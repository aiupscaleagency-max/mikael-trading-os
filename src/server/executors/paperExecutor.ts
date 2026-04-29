import { log } from "../../logger.js";
import type { TradeExecutor, OpenOrderParams, OrderResult, ResolveResult, AccountInfo, ExecutorMode } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// PaperExecutor — simulerad order-routing
//
// - openOrder: hämtar Binance public-pris som entry, returnerar paper orderId
// - resolveOrder: hämtar Binance public-pris vid resolve, räknar binary outcome
// - getAccount: hämtas från externa state (paperAccount i tradeState)
//
// All paper-pris-data kommer från Binance public API — så pris-rörelser är
// 100% RIKTIGA. Bara order-routern är simulerad.
// ═══════════════════════════════════════════════════════════════════════════

export class PaperExecutor implements TradeExecutor {
  readonly mode: ExecutorMode = "paper";
  readonly name = "Paper (sim order, riktiga priser)";

  private getAccountFn?: () => Promise<AccountInfo>;

  constructor(opts?: { getAccount?: () => Promise<AccountInfo> }) {
    this.getAccountFn = opts?.getAccount;
  }

  async getPrice(symbol: string): Promise<number> {
    // Binance public ticker — ingen auth, fungerar i alla modes
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (!r.ok) throw new Error(`Binance ticker svar ${r.status} för ${symbol}`);
    const data = (await r.json()) as { price: string };
    const p = parseFloat(data.price);
    if (!p || isNaN(p)) throw new Error(`Ogiltigt pris för ${symbol}`);
    return p;
  }

  async openOrder(params: OpenOrderParams): Promise<OrderResult> {
    const entryPrice = await this.getPrice(params.symbol);
    const filledQuantity = params.quoteAmount / entryPrice;
    return {
      orderId: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol: params.symbol,
      side: params.side,
      entryPrice,
      filledQuantity,
      filledQuoteAmount: params.quoteAmount,
      fees: 0, // paper: inga avgifter
      timestamp: Date.now(),
      status: "filled",
    };
  }

  async resolveOrder(
    orderId: string,
    openParams: { entryPrice: number; symbol: string; side: "BUY" | "SELL"; quoteAmount: number; payoutMultiplier: number },
  ): Promise<ResolveResult> {
    const exitPrice = await this.getPrice(openParams.symbol);
    const won =
      openParams.side === "BUY" ? exitPrice > openParams.entryPrice : exitPrice < openParams.entryPrice;
    // Binary outcome (scalp-style): vinst = stake × (payout-1), förlust = -stake
    const pnl = won
      ? openParams.quoteAmount * (openParams.payoutMultiplier - 1)
      : -openParams.quoteAmount;
    return {
      orderId,
      exitPrice,
      pnl,
      won,
      closedAt: Date.now(),
    };
  }

  async healthCheck(): Promise<{ ok: boolean; details: string }> {
    try {
      const btc = await this.getPrice("BTCUSDT");
      return { ok: true, details: `Binance public OK · BTC $${btc.toFixed(0)}` };
    } catch (err) {
      return { ok: false, details: `Binance public-fel: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async getAccount(): Promise<AccountInfo> {
    if (this.getAccountFn) return this.getAccountFn();
    return { cashBalance: 0, totalEquity: 0, openPositions: 0 };
  }
}
