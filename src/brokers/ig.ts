import type { BrokerAdapter } from "./adapter.js";
import type { Account, Kline, OrderRequest, OrderResult, Position, Ticker } from "../types.js";
import {
  getIgStatus, testIgConnection, getIgAccounts, getIgPositions, igOrderExecutionEnabled, withIgPriority, type IgEnvironment,
} from "../integrations/igConnection.js";
import { getIgOrderState } from "../integrations/igOrders.js";
import { igPositionLimitReason } from "../integrations/igRiskLimits.js";
import { getIgMarket, getIgCandles, type IgTimeframe } from "../integrations/igMarkets.js";
import { previewIgOrder, confirmIgOrder, closeIgPosition } from "../integrations/igOrders.js";

// ═══════════════════════════════════════════════════════════════════════════
// IG som mäklare. TEST = IG Demo (virtuella pengar på IG:s demokonto),
// LIVE = IG Live (riktiga pengar). Samma kod för båda; bara miljön skiljer.
//
//  - symbol = IG EPIC (t.ex. CS.D.EURUSD.MINI.IP). Visningsnamnet kommer från IG.
//  - CFD: SÄLJ utan position öppnar en kort position. Stängning görs alltid
//    med closeDealId (IG close-position), aldrig med en motsatt "sälj".
//  - Ordrar går genom Codex igOrders (granskning → bekräftelse, idempotens,
//    kill switch, budget). Orderläget är AV som standard i båda miljöerna:
//    IG_ORDER_EXECUTION_ENABLED_DEMO / IG_ORDER_EXECUTION_ENABLED_LIVE.
//  - Okänt orderutfall skickas aldrig om.
// ═══════════════════════════════════════════════════════════════════════════

export const IG_EXECUTION_OFF = "Orderläget är avstängt";

export class IgExecutionOffError extends Error {
  constructor(env: IgEnvironment) {
    super(`${IG_EXECUTION_OFF} för IG ${env === "live" ? "Live" : "Demo"}. Inget skickades till IG. (Slås på med IG_ORDER_EXECUTION_ENABLED_${env.toUpperCase()}=true i .env och omstart.)`);
  }
}

const TF: Record<string, IgTimeframe> = { "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d" };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isEpic = (s: string) => /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(s) && s.length <= 100;

export interface IgDeps {
  status: typeof getIgStatus;
  connect: typeof testIgConnection;
  accounts: typeof getIgAccounts;
  positions: typeof getIgPositions;
  market: (env: IgEnvironment, epic: string) => Promise<any>;
  candles: (env: IgEnvironment, epic: string, tf: IgTimeframe, limit: number) => Promise<any>;
  preview: (env: IgEnvironment, input: Record<string, any>) => Promise<any>;
  confirm: (env: IgEnvironment, draftId: string) => Promise<any>;
  close: (env: IgEnvironment, dealId: string) => Promise<any>;
  enabled: (env: IgEnvironment) => boolean;
  now: () => number;
  /** M1: verifierade positioner markerar accepterade order som observerade */
  observe: (env: IgEnvironment, positions: { dealId: string | null }[]) => void;
}

const defaultDeps: IgDeps = {
  status: getIgStatus, connect: testIgConnection, accounts: getIgAccounts, positions: getIgPositions,
  market: getIgMarket, candles: getIgCandles, preview: previewIgOrder, confirm: confirmIgOrder, close: closeIgPosition,
  enabled: igOrderExecutionEnabled, now: Date.now,
  observe: (env, positions) => { try { getIgOrderState(env, positions); } catch { /* bara avstämning */ } },
};
/** Positioner cachas så här länge (samma IG-session). Order och stängningar läser alltid färskt. */
export const IG_POSITIONS_CACHE_MS = 15_000;

/** Pengar för en order i kontovalutan: storlek från IG:s regler, marginal, SL/TP i kronor. */
export interface IgStakeQuote {
  ok: boolean;
  reason?: string;
  epic: string;
  name: string | null;
  direction: "BUY" | "SELL";
  currency: string | null;
  entry: number | null;
  bid: number | null;
  offer: number | null;
  stake: number;
  size: number | null;
  minSize: number | null;
  unit: string | null;
  contractSize: number | null;
  /** Värde av 1 hel prisenhet × 1 kontrakt i kontovalutan */
  pointValue: number | null;
  marginRate: number | null;
  margin: number | null;
  minMargin: number | null;
  exposure: number | null;
  moneyAtSl: number | null;
  moneyAtTp: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  quoteAgeMs: number | null;
  basis: string;
}

