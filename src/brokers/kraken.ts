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

// Kraken REST-adapter (spot). Kraken tillåter API-handel från Sverige/EU,
// till skillnad från Binance. Kraken har ingen spot-sandbox, så den här
// mäklaren är alltid LIVE (riktiga pengar). Order-grinden släpper bara igenom
// ordrar när MODE=live och LIVE_TRADING_CONFIRMED=true.
//
// Resten av systemet använder symboler som "BTCUSDT". Här mappas de till
// Krakens par i vald quote-valuta (KRAKEN_QUOTE, standard EUR): BTCUSDT → XBTEUR.

interface KrakenConfig {
  apiKey: string;
  apiSecret: string;
  quote: string; // t.ex. "EUR" eller "USD"
  baseUrl?: string;
}

interface KrakenResp<T> {
  error: string[];
  result: T;
}

interface KrakenPairInfo {
  altname: string;
  base: string;
  quote: string;
  lot_decimals: number;
  pair_decimals: number;
  ordermin?: string;
  costmin?: string;
}

const STABLE_QUOTES = ["USDT", "USDC", "USD", "EUR", "BUSD", "FDUSD"];
const INTERVAL_MIN: Record<string, number> = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080,
};

/** Krakens tillgångskoder (XXBT, ZEUR, XETH, SOL) → vanliga namn (BTC, EUR, ETH, SOL). */
export function normalizeKrakenAsset(code: string): string {
  let a = code.split(".")[0] ?? code; // "ETH.F" (staking-varianter) → "ETH"
  if (a.length === 4 && (a.startsWith("X") || a.startsWith("Z"))) a = a.slice(1);
  if (a === "XBT") a = "BTC";
  if (a === "XDG") a = "DOGE";
  return a;
}

export class KrakenBroker implements BrokerAdapter {
  readonly name = "kraken";
  readonly mode = "live" as const;
  private readonly cfg: Required<KrakenConfig>;
  private lastNonce = 0;
  private pairCache = new Map<string, KrakenPairInfo>();

  constructor(cfg: KrakenConfig) {
    this.cfg = { baseUrl: "https://api.kraken.com", ...cfg, quote: (cfg.quote || "EUR").toUpperCase() };
  }

