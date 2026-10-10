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
import { log } from "../logger.js";
import { getIgHistory } from "../integrations/igMarkets.js";
import type { IgEnvironment } from "../integrations/igConnection.js";
import { setStakeHistory } from "../risk/stakeLadder.js";
import { listTimedExits } from "./tradeHorizon.js";
import { reconcileStrategyDeals, type ClosedTx, type ObservedPosition } from "./igStrategyTrades.js";
import { DEMO_SIM_SHORT, type IgDemoSim } from "../integrations/igDemoSim.js";

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
  /** Demo-simulering (Live-pris, låtsaspengar) */
  sim?: boolean;
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
  deps: { history?: typeof getIgHistory; sim?: Pick<IgDemoSim, "snapshot" | "positionsView"> | null } = {},
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
  let rawTx: ClosedTx[] = [];
  let livePositions: ObservedPosition[] | null = null;
  if (!errors.length) {
    try {
      const h = await (deps.history ?? getIgHistory)(env);
      partial = h.status === "partial";
      rawTx = h.transactions as ClosedTx[];
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
      const positions = await broker.getPositions();
      // Simulerade positioner finns aldrig hos IG och ska inte stämmas av mot IG:s historik
      livePositions = positions.filter((p) => !p.sim);
      for (const p of positions) {
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
          ...(p.sim ? { sim: true } : {}),
        });
      }
    } catch (e) { errors.push(`positioner: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // Demo-simulering: övningsaffärerna (Live-pris, låtsaspengar) visas i Demo-resultatet, märkta "sim".
  // De räknas inte in i insatstrappan eller strategiresultaten (de bygger på IG:s egen historik).
  const igTrades = trades.slice();
  if (env === "demo") {
    const sim = deps.sim === undefined ? (await import("./igDemoSimLive.js")).igDemoSim : deps.sim;
    if (sim) {
      try {
        for (const t of sim.snapshot().closed) {
          trades.push({
            at: t.closedAt, coin: `${t.name} · ${DEMO_SIM_SHORT}`, side: t.direction === "SELL" ? "SELL" : "BUY", qty: t.size, price: t.closeLevel, usd: 0,
            kind: "sim", pnl: t.pnl, pnlPct: t.openLevel > 0 ? ((t.direction === "SELL" ? -1 : 1) * (t.closeLevel - t.openLevel) / t.openLevel) * 100 : undefined,
            openLevel: t.openLevel, closeLevel: t.closeLevel, reference: t.dealId,
          });
        }
        // Gick IG-positionerna inte att läsa syns de simulerade ändå (de finns bara här)
        if (!open.some((o) => o.sim)) {
          const exits = listTimedExits();
          for (const p of sim.positionsView()) {
            const x = exits.find((y) => y.dealId === p.dealId);
            open.push({
              coin: `${p.name} · ${DEMO_SIM_SHORT}`, epic: p.epic, dealId: p.dealId, direction: p.direction, qty: p.size, avg: p.level, price: p.currentPrice, value: null,
              upnl: p.upnl, upnlPct: p.currentPrice !== null && p.level > 0 ? ((p.direction === "SELL" ? -1 : 1) * (p.currentPrice - p.level) / p.level) * 100 : null,
              tp: p.limitLevel ?? undefined, sl: p.stopLevel ?? undefined, closeAt: x?.requestedExitAt ?? x?.exitAt ?? null, nextAttemptAt: x?.exitAt ?? null,
              exitState: x ? x.igState ?? "waiting" : null, exitError: x?.lastError ?? null, sim: true,
            });
          }
        }
      } catch (e) { errors.push(`simulering: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  // Bara när IG-historiken faktiskt lästes: ett IG-avbrott får aldrig nollställa trappan/minnet.
  if (!errors.length) {
    const pnls = igTrades.filter((t) => t.pnl !== undefined).sort((a, b) => a.at - b.at).map((t) => t.pnl!);
    setStakeHistory(pnls, balance, currency, env);
  }
  // F1: strategins stängda affärer registreras bara när positioner OCH hela historiken lästes utan fel (samma miljö).
  // Ofullständig historik (fler sidor än lästes) → vänta, så att en delstängning aldrig räknas som hela affären.
  if (!errors.length && livePositions && !partial) {
    try { reconcileStrategyDeals(env, livePositions, rawTx, parseIgMoney, currency); }
    catch (e) { log.warn(`[strategi-resultat] avstämningen misslyckades: ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (env === "demo" && !errors.length) {
    try {
      mkdirSync(path.dirname(dataPath("ig-closed-demo.json")), { recursive: true });
      writeFileSync(dataPath("ig-closed-demo.json"), JSON.stringify(igTrades.filter((t) => t.pnl !== undefined).map((t) => ({ base: t.coin, side: "SELL", qty: t.qty, price: t.price, at: t.at, kind: "IG Demo", pnl: t.pnl }))));
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