export class IgBroker implements BrokerAdapter {
  readonly name: string;
  readonly mode: "paper" | "live";
  readonly env: IgEnvironment;
  private readonly d: IgDeps;
  private connecting: Promise<unknown> | null = null;
  private lastConnectFail = 0;
  private accountCache: { at: number; gen: string | null; value: Account } | null = null;
  private positionsCache: { at: number; gen: string | null; value: Position[] } | null = null;
  private positionsJob: Promise<Position[]> | null = null;

  constructor(env: IgEnvironment, deps: Partial<IgDeps> = {}) {
    this.env = env;
    this.name = env === "live" ? "ig" : "ig-demo";
    this.mode = env === "live" ? "live" : "paper";
    this.d = { ...defaultDeps, ...deps };
  }

  /** IG-status för miljön (utan hemligheter). */
  status() { return this.d.status().environments[this.env]; }
  executionEnabled(): boolean { return this.d.enabled(this.env); }

  /** Ansluter vid behov. Ett misslyckat försök väntar 60 s innan nästa. */
  async ensureConnected(): Promise<void> {
    const s = this.status();
    if (s.status === "connected") return;
    if (!s.credentialsComplete) throw new Error(`IG ${this.env === "live" ? "Live" : "Demo"} saknar inloggningsuppgifter (~/.config/aiupscale/trading-ig.json)`);
    if (this.d.now() - this.lastConnectFail < 60_000) throw new Error(s.error || "IG är inte anslutet (nytt försök inom en minut)");
    this.connecting ??= this.d.connect(this.env).finally(() => { this.connecting = null; });
    await this.connecting;
    const after = this.status();
    if (after.status !== "connected") { this.lastConnectFail = this.d.now(); throw new Error(after.error || "IG kunde inte anslutas"); }
  }

  private epic(symbol: string): string {
    if (!isEpic(symbol)) throw new Error(`"${symbol}" är ingen IG-EPIC. Välj instrument från IG-katalogen.`);
    return symbol;
  }

  async getAccount(): Promise<Account> {
    await this.ensureConnected();
    const gen = this.status().connectionGeneration ?? null;
    if (this.accountCache && this.accountCache.gen === gen && this.d.now() - this.accountCache.at < 15_000) return this.accountCache.value;
    const read = await this.d.accounts(this.env).catch(() => null); // uppdaterar kontosammanfattningen i statusen
    const a = this.status().account;
    if (!a) throw new Error("IG-kontot kunde inte läsas");
    const cur = a.currency ?? "?";
    const balance = finite(a.balance) ? a.balance : null, available = finite(a.available) ? a.available : null;
    const value: Account = {
      balances: [{ asset: cur, free: available ?? 0, locked: balance !== null && available !== null ? Math.max(0, balance - available) : 0 }],
      totalValueUsdt: balance ?? 0,
      updatedAt: this.d.now(),
      currency: cur, balance, available, profitLoss: finite(a.profitLoss) ? a.profitLoss : null,
    };
    // Misslyckad läsning (t.ex. läsgräns): visa senast kända men cacha den inte som färsk
    if (read && (read as { status?: string }).status === "ready") this.accountCache = { at: this.d.now(), gen, value };
    else value.updatedAt = a.updatedAt ?? value.updatedAt;
    return value;
  }

  /** Positioner. Cachas 15 s (singleflight, samma IG-session) så att panelernas polling inte äter läsbudgeten.
   *  fresh = läs alltid från IG (order, stängning, tidsgräns). */
  async getPositions(opts: { fresh?: boolean } = {}): Promise<Position[]> {
    await this.ensureConnected();
    const gen = this.status().connectionGeneration ?? null;
    const c = this.positionsCache;
    if (!opts.fresh && c && c.gen === gen && this.d.now() - c.at < IG_POSITIONS_CACHE_MS) return c.value.map((p) => ({ ...p }));
    if (!opts.fresh && this.positionsJob) return (await this.positionsJob).map((p) => ({ ...p }));
    const job = this.readPositions(gen);
    if (!opts.fresh) this.positionsJob = job;
    try { return (await job).map((p) => ({ ...p })); } finally { if (this.positionsJob === job) this.positionsJob = null; }
  }
  /** Glöm cachen (efter en order/stängning). */
  invalidatePositions(): void { this.positionsCache = null; this.accountCache = null; }

