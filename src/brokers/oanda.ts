// ═══════════════════════════════════════════════════════════════════════════
//  OANDA — Forex Broker Adapter
//
//  Stödjer FX-par typ EUR_USD, GBP_USD, USD_JPY. Symbolformat = ICKE-Binance:
//  Oanda använder underscore (EUR_USD), inte slash eller koncatenation.
//
//  Setup:
//    1. Skapa demo-konto: https://www.oanda.com/account/login
//    2. Generera API-token: My Account → Manage API Access
//    3. Lägg in i .env:
//         OANDA_API_KEY=your-token
//         OANDA_ACCOUNT_ID=001-004-12345-001
//         OANDA_BASE_URL=https://api-fxpractice.oanda.com  (demo)
// ═══════════════════════════════════════════════════════════════════════════

import type { BrokerAdapter } from "./adapter.js";
import type {
  Account,
  Kline,
  OrderRequest,
  OrderResult,
  Position,
  Ticker,
} from "../types.js";
import { log } from "../logger.js";

interface OandaConfig {
  apiKey: string;
  accountId: string;
  baseUrl: string;
  isPractice: boolean;
}

export class OandaBroker implements BrokerAdapter {
  readonly name = "oanda";
  readonly mode: "paper" | "live";
  private cfg: OandaConfig;

