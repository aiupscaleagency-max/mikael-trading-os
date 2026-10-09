// ═══════════════════════════════════════════════════════════════════════════
// Resultatfönstret: affärer med vinst/förlust (grönt/rött), öppna positioner
// med vinst/förlust just nu, och summor — nu från IG.
//   TEST = IG Demo, LIVE = IG Live. Varje läge läser BARA sin egen miljö
//   (egen IG-session, egna transaktioner); de blandas aldrig.
//   Avslutade affärer: IG:s transaktionshistorik (DEAL, 30 dagar, P/L i kontovalutan).
//   Öppna: IG-positioner, P/L räknad från IG-kvot och IG:s punktvärde (brutto).
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { dataPath } from "../dataDir.js";
import { getIgHistory } from "../integrations/igMarkets.js";
import type { IgEnvironment } from "../integrations/igConnection.js";
import { setStakeHistory } from "../risk/stakeLadder.js";
import { listTimedExits } from "./tradeHorizon.js";

export interface ResultTrade {
  at: number; coin: string; side: "BUY" | "SELL"; qty: number; price: number; usd: number; kind: string;
  /** Vinst/förlust i kontovalutan (IG profitAndLoss) */
  pnl?: number; pnlPct?: number; openLevel?: number | null; closeLevel?: number | null; reference?: string | null;
}
export interface ResultOpen {
  coin: string; qty: number; avg: number; price: number | null; value: number | null; upnl: number | null; upnlPct: number | null;
  tp?: number; sl?: number; epic?: string; dealId?: string; direction?: "BUY" | "SELL"; closeAt?: number | null; nextAttemptAt?: number | null;
  /** Tidsgränsens läge: waiting | execution-off ("väntar – orderläget av") | retrying | needs-attention */
  exitState?: string | null; exitError?: string | null;
}
export interface Results {
  mode: "TEST" | "LIVE";
  env?: IgEnvironment; label?: string; currency?: string | null;
  trades: ResultTrade[];
  open: ResultOpen[];
  totals: { realized: number; unrealized: number; wins: number; losses: number; trades: number; today: number };
  error?: string | null; partial?: boolean;
}

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Behålls för gamla anropsvägar; IG-resultat läses från IG:s egen historik. */
export function recordLiveFill(_f: { symbol: string; side: "BUY" | "SELL"; qty: number; price: number; usd?: number; kind: string }): void { /* IG: historiken finns hos IG */ }

/** "SEK 12.50", "-kr3,20", "£15.00" → tal i kontovalutan, annars null. */
export function parseIgMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.replace(/\s/g, "").replace(/^(?:[A-Z]{3}|kr|\$|£|€)/i, "").replace(/^(-?)(?:[A-Z]{3}|kr|\$|£|€)/i, "$1").replace(",", ".");
  return /^[+-]?\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}

function summarize(base: Omit<Results, "totals">): Results {
  const sells = base.trades.filter((t) => t.pnl !== undefined);
  const dayStart = startOfDay();
  return {
    ...base,
    trades: [...base.trades].sort((a, b) => b.at - a.at).slice(0, 200),
    totals: {
      realized: sells.reduce((s, t) => s + (t.pnl ?? 0), 0),
      unrealized: base.open.reduce((s, o) => s + (o.upnl ?? 0), 0),
      wins: sells.filter((t) => (t.pnl ?? 0) > 0).length,
      losses: sells.filter((t) => (t.pnl ?? 0) <= 0).length,
      trades: sells.length,
      today: sells.filter((t) => t.at >= dayStart).reduce((s, t) => s + (t.pnl ?? 0), 0),
    },
  };
}

