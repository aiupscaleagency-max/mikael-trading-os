// ═══════════════════════════════════════════════════════════════════════════
// Resultatfönstret: alla affärer med vinst/förlust (grönt/rött), öppna
// innehav med vinst/förlust just nu, och summor.
//   TEST: TEST-kontots egna affärer (data/bybit-paper.json, exakt P/L).
//   LIVE: en logg över LIVE-affärer som boten lagt (data/live-journal.jsonl),
//         P/L räknas mot snittpriset för köpen.
// ═══════════════════════════════════════════════════════════════════════════

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { getCachedTicker } from "./marketStream.js";

const LIVE_JOURNAL = path.resolve("data/live-journal.jsonl");
import { getTradeFeeRate } from "../risk/tradeSizing.js";
const LIVE_FEE = getTradeFeeRate();

export interface ResultTrade {
  id?: string;
  fee?: number;
  tradeId?: string;
  at: number;
  coin: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  usd: number;
  kind: string;
  /** Bara på sälj: vinst/förlust efter avgifter */
  pnl?: number;
  pnlPct?: number;
}
export interface ResultOpen {
  costKnown?: boolean;
  coin: string;
  qty: number;
  avg: number;
  price: number | null;
  value: number | null;
  upnl: number | null;
  upnlPct: number | null;
  tp?: number;
  sl?: number;
  potentialPnl?: number | null;
  potentialPnlPct?: number | null;
  stopPnl?: number | null;
  stopPnlPct?: number | null;
}
export interface Results {
  feeRate: number;
  mode: "TEST" | "LIVE";
  trades: ResultTrade[];
  open: ResultOpen[];
  totals: { realized: number | null; unrealized: number | null; wins: number; losses: number; trades: number; today: number | null; complete: boolean; knownRealized: number };
}

const baseOf = (s: string) => s.toUpperCase().replace(/[/-]/g, "").replace(/(USDT|USDC|USD|BUSD|FDUSD)$/, "");
const priceOf = (coin: string) => { const tick = getCachedTicker(`${coin}USDC`); return tick && Date.now() - tick.ts < 60_000 ? tick.price : null; };
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Logga en LIVE-affär (anropas när en LIVE-order fyllts). */
export function recordLiveFill(f: { symbol: string; side: "BUY" | "SELL"; qty: number; price: number; usd?: number; kind: string }): void {
  if (!(f.qty > 0) || !(f.price > 0)) return;
  try {
    mkdirSync(path.dirname(LIVE_JOURNAL), { recursive: true });
    appendFileSync(LIVE_JOURNAL, JSON.stringify({ at: Date.now(), coin: baseOf(f.symbol), side: f.side, qty: f.qty, price: f.price, usd: f.usd ?? f.qty * f.price, kind: f.kind }) + "\n");
  } catch { /* loggen är bara för visning */ }
}

function summarize(mode: "TEST" | "LIVE", trades: ResultTrade[], open: ResultOpen[]): Results {
  const sells = trades.filter((t) => t.side === "SELL" && t.pnl !== undefined);
  const dayStart = startOfDay();
  return {
    mode,
    feeRate: LIVE_FEE,
    trades: [...trades].sort((a, b) => b.at - a.at).slice(0, 200),
    open: open.map((o) => {
      const cost = o.qty * o.avg;
      const potentialPnl = o.costKnown !== false && o.tp && cost > 0 ? o.qty * o.tp * (1 - LIVE_FEE) - cost : null;
      const stopPnl = o.costKnown !== false && o.sl && cost > 0 ? o.qty * o.sl * (1 - LIVE_FEE) - cost : null;
      return { ...o, potentialPnl, potentialPnlPct: potentialPnl === null ? null : potentialPnl / cost * 100,
        stopPnl, stopPnlPct: stopPnl === null ? null : stopPnl / cost * 100 };
    }),
    totals: {
      complete: !trades.some((t) => t.side === "SELL" && t.pnl === undefined) && open.every((o) => o.upnl !== null),
      knownRealized: sells.reduce((s,t) => s + (t.pnl ?? 0), 0),
      realized: trades.some((t) => t.side === "SELL" && t.pnl === undefined) ? null : sells.reduce((s, t) => s + (t.pnl ?? 0), 0),
      unrealized: open.some((o) => o.upnl === null) ? null : open.reduce((s, o) => s + (o.upnl ?? 0), 0),
      wins: sells.filter((t) => (t.pnl ?? 0) > 0).length,
      losses: sells.filter((t) => (t.pnl ?? 0) <= 0).length,
      trades: sells.length,
      today: trades.some((t) => t.side === "SELL" && t.at >= dayStart && t.pnl === undefined) ? null : sells.filter((t) => t.at >= dayStart).reduce((s, t) => s + (t.pnl ?? 0), 0),
    },
  };
}

