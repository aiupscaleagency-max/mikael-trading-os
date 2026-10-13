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

// Binance REST-adapter. Fungerar mot både live (api.binance.com) och spot
// testnet (testnet.binance.vision) — de använder identiska endpoints och
// samma HMAC-SHA256-signaturschema, bara olika URL och olika nycklar.
//
// Vi använder globala fetch (Node 20+) så inga externa http-klienter behövs.

interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  mode: "paper" | "live";
}

interface BinanceAccountResp {
  balances: Array<{ asset: string; free: string; locked: string }>;
}

interface BinanceOrderResp {
  symbol: string;
  orderId: number;
  status: string;
  side: "BUY" | "SELL";
  type: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  transactTime: number;
  fills?: Array<{ price: string; qty: string }>;
}

interface BinanceTicker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

export class BinanceBroker implements BrokerAdapter {
  readonly name = "binance";
  readonly mode: "paper" | "live";
  private readonly cfg: BinanceConfig;

  // Enkel in-memory cache av senast sedda priser. Används för att uppskatta
  // positioners mark-to-market-värde utan extra API-anrop.
  private priceCache = new Map<string, number>();

  constructor(cfg: BinanceConfig) {
    this.cfg = cfg;
    this.mode = cfg.mode;
  }

  // --- Låg-nivå: signerade requests ---

  private sign(queryString: string): string {
    return crypto
      .createHmac("sha256", this.cfg.apiSecret)
      .update(queryString)
      .digest("hex");
  }

  private async signedRequest<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<T> {
    const timestamp = Date.now();
    // recvWindow skyddar mot att gamla requests räknas som giltiga om klockan glider.
    const query = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      timestamp: String(timestamp),
      recvWindow: "5000",
    }).toString();

    const signature = this.sign(query);
    const url = `${this.cfg.baseUrl}${path}?${query}&signature=${signature}`;

    const res = await fetch(url, {
      method,
      headers: { "X-MBX-APIKEY": this.cfg.apiKey },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Binance ${method} ${path} ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  private async publicRequest<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    ).toString();
    const url = query ? `${this.cfg.baseUrl}${path}?${query}` : `${this.cfg.baseUrl}${path}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Binance GET ${path} ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  // --- Högnivå-API ---

  async getAccount(): Promise<Account> {
    const resp = await this.signedRequest<BinanceAccountResp>("GET", "/api/v3/account");
    const balances: Balance[] = resp.balances
      .map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
      .filter((b) => b.free > 0 || b.locked > 0);

    // Grov total-värdering i USDT: summera non-stable-innehav * senast sett pris,
    // plus USDT/BUSD/FDUSD 1:1. Missar kanter men duger för UI och risk-koll.
    let totalValueUsdt = 0;
    for (const b of balances) {
      const amount = b.free + b.locked;
      if (["USDT", "BUSD", "FDUSD", "USDC"].includes(b.asset)) {
        totalValueUsdt += amount;
        continue;
      }
      const symbol = `${b.asset}USDT`;
      const cached = this.priceCache.get(symbol);
      if (cached !== undefined) {
        totalValueUsdt += amount * cached;
      } else {
        // Slå upp on-demand; tolerera fel (t.ex. obskyra tokens utan USDT-par).
        try {
          const t = await this.getTicker(symbol);
          totalValueUsdt += amount * t.price;
        } catch {
          /* ignorera */
        }
      }
    }

    return { balances, totalValueUsdt, updatedAt: Date.now() };
  }

  async getPositions(): Promise<Position[]> {
    // Binance spot har ingen "positions"-endpoint (spot är inte margin/futures).
    // En spot-"position" är helt enkelt ett non-quote-saldo. Vi rapporterar varje
    // sådant saldo som en position med okänt entry-pris (0) så att agenten kan se
    // att den äger något. Riktigt entry-pris trackar vi i memory store utifrån
    // faktiskt exekverade orders.
    const account = await this.getAccount();
    const positions: Position[] = [];
    for (const b of account.balances) {
      const qty = b.free + b.locked;
      if (qty <= 0) continue;
      if (["USDT", "BUSD", "FDUSD", "USDC"].includes(b.asset)) continue;
      const symbol = `${b.asset}USDT`;
      let price = this.priceCache.get(symbol) ?? 0;
      if (price === 0) {
        try {
          price = (await this.getTicker(symbol)).price;
        } catch {
          continue;
        }
      }
      positions.push({
        symbol,
        baseAsset: b.asset,
        quoteAsset: "USDT",
        quantity: qty,
        avgEntryPrice: 0, // Fylls i från memory store i run-loopen
        currentPrice: price,
        unrealizedPnlUsdt: 0,
        openedAt: 0,
      });
    }
    return positions;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const t = await this.publicRequest<BinanceTicker24h>("/api/v3/ticker/24hr", { symbol });
    const price = Number(t.lastPrice);
    this.priceCache.set(symbol, price);
    return {
      symbol: t.symbol,
      price,
      changePct24h: Number(t.priceChangePercent),
      volume24h: Number(t.quoteVolume),
    };
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    // Binance returnerar en array av arrays. Vi mappar till struct-form.
    type RawKline = [number, string, string, string, string, string, number, ...unknown[]];
    const raw = await this.publicRequest<RawKline[]>("/api/v3/klines", {
      symbol,
      interval,
      limit,
    });
    return raw.map((k) => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6],
    }));
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const params: Record<string, string | number> = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
    };

    if (order.type === "MARKET") {
      // För MARKET BUY är det ofta bäst att specificera quoteOrderQty (hur mycket
      // USDT du vill spendera), eftersom du inte exakt vet priset. För SELL
      // använder vi quantity (hur mycket av baseAsset du vill sälja).
      if (order.quoteOrderQty !== undefined) {
        params.quoteOrderQty = order.quoteOrderQty;
      } else if (order.quantity !== undefined) {
        params.quantity = order.quantity;
      } else {
        throw new Error("MARKET order kräver quantity eller quoteOrderQty");
      }
    } else if (order.type === "LIMIT") {
      if (order.quantity === undefined || order.price === undefined) {
        throw new Error("LIMIT order kräver quantity och price");
      }
      params.quantity = order.quantity;
      params.price = order.price;
      params.timeInForce = "GTC";
    }

    const resp = await this.signedRequest<BinanceOrderResp>("POST", "/api/v3/order", params);

    const executedQty = Number(resp.executedQty);
    const cummQuote = Number(resp.cummulativeQuoteQty);
    const avgFillPrice = executedQty > 0 ? cummQuote / executedQty : 0;

    return {
      orderId: String(resp.orderId),
      symbol: resp.symbol,
      side: resp.side,
      type: resp.type as OrderResult["type"],
      status: resp.status,
      executedQty,
      cummulativeQuoteQty: cummQuote,
      avgFillPrice,
      timestamp: resp.transactTime,
    };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.signedRequest("DELETE", "/api/v3/order", { symbol, orderId });
  }
}
