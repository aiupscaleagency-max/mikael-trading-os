import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { getTradePercent, getTradeFeeRate, getTradeSizing, percentageAmount } from "../risk/tradeSizing.js";
import { getResults } from "./results.js";
import { listTimedExits, type TimedExit } from "./tradeHorizon.js";
import { listLiveTpSl } from "./liveTpSl.js";
import { listPendingOrders } from "./orderGate.js";
import { getAnalysisSelection } from "./analysisSelection.js";
import { getAnalysisSession } from "./analysisSession.js";
import { getAnalysis, snapshot as agentSnapshot } from "./agentActivity.js";
import { listCustomSymbols } from "./customSymbols.js";
import { getCachedTicker } from "./marketStream.js";

interface Lot {
  base: string; remaining: number; entryPrice?: number | null; openedAt?: number | null;
  costBasisRemaining?: number | null; entryFee?: number | null;
}
interface PaperSnapshot {
  initialCapital: number; usdc: number; feeRate: number;
  lots: Record<string, Lot>;
  holdings: Record<string, { qty: number; avg: number; openedAt: number }>;
  open: Array<{ base: string; kind: string; price: number; side?: string; qty?: number; group?: string }>;
}

/** Gemensam lottvy: okänd historisk anskaffning får aldrig bli fabricerad avkastning. */
export function paperPositions(snap: PaperSnapshot, exits: TimedExit[], now: number,
  quote = (symbol: string): { price: number; ts: number } | null => getCachedTicker(symbol)) {
  return Object.entries(snap.lots).filter(([, lot]) => lot.remaining > 1e-12).map(([tradeId, lot]) => {
    const symbol = `${lot.base}USDC`;
    const tick = quote(symbol);
    const price = tick && now - tick.ts < 60_000 ? tick.price : null;
    const cost = typeof lot.costBasisRemaining === "number" && lot.costBasisRemaining > 0 ? lot.costBasisRemaining : null;
    const exit = exits.find((x) => x.broker === "bybit-paper" && x.paperGroup === tradeId);
    const tp = snap.open.find((o) => o.group === tradeId && o.kind === "TP")?.price ?? null;
    const sl = snap.open.find((o) => o.group === tradeId && o.kind === "SL")?.price ?? null;
    const net = (p: number | null) => p !== null && cost !== null ? lot.remaining * p * (1 - snap.feeRate) - cost : null;
    const pct = (n: number | null) => n !== null && cost !== null ? n / cost * 100 : null;
    const unrealizedNet = net(price), potentialNet = net(tp), stopNet = net(sl);
    return { tradeId, buyOrderId: tradeId, symbol, coin: lot.base, remainingQty: lot.remaining,
      entryPrice: lot.entryPrice ?? null, costBasisRemaining: cost, currentPrice: price,
      priceAt: tick?.ts ?? null, source: "Bybit EU spot", openedAt: lot.openedAt ?? null,
      exitAt: exit?.exitAt ?? null, status: cost === null ? "unknown_cost" : "open",
      unrealizedNet, unrealizedPct: pct(unrealizedNet), tp, sl, potentialNet, potentialPct: pct(potentialNet),
      stopNet, stopPct: pct(stopNet), exitStatus: exit?.status ?? (exit ? "waiting" : null),
      lastError: exit?.lastError ?? null, retryAt: exit?.retryAt ?? null };
  }).concat(Object.entries(snap.holdings).flatMap(([coin, holding]) => {
    const covered = Object.values(snap.lots).filter((l) => l.base === coin).reduce((sum,l) => sum + l.remaining, 0);
    const remaining = Math.max(0, holding.qty - covered);
    if (remaining <= Math.max(1e-12, holding.qty * 1e-9)) return [];
    const symbol = `${coin}USDC`, tick = quote(symbol);
    return [{tradeId: `aggregate:${coin}`, buyOrderId: `aggregate:${coin}`, symbol, coin, remainingQty: remaining,
      entryPrice: null, costBasisRemaining: null, currentPrice: tick && now - tick.ts < 60_000 ? tick.price : null,
      priceAt: tick?.ts ?? null, source: "Bybit EU spot", openedAt: null, exitAt: null, status: "unknown_cost",
      unrealizedNet: null, unrealizedPct: null, tp: null, sl: null, potentialNet: null, potentialPct: null,
      stopNet: null, stopPct: null, exitStatus: null, lastError: null, retryAt: null}];
  }));
}

