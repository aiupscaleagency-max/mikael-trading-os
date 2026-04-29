import crypto from "node:crypto";
import { log } from "../../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Binance API-integration — Testnet OCH Mainnet (samma kod, olika base-URL)
//
// Mike vill: TEST = Binance Testnet (riktig API, demo-pengar)
//           LIVE = Binance Mainnet (riktiga pengar)
//
// Säkerhet:
// - HMAC-SHA256-signering på alla auth-endpoints
// - recvWindow 5000ms
// - Byggs som READ-ONLY först, write-permissions kräver explicit setup
// ═══════════════════════════════════════════════════════════════════════════

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

const TESTNET_BASE = "https://testnet.binance.vision";
const MAINNET_BASE = "https://api.binance.com";

export class BinanceClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  readonly mode: "testnet" | "live";

  constructor(creds: BinanceCredentials) {
    if (!creds.apiKey || !creds.apiSecret) {
      throw new Error("Binance kräver apiKey + apiSecret");
    }
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
    this.baseUrl = creds.testnet ? TESTNET_BASE : MAINNET_BASE;
    this.mode = creds.testnet ? "testnet" : "live";
  }

  private sign(queryString: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(queryString).digest("hex");
  }

  private async signedRequest<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const allParams = { ...params, timestamp, recvWindow };
    const queryString = Object.entries(allParams)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const signature = this.sign(queryString);
    const url = `${this.baseUrl}${path}?${queryString}&signature=${signature}`;
    const r = await fetch(url, {
      method,
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Binance ${method} ${path} → ${r.status}: ${errText.slice(0, 300)}`);
    }
    return r.json() as Promise<T>;
  }

  // ─── PUBLIC endpoints (ingen auth) ───

  async getPrice(symbol: string): Promise<number> {
    const r = await fetch(`${this.baseUrl}/api/v3/ticker/price?symbol=${symbol}`);
    if (!r.ok) throw new Error(`Binance ticker svar ${r.status}`);
    const data = (await r.json()) as { price: string };
    return parseFloat(data.price);
  }

  async getKlines(symbol: string, interval = "1m", limit = 100): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
    const r = await fetch(`${this.baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!r.ok) throw new Error(`Binance klines svar ${r.status}`);
    const raw = (await r.json()) as Array<Array<string | number>>;
    return raw.map((k) => ({
      time: Math.floor((k[0] as number) / 1000),
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
    }));
  }

  // ─── AUTHENTICATED endpoints ───

  async getAccount(): Promise<{
    canTrade: boolean;
    canDeposit: boolean;
    canWithdraw: boolean;
    balances: Array<{ asset: string; free: string; locked: string }>;
  }> {
    return this.signedRequest("GET", "/api/v3/account");
  }

  async getOpenOrders(symbol?: string): Promise<Array<{
    symbol: string;
    orderId: number;
    clientOrderId: string;
    price: string;
    origQty: string;
    executedQty: string;
    status: string;
    type: string;
    side: string;
    time: number;
  }>> {
    return this.signedRequest("GET", "/api/v3/openOrders", symbol ? { symbol } : {});
  }

  async getMyTrades(symbol: string, limit = 50): Promise<Array<{
    symbol: string;
    id: number;
    orderId: number;
    price: string;
    qty: string;
    quoteQty: string;
    commission: string;
    commissionAsset: string;
    time: number;
    isBuyer: boolean;
  }>> {
    return this.signedRequest("GET", "/api/v3/myTrades", { symbol, limit });
  }

  async placeMarketOrder(params: {
    symbol: string;
    side: "BUY" | "SELL";
    quoteOrderQty?: number; // USD-belopp (för BUY)
    quantity?: number;       // base-asset-qty (för SELL eller LIMIT)
    clientOrderId?: string;
  }): Promise<{
    orderId: number;
    clientOrderId: string;
    symbol: string;
    side: string;
    status: string;
    executedQty: string;
    cummulativeQuoteQty: string;
    fills?: Array<{ price: string; qty: string; commission: string; commissionAsset: string }>;
  }> {
    const orderParams: Record<string, string | number> = {
      symbol: params.symbol,
      side: params.side,
      type: "MARKET",
    };
    if (params.quoteOrderQty) orderParams.quoteOrderQty = params.quoteOrderQty.toFixed(2);
    if (params.quantity) orderParams.quantity = params.quantity.toFixed(6);
    if (params.clientOrderId) orderParams.newClientOrderId = params.clientOrderId;
    log.info(`[binance-${this.mode}] PLACE ORDER ${params.side} ${params.symbol} ${params.quoteOrderQty ? `$${params.quoteOrderQty}` : `${params.quantity}qty`}`);
    return this.signedRequest("POST", "/api/v3/order", orderParams);
  }

  async cancelOrder(symbol: string, orderId: number): Promise<unknown> {
    return this.signedRequest("DELETE", "/api/v3/order", { symbol, orderId });
  }

  // ─── Härledda metoder ───

  // Total USDT-värde av kontot (cash + öppna positioner värderade till nuvarande pris)
  async getTotalEquity(): Promise<{ cashUsdt: number; positions: Array<{ asset: string; qty: number; valueUsdt: number }>; totalUsdt: number }> {
    const account = await this.getAccount();
    const nonZero = account.balances.filter((b) => parseFloat(b.free) + parseFloat(b.locked) > 0);
    const usdt = nonZero.find((b) => b.asset === "USDT");
    const cashUsdt = usdt ? parseFloat(usdt.free) + parseFloat(usdt.locked) : 0;
    const positions: Array<{ asset: string; qty: number; valueUsdt: number }> = [];
    let totalUsdt = cashUsdt;
    for (const b of nonZero) {
      if (b.asset === "USDT" || b.asset === "BUSD" || b.asset === "USDC") continue;
      const qty = parseFloat(b.free) + parseFloat(b.locked);
      try {
        const price = await this.getPrice(`${b.asset}USDT`);
        const valueUsdt = qty * price;
        positions.push({ asset: b.asset, qty, valueUsdt });
        totalUsdt += valueUsdt;
      } catch {
        // hopp över tokens utan USDT-pair
      }
    }
    return { cashUsdt, positions, totalUsdt };
  }

  // Healthcheck — verifierar API-keys + permissions
  async healthCheck(): Promise<{ ok: boolean; canTrade: boolean; usdtFree: number; details: string }> {
    try {
      const account = await this.getAccount();
      const usdt = account.balances.find((b) => b.asset === "USDT");
      const free = usdt ? parseFloat(usdt.free) : 0;
      return {
        ok: true,
        canTrade: account.canTrade,
        usdtFree: free,
        details: `Binance ${this.mode} OK · canTrade=${account.canTrade} · USDT free $${free.toFixed(2)}`,
      };
    } catch (err) {
      return {
        ok: false,
        canTrade: false,
        usdtFree: 0,
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// Cached client per credential-hash (förhindrar att skapa nya HTTP-clients varje request)
const clientCache = new Map<string, BinanceClient>();

export function getBinanceClient(creds: BinanceCredentials): BinanceClient {
  const key = `${creds.testnet ? "t" : "l"}-${creds.apiKey.slice(0, 8)}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, new BinanceClient(creds));
  }
  return clientCache.get(key)!;
}