export async function getResults(
  brokers: Record<string, BrokerAdapter>,
  mode: "TEST" | "LIVE",
  _liveTpSl: Array<{ symbol: string; takeProfit?: number; stopLoss?: number }> = [],
  deps: { history?: typeof getIgHistory } = {},
): Promise<Results> {
  const env: IgEnvironment = mode === "LIVE" ? "live" : "demo";
  const broker = brokers[env === "live" ? "ig" : "ig-demo"];
  const label = env === "live" ? "IG Live" : "IG Demo";
  if (!broker) return summarize({ mode, env, label, currency: null, trades: [], open: [], error: `${label} är inte kopplat` });
  const errors: string[] = [];
  let currency: string | null = null, balance: number | null = null;
  try { const a = await broker.getAccount(); currency = a.currency ?? null; balance = a.balance ?? null; }
  catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }

  const trades: ResultTrade[] = [];
  let partial = false;
  if (!errors.length) {
    try {
      const h = await (deps.history ?? getIgHistory)(env);
      partial = h.status === "partial";
      for (const t of h.transactions as any[]) {
        if (t.cashTransaction === true || t.type !== "DEAL") continue;
        const pnl = parseIgMoney(t.profitAndLoss);
        const at = Date.parse(String(t.date ?? "").replace(" ", "T") + (String(t.date ?? "").endsWith("Z") ? "" : "Z"));
        const size = Number(String(t.size ?? "").replace(",", "."));
        const open = Number(t.openLevel), close = Number(t.closeLevel);
        trades.push({
          at: Number.isFinite(at) ? at : 0, coin: t.instrumentName ?? "?", side: size < 0 ? "SELL" : "BUY", qty: Math.abs(size) || 0,
          price: Number.isFinite(close) ? close : 0, usd: 0, kind: "IG",
          ...(pnl !== null ? { pnl } : {}), openLevel: Number.isFinite(open) ? open : null, closeLevel: Number.isFinite(close) ? close : null, reference: t.reference ?? null,
        });
      }
    } catch (e) { errors.push(`historik: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const open: ResultOpen[] = [];
  if (!errors.length || errors.every((e) => e.startsWith("historik"))) {
    try {
      const exits = listTimedExits();
      for (const p of await broker.getPositions()) {
        const exposure = p.avgEntryPrice * p.quantity;
        open.push({
          coin: p.name ?? p.symbol, epic: p.symbol, dealId: p.dealId, direction: p.direction, qty: p.quantity, avg: p.avgEntryPrice,
          price: p.currentPrice || null, value: null, upnl: p.pnlVerified ? p.unrealizedPnlUsdt : null,
          upnlPct: p.pnlVerified && exposure > 0 ? ((p.direction === "SELL" ? -1 : 1) * (p.currentPrice - p.avgEntryPrice) / p.avgEntryPrice) * 100 : null,
          tp: p.limitLevel ?? undefined, sl: p.stopLevel ?? undefined,
          closeAt: exits.find((x) => x.dealId === p.dealId)?.requestedExitAt ?? exits.find((x) => x.dealId === p.dealId)?.exitAt ?? null,
          nextAttemptAt: exits.find((x) => x.dealId === p.dealId)?.exitAt ?? null,
          exitState: (() => { const x = exits.find((y) => y.dealId === p.dealId); return x ? x.igState ?? "waiting" : null; })(),
          exitError: exits.find((x) => x.dealId === p.dealId)?.lastError ?? null,
        });
      }
    } catch (e) { errors.push(`positioner: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // Bara när IG-historiken faktiskt lästes: ett IG-avbrott får aldrig nollställa trappan/minnet.
  if (!errors.length) {
    const pnls = trades.filter((t) => t.pnl !== undefined).sort((a, b) => a.at - b.at).map((t) => t.pnl!);
    setStakeHistory(pnls, balance, currency, env);
  }
  if (env === "demo" && !errors.length) {
    try {
      mkdirSync(path.dirname(dataPath("ig-closed-demo.json")), { recursive: true });
      writeFileSync(dataPath("ig-closed-demo.json"), JSON.stringify(trades.filter((t) => t.pnl !== undefined).map((t) => ({ base: t.coin, side: "SELL", qty: t.qty, price: t.price, at: t.at, kind: "IG Demo", pnl: t.pnl }))));
    } catch { /* bara för tradingminnet */ }
  }
  return summarize({ mode, env, label, currency, trades, open, error: errors.length ? errors.join(" · ") : null, partial });
}

// Panelerna frågar ofta (var 5:e s). Svaret återanvänds i 10 s per läge och samtidiga anrop delar
// samma läsning, så att resultatpanelen inte äter IG:s läsbudget som order och stängningar behöver.
const resultsCache = new Map<string, { at: number; value: Results }>();
const resultsJobs = new Map<string, Promise<Results>>();
export const RESULTS_CACHE_MS = 30_000;
export async function getResultsCached(brokers: Record<string, BrokerAdapter>, mode: "TEST" | "LIVE", now = Date.now): Promise<Results> {
  const c = resultsCache.get(mode);
  if (c && now() - c.at < RESULTS_CACHE_MS) return c.value;
  const running = resultsJobs.get(mode);
  if (running) return running;
  const job = getResults(brokers, mode).then((v) => { resultsCache.set(mode, { at: now(), value: v }); return v; });
  resultsJobs.set(mode, job);
  try { return await job; } finally { resultsJobs.delete(mode); }
}