  private async readPositions(gen: string | null): Promise<Position[]> {
    const ps = await this.d.positions(this.env);
    if (ps.status !== "ready" || !Array.isArray(ps.positions)) throw new Error(ps.error || "IG-positionerna kunde inte läsas");
    const out: Position[] = [];
    for (const p of ps.positions as any[]) {
      if (!p.epic || !p.dealId) continue;
      let price: number | null = p.direction === "BUY" ? p.bid : p.offer;
      let pnl: number | null = null, pnlCurrency: string | null = null, name = p.instrumentName ?? p.epic;
      try {
        const m = await this.d.market(this.env, p.epic);
        const q = m.quote, r = m.calculationRules;
        name = m.name ?? name;
        price = p.direction === "BUY" ? q.bid : q.offer;
        const basis = finite(p.level) && finite(p.size) && r?.verified && p.currency === r.executionCurrency;
        if (basis && finite(price)) {
          const delta = (p.direction === "BUY" ? 1 : -1) * (price - p.level);
          pnl = delta * p.size * (delta >= 0 ? r.profitPointValue : r.pointValue);
          pnlCurrency = r.pointCurrency;
        }
      } catch { /* P/L lämnas tom hellre än gissad */ }
      out.push({
        symbol: p.epic, baseAsset: name, quoteAsset: pnlCurrency ?? p.currency ?? "", quantity: p.size ?? 0,
        avgEntryPrice: p.level ?? 0, currentPrice: price ?? 0, unrealizedPnlUsdt: pnl ?? 0, openedAt: 0,
        dealId: p.dealId, direction: p.direction === "SELL" ? "SELL" : "BUY", name, pnlCurrency, pnlVerified: pnl !== null,
        stopLevel: p.stopLevel ?? null, limitLevel: p.limitLevel ?? null,
      });
    }
    this.d.observe(this.env, (ps.positions as any[]).map((p) => ({ dealId: p.dealId ?? null })));
    this.positionsCache = { at: this.d.now(), gen, value: out };
    return out;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    await this.ensureConnected();
    const m = await this.d.market(this.env, this.epic(symbol));
    const q = m.quote;
    if (!finite(q.bid) || !finite(q.offer)) throw new Error("IG-kvot saknas för instrumentet");
    return { symbol, price: (q.bid + q.offer) / 2, changePct24h: finite(q.percentageChange) ? q.percentageChange : 0, volume24h: 0 };
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    await this.ensureConnected();
    const tf = TF[interval];
    if (!tf) throw new Error(`IG stöder inte intervallet ${interval}`);
    const c = await this.d.candles(this.env, this.epic(symbol), tf, Math.min(200, Math.max(20, Math.round(limit) || 100)));
    return (c.candles as any[]).map((b) => ({ openTime: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0, closeTime: b.closeTime }));
  }

