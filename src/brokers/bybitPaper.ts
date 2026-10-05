import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrokerAdapter } from "./adapter.js";
import type { Account, Balance, Kline, OrderRequest, OrderResult, Position, Ticker } from "../types.js";
import { getTradeFeeRate } from "../risk/tradeSizing.js";
import { BybitBroker } from "./bybit.js";

// ═══════════════════════════════════════════════════════════════════════════
// BYBIT EU TEST — låtsaspengar i boten, riktiga priser från Bybit EU
// ═══════════════════════════════════════════════════════════════════════════
// Bybit EU har ingen demo-API (testat 2026-10-03), och Mike vill varken ha
// riktiga pengar i TEST. Därför fylls TEST-ordrar här, mot Bybit
// EU:s riktiga orderbok (köp på bästa sälj-pris, sälj på bästa köp-pris) med
// samma avgift som Bybit. Inga pengar rör sig och ingen order skickas till Bybit.
//
// Saldot sparas i data/bybit-paper.json. Startsaldo: PAPER_START_USDC (1 000 000).
// LIMIT-ordrar och TP/SL ligger kvar här och fylls när priset når dit
// (kollas var 5:e sekund medan något väntar).
// ═══════════════════════════════════════════════════════════════════════════

const FEE = getTradeFeeRate(); // Samma avgift i TEST och vinstberäkningen.
const FILE = path.resolve("data/bybit-paper.json");
const STABLES = ["USDT", "USDC", "USD", "EUR", "BUSD", "FDUSD"];

interface Holding { qty: number; avg: number; openedAt: number }
interface OpenOrder {
  id: string;
  base: string;
  side: "BUY" | "SELL";
  kind: "LIMIT" | "TP" | "SL";
  qty: number;
  price: number;
  /** TP och SL hör ihop: fylls den ena tas den andra bort */
  group?: string;
  /** LIMIT-köp med TP/SL: läggs först när köpet fyllts */
  tp?: number;
  sl?: number;
  createdAt: number;
}
export interface PaperLot {
  base: string; remaining: number;
  buyQty?: number | null; entryPrice?: number | null; entryFee?: number | null;
  costBasisRemaining?: number | null; openedAt?: number | null;
}
export interface PaperFill {
  id: string; base: string; side: string; qty: number; price: number; fee: number;
  at: number; kind: string; pnl?: number; tradeId?: string; orderId?: string; group?: string;
}
export interface PaperState {
  initialCapital: number;
  lots: Record<string, PaperLot>;
  usdc: number;
  holdings: Record<string, Holding>;
  open: OpenOrder[];
  fills: PaperFill[];
}

export class BybitPaperBroker implements BrokerAdapter {
  readonly name = "bybit-paper";
  readonly mode = "paper" as const;
  private readonly market: BybitBroker;
  private state: PaperState;
  private timer: NodeJS.Timeout | null = null;
  private readonly baseUrl: string;

  constructor(cfg: { quote?: string; baseUrl?: string } = {}) {
    // Bara publika anrop (pris, ljus, orderbok): inga nycklar behövs.
    this.baseUrl = cfg.baseUrl || "https://api.bybit.eu";
    this.market = new BybitBroker({ apiKey: "", apiSecret: "", quote: cfg.quote || "USDC", baseUrl: this.baseUrl });
    this.state = this.load();
    this.save();
    this.schedule();
  }

  /** Ögonblicksbild för resultatfönstret (affärer, innehav, TP/SL). */
  snapshot(): PaperState & { feeRate: number } {
    return { ...JSON.parse(JSON.stringify(this.state)), feeRate: FEE };
  }

