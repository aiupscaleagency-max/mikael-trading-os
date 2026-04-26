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
//  Alpaca broker-adapter: aktier + optioner, paper + live.
//
//  Alpaca REST API: https://docs.alpaca.markets/reference/
//  - Trading:     {baseUrl}/v2/account, /v2/orders, /v2/positions
//  - Market data: https://data.alpaca.markets/v2/stocks/...
//  - Options:     /v2/orders med class="option", OCC-symbologie
//
//  Auth: headers APCA-API-KEY-ID + APCA-API-SECRET-KEY (samma för paper/live,
//  olika nycklar)
// ═══════════════════════════════════════════════════════════════════════════

interface AlpacaConfig {
  keyId: string;
  secretKey: string;
  baseUrl: string; // paper-api.alpaca.markets eller api.alpaca.markets
  dataUrl: string; // data.alpaca.markets
  mode: "paper" | "live";
}

// ── Alpaca response-typer ──

interface AlpacaAccount {
  id: string;
  status: string;
  equity: string;
  cash: string;
  buying_power: string;
  portfolio_value: string;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
  transfers_blocked: boolean;
}

interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
  market_value: string;
  side: string;
  asset_class: string;
}

interface AlpacaOrder {
  id: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  filled_qty: string;
  filled_avg_price: string;
  created_at: string;
  order_class?: string;
}

interface AlpacaBar {
  t: string; // ISO timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaSnapshot {
  latestTrade?: { p: number };
  dailyBar?: { o: number; c: number; v: number };
  prevDailyBar?: { c: number };
}

export class AlpacaBroker implements BrokerAdapter {
  readonly name = "alpaca";
  readonly mode: "paper" | "live";
  private readonly cfg: AlpacaConfig;

  constructor(cfg: AlpacaConfig) {
    this.cfg = cfg;
    this.mode = cfg.mode;
  }

  private headers(): Record<string, string> {
    return {
      "APCA-API-KEY-ID": this.cfg.keyId,
      "APCA-API-SECRET-KEY": this.cfg.secretKey,
      "Content-Type": "application/json",
    };
  }