  /** Storlek och pengar för en insats (marginal) i kontovalutan. Skickar inget. */
  async stakeQuote(input: { epic: string; direction: "BUY" | "SELL"; stake: number; stopLoss?: number; takeProfit?: number; size?: number }): Promise<IgStakeQuote> {
    await this.ensureConnected();
    const m = await this.d.market(this.env, this.epic(input.epic));
    const q = m.quote, r = m.calculationRules ?? {};
    const entry = input.direction === "BUY" ? q.offer : q.bid;
    const minSize = finite(m.dealingRules?.minDealSize?.value) ? m.dealingRules.minDealSize.value : null;
    const base: IgStakeQuote = {
      ok: false, epic: input.epic, name: m.name ?? null, direction: input.direction, currency: r.pointCurrency ?? null,
      entry: finite(entry) ? entry : null, bid: finite(q.bid) ? q.bid : null, offer: finite(q.offer) ? q.offer : null,
      stake: input.stake, size: null, minSize, unit: m.instrument?.unit ?? null, contractSize: m.instrument?.contractSize ?? null,
      pointValue: finite(r.pointValue) ? r.pointValue : null, marginRate: finite(r.marginRate) ? r.marginRate : null,
      margin: null, minMargin: null, exposure: null, moneyAtSl: null, moneyAtTp: null,
      stopLoss: input.stopLoss ?? null, takeProfit: input.takeProfit ?? null,
      quoteAgeMs: finite(q.observedAt) ? this.d.now() - q.observedAt : null,
      basis: r.note ?? "IG-regler",
    };
    if (!finite(entry) || entry <= 0) return { ...base, reason: "IG-kvot saknas" };
    if (!r.verified || !finite(r.pointValue) || !finite(r.marginRate)) return { ...base, reason: r.note || "IG:s kontraktsvärde eller marginal kunde inte verifieras" };
    const perContractMargin = entry * r.pointValue * r.marginRate;
    const decimals = minSize !== null ? Math.max(0, (String(minSize).split(".")[1] ?? "").length) : 2;
    const step = 10 ** -decimals;
    const raw = input.stake / perContractMargin;
    // Fast antal (quantity) prissätts som det är och måste klara samma budget som en insats
    const size = finite(input.size) && input.size > 0 ? input.size : Math.floor(raw / step + 1e-9) * step;
    const minMargin = minSize !== null ? minSize * perContractMargin : null;
    const priced = (sz: number) => ({
      size: +sz.toFixed(decimals),
      margin: sz * perContractMargin,
      exposure: entry * sz * r.pointValue,
      moneyAtSl: finite(input.stopLoss) ? Math.abs(entry - input.stopLoss) * sz * r.pointValue : null,
      moneyAtTp: finite(input.takeProfit) ? Math.abs(input.takeProfit - entry) * sz * (r.profitPointValue ?? r.pointValue) : null,
    });
    if (minSize !== null && size < minSize) {
      return {
        ...base, minMargin,
        reason: `Minsta IG-kontrakt (${minSize} ${m.instrument?.unit ?? "kontrakt"}) kräver ca ${minMargin!.toFixed(2)} ${r.pointCurrency} i marginal, mer än insatsen ${input.stake.toFixed(2)} ${r.pointCurrency}. Höj insatsen eller välj ett annat instrument.`,
      };
    }
    if (!(size > 0)) return { ...base, minMargin, reason: "Insatsen räcker inte till något kontrakt" };
    const pr = priced(size);
    // Samma gränser som godkännandet (igOrders): marginal ≤ 3 % av saldot, ≤ tillgängligt, SL-förlust ≤ 5 %
    const acc = await this.getAccount().catch(() => null);
    if (acc && finite(acc.balance) && finite(acc.available) && acc.currency === r.pointCurrency) {
      const why = igPositionLimitReason({ margin: pr.margin, risk: pr.moneyAtSl, balance: acc.balance, available: acc.available, currency: acc.currency ?? "" });
      if (why) return { ...base, minMargin, ...pr, ok: false, reason: why };
    }
    return { ...base, ok: true, minMargin, ...pr };
  }

  /** Öppna positioners marginal och exponering i kontovalutan (positioner ur cachen, IG-regler per instrument).
   *  verified=false om någon position inte kan räknas säkert (då visas inget påhittat). */
  async portfolioMargin(): Promise<{ margin: number; exposure: number; positions: number; verified: boolean; currency: string | null }> {
    const acc = await this.getAccount().catch(() => null);
    const ps = await this.getPositions();
    let margin = 0, exposure = 0, verified = !!acc?.currency;
    for (const p of ps) {
      try {
        const m = await this.d.market(this.env, p.symbol), r = m.calculationRules;
        if (!r?.verified || !finite(r.pointValue) || !finite(r.marginRate) || r.pointCurrency !== acc?.currency || !(p.quantity > 0) || !(p.avgEntryPrice > 0)) { verified = false; continue; }
        const ex = p.avgEntryPrice * p.quantity * r.pointValue;
        exposure += ex; margin += ex * r.marginRate;
      } catch { verified = false; }
    }
    return { margin, exposure, positions: ps.length, verified, currency: acc?.currency ?? null };
  }

