import { log } from "../../logger.js";
import type { TradeExecutor, OpenOrderParams, OrderResult, ResolveResult, AccountInfo, ExecutorMode } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// OandaExecutor — forex via Oanda API (paper-mode + live-mode)
//
// Oanda har två endpoints:
// - api-fxpractice.oanda.com (DEMO/paper trading - gratis)
// - api-fxtrade.oanda.com (LIVE - riktiga pengar)
//
// Symbol-format: EUR_USD (Oanda) ↔ EUR/USD (vår display)
// Implementerar samma TradeExecutor-interface som BinanceExecutor.
//
// SETUP (Mike behöver):
// 1. Skapa konto på oanda.com
// 2. Generera API-token i developers > generate-token
// 3. Hitta account-ID i konto-info
// 4. Lägg in i Settings → set-oanda-key + set-oanda-account
// ═══════════════════════════════════════════════════════════════════════════

export interface OandaConfig {
  apiToken: string;
  accountId: string;
  practice: boolean; // true = demo (gratis), false = live (riktiga pengar)
}

export class OandaExecutor implements TradeExecutor {
  readonly mode: ExecutorMode;
  readonly name: string;
  private apiToken: string;
  private accountId: string;
  private baseUrl: string;

  constructor(config: OandaConfig) {
    if (!config.apiToken || !config.accountId) {
      throw new Error("Oanda credentials saknas (apiToken + accountId krävs)");
    }
    this.apiToken = config.apiToken;
    this.accountId = config.accountId;
    this.baseUrl = config.practice ? "https://api-fxpractice.oanda.com" : "https://api-fxtrade.oanda.com";
    this.mode = config.practice ? "binance-testnet" : "binance-live"; // Återanvänder mode-typer
    this.name = config.practice ? "Oanda Practice (forex demo)" : "Oanda LIVE (forex riktiga pengar)";
  }

  // EUR/USD → EUR_USD för Oanda
  private oandaSymbol(s: string): string {
    return s.replace("/", "_");
  }

  private async oandaRequest<T = unknown>(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const opts: RequestInit = {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        "Accept-Datetime-Format": "UNIX",
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Oanda ${method} ${endpoint} → ${r.status}: ${errText.slice(0, 200)}`);
    }
    return r.json() as Promise<T>;
  }

  async getPrice(symbol: string): Promise<number> {
    const oSym = this.oandaSymbol(symbol);
    type PricingResp = { prices: Array<{ instrument: string; bids: Array<{ price: string }>; asks: Array<{ price: string }> }> };
    const data = await this.oandaRequest<PricingResp>("GET", `/v3/accounts/${this.accountId}/pricing?instruments=${oSym}`);
    const p = data.prices.find((x) => x.instrument === oSym);
    if (!p) throw new Error(`Oanda saknar pris för ${symbol}`);
    // Mid-pris (snitt av bid/ask)
    const bid = parseFloat(p.bids[0]?.price || "0");
    const ask = parseFloat(p.asks[0]?.price || "0");
    if (!bid || !ask) throw new Error(`Oanda ogiltigt pris för ${symbol}`);
    return (bid + ask) / 2;
  }

  async openOrder(params: OpenOrderParams): Promise<OrderResult> {
    const oSym = this.oandaSymbol(params.symbol);
    log.info(`[oanda] PLACE ORDER: ${params.side} ${oSym} $${params.quoteAmount}`);
    // Oanda använder UNITS (positiv = BUY, negativ = SELL)
    // 1 unit ≈ $1 motsvarande lot-size
    const units = params.side === "BUY" ? params.quoteAmount : -params.quoteAmount;
    type OrderResp = {
      orderFillTransaction: {
        id: string;
        instrument: string;
        units: string;
        price: string;
        commission: string;
        accountBalance: string;
      };
    };
    const order = await this.oandaRequest<OrderResp>("POST", `/v3/accounts/${this.accountId}/orders`, {
      order: {
        type: "MARKET",
        instrument: oSym,
        units: String(units),
        timeInForce: "FOK", // Fill-or-Kill
        positionFill: "DEFAULT",
      },
    });
    const fill = order.orderFillTransaction;
    if (!fill) throw new Error("Oanda order fyllde inte");
    return {
      orderId: fill.id,
      symbol: params.symbol,
      side: params.side,
      entryPrice: parseFloat(fill.price),
      filledQuantity: Math.abs(parseFloat(fill.units)),
      filledQuoteAmount: params.quoteAmount,
      fees: parseFloat(fill.commission || "0"),
      timestamp: Date.now(),
      status: "filled",
      rawResponse: fill,
    };
  }

  async resolveOrder(
    orderId: string,
    openParams: { entryPrice: number; symbol: string; side: "BUY" | "SELL"; quoteAmount: number; payoutMultiplier: number },
  ): Promise<ResolveResult> {
    // För forex i scalp-mode: stäng position genom att skicka motsatt order
    log.info(`[oanda] CLOSE POSITION: ${orderId} ${openParams.symbol}`);
    const oSym = this.oandaSymbol(openParams.symbol);
    const closeSide = openParams.side === "BUY" ? "SELL" : "BUY";
    const closeUnits = closeSide === "BUY" ? openParams.quoteAmount : -openParams.quoteAmount;
    type CloseResp = {
      orderFillTransaction: {
        id: string;
        units: string;
        price: string;
        pl: string; // realized profit/loss i konto-currency
        commission: string;
      };
    };
    const close = await this.oandaRequest<CloseResp>("POST", `/v3/accounts/${this.accountId}/orders`, {
      order: {
        type: "MARKET",
        instrument: oSym,
        units: String(closeUnits),
        timeInForce: "FOK",
        positionFill: "REDUCE_ONLY",
      },
    });
    const fill = close.orderFillTransaction;
    const exitPrice = parseFloat(fill.price);
    const pnl = parseFloat(fill.pl || "0");
    const won = pnl > 0;
    return { orderId, exitPrice, pnl, won, closedAt: Date.now() };
  }

  async healthCheck(): Promise<{ ok: boolean; details: string }> {
    try {
      type AccountResp = { account: { balance: string; currency: string; openTradeCount: number } };
      const data = await this.oandaRequest<AccountResp>("GET", `/v3/accounts/${this.accountId}/summary`);
      return { ok: true, details: `Oanda OK · balance ${data.account.balance} ${data.account.currency} · ${data.account.openTradeCount} öppna` };
    } catch (err) {
      return { ok: false, details: `Oanda-fel: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async getAccount(): Promise<AccountInfo> {
    type AccountResp = { account: { balance: string; NAV: string; openTradeCount: number } };
    const data = await this.oandaRequest<AccountResp>("GET", `/v3/accounts/${this.accountId}/summary`);
    return {
      cashBalance: parseFloat(data.account.balance),
      totalEquity: parseFloat(data.account.NAV), // Net Asset Value (cash + unrealized)
      openPositions: data.account.openTradeCount,
    };
  }
}