function testResults(paper: BrokerAdapter, snapshot?: ReturnType<import("../brokers/bybitPaper.js").BybitPaperBroker["snapshot"]>, prices: (coin:string)=>number|null = priceOf): Results {
  const snap = snapshot ?? (paper as unknown as { snapshot?: () => ReturnType<import("../brokers/bybitPaper.js").BybitPaperBroker["snapshot"]> }).snapshot?.();
  if (!snap) return summarize("TEST", [], []);
  const trades: ResultTrade[] = snap.fills.map((f) => {
    const usd = f.qty * f.price;
    // Vinst i % av vad köpet kostade (P/L / (sålt värde − P/L))
    const cost = f.pnl !== undefined ? usd - f.fee - f.pnl : 0;
    return {
      id: f.id, fee: f.fee, tradeId: f.tradeId, at: f.at, coin: f.base, side: f.side === "SELL" ? "SELL" : "BUY", qty: f.qty, price: f.price, usd, kind: f.kind,
      ...(f.side === "SELL" && f.pnl !== undefined ? { pnl: f.pnl, pnlPct: cost > 0 ? (f.pnl / cost) * 100 : undefined } : {}),
    };
  });
  const open: ResultOpen[] = Object.entries(snap.holdings)
    .filter(([, h]) => h.qty > 0)
    .map(([coin, h]) => {
      const price = prices(coin);
      // Värde efter säljavgift, mot snittpriset (köpavgiften ingår redan i snittet)
      const value = price ? h.qty * price : null;
      const knownCost = Object.values(snap.lots).filter((l) => l.base === coin && l.remaining > 1e-12).every((l) => typeof l.costBasisRemaining === "number");
      const covered = Object.values(snap.lots).filter((l) => l.base === coin).reduce((s,l) => s + l.remaining,0);
      const upnl = price && knownCost && Math.abs(covered - h.qty) < Math.max(1e-12,h.qty*1e-8) ? h.qty * price * (1 - LIVE_FEE) - h.qty * h.avg : null;
      // En enda målnivå får bara användas när den täcker hela innehavet.
      const levels = (kind: string) => snap.open.filter((o) => o.base === coin && o.kind === kind);
      const level = (kind: string) => { const orders = levels(kind); const unique = new Set(orders.map((o) => o.price));
        return unique.size === 1 && Math.abs(orders.reduce((s,o) => s + o.qty,0) - h.qty) < Math.max(1e-12,h.qty*1e-8) ? orders[0]?.price : undefined; };
      const tp = level("TP"), sl = level("SL");
      return { coin, costKnown: knownCost && Math.abs(covered-h.qty) < Math.max(1e-12,h.qty*1e-8), qty: h.qty, avg: h.avg, price, value, upnl, upnlPct: upnl !== null ? (upnl / (h.qty * h.avg)) * 100 : null, tp, sl };
    });
  return summarize("TEST", trades, open);
}

async function liveResults(live: BrokerAdapter, tpsl: Array<{ symbol: string; takeProfit?: number; stopLoss?: number }>): Promise<Results> {
  let rows: Array<{ at: number; coin: string; side: "BUY" | "SELL"; qty: number; price: number; usd: number; kind: string }> = [];
  try {
    rows = readFileSync(LIVE_JOURNAL, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* inga LIVE-affärer än */ }
  // Snittpris per mynt (köpavgiften räknas in), P/L på varje sälj
  const pos = new Map<string, { qty: number; cost: number }>();
  const trades: ResultTrade[] = [];
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const p = pos.get(r.coin) ?? { qty: 0, cost: 0 };
    if (r.side === "BUY") {
      p.qty += r.qty; p.cost += r.usd * (1 + LIVE_FEE);
      trades.push({ ...r });
    } else {
      const avg = p.qty > 0 ? p.cost / p.qty : r.price;
      const q = Math.min(r.qty, p.qty || r.qty);
      const cost = q * avg;
      const knownCost = p.qty >= r.qty - 1e-12 && p.cost > 0;
      const pnl = knownCost ? r.usd * (1 - LIVE_FEE) - cost : undefined;
      p.qty = Math.max(0, p.qty - q); p.cost = p.qty > 0 ? p.qty * avg : 0;
      trades.push({ ...r, pnl, pnlPct: pnl !== undefined && cost > 0 ? (pnl / cost) * 100 : undefined });
    }
    pos.set(r.coin, p);
  }
  // Öppna innehav: det som faktiskt ligger på Bybit, P/L mot bottens snittpris
  const open: ResultOpen[] = [];
  const positions = await live.getPositions();
  for (const ps of positions) {
    const coin = ps.baseAsset;
    const j = pos.get(coin);
    const avg = j && j.qty >= ps.quantity - 1e-12 && j.qty > 0 ? j.cost / j.qty : 0;
    const price = priceOf(coin) ?? (ps.currentPrice || null);
    const value = price ? ps.quantity * price : null;
    if (value !== null && value < 0.5) continue; // damm under $0,50 visas inte
    const upnl = price && avg > 0 ? ps.quantity * price * (1 - LIVE_FEE) - ps.quantity * avg : null;
    const all = tpsl.filter((t) => baseOf(t.symbol) === coin);
    const w = all.length === 1 && Math.abs(((all[0] as {qty?:number}).qty ?? 0) - ps.quantity) <= Math.max(1e-12, ps.quantity*1e-8) ? all[0] : undefined;
    open.push({ coin, qty: ps.quantity, avg, price, value, upnl, upnlPct: upnl !== null && avg > 0 ? (upnl / (ps.quantity * avg)) * 100 : null, tp: w?.takeProfit, sl: w?.stopLoss });
  }
  return summarize("LIVE", trades, open);
}

export async function getResults(
  brokers: Record<string, BrokerAdapter>,
  mode: "TEST" | "LIVE",
  liveTpSl: Array<{ symbol: string; takeProfit?: number; stopLoss?: number }>,
  paperView?: { snapshot: ReturnType<import("../brokers/bybitPaper.js").BybitPaperBroker["snapshot"]>; prices: (coin:string)=>number|null },
): Promise<Results> {
  if (mode === "LIVE") return brokers.bybit ? liveResults(brokers.bybit, liveTpSl) : summarize("LIVE", [], []);
  const paper = brokers["bybit-paper"];
  return paper ? testResults(paper,paperView?.snapshot,paperView?.prices) : summarize("TEST", [], []);
}