  /** BTCUSDT / BTC/USD / BTC → base "BTC". */
  private baseOf(symbol: string): string {
    const s = symbol.toUpperCase().replace("/", "");
    for (const q of STABLE_QUOTES) {
      if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length);
    }
    return s;
  }

  /** BTCUSDT → "XBTEUR" (Krakens altname-format). */
  private pairOf(symbol: string): string {
    const base = this.baseOf(symbol);
    return `${base === "BTC" ? "XBT" : base === "DOGE" ? "XDG" : base}${this.cfg.quote}`;
  }

  private nonce(): string {
    const n = Math.max(Date.now() * 1000, this.lastNonce + 1);
    this.lastNonce = n;
    return String(n);
  }

  private async publicRequest<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const q = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
    const res = await fetch(`${this.cfg.baseUrl}/0/public/${path}?${q}`);
    if (!res.ok) throw new Error(`Kraken GET ${path} ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as KrakenResp<T>;
    if (body.error?.length) throw new Error(`Kraken ${path}: ${body.error.join(", ")}`);
    return body.result;
  }

  private async privateRequest<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const urlPath = `/0/private/${path}`;
    const nonce = this.nonce();
    const postData = new URLSearchParams({
      nonce,
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    }).toString();
    // API-Sign = HMAC-SHA512(urlPath + SHA256(nonce + postData), base64-avkodad secret)
    const sha = crypto.createHash("sha256").update(nonce + postData).digest();
    const sig = crypto
      .createHmac("sha512", Buffer.from(this.cfg.apiSecret, "base64"))
      .update(Buffer.concat([Buffer.from(urlPath), sha]))
      .digest("base64");
    const res = await fetch(`${this.cfg.baseUrl}${urlPath}`, {
      method: "POST",
      headers: {
        "API-Key": this.cfg.apiKey,
        "API-Sign": sig,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: postData,
    });
    if (!res.ok) throw new Error(`Kraken POST ${path} ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as KrakenResp<T>;
    if (body.error?.length) throw new Error(`Kraken ${path}: ${body.error.join(", ")}`);
    return body.result;
  }

  private async pairInfo(pair: string): Promise<KrakenPairInfo> {
    const cached = this.pairCache.get(pair);
    if (cached) return cached;
    const r = await this.publicRequest<Record<string, KrakenPairInfo>>("AssetPairs", { pair });
    const info = Object.values(r)[0];
    if (!info) throw new Error(`Kraken: paret ${pair} finns inte`);
    this.pairCache.set(pair, info);
    return info;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const pair = this.pairOf(symbol);
    const r = await this.publicRequest<Record<string, { c: string[]; o: string; v: string[] }>>("Ticker", { pair });
    const t = Object.values(r)[0];
    if (!t) throw new Error(`Kraken: inget pris för ${pair}`);
    const price = Number(t.c[0]);
    const open = Number(t.o);
    return {
      symbol,
      price,
      changePct24h: open > 0 ? ((price - open) / open) * 100 : 0,
      volume24h: Number(t.v[1] ?? 0) * price,
    };
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    const pair = this.pairOf(symbol);
    const mins = INTERVAL_MIN[interval] ?? 60;
    const r = await this.publicRequest<Record<string, unknown>>("OHLC", { pair, interval: mins });
    const rows = Object.entries(r).find(([k]) => k !== "last")?.[1] as Array<Array<string | number>> | undefined;
    if (!rows) return [];
    return rows.slice(-limit).map((k) => {
      const openTime = Number(k[0]) * 1000;
      return {
        openTime,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[6]),
        closeTime: openTime + mins * 60_000 - 1,
      };
    });
  }

  async getAccount(): Promise<Account> {
    const raw = await this.privateRequest<Record<string, string>>("Balance");
    const merged = new Map<string, number>();
    for (const [code, amt] of Object.entries(raw)) {
      const a = normalizeKrakenAsset(code);
      merged.set(a, (merged.get(a) ?? 0) + Number(amt));
    }
    const balances: Balance[] = [...merged.entries()]
      .filter(([, v]) => v > 0)
      .map(([asset, free]) => ({ asset, free, locked: 0 }));

    // Totalvärde i quote-valutan (EUR/USD). Stablecoins räknas 1:1.
    let totalValueUsdt = 0;
    for (const b of balances) {
      if (b.asset === this.cfg.quote || STABLE_QUOTES.includes(b.asset)) {
        totalValueUsdt += b.free;
        continue;
      }
      try {
        totalValueUsdt += b.free * (await this.getTicker(`${b.asset}USDT`)).price;
      } catch { /* okänt par — hoppa över */ }
    }
    return { balances, totalValueUsdt, updatedAt: Date.now() };
  }

  async getPositions(): Promise<Position[]> {
    const acc = await this.getAccount();
    const out: Position[] = [];
    for (const b of acc.balances) {
      if (b.asset === this.cfg.quote || STABLE_QUOTES.includes(b.asset)) continue;
      let price = 0;
      try { price = (await this.getTicker(`${b.asset}USDT`)).price; } catch { /* ignorera */ }
      out.push({
        symbol: `${b.asset}USDT`,
        baseAsset: b.asset,
        quoteAsset: this.cfg.quote,
        quantity: b.free,
        avgEntryPrice: 0, // Kraken spot har ingen ingångskurs per innehav
        currentPrice: price,
        unrealizedPnlUsdt: 0,
        openedAt: 0,
      });
    }
    return out;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const pair = this.pairOf(order.symbol);
    const info = await this.pairInfo(pair);
    let volume = order.quantity;
    let lastPrice = 0;
    if (volume === undefined) {
      if (order.quoteOrderQty === undefined) throw new Error("Kraken: ange antal eller belopp");
      // Kraken tar volym i bas-valuta. Räkna om beloppet med senaste priset.
      lastPrice = (await this.getTicker(order.symbol)).price;
      volume = order.quoteOrderQty / lastPrice;
    }
    const factor = 10 ** info.lot_decimals;
    volume = Math.floor(volume * factor) / factor;
    const min = Number(info.ordermin ?? 0);
    if (!(volume > 0) || volume < min) {
      throw new Error(`Kraken: för litet belopp för ${pair} (minsta volym ${min} ${normalizeKrakenAsset(info.base)})`);
    }

    const params: Record<string, string> = {
      pair,
      type: order.side === "BUY" ? "buy" : "sell",
      ordertype: order.type === "LIMIT" ? "limit" : "market",
      volume: volume.toFixed(info.lot_decimals),
    };
    if (order.type === "LIMIT") {
      if (order.price === undefined) throw new Error("Kraken: LIMIT kräver pris");
      params.price = order.price.toFixed(info.pair_decimals);
    }
    const added = await this.privateRequest<{ txid: string[] }>("AddOrder", params);
    const txid = added.txid?.[0];
    if (!txid) throw new Error("Kraken: inget order-id tillbaka");

    // Hämta utfallet (market-ordrar fylls nästan direkt).
    await new Promise((r) => setTimeout(r, 1000));
    let executedQty = 0, cost = 0, avg = 0, status = "pending";
    try {
      const q = await this.privateRequest<Record<string, { status: string; vol_exec: string; cost: string; price: string }>>(
        "QueryOrders", { txid },
      );
      const o = q[txid];
      if (o) {
        status = o.status;
        executedQty = Number(o.vol_exec);
        cost = Number(o.cost);
        avg = Number(o.price) || (executedQty > 0 ? cost / executedQty : 0);
      }
    } catch { /* ordern ligger ändå hos Kraken; status visas som pending */ }

    return {
      orderId: txid,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status,
      executedQty,
      cummulativeQuoteQty: cost,
      avgFillPrice: avg || lastPrice,
      timestamp: Date.now(),
    };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    void symbol;
    await this.privateRequest("CancelOrder", { txid: orderId });
  }
}
