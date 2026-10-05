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

// Bybit EU-adapter (spot, API v5). Bybit EU har EU-licens (MiCA) och tillåter
// API-handel från Sverige. Kontot är alltid riktiga pengar, så den här
// mäklaren är LIVE. Order-grinden släpper bara igenom ordrar när MODE=live
// och LIVE_TRADING_CONFIRMED=true.
//
// Resten av systemet använder "BTCUSDT". Här mappas symbolerna till Bybits par
// i vald quote-valuta (BYBIT_QUOTE, standard USDC eftersom USDT är begränsat i EU):
// BTCUSDT → BTCUSDC.

interface BybitConfig {
  apiKey: string;
  apiSecret: string;
  quote: string;
  baseUrl: string;
}

interface BybitResp<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

interface BybitInstrument {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  lotSizeFilter: { basePrecision: string; quotePrecision?: string; minOrderQty: string; minOrderAmt: string };
  priceFilter: { tickSize: string };
}

const STABLES = ["USDT", "USDC", "USD", "EUR", "BUSD", "FDUSD"];
const INTERVAL: Record<string, string> = {
  "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D", "1w": "W",
};
const RECV_WINDOW = "5000";

function decimals(step: string): number {
  const s = String(step);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.replace(/0+$/, "").length - i - 1;
}

export class BybitBroker implements BrokerAdapter {
  readonly name: string;
  // "paper" = Bybits demokonto (Demo Trading): samma börs, par och priser som LIVE, fast låtsaspengar.
  readonly mode: "paper" | "live";
  private readonly cfg: BybitConfig;
  private instCache = new Map<string, BybitInstrument>();

  constructor(cfg: Partial<BybitConfig> & { apiKey: string; apiSecret: string; demo?: boolean }) {
    this.mode = cfg.demo ? "paper" : "live";
    this.name = cfg.demo ? "bybit-demo" : "bybit";
    this.cfg = {
      quote: (cfg.quote || "USDC").toUpperCase(),
      baseUrl: cfg.baseUrl || "https://api.bybit.eu",
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
    };
  }

  /** Minsta köpbelopp i USD som går att sälja tillbaka (minsta order + 10 %). */
  async minBuyUsd(symbol: string): Promise<number> {
    return sellableMinUsd(await this.instrument(this.pairOf(symbol)));
  }

