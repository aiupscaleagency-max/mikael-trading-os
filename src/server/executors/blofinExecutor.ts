import crypto from "node:crypto";
import { log } from "../../logger.js";
import type { TradeExecutor, OpenOrderParams, OrderResult, ResolveResult, AccountInfo, ExecutorMode } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// BlofinExecutor — perpetual futures + spot via Blofin API
//
// Blofin API-bas: https://openapi.blofin.com
// Auth: API-key + secret + passphrase (likt OKX)
// Stödjer: spot, perpetual futures, copy-trading
//
// Mike vill köra både binary-style (Blofin scalping) och spot
// ═══════════════════════════════════════════════════════════════════════════

export interface BlofinConfig {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  testnet?: boolean;
}

export class BlofinExecutor implements TradeExecutor {
  readonly mode: ExecutorMode = "binance-live"; // återanvänder type
  readonly name: string;
  private apiKey: string;
  private apiSecret: string;
  private passphrase: string;
  private baseUrl: string;

  constructor(config: BlofinConfig) {
    if (!config.apiKey || !config.apiSecret || !config.passphrase) {
      throw new Error("Blofin kräver apiKey + apiSecret + passphrase");
    }
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.passphrase = config.passphrase;
    this.baseUrl = config.testnet ? "https://demo-trading-openapi.blofin.com" : "https://openapi.blofin.com";
    this.name = config.testnet ? "Blofin Demo" : "Blofin LIVE";
  }

  private sign(timestamp: string, method: string, path: string, body: string): string {
    const message = timestamp + method + path + body;
    return crypto.createHmac("sha256", this.apiSecret).update(message).digest("base64");
  }

  private async signedRequest<T = unknown>(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    const timestamp = String(Date.now());
    const bodyStr = body ? JSON.stringify(body) : "";
    const signature = this.sign(timestamp, method, endpoint, bodyStr);
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "ACCESS-KEY": this.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": this.passphrase,
      "Content-Type": "application/json",
    };
    const opts: RequestInit = { method, headers };
    if (body) opts.body = bodyStr;
    const r = await fetch(url, opts);
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Blofin ${method} ${endpoint} → ${r.status}: ${errText.slice(0, 200)}`);
    }
    const json = (await r.json()) as { code?: string; msg?: string; data?: unknown };
    if (json.code && json.code !== "0") {
      throw new Error(`Blofin error ${json.code}: ${json.msg}`);
    }
    return json.data as T;
  }

  // BTC-USDT → BTC-USDT (Blofin format)
  private blofinSymbol(s: string): string {
    if (s.includes("-")) return s;
    if (s.endsWith("USDT")) return `${s.slice(0, -4)}-USDT`;
    return s;
  }

  async getPrice(symbol: string): Promise<number> {
    const bSym = this.blofinSymbol(symbol);
    const r = await fetch(`${this.baseUrl}/api/v1/market/tickers?instId=${bSym}`);
    if (!r.ok) throw new Error(`Blofin ticker ${symbol} → ${r.status}`);
    const data = (await r.json()) as { code: string; data: Array<{ instId: string; last: string }> };
    if (data.code !== "0" || !data.data?.[0]) throw new Error(`Blofin saknar ticker för ${symbol}`);
    return parseFloat(data.data[0].last);
  }

  async openOrder(params: OpenOrderParams): Promise<OrderResult> {
    const bSym = this.blofinSymbol(params.symbol);
    log.info(`[blofin] PLACE ORDER: ${params.side} ${bSym} $${params.quoteAmount}`);
    // Hämta pris för att räkna kvantitet (Blofin tar size i base-asset)
    const price = await this.getPrice(params.symbol);
    const size = params.quoteAmount / price;
    type OrderResp = { orderId: string; clientOrderId?: string };
    const order = await this.signedRequest<OrderResp[]>("POST", "/api/v1/trade/order", {
      instId: bSym,
      tdMode: "cash", // spot mode
      side: params.side.toLowerCase(),
      ordType: "market",
      sz: size.toFixed(6),
      clOrdId: params.clientOrderId || `mtos${Date.now()}`,
    });
    const o = order[0];
    if (!o) throw new Error("Blofin returnerade ingen order");
    return {
      orderId: o.orderId,
      symbol: params.symbol,
      side: params.side,
      entryPrice: price,
      filledQuantity: size,
      filledQuoteAmount: params.quoteAmount,
      fees: params.quoteAmount * 0.001, // 0.1% taker
      timestamp: Date.now(),
      status: "filled",
    };
  }

  async resolveOrder(
    orderId: string,
    openParams: { entryPrice: number; symbol: string; side: "BUY" | "SELL"; quoteAmount: number; payoutMultiplier: number },
  ): Promise<ResolveResult> {
    log.info(`[blofin] CLOSE: ${orderId} ${openParams.symbol}`);
    const exitPrice = await this.getPrice(openParams.symbol);
    const closeSide = openParams.side === "BUY" ? "SELL" : "BUY";
    const bSym = this.blofinSymbol(openParams.symbol);
    const size = openParams.quoteAmount / openParams.entryPrice;
    await this.signedRequest("POST", "/api/v1/trade/order", {
      instId: bSym,
      tdMode: "cash",
      side: closeSide.toLowerCase(),
      ordType: "market",
      sz: size.toFixed(6),
      clOrdId: `mtos-close-${orderId}`,
    });
    // Spot-style PnL: (exit - entry) × qty - fees (för LONG)
    const grossPnl = openParams.side === "BUY"
      ? (exitPrice - openParams.entryPrice) * size
      : (openParams.entryPrice - exitPrice) * size;
    const fees = openParams.quoteAmount * 0.002; // 0.1% open + 0.1% close
    const pnl = grossPnl - fees;
    return { orderId, exitPrice, pnl, won: pnl > 0, closedAt: Date.now() };
  }

  async healthCheck(): Promise<{ ok: boolean; details: string }> {
    try {
      type AccResp = { details: Array<{ ccy: string; cashBal: string }> };
      const data = await this.signedRequest<AccResp[]>("GET", "/api/v1/account/balance");
      const usdt = data[0]?.details.find((d) => d.ccy === "USDT");
      const free = usdt ? parseFloat(usdt.cashBal) : 0;
      return { ok: true, details: `Blofin OK · USDT ${free.toFixed(2)}` };
    } catch (err) {
      return { ok: false, details: err instanceof Error ? err.message : String(err) };
    }
  }

  async getAccount(): Promise<AccountInfo> {
    type AccResp = { details: Array<{ ccy: string; cashBal: string; eq: string }> };
    const data = await this.signedRequest<AccResp[]>("GET", "/api/v1/account/balance");
    const usdt = data[0]?.details.find((d) => d.ccy === "USDT");
    const cash = usdt ? parseFloat(usdt.cashBal) : 0;
    const equity = usdt ? parseFloat(usdt.eq) : cash;
    return { cashBalance: cash, totalEquity: equity, openPositions: 0 };
  }
}
