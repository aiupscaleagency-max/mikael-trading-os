import { log } from "../../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Oanda API-integration — Practice (demo) eller Live forex-trading
//
// Mike vill: forex via Oanda för cross-pairs som Binance saknar
// Symbol-format: EUR/USD ↔ EUR_USD (Oanda)
// ═══════════════════════════════════════════════════════════════════════════

export interface OandaCredentials {
  apiToken: string;
  accountId: string;
  practice: boolean;
}

const PRACTICE_BASE = "https://api-fxpractice.oanda.com";
const LIVE_BASE = "https://api-fxtrade.oanda.com";

export class OandaClient {
  private apiToken: string;
  private accountId: string;
  private baseUrl: string;
  readonly mode: "practice" | "live";

  constructor(creds: OandaCredentials) {
    if (!creds.apiToken || !creds.accountId) {
      throw new Error("Oanda kräver apiToken + accountId");
    }
    this.apiToken = creds.apiToken;
    this.accountId = creds.accountId;
    this.baseUrl = creds.practice ? PRACTICE_BASE : LIVE_BASE;
    this.mode = creds.practice ? "practice" : "live";
  }

  // EUR/USD → EUR_USD
  private oandaSymbol(s: string): string {
    return s.replace("/", "_");
  }

  private async request<T = unknown>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
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
      throw new Error(`Oanda ${method} ${path} → ${r.status}: ${errText.slice(0, 300)}`);
    }
    return r.json() as Promise<T>;
  }

  async getAccountSummary(): Promise<{
    balance: number;
    NAV: number;
    unrealizedPL: number;
    openTradeCount: number;
    currency: string;
  }> {
    type Resp = {
      account: {
        balance: string;
        NAV: string;
        unrealizedPL: string;
        openTradeCount: number;
        currency: string;
      };
    };
    const data = await this.request<Resp>("GET", `/v3/accounts/${this.accountId}/summary`);
    return {
      balance: parseFloat(data.account.balance),
      NAV: parseFloat(data.account.NAV),
      unrealizedPL: parseFloat(data.account.unrealizedPL),
      openTradeCount: data.account.openTradeCount,
      currency: data.account.currency,
    };
  }

  async getPrice(symbol: string): Promise<{ bid: number; ask: number; mid: number }> {
    const oSym = this.oandaSymbol(symbol);
    type Resp = { prices: Array<{ bids: Array<{ price: string }>; asks: Array<{ price: string }> }> };
    const data = await this.request<Resp>("GET", `/v3/accounts/${this.accountId}/pricing?instruments=${oSym}`);
    const p = data.prices[0];
    if (!p) throw new Error(`Oanda saknar pris för ${symbol}`);
    const bid = parseFloat(p.bids[0]?.price || "0");
    const ask = parseFloat(p.asks[0]?.price || "0");
    return { bid, ask, mid: (bid + ask) / 2 };
  }

  async placeMarketOrder(params: {
    symbol: string;
    side: "BUY" | "SELL";
    units: number; // positiv = BUY, signering hanteras här
    clientOrderId?: string;
  }): Promise<{
    orderId: string;
    fillPrice: number;
    units: number;
    pl?: number;
  }> {
    const oSym = this.oandaSymbol(params.symbol);
    const signedUnits = params.side === "BUY" ? Math.abs(params.units) : -Math.abs(params.units);
    log.info(`[oanda-${this.mode}] PLACE ORDER ${params.side} ${oSym} ${signedUnits} units`);
    type Resp = {
      orderFillTransaction?: {
        id: string;
        instrument: string;
        units: string;
        price: string;
        pl: string;
      };
    };
    const data = await this.request<Resp>("POST", `/v3/accounts/${this.accountId}/orders`, {
      order: {
        type: "MARKET",
        instrument: oSym,
        units: String(signedUnits),
        timeInForce: "FOK",
        positionFill: "DEFAULT",
      },
    });
    const fill = data.orderFillTransaction;
    if (!fill) throw new Error("Oanda returnerade ingen fill");
    return {
      orderId: fill.id,
      fillPrice: parseFloat(fill.price),
      units: parseFloat(fill.units),
      pl: parseFloat(fill.pl || "0"),
    };
  }

  async getOpenPositions(): Promise<Array<{ instrument: string; long: number; short: number; unrealizedPL: number }>> {
    type Resp = {
      positions: Array<{
        instrument: string;
        long: { units: string; unrealizedPL: string };
        short: { units: string; unrealizedPL: string };
      }>;
    };
    const data = await this.request<Resp>("GET", `/v3/accounts/${this.accountId}/openPositions`);
    return data.positions.map((p) => ({
      instrument: p.instrument,
      long: parseFloat(p.long.units),
      short: parseFloat(p.short.units),
      unrealizedPL: parseFloat(p.long.unrealizedPL) + parseFloat(p.short.unrealizedPL),
    }));
  }

  async healthCheck(): Promise<{ ok: boolean; balance: number; openTrades: number; details: string }> {
    try {
      const account = await this.getAccountSummary();
      return {
        ok: true,
        balance: account.balance,
        openTrades: account.openTradeCount,
        details: `Oanda ${this.mode} OK · balance ${account.balance} ${account.currency} · ${account.openTradeCount} öppna`,
      };
    } catch (err) {
      return {
        ok: false,
        balance: 0,
        openTrades: 0,
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

const clientCache = new Map<string, OandaClient>();

export function getOandaClient(creds: OandaCredentials): OandaClient {
  const key = `${creds.practice ? "p" : "l"}-${creds.accountId}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, new OandaClient(creds));
  }
  return clientCache.get(key)!;
}
