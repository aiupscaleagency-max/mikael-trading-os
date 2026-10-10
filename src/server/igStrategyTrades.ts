// ═════════════════════════════════════════════════════════════════════
// F1: koppla IG-affärer till strategier i Strategibiblioteket
//
//  1. En order som skapas från en strategi bär strategi-id:t (PendingOrder.strategyId).
//  2. När IG accepterar ordern sparas dealId → strategi här (ig-strategy-deals.json), per miljö.
//  3. När positionen inte längre finns hos IG letas den stängda affären upp i IG:s egen
//     transaktionshistorik (samma miljö) och resultatet registreras EN gång per dealId.
//
// Ingen gissning: en affär utan strategi-id registreras aldrig, och en stängd position
// registreras bara när EXAKT en ny transaktion i historiken passar (samma instrument,
// samma storlek, samma öppningskurs om den är känd, stängd efter öppningen).
// ═════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../dataDir.js";
import { log } from "../logger.js";
import { isLibraryStrategy, recordStrategyTrade, type LibraryEnv } from "./igStrategyLibrary.js";

export interface StrategyDeal {
  env: LibraryEnv;
  dealId: string;
  strategyId: string;
  epic: string;
  name: string | null;
  size: number | null;
  openLevel: number | null;
  openedAt: number;
  /** Transaktionen som räknades (så samma rad aldrig används för två affärer) */
  txKey?: string;
  recordedAt?: number;
}

const file = () => dataPath("ig-strategy-deals.json");
function readDeals(): StrategyDeal[] {
  try { const v = JSON.parse(fs.readFileSync(file(), "utf8")); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeDeals(list: StrategyDeal[]): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    // Behåll alla öppna + de 500 senaste registrerade
    const open = list.filter((d) => !d.recordedAt), done = list.filter((d) => d.recordedAt).slice(-500);
    const tmp = file() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify([...done, ...open], null, 2));
    fs.renameSync(tmp, file());
  } catch (err) { log.warn(`[strategi-resultat] kunde inte spara: ${err instanceof Error ? err.message : String(err)}`); }
}

export function listStrategyDeals(env?: LibraryEnv): StrategyDeal[] { return readDeals().filter((d) => !env || d.env === env); }

/** Spara att en accepterad IG-affär kom från en strategi. Utan känt strategi-id sparas inget. */
export function tagStrategyDeal(d: { env: LibraryEnv; dealId?: string | null; strategyId?: string | null; epic: string; name?: string | null; size?: number | null; openedAt?: number }): boolean {
  if (!d.dealId || !isLibraryStrategy(d.strategyId) || (d.env !== "demo" && d.env !== "live")) return false;
  const list = readDeals();
  if (list.some((x) => x.env === d.env && x.dealId === d.dealId)) return false;
  const fin = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  list.push({ env: d.env, dealId: d.dealId, strategyId: d.strategyId, epic: d.epic, name: d.name ?? null, size: fin(d.size), openLevel: null /* tas från IG-positionen, aldrig från en uppskattad orderkurs */, openedAt: d.openedAt ?? Date.now() });
  writeDeals(list);
  log.trade(`[strategi-resultat] ${d.dealId} (${d.env === "live" ? "IG Live" : "IG Demo"}) hör till strategin ${d.strategyId}`);
  return true;
}

export interface ObservedPosition { dealId?: string; name?: string | null; symbol?: string; quantity?: number; avgEntryPrice?: number }
export interface ClosedTx { date?: string | null; type?: string | null; instrumentName?: string | null; size?: string | null; openLevel?: string | null; profitAndLoss?: string | null; currency?: string | null; reference?: string | null; cashTransaction?: boolean | null }

const num = (v: unknown) => { const n = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const txTime = (t: ClosedTx) => { const s = String(t.date ?? ""); const ms = Date.parse(s.replace(" ", "T") + (s.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(s) ? "" : "Z")); return Number.isFinite(ms) ? ms : null; };
const txKeyOf = (t: ClosedTx) => `${t.reference ?? ""}|${t.date ?? ""}|${t.instrumentName ?? ""}|${t.size ?? ""}|${t.openLevel ?? ""}`;

/**
 * Stämmer av strategins affärer för EN miljö mot IG:s positioner och transaktionshistorik.
 * Anropas bara när både positioner och historik lästes utan fel. Returnerar antalet nya registreringar.
 */
export function reconcileStrategyDeals(env: LibraryEnv, positions: ObservedPosition[], transactions: ClosedTx[], parseMoney: (v: unknown) => number | null, accountCurrency: string | null, now = Date.now()): number {
  const list = readDeals();
  const mine = list.filter((d) => d.env === env && !d.recordedAt);
  if (!mine.length) return 0;
  let changed = false, recorded = 0;
  const openIds = new Set(positions.map((p) => p.dealId).filter(Boolean));
  const used = new Set(list.filter((d) => d.env === env && d.txKey).map((d) => d.txKey!));
  for (const d of mine) {
    const pos = positions.find((p) => p.dealId === d.dealId);
    if (pos) {
      // Fortfarande öppen: ta öppningskurs, storlek och namn direkt från IG
      const lvl = num(pos.avgEntryPrice), sz = num(pos.quantity);
      if (lvl && lvl > 0 && d.openLevel !== lvl) { d.openLevel = lvl; changed = true; }
      if (sz && sz > 0 && d.size !== sz) { d.size = sz; changed = true; }
      if (pos.name && d.name !== pos.name) { d.name = pos.name; changed = true; }
      continue;
    }
    if (openIds.has(d.dealId)) continue;
    const candidates = transactions.filter((t) => {
      if (t.cashTransaction === true || t.type !== "DEAL") return false;
      if (used.has(txKeyOf(t))) return false;
      if (parseMoney(t.profitAndLoss) === null) return false;
      const at = txTime(t); if (at === null || at < d.openedAt - 60_000) return false;
      if (!d.name || t.instrumentName !== d.name) return false;
      const sz = num(t.size); if (d.size !== null && (sz === null || Math.abs(Math.abs(sz) - d.size) > 1e-9)) return false;
      const ol = num(t.openLevel); if (d.openLevel !== null && (ol === null || Math.abs(ol - d.openLevel) > Math.max(1e-9, d.openLevel * 1e-9))) return false;
      return true;
    });
    // Ingen eller flera möjliga rader: vänta (historiken kan vara sen) i stället för att gissa.
    if (candidates.length !== 1) continue;
    const t = candidates[0]!;
    const r = recordStrategyTrade(env, d.strategyId, { dealId: d.dealId, pnl: parseMoney(t.profitAndLoss)!, currency: t.currency ?? accountCurrency, at: txTime(t)!, epic: d.epic }, now);
    if (!r.ok) { log.warn(`[strategi-resultat] ${d.dealId}: ${r.error}`); continue; }
    d.txKey = txKeyOf(t); d.recordedAt = now; used.add(d.txKey); changed = true;
    if (!r.duplicate) recorded++;
  }
  if (changed) writeDeals(list);
  return recorded;
}