  private load(): PaperState {
    try {
      const s = JSON.parse(fs.readFileSync(FILE, "utf8")) as PaperState;
      if (!s.lots) {
        s.lots = {};
        for (const o of s.open ?? []) if (o.group) s.lots[o.group] = { base: o.base, remaining: o.qty };
      }
      for (const lot of Object.values(s.lots)) {
        lot.buyQty ??= null; lot.entryPrice ??= null; lot.entryFee ??= null;
        lot.costBasisRemaining ??= null; lot.openedAt ??= null;
      }
      if (typeof s.usdc === "number") {
        // Höj befintligt TEST-startkapital en gång; behåll positioner, avgifter och resultat.
        const target = Number(process.env.PAPER_START_USDC ?? 1_000_000) || 1_000_000;
        const previous = s.initialCapital ?? 10_000;
        if (target > previous) s.usdc += target - previous;
        s.initialCapital = Math.max(previous, target);
        return { initialCapital: s.initialCapital, lots: s.lots ?? {}, usdc: s.usdc, holdings: s.holdings ?? {}, open: s.open ?? [], fills: s.fills ?? [] };
      }
    } catch { /* första gången */ }
    return { initialCapital: Number(process.env.PAPER_START_USDC ?? 1_000_000) || 1_000_000, lots: {}, usdc: Number(process.env.PAPER_START_USDC ?? 1_000_000) || 1_000_000, holdings: {}, open: [], fills: [] };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE + ".tmp", JSON.stringify(this.state, null, 2));
      fs.renameSync(FILE + ".tmp", FILE);
    } catch (err) {
      throw new Error(`TEST-kontot kunde inte sparas: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private baseOf(symbol: string): string {
    return symbol.toUpperCase().replace(/[/-]/g, "").replace(/(USDT|USDC|USD|BUSD|FDUSD)$/, "");
  }

  /** Bästa köp- och sälj-pris i Bybit EU:s orderbok (USDC-paret), reserv: senaste pris. */
  private async book(base: string): Promise<{ bid: number; ask: number }> {
    const pair = `${base}USDC`;
    try {
      const r = await fetch(`${this.baseUrl}/v5/market/orderbook?category=spot&symbol=${pair}&limit=1`);
      const d = (await r.json()) as { retCode: number; result?: { a?: string[][]; b?: string[][] } };
      const ask = Number(d.result?.a?.[0]?.[0]), bid = Number(d.result?.b?.[0]?.[0]);
      if (d.retCode === 0 && ask > 0 && bid > 0) return { bid, ask };
    } catch { /* reserv nedan */ }
    const p = (await this.market.getTicker(`${base}USDC`)).price;
    return { bid: p, ask: p };
  }

  /** USDC som väntande LIMIT-köp håller undan. */
  private reservedUsdc(state: PaperState = this.state): number {
    return state.open.filter((o) => o.kind === "LIMIT" && o.side === "BUY").reduce((t, o) => t + o.qty * o.price * (1 + FEE), 0);
  }
  /** Mynt som väntande LIMIT-sälj håller undan. */
  private reservedQty(base: string, state: PaperState = this.state): number {
    return state.open.filter((o) => o.base === base && o.kind === "LIMIT" && o.side === "SELL").reduce((t, o) => t + o.qty, 0);
  }

  getTicker(symbol: string): Promise<Ticker> { return this.market.getTicker(symbol); }
  getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> { return this.market.getKlines(symbol, interval, limit); }

  async getAccount(): Promise<Account> {
    // Frys kontot före asynkrona prisfrågor så att en samtidig fill inte blandar gammalt och nytt saldo.
    const state = this.snapshot();
    const updatedAt = Date.now();
    const res = Math.min(state.usdc, this.reservedUsdc(state));
    const balances: Balance[] = [{ asset: "USDC", free: state.usdc - res, locked: res }];
    const values = await Promise.all(Object.entries(state.holdings).map(async ([base, h]) => {
      if (!(h.qty > 0)) return 0;
      const locked = this.reservedQty(base, state);
      balances.push({ asset: base, free: Math.max(0, h.qty - locked), locked: Math.min(h.qty, locked) });
      const ticker = await this.market.getTicker(`${base}USDC`);
      if (!Number.isFinite(ticker.price) || !(ticker.price > 0)) throw new Error(`Verifierat Bybit EU-pris saknas för ${base}USDC; kontovärdet är otillgängligt`);
      return h.qty * ticker.price;
    }));
    const totalValueUsdt = state.usdc + values.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(totalValueUsdt)) throw new Error("TEST-kontots värde kunde inte verifieras");
    return { balances, totalValueUsdt, updatedAt };
  }

  async getPositions(): Promise<Position[]> {
    const state = this.snapshot();
    const out = await Promise.all(Object.entries(state.holdings).filter(([base, h]) => h.qty > 0 && !STABLES.includes(base)).map(async ([base, h]): Promise<Position> => {
      const ticker = await this.market.getTicker(`${base}USDC`);
      const price = ticker.price;
      if (!Number.isFinite(price) || !(price > 0)) throw new Error(`Verifierat Bybit EU-pris saknas för ${base}USDC; positionens nuvärde är otillgängligt`);
      return { symbol: `${base}USDC`, baseAsset: base, quoteAsset: "USDC", quantity: h.qty,
        avgEntryPrice: h.avg, currentPrice: price, unrealizedPnlUsdt: (price - h.avg) * h.qty, openedAt: h.openedAt };
    }));
    return out;
  }

  /** Fyller en affär och uppdaterar saldot. Kastar fel om pengarna/innehavet inte räcker. */
  // reserved=true: väntande ordrar räknas bort (nya ordrar). false: en väntande order som nu fylls.
  private fill(base: string, side: "BUY" | "SELL", qty: number, price: number, kind: string, reserved = true, group?: string, orderId?: string): { qty: number; cost: number } {
    if (!(qty > 0) || !Number.isFinite(qty) || !(price > 0) || !Number.isFinite(price)) throw new Error("TEST: ogiltigt antal eller pris");
    if (side === "SELL" && group && qty > (this.state.lots[group]?.remaining ?? 0) + 1e-12) throw new Error("TEST: köpets kvarvarande antal räcker inte");
    const cost = qty * price, fee = cost * FEE;
    const allocations: Array<{ tradeId: string | null; qty: number; basis: number | null }> = [];
    if (side === "BUY") {
      const free = this.state.usdc - (reserved ? this.reservedUsdc() : 0);
      if (cost + fee > free + 1e-9) throw new Error(`TEST: för lite USDC (fritt ${free.toFixed(2)}, behöver ${(cost + fee).toFixed(2)})`);
      const h = this.state.holdings[base] ?? { qty: 0, avg: 0, openedAt: Date.now() };
      h.avg = (h.avg * h.qty + cost + fee) / (h.qty + qty); // avgiften ingår, som Bybits snittpris
      h.qty += qty;
      this.state.holdings[base] = h;
      this.state.usdc -= cost + fee;
      if (group) this.state.lots[group] = { base, remaining: qty, buyQty: qty, entryPrice: price, entryFee: fee, costBasisRemaining: cost + fee, openedAt: Date.now() };
      allocations.push({ tradeId: group ?? null, qty, basis: null });
    } else {
      const h = this.state.holdings[base];
      const free = (h?.qty ?? 0) - (reserved ? this.reservedQty(base) : 0);
      if (!h || free + 1e-12 < qty) throw new Error(`TEST: du har bara ${Math.max(0, free)} ${base} fritt`);
      const oldAverage = h.avg;
      const oldCost = h.avg * h.qty;
      let consume = qty;
      let removedCost = 0;
      const lots = group ? [[group, this.state.lots[group]] as const] : Object.entries(this.state.lots);
      for (const [tradeId, lot] of lots) {
        if (!lot || lot.base !== base || consume <= 0) continue;
        const used = Math.min(lot.remaining, consume);
        if (!(used > 0)) continue;
        const basis = typeof lot.costBasisRemaining === "number" ? lot.costBasisRemaining * used / lot.remaining : null;
        allocations.push({ tradeId, qty: used, basis });
        if (basis !== null) lot.costBasisRemaining = Math.max(0, lot.costBasisRemaining! - basis);
        removedCost += basis ?? oldAverage * used;
        lot.remaining = Math.max(0, lot.remaining - used);
        consume -= used;
      }
      if (consume > 1e-12) {
        allocations.push({ tradeId: null, qty: consume, basis: null });
        removedCost += oldAverage * consume;
      }
      h.qty = Math.max(0, h.qty - qty);
      if (h.qty <= 1e-12) delete this.state.holdings[base];
      else h.avg = Math.max(0, oldCost - removedCost) / h.qty;
      this.state.usdc += cost - fee;
      this.state.open = this.state.open.filter((o) => !o.group || (this.state.lots[o.group]?.remaining ?? o.qty) > 1e-12);
      for (const o of this.state.open) if (o.group && this.state.lots[o.group]) o.qty = Math.min(o.qty, this.state.lots[o.group]!.remaining);

    }
    for (const allocation of allocations) {
      const allocationFee = fee * allocation.qty / qty;
      const pnl = side === "SELL" && allocation.basis !== null ? price * allocation.qty - allocationFee - allocation.basis : undefined;
      this.state.fills.push({ id: randomUUID(), base, side, qty: allocation.qty, price, fee: allocationFee, at: Date.now(), kind, pnl,
        tradeId: allocation.tradeId ?? undefined, group: allocation.tradeId ?? undefined, orderId: orderId ?? group });
    }
    if (this.state.fills.length > 500) this.state.fills.shift();
    return { qty, cost };
  }

  async getOrderResult(symbol: string, id: string): Promise<OrderResult | null> {
    const pending = this.state.open.find((o) => o.id === id && o.kind === "LIMIT");
    const lot = this.state.lots[id];
    if (!pending && !lot) return null;
    const qty = lot?.remaining ?? 0;
    return { orderId: id, symbol, side: pending?.side ?? "BUY", type: "LIMIT", status: pending ? "New" : "Filled", executedQty: qty, cummulativeQuoteQty: 0, avgFillPrice: this.state.holdings[this.baseOf(symbol)]?.avg ?? 0, timestamp: Date.now() };
  }

  async getTimedExitQuantity(symbol: string, group: string): Promise<number | null> {
    const lot = this.state.lots[group];
    return lot?.base === this.baseOf(symbol) ? lot.remaining : null;
  }

  async placeTimedExitOrder(order: OrderRequest, group: string): Promise<OrderResult> {
    const owned = await this.getTimedExitQuantity(order.symbol, group);
    if (owned === null || !(owned > 0)) throw new Error("TEST: köpets ägda antal saknas");
    return this.executeOrder({ ...order, quantity: Math.min(order.quantity ?? owned, owned) }, group);
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> { return this.executeOrder(order); }

  private async executeOrder(order: OrderRequest, sellGroup?: string): Promise<OrderResult> {
    const base = this.baseOf(order.symbol);
    const id = `paper-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { bid, ask } = await this.book(base);
    const ref = order.side === "BUY" ? ask : bid;
    let qty = order.quantity;
    if (qty === undefined) {
      if (order.quoteOrderQty === undefined) throw new Error("TEST: ange antal eller belopp");
      // Beloppet inkluderar avgiften (som "köp för $X" hos Bybit)
      qty = order.quoteOrderQty / (1 + FEE) / (order.type === "LIMIT" && order.price ? order.price : ref);
    }
    if (!(qty > 0)) throw new Error("TEST: antalet måste vara större än 0");

    const before = JSON.parse(JSON.stringify(this.state)) as PaperState;
    let status = "New", executedQty = 0, cost = 0, avg = 0;
    const marketable = order.type === "MARKET" ||
      (order.price !== undefined && (order.side === "BUY" ? order.price >= ask : order.price <= bid));
    if (order.type === "LIMIT" && order.price === undefined) throw new Error("TEST: LIMIT kräver pris");

    if (marketable) {
      const r = this.fill(base, order.side, qty, ref, order.type, true, order.side === "BUY" ? id : sellGroup, id);
      status = "Filled"; executedQty = r.qty; cost = r.cost; avg = ref;
    } else {
      if (order.side === "BUY" && qty * order.price! * (1 + FEE) > this.state.usdc - this.reservedUsdc() + 1e-9) throw new Error("TEST: för lite fritt USDC för limit-ordern");
      if (order.side === "SELL" && qty > (this.state.holdings[base]?.qty ?? 0) - this.reservedQty(base) + 1e-12) throw new Error(`TEST: för lite fritt ${base} för limit-ordern`);
      this.state.open.push({ id, base, side: order.side, kind: "LIMIT", qty, price: order.price!, createdAt: Date.now(), tp: order.takeProfit, sl: order.stopLoss });
    }

    // TP/SL (bara efter köp): säljer automatiskt vid vinst eller förlust.
    // För ett LIMIT-köp som väntar läggs de först när köpet fyllts (check()).
    if (marketable && order.side === "BUY") this.addTpSl(id, base, executedQty, order.takeProfit, order.stopLoss, avg);
    try { this.save(); } catch (err) { this.state = before; throw err; }
    if (executedQty > 0) console.log(`[TEST] ${order.side === "BUY" ? "KÖP" : "SÄLJ"} ${executedQty} ${base} @ ${avg} USDC (Bybit EU orderbok, ${order.type}), avgift ${(cost * FEE).toFixed(4)}`);
    this.schedule();
    return { orderId: id, symbol: order.symbol, side: order.side, type: order.type, status, executedQty, cummulativeQuoteQty: cost, avgFillPrice: avg, timestamp: Date.now() };
  }

  private addTpSl(group: string, base: string, qty: number, tp?: number, sl?: number, fillPx?: number): void {
    if (!(qty > 0)) return;
    // Priset kan ha rört sig sedan ordern föreslogs (godkänn-läge). Ligger TP/SL
    // redan på fel sida om köppriset sätts de om från köppriset (TEST_TP_PCT/TEST_SL_PCT),
    // annars skulle traden säljas direkt.
    if (fillPx && fillPx > 0) {
      const tpPct = Number(process.env.TEST_TP_PCT ?? 3) || 3, slPct = Number(process.env.TEST_SL_PCT ?? 1.5) || 1.5;
      if (tp !== undefined && tp <= fillPx) { tp = +(fillPx * (1 + tpPct / 100)).toPrecision(6); console.log(`[TEST] TP flyttad till ${tp} (låg under köppriset)`); }
      if (sl !== undefined && sl >= fillPx) { sl = +(fillPx * (1 - slPct / 100)).toPrecision(6); console.log(`[TEST] SL flyttad till ${sl} (låg över köppriset)`); }
    }
    if (tp !== undefined) this.state.open.push({ id: `${group}-tp`, base, side: "SELL", kind: "TP", qty, price: tp, group, createdAt: Date.now() });
    if (sl !== undefined) this.state.open.push({ id: `${group}-sl`, base, side: "SELL", kind: "SL", qty, price: sl, group, createdAt: Date.now() });
  }

  async cancelOrder(_symbol: string, orderId: string): Promise<void> {
    const pendingBuy = this.state.open.find((o) => o.id === orderId && o.side === "BUY" && o.kind === "LIMIT");
    if (pendingBuy) this.state.lots[orderId] ??= { base: pendingBuy.base, remaining: 0 };
    const before = this.state.open.length;
    this.state.open = this.state.open.filter((o) => o.id !== orderId && o.group !== orderId);
    if (this.state.open.length === before && !this.state.lots[orderId]) throw new Error(`TEST: ordern ${orderId} finns inte (redan fylld eller borttagen)`);
    this.save();
  }

  /** Kollar väntande LIMIT/TP/SL mot Bybit EU:s orderbok. */
  private async check(): Promise<void> {
    if (!this.state.open.length) return;
    const bases = [...new Set(this.state.open.map((o) => o.base))];
    for (const base of bases) {
      let b: { bid: number; ask: number };
      try { b = await this.book(base); } catch { continue; }
      for (const o of this.state.open.filter((x) => x.base === base)) {
        if (!this.state.open.includes(o)) continue; // syskon (TP/SL) togs nyss bort
        const hit =
          o.kind === "LIMIT" ? (o.side === "BUY" ? b.ask <= o.price : b.bid >= o.price)
          : o.kind === "TP" ? b.bid >= o.price
          : b.bid <= o.price; // SL
        if (!hit) continue;
        const px = o.kind === "LIMIT" ? o.price : b.bid; // TP/SL säljs till marknadspris, som hos Bybit
        const before = JSON.parse(JSON.stringify(this.state)) as PaperState;
        try {
          const have = this.state.holdings[base]?.qty ?? 0;
          const owned = o.group ? this.state.lots[o.group]?.remaining ?? 0 : have;
          const r = this.fill(base, o.side, o.side === "SELL" ? Math.min(o.qty, have, owned) : o.qty, px, o.kind, false, o.side === "BUY" ? o.id : o.group, o.id);
          this.state.open = this.state.open.filter((x) => x !== o && (!o.group || x.group !== o.group));
          if (o.kind === "LIMIT" && o.side === "BUY") this.addTpSl(o.id, base, r.qty, o.tp, o.sl, px);
          this.save();
          console.log(`[TEST] ${o.side === "BUY" ? "KÖP" : "SÄLJ"} ${r.qty} ${base} @ ${px} USDC (${o.kind}), avgift ${(r.cost * FEE).toFixed(4)}`);
        } catch (e) {
          this.state = before;
          console.warn(`[TEST] ${o.kind}-order ${o.id} väntar på nytt försök: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  private schedule(): void {
    if (this.timer || !this.state.open.length) return;
    this.timer = setInterval(() => {
      if (!this.state.open.length) { clearInterval(this.timer!); this.timer = null; return; }
      this.check().catch(() => { /* nästa varv */ });
    }, 5000);
    this.timer.unref?.();
  }
}