/** Tillgängliga marknader är en katalog, aldrig ett automatiskt analysurval. */
export function mergeMarketSymbols(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat().map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{2,20}USDC$/.test(s)))].sort();
}
const observedMarkets = new Map<string, string[]>();
function marketCatalogue(extra: readonly string[] = []): string[] {
  return mergeMarketSymbols(config.crypto.symbols, listCustomSymbols().filter((s) => s.usdc).map((s) => s.symbol),
    getAnalysisSelection("TEST").selectedSymbols, getAnalysisSelection("LIVE").selectedSymbols,
    ...observedMarkets.values(), extra);
}

// Samma ögonblicksbild delas av samtidiga vyer; innehållsrevisionen ändras inte av klockan.
let generation = 0;
const cached = new Map<string, { at: number; value: Awaited<ReturnType<typeof collect>> }>();
const pending = new Map<string, Promise<Awaited<ReturnType<typeof collect>>>>();

async function collect(brokers: Record<string, BrokerAdapter>, broker: "bybit" | "bybit-paper") {
  const mode = broker === "bybit" ? "LIVE" : "TEST";
  const adapter = brokers[broker];
  let account: { equity: number | null; available: number | null; status: string; updatedAt: number | null; error?: string } = {
    equity: null, available: null, status: "unavailable", updatedAt: null };
  let amount: number | null = null;
  try {
    if (!adapter) throw new Error("Bybit-kontot saknas");
    const sizing = await getTradeSizing(adapter);
    account = { equity: sizing.equity, available: sizing.available, status: "ready", updatedAt: sizing.updatedAt };
    amount = sizing.amount;
  } catch { account.error = "Kontot kunde inte verifieras. Senaste saldo visas inte som aktuellt."; }
  const now = Date.now();
  const snap = broker === "bybit-paper" ? (adapter as unknown as { snapshot?: () => PaperSnapshot })?.snapshot?.() : undefined;
  const quotes = new Map<string,{price:number;ts:number}>();
  if (snap && adapter) {
    try {
      for (const [coin,h] of Object.entries(snap.holdings)) {
        if (!(h.qty > 0)) continue;
        const symbol = `${coin}USDC`, cached = getCachedTicker(symbol);
        const tick = cached && now - cached.ts < 60_000 ? cached : {...await adapter.getTicker(symbol),ts:Date.now()};
        if (!(Number.isFinite(tick.price) && tick.price > 0)) throw new Error("Pris saknas");
        quotes.set(symbol,tick);
      }
      const equity = snap.usdc + Object.entries(snap.holdings).reduce((sum,[coin,h]) => sum + h.qty * (quotes.get(`${coin}USDC`)?.price ?? 0),0);
      const reserved = snap.open.filter((o)=>o.kind === "LIMIT" && o.side === "BUY").reduce((sum,o)=>sum + (o.qty ?? 0) * o.price * (1+snap.feeRate),0);
      account = {equity,available:Math.max(0,snap.usdc-reserved),status:"ready",updatedAt:now};
      amount = percentageAmount(equity,account.available!,getTradePercent());
    } catch { account = {equity:null,available:null,status:"unavailable",updatedAt:null,error:"Marknadspris saknas; kontovärdet kan inte verifieras"}; amount=null; }
  }
  let results: Awaited<ReturnType<typeof getResults>> | null = null;
  try { if (adapter && account.status === "ready") results = await getResults(brokers, mode, listLiveTpSl(), snap ? {snapshot:snap as ReturnType<import("../brokers/bybitPaper.js").BybitPaperBroker["snapshot"]>,prices:(coin)=>quotes.get(`${coin}USDC`)?.price ?? null} : undefined); }
  catch { account.status = "unavailable"; account.error = "Innehaven kunde inte verifieras"; }
  const positions = snap ? paperPositions(snap, listTimedExits(), now, (symbol)=>quotes.get(symbol) ?? null) : (results?.open ?? []).map((o) => ({
    tradeId: `aggregate:${o.coin}`, buyOrderId: null, symbol: `${o.coin}USDC`, coin: o.coin, remainingQty: o.qty,
    entryPrice: o.avg > 0 ? o.avg : null, costBasisRemaining: o.avg > 0 ? o.qty * o.avg : null,
    currentPrice: o.price, priceAt: getCachedTicker(`${o.coin}USDC`)?.ts ?? null, source: "Bybit EU spot",
    openedAt: null, exitAt: null, status: "aggregate", unrealizedNet: o.upnl, unrealizedPct: o.upnlPct,
    tp: o.tp ?? null, sl: o.sl ?? null, potentialNet: o.potentialPnl ?? null, potentialPct: o.potentialPnlPct ?? null,
    stopNet: o.stopPnl ?? null, stopPct: o.stopPnlPct ?? null, exitStatus: null, lastError: null, retryAt: null }));
  const selected = getAnalysisSelection(mode);
  const allOrders = await listPendingOrders();
  const orders = allOrders.filter((p) => p.venue === `broker:${broker}`);
  const brokerMarkets = mergeMarketSymbols(positions.map((p) => p.symbol), orders.map((p) => p.symbol),
    snap?.open.map((o) => `${o.base}USDC`) ?? [], listTimedExits().filter((x) => x.broker === broker).map((x) => x.symbol));
  if (account.status === "ready" && JSON.stringify(observedMarkets.get(broker)) !== JSON.stringify(brokerMarkets)) {
    observedMarkets.set(broker, brokerMarkets);
    invalidateTradingState();
  }
  const paperMarketSnapshot = (brokers["bybit-paper"] as unknown as { snapshot?: () => PaperSnapshot })?.snapshot?.();
  const sharedMarketNames = mergeMarketSymbols(brokerMarkets, allOrders.map((p) => p.symbol),
    listTimedExits().map((x) => x.symbol),
    Object.entries(paperMarketSnapshot?.holdings ?? {}).filter(([, h]) => h.qty > 0).map(([base]) => `${base}USDC`),
    paperMarketSnapshot?.open.map((o) => `${o.base}USDC`) ?? []);
  const marketSymbols = marketCatalogue(sharedMarketNames);
  const data = { marketSymbols, schemaVersion: 1, broker, mode, executionMode: config.executionMode, quote: "USDC", account,
    sizing: { percent: getTradePercent(), amount, feeRate: getTradeFeeRate() }, selection: selected,
    selectedSymbols: selected.selectedSymbols, session: getAnalysisSession()?.broker === broker ? getAnalysisSession() : null,
    analysis: getAnalysis()?.broker === broker ? getAnalysis() : null, agents: { scope: "global_runtime", ...agentSnapshot() }, pendingOrders: orders, positions, results, totals: results?.totals ?? null,
    completeness: { positions: account.status === "ready", prices: positions.every((p) => p.currentPrice !== null) } };
  const revisionData = { ...data, account: { ...account, updatedAt: null } };
  const revision = createHash("sha256").update(JSON.stringify(revisionData)).digest("hex").slice(0, 20);
  return { ...data, revision, serverNow: now };
}

export function invalidateTradingState(): void { generation++; cached.clear(); pending.clear(); }
export async function getTradingState(brokers: Record<string, BrokerAdapter>, broker: "bybit" | "bybit-paper") {
  const prev = cached.get(broker);
  if (prev && Date.now() - prev.at < 2000) return { ...prev.value, serverNow: Date.now() };
  const version = generation;
  let request = pending.get(broker);
  if (!request) {
    request = collect(brokers, broker);
    pending.set(broker, request);
  }
  try { const value = await request; if (generation !== version) return getTradingState(brokers,broker); cached.set(broker, { at: Date.now(), value }); return value; }
  finally { if (pending.get(broker) === request) pending.delete(broker); }
}
