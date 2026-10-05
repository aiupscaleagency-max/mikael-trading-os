import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Poängtavla från TEST-körningen
//
//  Varje godkänd KÖP-signal öppnar en låtsasaffär och nästa godkända SÄLJ
//  stänger den, oavsett om Mike lade ordern eller inte. Så ser vi hur varje
//  strategi hade gått live, med avgift (0,1 % per sida som på Bybit spot).
//  Sparas i data/strategy-paper.json så att historiken överlever omstarter.
// ═══════════════════════════════════════════════════════════════════════════

const FILE = path.resolve(process.cwd(), "data", "strategy-paper.json");
const FEE = 0.001;
const MAX_TRADES = 5000;

export interface PaperTrade {
  id: string;
  strategyId: string;
  strategyName: string;
  coin: string;
  venue: "test" | "live";
  entry: number;
  entryTime: number;
  exit?: number;
  exitTime?: number;
  why?: string;
  pnlPct?: number;
  status: "öppen" | "stängd" | "nollställd";
}

let trades: PaperTrade[] = [];
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;

export async function loadPaperLedger(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try { trades = JSON.parse(await fs.readFile(FILE, "utf8")) as PaperTrade[]; } catch { trades = []; }
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      await fs.writeFile(FILE, JSON.stringify(trades.slice(-MAX_TRADES), null, 1), "utf8");
    } catch (err) {
      log.warn(`[poängtavla] kunde inte spara: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 1000);
}

/** Anropas när en signal blivit godkänd (review.final === "ok"). */
export function recordPaperSignal(sig: {
  strategyId: string; strategyName: string; coin: string; side: "BUY" | "SELL";
  price: number; candleCloseTime: number; why: string;
}, venue: "test" | "live"): void {
  const open = trades.find((t) => t.status === "öppen" && t.strategyId === sig.strategyId && t.coin === sig.coin);
  if (sig.side === "BUY") {
    if (open) return; // redan inne
    trades.push({
      id: crypto.randomUUID(), strategyId: sig.strategyId, strategyName: sig.strategyName, coin: sig.coin,
      venue, entry: sig.price, entryTime: sig.candleCloseTime, status: "öppen",
    });
  } else {
    if (!open) return;
    open.exit = sig.price;
    open.exitTime = sig.candleCloseTime;
    open.why = sig.why;
    open.pnlPct = ((sig.price / open.entry) * (1 - FEE) * (1 - FEE) - 1) * 100;
    open.status = "stängd";
  }
  save();
}

/** När Mike nollställer en strategi räknas öppna låtsasaffärer inte med. */
export function resetPaper(strategyId: string, coin?: string): void {
  for (const t of trades) {
    if (t.status === "öppen" && t.strategyId === strategyId && (!coin || t.coin === coin)) t.status = "nollställd";
  }
  save();
}

export interface ScoreRow {
  strategyId: string;
  closed: number;
  wins: number;
  winRatePct: number;
  totalReturnPct: number;
  avgTradePct: number;
  bestPct: number | null;
  worstPct: number | null;
  open: Array<{ coin: string; entry: number; entryTime: number; nowPrice: number | null; unrealizedPct: number | null }>;
  firstTradeAt: number | null;
  daysRunning: number;
  lastTrades: PaperTrade[];
  ready: { ok: boolean; text: string };
}

/** Krav innan en strategi föreslås för LIVE ($5-gränsen gäller ändå). */
export const READY_RULES = { minTrades: 10, minDays: 7 };

export function scoreboard(strategyId: string, priceOf: (coin: string) => number | null): ScoreRow {
  const mine = trades.filter((t) => t.strategyId === strategyId && t.status !== "nollställd");
  const closed = mine.filter((t) => t.status === "stängd" && t.pnlPct != null);
  const wins = closed.filter((t) => t.pnlPct! > 0).length;
  const equity = closed.reduce((e, t) => e * (1 + t.pnlPct! / 100), 1);
  const pnls = closed.map((t) => t.pnlPct!);
  const first = mine.length ? Math.min(...mine.map((t) => t.entryTime)) : null;
  const days = first ? (Date.now() - first) / 86_400_000 : 0;
  const totalReturnPct = (equity - 1) * 100;
  const winRatePct = closed.length ? (wins / closed.length) * 100 : 0;

  const missing: string[] = [];
  if (closed.length < READY_RULES.minTrades) missing.push(`${READY_RULES.minTrades - closed.length} affärer till`);
  if (days < READY_RULES.minDays) missing.push(`${Math.ceil(READY_RULES.minDays - days)} dagar till`);
  if (closed.length && totalReturnPct <= 0) missing.push("måste gå plus");
  const ok = missing.length === 0;

  return {
    strategyId,
    closed: closed.length,
    wins,
    winRatePct: Math.round(winRatePct * 10) / 10,
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    avgTradePct: pnls.length ? Math.round((pnls.reduce((a, b) => a + b, 0) / pnls.length) * 100) / 100 : 0,
    bestPct: pnls.length ? Math.round(Math.max(...pnls) * 100) / 100 : null,
    worstPct: pnls.length ? Math.round(Math.min(...pnls) * 100) / 100 : null,
    open: mine.filter((t) => t.status === "öppen").map((t) => {
      const p = priceOf(t.coin);
      return {
        coin: t.coin, entry: t.entry, entryTime: t.entryTime, nowPrice: p,
        unrealizedPct: p ? Math.round(((p / t.entry) * (1 - FEE) * (1 - FEE) - 1) * 10000) / 100 : null,
      };
    }),
    firstTradeAt: first,
    daysRunning: Math.round(days * 10) / 10,
    lastTrades: closed.slice(-5).reverse(),
    ready: {
      ok,
      text: ok
        ? `Klar för LIVE-prov: ${closed.length} affärer på ${Math.floor(days)} dagar, ${totalReturnPct.toFixed(2)}% totalt.`
        : `Inte klar för LIVE än: ${missing.join(", ")}.`,
    },
  };
}
