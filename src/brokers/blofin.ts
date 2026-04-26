import crypto from "node:crypto";
import type {
  Account,
  Balance,
  Kline,
  OrderRequest,
  OrderResult,
  Position,
  Ticker,
} from "../types.js";
import type { BrokerAdapter } from "./adapter.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Blofin broker-adapter: krypto-derivat med leverage.
//
//  API-docs: https://docs.blofin.com/
//  Auth: ACCESS-KEY, ACCESS-SIGN (HMAC-SHA256 base64), ACCESS-TIMESTAMP,
//        ACCESS-PASSPHRASE headers.
//  Signatur: base64(hmac_sha256(secret, timestamp + method + path + body))
// ═══════════════════════════════════════════════════════════════════════════

interface BlofinConfig {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  baseUrl: string;
  mode: "paper" | "live";
}

export class BlofinBroker implements BrokerAdapter {
  readonly name = "blofin";
  readonly mode: "paper" | "live";
  private readonly cfg: BlofinConfig;

  constructor(cfg: BlofinConfig) {
    this.cfg = cfg;
    this.mode = cfg.mode;
  }

  private sign(timestamp: string, method: string, path: string, body: string): string {
    const prehash = timestamp + method.toUpperCase() + path + body;
    return crypto
      .createHmac("sha256", this.cfg.apiSecret)
      .update(prehash)
      .digest("base64");
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const timestamp = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : "";
    const signature = this.sign(timestamp, method, path, bodyStr);

    const headers: Record<string, string> = {
      "ACCESS-KEY": this.cfg.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": this.cfg.passphrase,
      "Content-Type": "application/json",
    };

    // Blofin demo-trading flag
    if (this.mode === "paper") {
      headers["x-simulated-trading"] = "1";
    }

    const url = method === "GET" && bodyStr
      ? `${this.cfg.baseUrl}${path}`
      : `${this.cfg.baseUrl}${path}`;

    const res = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? bodyStr : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Blofin ${method} ${path} ${res.status}: ${text}`);
    }

    const json = (await res.json()) as { code: string; msg: string; data: T };
    if (json.code !== "0") {
      throw new Error(`Blofin API error ${json.code}: ${json.msg}`);
    }
    return json.data;
  }

  // ── BrokerAdapter implementation ──

  async getAccount(): Promise<Account> {
    const data = await this.request<
      Array<{ currency: string; available: string; frozen: string; equity: string }>
    >("GET", "/api/v1/account/balance");
    const balances: Balance[] = data.map((b) => ({
      asset: b.currency,
      free: Number(b.available),
      locked: Number(b.frozen),
    }));
    const totalValueUsdt = data.reduce((sum, b) => sum + Number(b.equity || 0), 0);
    return { balances, totalValueUsdt, updatedAt: Date.now() };
  }

  async getPositions(): Promise<Position[]> {
    const data = await this.request<
      Array<{
        instId: string;
        pos: string;
        avgPx: string;
        markPx: string;
        upl: string;
        cTime: string;
      }>
    >("GET", "/api/v1/account/positions");

    return data
      .filter((p) => Number(p.pos) !== 0)
      .map((p) => {
        const parts = p.instId.split("-");
        return {
          symbol: p.instId,
          baseAsset: parts[0] ?? p.instId,
          quoteAsset: parts[1] ?? "USDT",
          quantity: Math.abs(Number(p.pos)),
          avgEntryPrice: Number(p.avgPx),
          currentPrice: Number(p.markPx),
          unrealizedPnlUsdt: Number(p.upl),
          openedAt: Number(p.cTime),
        };
      });
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const data = await this.request<
      Array<{ instId: string; last: string; open24h: string; vol24h: string }>
    >("GET", `/api/v1/market/tickers?instId=${symbol}`);
    const t = data[0];
    if (!t) throw new Error(`Ingen ticker för ${symbol}`);
    const price = Number(t.last);
    const open24 = Number(t.open24h);
    const changePct = open24 > 0 ? ((price - open24) / open24) * 100 : 0;
    return {
      symbol: t.instId,
      price,
      changePct24h: changePct,
      volume24h: Number(t.vol24h),
    };
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    // Blofin bar-format: 1m, 5m, 15m, 1H, 4H, 1D
    const barMap: Record<string, string> = {
      "1m": "1m",
      "5m": "5m",
      "15m": "15m",
      "1h": "1H",
      "4h": "4H",
      "1d": "1D",
    };
    const bar = barMap[interval] ?? "1H";
    const data = await this.request<string[][]>(
      "GET",
      `/api/v1/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`,
    );
    // Blofin returnerar [timestamp, open, high, low, close, vol, ...]
    return data
      .map((k) => ({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: Number(k[0]),
      }))
      .reverse(); // Blofin returnerar nyast-först, vi vill äldst-först
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    // Blofin trade-order format
    const body: Record<string, string> = {
      instId: order.symbol,
      tdMode: "cross", // cross-margin
      side: order.side.toLowerCase(),
      ordType: order.type === "MARKET" ? "market" : "limit",
    };

    if (order.quantity !== undefined) {
      body.sz = String(order.quantity);
    }
    if (order.type === "LIMIT" && order.price !== undefined) {
      body.px = String(order.price);
    }

    const data = await this.request<Array<{ ordId: string; sCode: string; sMsg: string }>>(
      "POST",
      "/api/v1/trade/order",
      body,
    );
    const result = data[0];
    if (!result || result.sCode !== "0") {
      throw new Error(`Blofin order fel: ${result?.sMsg ?? "okänt"}`);
    }

    return {
      orderId: result.ordId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status: "submitted",
      executedQty: 0,
      cummulativeQuoteQty: 0,
      avgFillPrice: 0,
      timestamp: Date.now(),
    };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.request("POST", "/api/v1/trade/cancel-order", {
      instId: symbol,
      ordId: orderId,
    });
  }

  // ── Blofin-specifika metoder ──

  /** Sätt leverage för ett instrument */
  async setLeverage(instId: string, lever: number): Promise<void> {
    await this.request("POST", "/api/v1/account/set-leverage", {
      instId,
      lever: String(lever),
      mgnMode: "cross",
    });
  }

  /** Lägg en order med take-profit / stop-loss */
  async placeOrderWithTpSl(params: {
    instId: string;
    side: "buy" | "sell";
    size: number;
    tpTriggerPrice?: number;
    slTriggerPrice?: number;
  }): Promise<string> {
    const body: Record<string, unknown> = {
      instId: params.instId,
      tdMode: "cross",
      side: params.side,
      ordType: "market",
      sz: String(params.size),
    };

    if (params.tpTriggerPrice) {
      body.tpTriggerPx = String(params.tpTriggerPrice);
      body.tpOrdPx = "-1"; // market price vid trigger
    }
    if (params.slTriggerPrice) {
      body.slTriggerPx = String(params.slTriggerPrice);
      body.slOrdPx = "-1";
    }

    const data = await this.request<Array<{ ordId: string; sCode: string; sMsg: string }>>(
      "POST",
      "/api/v1/trade/order",
      body,
    );
    const result = data[0];
    if (!result || result.sCode !== "0") {
      throw new Error(`Blofin order+TP/SL fel: ${result?.sMsg ?? "okänt"}`);
    }
    return result.ordId;
  }
}