  constructor(cfg: { apiKey: string; accountId: string; baseUrl: string }) {
    this.cfg = {
      apiKey: cfg.apiKey,
      accountId: cfg.accountId,
      baseUrl: cfg.baseUrl,
      isPractice: cfg.baseUrl.includes("fxpractice"),
    };
    this.mode = this.cfg.isPractice ? "paper" : "live";
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${this.cfg.apiKey}`,
        "Content-Type": "application/json",
        "Accept-Datetime-Format": "RFC3339",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Oanda ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async getAccount(): Promise<Account> {
    const data = await this.request<{
      account: { balance: string; NAV: string; currency: string; unrealizedPL: string };
    }>("GET", `/v3/accounts/${this.cfg.accountId}`);

    const totalValueUsdt = parseFloat(data.account.NAV);
    const cashUsdt = parseFloat(data.account.balance);

    return {
      totalValueUsdt: isNaN(totalValueUsdt) ? 0 : totalValueUsdt,
      cashUsdt: isNaN(cashUsdt) ? 0 : cashUsdt,
      currency: data.account.currency ?? "USD",
    };
  }

  async getPositions(): Promise<Position[]> {
    const data = await this.request<{
      positions: Array<{
        instrument: string;
        long: { units: string; averagePrice: string; unrealizedPL: string };
        short: { units: string; averagePrice: string; unrealizedPL: string };
      }>;
    }>("GET", `/v3/accounts/${this.cfg.accountId}/openPositions`);

    const positions: Position[] = [];
    for (const p of data.positions) {
      const longQty = parseFloat(p.long.units);
      const shortQty = parseFloat(p.short.units);
      if (longQty !== 0) {
        positions.push({
          symbol: p.instrument,
          quantity: longQty,
          avgEntryPrice: parseFloat(p.long.averagePrice),
          currentPrice: 0, // hämtas separat vid behov
          unrealizedPnlUsdt: parseFloat(p.long.unrealizedPL),
        });
      }
      if (shortQty !== 0) {
        positions.push({
          symbol: p.instrument,
          quantity: shortQty,
          avgEntryPrice: parseFloat(p.short.averagePrice),
          currentPrice: 0,
          unrealizedPnlUsdt: parseFloat(p.short.unrealizedPL),
        });
      }
    }
    return positions;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const data = await this.request<{
      prices: Array<{
        instrument: string;
        bids: Array<{ price: string }>;
        asks: Array<{ price: string }>;
        time: string;
      }>;
    }>(
      "GET",
      `/v3/accounts/${this.cfg.accountId}/pricing?instruments=${encodeURIComponent(symbol)}`,
    );

    const p = data.prices?.[0];
    if (!p) throw new Error(`Oanda: ingen pris-data för ${symbol}`);
    const bid = parseFloat(p.bids[0]?.price ?? "0");
    const ask = parseFloat(p.asks[0]?.price ?? "0");
    const mid = (bid + ask) / 2;

    return {
      symbol,
      price: mid,
      bid,
      ask,
      changePct24h: 0, // Oanda ger inte 24h direkt — kan beräknas från klines vid behov
      volume24h: 0,
      high24h: mid,
      low24h: mid,
    };
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    const granularity = mapInterval(interval);
    const data = await this.request<{
      candles: Array<{
        time: string;
        mid: { o: string; h: string; l: string; c: string };
        volume: number;
      }>;
    }>(
      "GET",
      `/v3/instruments/${encodeURIComponent(symbol)}/candles?granularity=${granularity}&count=${limit}&price=M`,
    );

    return data.candles.map((c) => ({
      openTime: new Date(c.time).getTime(),
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
      volume: c.volume,
      closeTime: new Date(c.time).getTime() + intervalMs(interval),
    }));
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    // Oanda kräver units (positivt = köp, negativt = sälj). Vi måste konvertera
    // antingen kvantitet eller USD-belopp till units.
    let units: number;
    if (order.quantity !== undefined) {
      units = order.side === "BUY" ? order.quantity : -order.quantity;
    } else if (order.quoteOrderQty !== undefined) {
      // Hämta nuvarande pris för att konvertera USD → units
      const ticker = await this.getTicker(order.symbol);
      const baseUnits = order.quoteOrderQty / (ticker.price || 1);
      // Forex handlas typiskt i hela enheter — runda av
      units = Math.round(order.side === "BUY" ? baseUnits : -baseUnits);
    } else {
      throw new Error("Order kräver antingen quantity eller quoteOrderQty.");
    }

    if (units === 0) {
      throw new Error(`Beräknad order-storlek är 0 units för ${order.symbol}`);
    }

    const orderType = order.type === "LIMIT" ? "LIMIT" : "MARKET";
    const body: Record<string, unknown> = {
      order: {
        instrument: order.symbol,
        units: String(units),
        type: orderType,
        timeInForce: orderType === "LIMIT" ? "GTC" : "FOK",
        positionFill: "DEFAULT",
      },
    };
    if (orderType === "LIMIT" && order.price !== undefined) {
      (body.order as Record<string, unknown>).price = String(order.price);
    }

    const result = await this.request<{
      orderFillTransaction?: {
        id: string;
        units: string;
        price: string;
        commission: string;
        time: string;
      };
      orderCreateTransaction?: { id: string };
    }>("POST", `/v3/accounts/${this.cfg.accountId}/orders`, body);

    const fill = result.orderFillTransaction;
    if (!fill) {
      // Möjligen pending limit-order; returnera tom result
      return {
        orderId: result.orderCreateTransaction?.id ?? "pending",
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        executedQty: 0,
        cummulativeQuoteQty: 0,
        avgFillPrice: 0,
        status: "PENDING",
      };
    }

    const executedQty = Math.abs(parseFloat(fill.units));
    const fillPrice = parseFloat(fill.price);
    log.trade(`Oanda fill: ${order.side} ${executedQty} ${order.symbol} @ ${fillPrice.toFixed(5)}`);

    return {
      orderId: fill.id,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      executedQty,
      cummulativeQuoteQty: executedQty * fillPrice,
      avgFillPrice: fillPrice,
      status: "FILLED",
    };
  }

  async cancelOrder(_symbol: string, orderId: string): Promise<void> {
    await this.request("PUT", `/v3/accounts/${this.cfg.accountId}/orders/${orderId}/cancel`);
  }
}

// Oanda-granularitet-mappning från standardintervall
function mapInterval(interval: string): string {
  const map: Record<string, string> = {
    "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30",
    "1h": "H1", "4h": "H4", "1d": "D", "1w": "W",
  };
  return map[interval] ?? "H1";
}

function intervalMs(interval: string): number {
  const map: Record<string, number> = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
  };
  return map[interval] ?? 3_600_000;
}
