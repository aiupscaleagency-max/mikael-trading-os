import crypto from "node:crypto";
import { log } from "../../logger.js";
import type { TradeExecutor, OpenOrderParams, OrderResult, ResolveResult, AccountInfo, ExecutorMode } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// BinanceExecutor — riktig order-routing via Binance API
//
// Stödjer både testnet (testnet.binance.vision) och mainnet (api.binance.com).
// Samma kod-väg, bara olika base-URL + keys.
//
// SÄKERHET:
// - API-keys måste konfigureras innan första anrop
// - HMAC-SHA256-signering på varje endpoint som kräver auth
// - 'recvWindow' 5000ms för att undvika replay-attacker
// - Bara MARKET-orders (för scalp-mode); LIMIT-orders kommer i framtid
//
// LIVE-AKTIVERING: kräver explicit setApiKeys + 6-punkts checklista
// (samma som frontend live-modal kräver)
// ═══════════════════════════════════════════════════════════════════════════

export interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export class BinanceExecutor implements TradeExecutor {
  readonly mode: ExecutorMode;
  readonly name: string;
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  constructor(config: BinanceConfig) {
    if (!config.apiKey || !config.apiSecret) {
      throw new Error("Binance API-keys saknas (apiKey + apiSecret krävs)");
    }
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.baseUrl = config.testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
    this.mode = config.testnet ? "binance-testnet" : "binance-live";
    this.name = config.testnet ? "Binance Testnet (riktig API, fake pengar)" : "Binance LIVE (riktiga pengar)";
  }

  private sign(params: Record<string, string | number>): string {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return crypto.createHmac("sha256", this.apiSecret).update(queryString).digest("hex");
  }

  private async signedRequest(method: "GET" | "POST" | "DELETE", endpoint: string, params: Record<string, string | number> = {}): Promise<unknown> {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const allParams = { ...params, timestamp, recvWindow };
    const signature = this.sign(allParams);
    const queryString = Object.entries(allParams)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const url = `${this.baseUrl}${endpoint}?${queryString}&signature=${signature}`;
    const r = await fetch(url, {
      method,
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Binance ${method} ${endpoint} → ${r.status}: ${errText}`);
    }
    return r.json();
  }

  async getPrice(symbol: string): Promise<number> {
    const r = await fetch(`${this.baseUrl}/api/v3/ticker/price?symbol=${symbol}`);
    if (!r.ok) throw new Error(`Binance ticker ${symbol} svar ${r.status}`);
    const data = (await r.json()) as { price: string };
    return parseFloat(data.price);
  }

  async openOrder(params: OpenOrderParams): Promise<OrderResult> {
    log.info(`[binance] PLACE ORDER: ${params.side} ${params.symbol} $${params.quoteAmount}`);
    // Använd MARKET-order med quoteOrderQty (USD-belopp)
    const order = (await this.signedRequest("POST", "/api/v3/order", {
      symbol: params.symbol,
      side: params.side,
      type: "MARKET",
      quoteOrderQty: params.quoteAmount.toFixed(2),
      newClientOrderId: params.clientOrderId || `mtos-${Date.now()}`,
    })) as {
      orderId: number;
      executedQty: string;
      cummulativeQuoteQty: string;
      fills?: Array<{ price: string; qty: string; commission: string; commissionAsset: string }>;
      status: string;
    };
    const filledQty = parseFloat(order.executedQty);
    const filledQuote = parseFloat(order.cummulativeQuoteQty);
    const avgPrice = filledQty > 0 ? filledQuote / filledQty : 0;
    const fees = (order.fills || []).reduce((sum, f) => sum + parseFloat(f.commission || "0"), 0);
    return {
      orderId: String(order.orderId),
      symbol: params.symbol,
      side: params.side,
      entryPrice: avgPrice,
      filledQuantity: filledQty,
      filledQuoteAmount: filledQuote,
      fees,
      timestamp: Date.now(),
      status: order.status === "FILLED" ? "filled" : (order.status === "PARTIALLY_FILLED" ? "partial" : "rejected"),
      rawResponse: order,
    };
  }

  async resolveOrder(
    orderId: string,
    openParams: { entryPrice: number; symbol: string; side: "BUY" | "SELL"; quoteAmount: number; payoutMultiplier: number },
  ): Promise<ResolveResult> {
    // För scalp-mode: stäng position med motsatt MARKET-order
    log.info(`[binance] CLOSE POSITION: ${orderId} ${openParams.symbol}`);
    const closeSide = openParams.side === "BUY" ? "SELL" : "BUY";
    const closeOrder = (await this.signedRequest("POST", "/api/v3/order", {
      symbol: openParams.symbol,
      side: closeSide,
      type: "MARKET",
      quoteOrderQty: openParams.quoteAmount.toFixed(2),
      newClientOrderId: `mtos-close-${orderId}`,
    })) as {
      orderId: number;
      executedQty: string;
      cummulativeQuoteQty: string;
      status: string;
    };
    const exitFilledQuote = parseFloat(closeOrder.cummulativeQuoteQty);
    const exitFilledQty = parseFloat(closeOrder.executedQty);
    const exitPrice = exitFilledQty > 0 ? exitFilledQuote / exitFilledQty : 0;
    // Faktisk PnL = exit_quote - entry_quote (för LONG)
    // För SHORT: entry_quote - exit_quote
    const pnl = openParams.side === "BUY"
      ? exitFilledQuote - openParams.quoteAmount
      : openParams.quoteAmount - exitFilledQuote;
    const won = pnl > 0;
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
      const account = (await this.signedRequest("GET", "/api/v3/account")) as { canTrade: boolean; balances: Array<{ asset: string; free: string; locked: string }> };
      if (!account.canTrade) return { ok: false, details: "API-key saknar trading-permission" };
      const usdt = account.balances.find((b) => b.asset === "USDT");
      const usdtFree = usdt ? parseFloat(usdt.free) : 0;
      return { ok: true, details: `${this.mode} OK · USDT free $${usdtFree.toFixed(2)}` };
    } catch (err) {
      return { ok: false, details: `Binance API-fel: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async getAccount(): Promise<AccountInfo> {
    const account = (await this.signedRequest("GET", "/api/v3/account")) as {
      balances: Array<{ asset: string; free: string; locked: string }>;
    };
    const usdt = account.balances.find((b) => b.asset === "USDT");
    const cash = usdt ? parseFloat(usdt.free) : 0;
    // Total equity kräver att alla assets konverteras — vi fokuserar på USDT just nu
    return {
      cashBalance: cash,
      totalEquity: cash, // utökas senare med open positions
      openPositions: 0,
    };
  }
}