  private baseOf(symbol: string): string {
    const s = symbol.toUpperCase().replace("/", "");
    for (const q of STABLES) if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length);
    return s;
  }

  private pairOf(symbol: string): string {
    return `${this.baseOf(symbol)}${this.cfg.quote}`;
  }

  // Signatur v5: HMAC-SHA256(timestamp + apiKey + recvWindow + (query | json-body)), hex.
  sign(timestamp: string, payload: string): string {
    return crypto
      .createHmac("sha256", this.cfg.apiSecret)
      .update(timestamp + this.cfg.apiKey + RECV_WINDOW + payload)
      .digest("hex");
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string | number> = {},
    signed = false,
  ): Promise<T> {
    const strParams = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const query = method === "GET" ? new URLSearchParams(strParams).toString() : "";
    const body = method === "POST" ? JSON.stringify(strParams) : undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (signed) {
      const ts = String(Date.now());
      headers["X-BAPI-API-KEY"] = this.cfg.apiKey;
      headers["X-BAPI-TIMESTAMP"] = ts;
      headers["X-BAPI-RECV-WINDOW"] = RECV_WINDOW;
      headers["X-BAPI-SIGN"] = this.sign(ts, method === "GET" ? query : (body ?? ""));
    }
    const url = `${this.cfg.baseUrl}${path}${query ? `?${query}` : ""}`;
    const res = await fetch(url, { method, headers, body });
    if (!res.ok) throw new Error(`Bybit ${method} ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as BybitResp<T>;
    if (data.retCode !== 0) throw new Error(`Bybit ${path}: ${data.retMsg} (kod ${data.retCode})`);
    return data.result;
  }

  private async instrument(pair: string): Promise<BybitInstrument> {
    const c = this.instCache.get(pair);
    if (c) return c;
    const r = await this.request<{ list: BybitInstrument[] }>("GET", "/v5/market/instruments-info", { category: "spot", symbol: pair });
    const inst = r.list?.[0];
    if (!inst) throw new Error(`Bybit: paret ${pair} finns inte`);
    this.instCache.set(pair, inst);
    return inst;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const pair = this.pairOf(symbol);
    const r = await this.request<{ list: Array<{ lastPrice: string; price24hPcnt: string; turnover24h: string }> }>(
      "GET", "/v5/market/tickers", { category: "spot", symbol: pair },
    );
    const t = r.list?.[0];
    if (!t) throw new Error(`Bybit: inget pris för ${pair}`);
    return {
      symbol,
      price: Number(t.lastPrice),
      changePct24h: Number(t.price24hPcnt) * 100,
      volume24h: Number(t.turnover24h),
    };
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    const iv = INTERVAL[interval] ?? "60";
    const r = await this.request<{ list: string[][] }>("GET", "/v5/market/kline", {
      category: "spot", symbol: this.pairOf(symbol), interval: iv, limit: Math.min(limit, 1000),
    });
    const ms = iv === "D" ? 86_400_000 : iv === "W" ? 604_800_000 : Number(iv) * 60_000;
    // Bybit levererar nyast först — vänd till äldst först som resten av systemet.
    return (r.list ?? []).slice().reverse().map((k) => {
      const openTime = Number(k[0]);
      return {
        openTime,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: openTime + ms - 1,
      };
    });
  }

  async getAccount(): Promise<Account> {
    const r = await this.request<{
      list: Array<{ totalEquity: string; coin: Array<{ coin: string; walletBalance: string; locked: string; usdValue: string }> }>;
    }>("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" }, true);
    const acc = r.list?.[0];
    const balances: Balance[] = (acc?.coin ?? [])
      .map((c) => ({ asset: c.coin, free: Number(c.walletBalance) - Number(c.locked || 0), locked: Number(c.locked || 0) }))
      .filter((b) => b.free + b.locked > 0);
    return { balances, totalValueUsdt: Number(acc?.totalEquity ?? 0), updatedAt: Date.now() };
  }

  /** Rått Unified-saldo (för live-vyn innan websocket-uppdateringen kommer). */
  async getWalletRaw(): Promise<Record<string, unknown> | null> {
    const r = await this.request<{ list: Array<Record<string, unknown>> }>(
      "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" }, true,
    );
    return r.list?.[0] ?? null;
  }

  /**
   * Funding-plånboken: dit insättningar ofta hamnar. Boten handlar inte
   * därifrån, men saldot visas så att Mike ser var pengarna ligger.
   * Kräver att API-nyckeln har läsrätt för Assets → Wallet.
   */
  async getFundingBalances(): Promise<Array<{ coin: string; balance: number; usdValue: number }>> {
    const r = await this.request<{ balance: Array<{ coin: string; walletBalance: string }> }>(
      "GET", "/v5/asset/transfer/query-account-coins-balance", { accountType: "FUND" }, true,
    );
    const out: Array<{ coin: string; balance: number; usdValue: number }> = [];
    for (const b of r.balance ?? []) {
      const balance = Number(b.walletBalance);
      if (!(balance > 0)) continue;
      let usdValue = 0;
      if (STABLES.includes(b.coin)) usdValue = balance;
      else {
        try { usdValue = balance * (await this.getTicker(`${b.coin}USDT`)).price; } catch { /* okänt par */ }
      }
      out.push({ coin: b.coin, balance, usdValue });
    }
    return out;
  }

  async getPositions(): Promise<Position[]> {
    const acc = await this.getAccount();
    const out: Position[] = [];
    for (const b of acc.balances) {
      if (STABLES.includes(b.asset)) continue;
      let price = 0;
      try { price = (await this.getTicker(`${b.asset}USDT`)).price; } catch { /* ignorera */ }
      out.push({
        symbol: `${b.asset}USDT`,
        baseAsset: b.asset,
        quoteAsset: this.cfg.quote,
        quantity: b.free + b.locked,
        avgEntryPrice: 0,
        currentPrice: price,
        unrealizedPnlUsdt: 0,
        openedAt: 0,
      });
    }
    return out;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const pair = this.pairOf(order.symbol);
    const inst = await this.instrument(pair);
    const params: Record<string, string> = {
      category: "spot",
      symbol: pair,
      side: order.side === "BUY" ? "Buy" : "Sell",
      orderType: order.type === "LIMIT" ? "Limit" : "Market",
    };

    if (order.type === "MARKET" && order.side === "BUY" && order.quantity === undefined) {
      // Köp för ett belopp i quote-valutan (t.ex. 5 USDC)
      const amt = Number(order.quoteOrderQty);
      const qd = decimals(inst.lotSizeFilter.quotePrecision ?? "0.01");
      const rounded = Math.floor(amt * 10 ** qd) / 10 ** qd;
      if (!(rounded >= Number(inst.lotSizeFilter.minOrderAmt))) {
        throw new Error(`Bybit: minsta belopp för ${pair} är ${inst.lotSizeFilter.minOrderAmt} ${this.cfg.quote}`);
      }
      // Köper man för exakt minsta beloppet går det inte att sälja tillbaka
      // (avgiften drar ned värdet under minsta order). Kräv 10 % marginal.
      const sellable = sellableMinUsd(inst);
      if (rounded < sellable) {
        throw new Error(`Bybit: ${pair} kräver minst ${inst.lotSizeFilter.minOrderAmt} ${this.cfg.quote} per order, så köp för minst $${sellable.toFixed(2)} för att kunna sälja tillbaka (eller välj BTC, minst $1)`);
      }
      params.marketUnit = "quoteCoin";
      params.qty = rounded.toFixed(qd);
    } else {
      let qty = order.quantity;
      const ref = order.type === "LIMIT" && order.price ? order.price : (await this.getTicker(order.symbol)).price;
      if (qty === undefined) {
        if (order.quoteOrderQty === undefined) throw new Error("Bybit: ange antal eller belopp");
        qty = order.quoteOrderQty / ref;
      }
      // Sälj aldrig mer än vi har fritt (köpavgiften dras i myntet, så "$5" kan vara för mycket)
      if (order.side === "SELL") {
        const base = this.baseOf(order.symbol);
        const acc = await this.getAccount();
        const free = acc.balances.find((b) => b.asset === base)?.free ?? 0;
        if (!(free > 0)) throw new Error(`Bybit: du har inga ${base} att sälja`);
        if (qty > free) qty = free;
      }
      const bd = decimals(inst.lotSizeFilter.basePrecision);
      qty = Math.floor(qty * 10 ** bd) / 10 ** bd;
      if (order.side === "SELL" && qty * ref < Number(inst.lotSizeFilter.minOrderAmt)) {
        throw new Error(`Bybit: ${pair} kräver minst ${inst.lotSizeFilter.minOrderAmt} ${this.cfg.quote} per order, innehavet är värt ca $${(qty * ref).toFixed(2)}`);
      }
      if (!(qty >= Number(inst.lotSizeFilter.minOrderQty))) {
        throw new Error(`Bybit: minsta antal för ${pair} är ${inst.lotSizeFilter.minOrderQty}`);
      }
      params.marketUnit = "baseCoin";
      params.qty = qty.toFixed(bd);
      if (order.type === "LIMIT") {
        if (order.price === undefined) throw new Error("Bybit: LIMIT kräver pris");
        params.price = order.price.toFixed(decimals(inst.priceFilter.tickSize));
        delete params.marketUnit;
      }
    }

    // TP/SL följer med LIMIT-ordrar hos Bybit. MARKET-köp i LIVE bevakas i
    // stället av boten (src/server/liveTpSl.ts) och säljs vid TP/SL.
    const tick = decimals(inst.priceFilter.tickSize);
    if (order.type === "LIMIT" && order.takeProfit !== undefined) { params.takeProfit = order.takeProfit.toFixed(tick); params.tpOrderType = "Market"; }
    if (order.type === "LIMIT" && order.stopLoss !== undefined) { params.stopLoss = order.stopLoss.toFixed(tick); params.slOrderType = "Market"; }

    const created = await this.request<{ orderId: string }>("POST", "/v5/order/create", params, true);
    const orderId = created.orderId;

    await new Promise((r) => setTimeout(r, 1000));
    let status = "New", executedQty = 0, cost = 0, avg = 0;
    try {
      const q = await this.request<{ list: Array<{ orderStatus: string; cumExecQty: string; cumExecValue: string; avgPrice: string }> }>(
        "GET", "/v5/order/realtime", { category: "spot", orderId }, true,
      );
      let o = q.list?.[0];
      if (!o) {
        const h = await this.request<{ list: typeof q.list }>("GET", "/v5/order/history", { category: "spot", orderId }, true);
        o = h.list?.[0];
      }
      if (o) {
        status = o.orderStatus;
        executedQty = Number(o.cumExecQty);
        cost = Number(o.cumExecValue);
        avg = Number(o.avgPrice) || (executedQty > 0 ? cost / executedQty : 0);
      }
    } catch { /* ordern finns hos Bybit; status visas som New */ }

    return {
      orderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status,
      executedQty,
      cummulativeQuoteQty: cost,
      avgFillPrice: avg,
      timestamp: Date.now(),
    };
  }

  /** Stäm av accepterade ordrar innan en ny säljorder får skickas. */
  async getOrderResult(symbol: string, orderId: string): Promise<OrderResult | null> {
    type Row = { orderStatus: string; cumExecQty: string; cumExecValue: string; avgPrice: string; side: "Buy" | "Sell"; orderType: "Market" | "Limit" };
    const params = { category: "spot", symbol: this.pairOf(symbol), orderId };
    const q = await this.request<{ list: Row[] }>("GET", "/v5/order/realtime", params, true);
    const o = q.list?.[0] ?? (await this.request<{ list: Row[] }>("GET", "/v5/order/history", params, true)).list?.[0];
    if (!o) return null;
    const qty = Number(o.cumExecQty), cost = Number(o.cumExecValue);
    return { orderId, symbol, side: o.side === "Buy" ? "BUY" : "SELL", type: o.orderType === "Limit" ? "LIMIT" : "MARKET",
      status: o.orderStatus, executedQty: qty, cummulativeQuoteQty: cost, avgFillPrice: Number(o.avgPrice) || (qty > 0 ? cost / qty : 0), timestamp: Date.now() };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.request("POST", "/v5/order/cancel", { category: "spot", symbol: this.pairOf(symbol), orderId }, true);
  }
}

/** Minsta order + 10 % marginal (avgift och kursrörelse), så att köpet går att sälja. */
function sellableMinUsd(inst: BybitInstrument): number {
  const min = Number(inst.lotSizeFilter.minOrderAmt) || 0;
  return Math.ceil(min * 1.1 * 100) / 100;
}
