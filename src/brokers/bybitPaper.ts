import fs from "node:fs";
import path from "node:path";
import type { BrokerAdapter } from "./adapter.js";
import type { Account, Balance, Kline, OrderRequest, OrderResult, Position, Ticker } from "../types.js";
import { BybitBroker } from "./bybit.js";

// ═══════════════════════════════════════════════════════════════════════════
// BYBIT EU TEST — låtsaspengar i boten, riktiga priser från Bybit EU
// ═══════════════════════════════════════════════════════════════════════════
// Bybit EU har ingen demo-API (testat 2026-10-03), och Mike vill varken ha
// Alpaca eller riktiga pengar i TEST. Därför fylls TEST-ordrar här, mot Bybit
// EU:s riktiga orderbok (köp på bästa sälj-pris, sälj på bästa köp-pris) med
// samma avgift som Bybit. Inga pengar rör sig och ingen order skickas till Bybit.
//
// Saldot sparas i data/bybit-paper.json. Startsaldo: PAPER_START_USDC (10 000).
// LIMIT-ordrar och TP/SL ligger kvar här och fylls när priset når dit
// (kollas var 5:e sekund medan något väntar).
// ═══════════════════════════════════════════════════════════════════════════

const FEE = Number(process.env.PAPER_FEE ?? 0.001); // Bybit spot taker 0,1 %
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
interface PaperState {
  usdc: number;
  holdings: Record<string, Holding>;
  open: OpenOrder[];
  fills: Array<{ id: string; base: string; side: string; qty: number; price: number; fee: number; at: number; kind: string; pnl?: number }>;
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
    this.schedule();
  }

  private load(): PaperState {
    try {
      const s = JSON.parse(fs.readFileSync(FILE, "utf8")) as PaperState;
      if (typeof s.usdc === "number") return { usdc: s.usdc, holdings: s.holdings ?? {}, open: s.open ?? [], fills: s.fills ?? [] };
    } catch { /* första gången */ }
    return { usdc: Number(process.env.PAPER_START_USDC ?? 10_000) || 10_000, holdings: {}, open: [], fills: [] };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.state, null, 2));
    } catch { /* saldot finns kvar i minnet */ }
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
    const p = (await this.market.getTicker(`${base}USDT`)).price;
    return { bid: p, ask: p };
  }

  /** USDC som väntande LIMIT-köp håller undan. */
  private reservedUsdc(): number {
    return this.state.open.filter((o) => o.kind === "LIMIT" && o.side === "BUY").reduce((t, o) => t + o.qty * o.price * (1 + FEE), 0);
  }
  /** Mynt som väntande LIMIT-sälj håller undan. */
  private reservedQty(base: string): number {
    return this.state.open.filter((o) => o.base === base && o.kind === "LIMIT" && o.side === "SELL").reduce((t, o) => t + o.qty, 0);
  }

  getTicker(symbol: string): Promise<Ticker> { return this.market.getTicker(symbol); }
  getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> { return this.market.getKlines(symbol, interval, limit); }

  async getAccount(): Promise<Account> {
    const res = Math.min(this.state.usdc, this.reservedUsdc());
    const balances: Balance[] = [{ asset: "USDC", free: this.state.usdc - res, locked: res }];
    let total = this.state.usdc;
    for (const [base, h] of Object.entries(this.state.holdings)) {
      if (!(h.qty > 0)) continue;
      const locked = this.reservedQty(base);
      balances.push({ asset: base, free: Math.max(0, h.qty - locked), locked: Math.min(h.qty, locked) });
      try { total += h.qty * (await this.market.getTicker(`${base}USDT`)).price; } catch { total += h.qty * h.avg; }
    }
    return { balances, totalValueUsdt: total, updatedAt: Date.now() };
  }

  async getPositions(): Promise<Position[]> {
    const out: Position[] = [];
    for (const [base, h] of Object.entries(this.state.holdings)) {
      if (!(h.qty > 0) || STABLES.includes(base)) continue;
      let price = h.avg;
      try { price = (await this.market.getTicker(`${base}USDT`)).price; } catch { /* senaste kända */ }
      out.push({
        symbol: `${base}USDT`, baseAsset: base, quoteAsset: "USDC", quantity: h.qty,
        avgEntryPrice: h.avg, currentPrice: price, unrealizedPnlUsdt: (price - h.avg) * h.qty, openedAt: h.openedAt,
      });
    }
    return out;
  }

  /** Fyller en affär och uppdaterar saldot. Kastar fel om pengarna/innehavet inte räcker. */
  // reserved=true: väntande ordrar räknas bort (nya ordrar). false: en väntande order som nu fylls.
  private fill(base: string, side: "BUY" | "SELL", qty: number, price: number, kind: string, reserved = true): { qty: number; cost: number } {
    const cost = qty * price, fee = cost * FEE;
    let pnl: number | undefined;
    if (side === "BUY") {
      const free = this.state.usdc - (reserved ? this.reservedUsdc() : 0);
      if (cost + fee > free + 1e-9) throw new Error(`TEST: för lite USDC (fritt ${free.toFixed(2)}, behöver ${(cost + fee).toFixed(2)})`);
      const h = this.state.holdings[base] ?? { qty: 0, avg: 0, openedAt: Date.now() };
      h.avg = (h.avg * h.qty + cost + fee) / (h.qty + qty); // avgiften ingår, som Bybits snittpris
      h.qty += qty;
      this.state.holdings[base] = h;
      this.state.usdc -= cost + fee;
    } else {
      const h = this.state.holdings[base];
      const free = (h?.qty ?? 0) - (reserved ? this.reservedQty(base) : 0);
      if (!h || free + 1e-12 < qty) throw new Error(`TEST: du har bara ${Math.max(0, free)} ${base} fritt`);
      pnl = (price - h.avg) * qty - fee; // vinst/förlust på affären (köpavgiften ligger i snittpriset)
      h.qty -= qty;
      if (h.qty <= 1e-12) delete this.state.holdings[base];
      this.state.usdc += cost - fee;
      // TP/SL får aldrig sälja mer än som finns kvar (t.ex. efter "Sälj allt")
      const left = this.state.holdings[base]?.qty ?? 0;
      this.state.open = this.state.open.filter((o) => !(o.base === base && (o.kind === "TP" || o.kind === "SL") && left <= 1e-12));
      for (const o of this.state.open) if (o.base === base && (o.kind === "TP" || o.kind === "SL") && o.qty > left) o.qty = left;
    }
    this.state.fills.push({ id: `f${Date.now()}`, base, side, qty, price, fee, at: Date.now(), kind, pnl });
    console.log(`[TEST] ${side === "BUY" ? "KÖP" : "SÄLJ"} ${qty} ${base} @ ${price} USDC (Bybit EU orderbok, ${kind}), avgift ${fee.toFixed(4)}`);
    if (this.state.fills.length > 500) this.state.fills.shift();
    return { qty, cost };
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
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

    let status = "New", executedQty = 0, cost = 0, avg = 0;
    const marketable = order.type === "MARKET" ||
      (order.price !== undefined && (order.side === "BUY" ? order.price >= ask : order.price <= bid));
    if (order.type === "LIMIT" && order.price === undefined) throw new Error("TEST: LIMIT kräver pris");

    if (marketable) {
      const r = this.fill(base, order.side, qty, ref, order.type);
      status = "Filled"; executedQty = r.qty; cost = r.cost; avg = ref;
    } else {
      if (order.side === "BUY" && qty * order.price! * (1 + FEE) > this.state.usdc - this.reservedUsdc() + 1e-9) throw new Error("TEST: för lite fritt USDC för limit-ordern");
      if (order.side === "SELL" && qty > (this.state.holdings[base]?.qty ?? 0) - this.reservedQty(base) + 1e-12) throw new Error(`TEST: för lite fritt ${base} för limit-ordern`);
      this.state.open.push({ id, base, side: order.side, kind: "LIMIT", qty, price: order.price!, createdAt: Date.now(), tp: order.takeProfit, sl: order.stopLoss });
    }

    // TP/SL (bara efter köp): säljer automatiskt vid vinst eller förlust.
    // För ett LIMIT-köp som väntar läggs de först när köpet fyllts (check()).
    if (marketable && order.side === "BUY") this.addTpSl(id, base, executedQty, order.takeProfit, order.stopLoss, avg);
    this.save();
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
    const before = this.state.open.length;
    this.state.open = this.state.open.filter((o) => o.id !== orderId && o.group !== orderId);
    if (this.state.open.length === before) throw new Error(`TEST: ordern ${orderId} finns inte (redan fylld eller borttagen)`);
    this.save();
  }

  /** Kollar väntande LIMIT/TP/SL mot Bybit EU:s orderbok. */
  private async check(): Promise<void> {
    if (!this.state.open.length) return;
    const bases = [...new Set(this.state.open.map((o) => o.base))];
    let changed = false;
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
        this.state.open = this.state.open.filter((x) => x !== o && (!o.group || x.group !== o.group));
        try {
          const have = this.state.holdings[base]?.qty ?? 0;
          const r = this.fill(base, o.side, o.side === "SELL" ? Math.min(o.qty, have) : o.qty, px, o.kind, false);
          if (o.kind === "LIMIT" && o.side === "BUY") this.addTpSl(o.id, base, r.qty, o.tp, o.sl, px);
        } catch (e) {
          console.warn(`[TEST] ${o.kind}-order ${o.id} togs bort: ${e instanceof Error ? e.message : String(e)}`);
        }
        changed = true;
      }
    }
    if (changed) this.save();
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