  /** Standardnivåer om agenten inte gav SL/TP: procent från priset, minst IG:s minsta avstånd × 1,5. */
  async defaultLevels(epic: string, direction: "BUY" | "SELL"): Promise<{ stopLoss: number; takeProfit: number }> {
    const m = await this.d.market(this.env, this.epic(epic));
    const entry = direction === "BUY" ? m.quote.offer : m.quote.bid;
    if (!finite(entry)) throw new Error("IG-kvot saknas");
    const slPct = Number(process.env.IG_DEFAULT_SL_PCT ?? 0.3) / 100, tpPct = Number(process.env.IG_DEFAULT_TP_PCT ?? 0.6) / 100;
    const d = m.dealingRules?.minNormalStopOrLimitDistance, scale = m.instrument?.scalingFactor;
    const minDist = d?.unit === "POINTS" && finite(scale) && scale > 0 ? d.value / scale : d?.unit === "PERCENTAGE" ? entry * d.value / 100 : 0;
    const sl = Math.max(entry * slPct, minDist * 1.5), tp = Math.max(entry * tpPct, minDist * 1.5);
    const dec = Math.max(2, (String(m.quote.offer).split(".")[1] ?? "").length);
    const sign = direction === "BUY" ? 1 : -1;
    return { stopLoss: +(entry - sign * sl).toFixed(dec), takeProfit: +(entry + sign * tp).toFixed(dec) };
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.d.enabled(this.env)) throw new IgExecutionOffError(this.env);
    // Orderns läsningar (granskning + bekräftelse) har förtur i läsbudgeten
    try { return await withIgPriority(() => this.placeOrderInner(order)); } finally { this.invalidatePositions(); }
  }
  private async placeOrderInner(order: OrderRequest): Promise<OrderResult> {
    await this.ensureConnected();
    if (order.closeDealId) return this.closePosition(order.closeDealId, order.symbol);
    const epic = this.epic(order.symbol);
    const direction = order.side;
    let { stopLoss, takeProfit } = order;
    if (!finite(stopLoss) || !finite(takeProfit)) {
      const lv = await this.defaultLevels(epic, direction);
      stopLoss = finite(stopLoss) ? stopLoss : lv.stopLoss;
      takeProfit = finite(takeProfit) ? takeProfit : lv.takeProfit;
    }
    let size = order.quantity;
    if (!finite(size)) {
      const stake = order.stakeAmount;
      if (!finite(stake) || stake <= 0) throw new Error("IG-order kräver insats (kontovaluta) eller antal kontrakt");
      const sq = await this.stakeQuote({ epic, direction, stake, stopLoss, takeProfit });
      if (!sq.ok || !sq.size) throw new Error(sq.reason || "Storleken kunde inte räknas fram");
      size = sq.size;
    }
    const draft = await this.d.preview(this.env, {
      epic, direction, size, orderType: order.type === "LIMIT" ? "LIMIT" : "MARKET",
      entry: order.type === "LIMIT" ? order.price : undefined,
      stopLevel: stopLoss, targetLevel: takeProfit, holdingMinutes: 15, autoClose: false,
    });
    const done = await this.d.confirm(this.env, draft.id);
    const result: OrderResult = {
      orderId: draft.id, symbol: epic, side: direction, type: order.type, status: done.status,
      executedQty: done.status === "accepted" ? size! : 0, cummulativeQuoteQty: done.status === "accepted" ? draft.margin ?? 0 : 0,
      avgFillPrice: draft.entry ?? 0, timestamp: this.d.now(), dealId: done.dealId, dealReference: done.dealReference, error: done.error,
    };
    if (done.status === "unknown") throw new Error(`IG-orderutfallet är okänt (${done.error ?? "ingen bekräftelse"}). Ordern skickas INTE om. Kontrollera i IG.`);
    if (done.status === "rejected") throw new Error(done.error || "IG avvisade ordern");
    return result;
  }

  /** Stänger en IG-position (DELETE /positions/otc med dealId). */
  async closePosition(dealId: string, symbol = ""): Promise<OrderResult> {
    if (!this.d.enabled(this.env)) throw new IgExecutionOffError(this.env);
    await this.ensureConnected();
    const plan = await withIgPriority(() => this.d.close(this.env, dealId)).finally(() => this.invalidatePositions());
    if (plan.status === "unknown") throw new Error(`IG-stängningens utfall är okänt (${plan.error ?? ""}). Skickas inte om; kontrollera i IG.`);
    if (plan.status === "failed") throw new Error(plan.error || "IG avvisade stängningen");
    return { orderId: dealId, symbol, side: "SELL", type: "MARKET", status: plan.status, executedQty: 0, cummulativeQuoteQty: 0, avgFillPrice: 0, timestamp: this.d.now(), dealId, dealReference: plan.dealReference };
  }

  async cancelOrder(_symbol: string, _orderId: string): Promise<void> {
    throw new Error("Att ta bort väntande IG-order stöds inte här; gör det i IG.");
  }
}