  private async tradingRequest<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca ${method} ${path} ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  private async dataRequest<T>(path: string): Promise<T> {
    const url = `${this.cfg.dataUrl}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca data ${path} ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  // ── BrokerAdapter implementation ──

  async getAccount(): Promise<Account> {
    const acc = await this.tradingRequest<AlpacaAccount>("GET", "/v2/account");
    const equity = Number(acc.equity);
    const cash = Number(acc.cash);
    const balances: Balance[] = [
      { asset: "USD", free: cash, locked: equity - cash },
    ];
    return {
      balances,
      totalValueUsdt: equity, // USD ≈ USDT för portfölj-rapportering
      updatedAt: Date.now(),
    };
  }

  async getPositions(): Promise<Position[]> {
    const positions = await this.tradingRequest<AlpacaPosition[]>("GET", "/v2/positions");
    return positions.map((p) => ({
      symbol: p.symbol,
      baseAsset: p.symbol,
      quoteAsset: "USD",
      quantity: Math.abs(Number(p.qty)),
      avgEntryPrice: Number(p.avg_entry_price),
      currentPrice: Number(p.current_price),
      unrealizedPnlUsdt: Number(p.unrealized_pl),
      openedAt: 0,
    }));
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const snap = await this.dataRequest<AlpacaSnapshot>(
      `/v2/stocks/${symbol}/snapshot`,
    );
    const price = snap.latestTrade?.p ?? snap.dailyBar?.c ?? 0;
    const prevClose = snap.prevDailyBar?.c ?? price;
    const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    return {
      symbol,
      price,
      changePct24h: changePct,
      volume24h: snap.dailyBar?.v ?? 0,
    };
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    // Mappa vårt interval-format (1h, 4h, 1d) till Alpaca timeframe
    const tfMap: Record<string, string> = {
      "1m": "1Min",
      "5m": "5Min",
      "15m": "15Min",
      "1h": "1Hour",
      "4h": "4Hour",
      "1d": "1Day",
    };
    const timeframe = tfMap[interval] ?? "1Hour";

    // Alpaca ger bars 1000 åt gången, vi begär 'limit' stycken
    const bars = await this.dataRequest<{ bars: AlpacaBar[] }>(
      `/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&sort=asc`,
    );
    return (bars.bars ?? []).map((b) => ({
      openTime: new Date(b.t).getTime(),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
      closeTime: new Date(b.t).getTime(),
    }));
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const body: Record<string, unknown> = {
      symbol: order.symbol,
      side: order.side.toLowerCase(),
      type: order.type.toLowerCase(),
      time_in_force: order.type === "MARKET" ? "day" : "gtc",
    };

    if (order.quantity !== undefined) {
      body.qty = String(order.quantity);
    } else if (order.quoteOrderQty !== undefined) {
      // Alpaca stöder 'notional' istället för quoteOrderQty
      body.notional = String(order.quoteOrderQty);
    }

    if (order.type === "LIMIT" && order.price !== undefined) {
      body.limit_price = String(order.price);
    }

    const resp = await this.tradingRequest<AlpacaOrder>("POST", "/v2/orders", body);
    const filledQty = Number(resp.filled_qty || 0);
    const avgPrice = Number(resp.filled_avg_price || 0);

    return {
      orderId: resp.id,
      symbol: resp.symbol,
      side: order.side,
      type: order.type,
      status: resp.status,
      executedQty: filledQty,
      cummulativeQuoteQty: filledQty * avgPrice,
      avgFillPrice: avgPrice,
      timestamp: new Date(resp.created_at).getTime(),
    };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    void symbol;
    await this.tradingRequest("DELETE", `/v2/orders/${orderId}`);
  }

  // ── Options-specifika metoder ──

  /**
   * Hämtar tillgängliga optionskontrakt (options chain) för en underlying.
   * Returnerar dem som en array; Claude väljer sen rätt kontrakt.
   */
  async getOptionsChain(
    underlying: string,
    params?: {
      expirationDateGte?: string; // YYYY-MM-DD
      expirationDateLte?: string;
      optionType?: "call" | "put";
      strikeGte?: number;
      strikeLte?: number;
      limit?: number;
    },
  ): Promise<OptionContract[]> {
    const query = new URLSearchParams({
      underlying_symbols: underlying,
      limit: String(params?.limit ?? 50),
      status: "active",
    });
    if (params?.expirationDateGte) query.set("expiration_date_gte", params.expirationDateGte);
    if (params?.expirationDateLte) query.set("expiration_date_lte", params.expirationDateLte);
    if (params?.optionType) query.set("type", params.optionType);
    if (params?.strikeGte) query.set("strike_price_gte", String(params.strikeGte));
    if (params?.strikeLte) query.set("strike_price_lte", String(params.strikeLte));

    const resp = await this.dataRequest<{ option_contracts?: RawOptionContract[] }>(
      `/v1beta1/options/contracts?${query}`,
    );
    return (resp.option_contracts ?? []).map((c) => ({
      symbol: c.symbol,
      name: c.name,
      underlying: c.underlying_symbol,
      type: c.type as "call" | "put",
      strikePrice: Number(c.strike_price),
      expirationDate: c.expiration_date,
      status: c.status,
    }));
  }

  /** Hämtar snapshot (bid/ask/greeks) för en lista av optionskontrakt. */
  async getOptionsSnapshots(symbols: string[]): Promise<OptionSnapshot[]> {
    if (symbols.length === 0) return [];
    const query = `symbols=${symbols.join(",")}`;
    const resp = await this.dataRequest<{ snapshots?: Record<string, RawOptionSnapshot> }>(
      `/v1beta1/options/snapshots?${query}`,
    );
    const result: OptionSnapshot[] = [];
    for (const [sym, snap] of Object.entries(resp.snapshots ?? {})) {
      result.push({
        symbol: sym,
        bidPrice: snap.latestQuote?.bp ?? 0,
        askPrice: snap.latestQuote?.ap ?? 0,
        lastPrice: snap.latestTrade?.p ?? 0,
        impliedVolatility: snap.greeks?.iv ?? null,
        delta: snap.greeks?.delta ?? null,
        theta: snap.greeks?.theta ?? null,
        gamma: snap.greeks?.gamma ?? null,
      });
    }
    return result;
  }

  /** Lägg en options-order (sell put, sell call, etc.) */
  async placeOptionOrder(params: {
    contractSymbol: string;
    side: "buy" | "sell";
    qty: number;
    type: "market" | "limit";
    limitPrice?: number;
    timeInForce?: string;
  }): Promise<OrderResult> {
    const body: Record<string, unknown> = {
      symbol: params.contractSymbol,
      qty: String(params.qty),
      side: params.side,
      type: params.type,
      time_in_force: params.timeInForce ?? "day",
    };
    if (params.type === "limit" && params.limitPrice !== undefined) {
      body.limit_price = String(params.limitPrice);
    }

    const resp = await this.tradingRequest<AlpacaOrder>("POST", "/v2/orders", body);
    const filledQty = Number(resp.filled_qty || 0);
    const avgPrice = Number(resp.filled_avg_price || 0);
    return {
      orderId: resp.id,
      symbol: params.contractSymbol,
      side: params.side === "buy" ? "BUY" : "SELL",
      type: params.type === "market" ? "MARKET" : "LIMIT",
      status: resp.status,
      executedQty: filledQty,
      cummulativeQuoteQty: filledQty * avgPrice * 100, // 1 kontrakt = 100 aktier
      avgFillPrice: avgPrice,
      timestamp: new Date(resp.created_at).getTime(),
    };
  }
}

// ── Interna typer för Alpaca-svar ──

export interface OptionContract {
  symbol: string;
  name: string;
  underlying: string;
  type: "call" | "put";
  strikePrice: number;
  expirationDate: string;
  status: string;
}

export interface OptionSnapshot {
  symbol: string;
  bidPrice: number;
  askPrice: number;
  lastPrice: number;
  impliedVolatility: number | null;
  delta: number | null;
  theta: number | null;
  gamma: number | null;
}

interface RawOptionContract {
  symbol: string;
  name: string;
  underlying_symbol: string;
  type: string;
  strike_price: string;
  expiration_date: string;
  status: string;
}

interface RawOptionSnapshot {
  latestQuote?: { bp: number; ap: number };
  latestTrade?: { p: number };
  greeks?: { iv: number; delta: number; theta: number; gamma: number };
}
