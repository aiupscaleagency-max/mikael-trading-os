// ═════════════════════════════════════════════════════════════════════
// F1: koppla IG-affärer till strategier i Strategibiblioteket
//
//  1. En order som skapas från en strategi bär strategi-id:t (PendingOrder.strategyId).
//  2. När IG accepterar ordern sparas dealId → strategi här (ig-strategy-deals.json), per miljö,
//     med riktning, ursprunglig storlek och öppningskurs ur IG:s bekräftelse.
//     Limitordrar räknas först när en öppen position med samma dealId syns hos IG.
//     En order med okänt utfall som senare stäms av som accepterad kopplas via utkastets id.
//  3. När positionen är helt stängd letas stängningsraderna upp i IG:s transaktionshistorik
//     (samma miljö, fullständig historik). Delstängningar summeras. Resultatet registreras EN
//     gång per dealId.
//
// Ingen gissning: utan strategi-id registreras inget. Raderna måste ha samma instrument,
// samma riktning, samma öppningskurs, (om IG anger den) öppningstid nära orderns och tillsammans
// exakt den ursprungliga storleken. Annars väntar affären; efter 7 dagar utan träff tas den bort
// utan att registreras.
// ═════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../dataDir.js";
import { log } from "../logger.js";
import { isLibraryStrategy, recordStrategyTrade, type LibraryEnv } from "./igStrategyLibrary.js";

export const STRATEGY_DEAL_MAX_AGE_MS = 7 * 86_400_000;
/** Hur nära orderns tid IG:s öppningstid (om historiken anger den) måste ligga */
export const OPEN_TIME_WINDOW_MS = 5 * 60_000;

export interface StrategyDeal {
  env: LibraryEnv;
  dealId: string;
  strategyId: string;
  epic: string;
  name: string | null;
  direction: "BUY" | "SELL";
  /** Ursprunglig storlek. Ändras aldrig av delstängningar. */
  size: number;
  /** Öppningskurs ur IG:s bekräftelse, annars ur IG-positionen. Utan den räknas affären aldrig. */
  openLevel: number | null;
  openedAt: number;
  orderType: "MARKET" | "LIMIT";
  /** Limitorder: väntar tills en öppen position med samma dealId syns */
  awaitingFill?: boolean;
  filledSeenAt?: number;
  /** Transaktionsraderna som räknades (så samma rad aldrig används för två affärer) */
  txKeys?: string[];
  recordedAt?: number;
}

const file = () => dataPath("ig-strategy-deals.json");
const unknownFile = () => dataPath("ig-strategy-unknown.json");
function readList<T>(f: string): T[] {
  try { const v = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeList(f: string, list: unknown[]): void {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, f);
  } catch (err) { log.warn(`[strategi-resultat] kunde inte spara: ${err instanceof Error ? err.message : String(err)}`); }
}
const readDeals = () => readList<StrategyDeal>(file());
function writeDeals(list: StrategyDeal[]): void {
  // Behåll alla öppna + de 500 senaste registrerade
  const open = list.filter((d) => !d.recordedAt), done = list.filter((d) => d.recordedAt).slice(-500);
  writeList(file(), [...done, ...open]);
}

export function listStrategyDeals(env?: LibraryEnv): StrategyDeal[] { return readDeals().filter((d) => !env || d.env === env); }

const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** Spara att en accepterad IG-affär kom från en strategi. Utan känt strategi-id, riktning eller storlek sparas inget. */
export function tagStrategyDeal(d: { env: LibraryEnv; dealId?: string | null; strategyId?: string | null; epic: string; name?: string | null; direction?: string | null; size?: number | null; openLevel?: number | null; orderType?: "MARKET" | "LIMIT"; openedAt?: number }): boolean {
  if (!d.dealId || !isLibraryStrategy(d.strategyId) || (d.env !== "demo" && d.env !== "live")) return false;
  if (d.direction !== "BUY" && d.direction !== "SELL") return false;
  const size = pos(d.size);
  if (!size) return false;
  const list = readDeals();
  if (list.some((x) => x.env === d.env && x.dealId === d.dealId)) return false;
  const orderType = d.orderType === "LIMIT" ? "LIMIT" : "MARKET";
  list.push({
    env: d.env, dealId: d.dealId, strategyId: d.strategyId, epic: d.epic, name: d.name ?? null, direction: d.direction, size,
    openLevel: pos(d.openLevel), openedAt: d.openedAt ?? Date.now(), orderType, ...(orderType === "LIMIT" ? { awaitingFill: true } : {}),
  });
  writeDeals(list);
  log.trade(`[strategi-resultat] ${d.dealId} (${d.env === "live" ? "IG Live" : "IG Demo"}) hör till strategin ${d.strategyId}${orderType === "LIMIT" ? " (räknas när limitordern fyllts)" : ""}`);
  return true;
}

// ─── Ordrar med okänt utfall: kopplas om IG senare bekräftar dem (utkastets id) ───
interface UnknownStrategyOrder { env: LibraryEnv; draftId: string; strategyId: string; epic: string; name: string | null; createdAt: number }
export function rememberUnknownStrategyOrder(o: Omit<UnknownStrategyOrder, "createdAt">, now = Date.now()): boolean {
  if (!o.draftId || !isLibraryStrategy(o.strategyId)) return false;
  const list = readList<UnknownStrategyOrder>(unknownFile()).filter((x) => now - x.createdAt < STRATEGY_DEAL_MAX_AGE_MS && !(x.env === o.env && x.draftId === o.draftId));
  list.push({ ...o, createdAt: now });
  writeList(unknownFile(), list.slice(-200));
  return true;
}
export function takeUnknownStrategyOrder(env: LibraryEnv, draftId: string, now = Date.now()): UnknownStrategyOrder | null {
  const list = readList<UnknownStrategyOrder>(unknownFile());
  const hit = list.find((x) => x.env === env && x.draftId === draftId && now - x.createdAt < STRATEGY_DEAL_MAX_AGE_MS) ?? null;
  const rest = list.filter((x) => !(x.env === env && x.draftId === draftId) && now - x.createdAt < STRATEGY_DEAL_MAX_AGE_MS);
  if (rest.length !== list.length) writeList(unknownFile(), rest);
  return hit;
}

export interface ObservedPosition { dealId?: string; name?: string | null; symbol?: string; quantity?: number; avgEntryPrice?: number }
export interface ClosedTx { date?: string | null; openDate?: string | null; type?: string | null; instrumentName?: string | null; size?: string | null; openLevel?: string | null; profitAndLoss?: string | null; currency?: string | null; reference?: string | null; cashTransaction?: boolean | null }

const num = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
const timeOf = (v: unknown) => { const s = String(v ?? ""); if (!s) return null; const ms = Date.parse(s.replace(" ", "T") + (s.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(s) ? "" : "Z")); return Number.isFinite(ms) ? ms : null; };
const txKeyOf = (t: ClosedTx) => `${t.reference ?? ""}|${t.date ?? ""}|${t.instrumentName ?? ""}|${t.size ?? ""}|${t.openLevel ?? ""}`;
const sameLevel = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-7);
/** IG-valuta ska vara en ISO-kod (SEK, EUR …). Annat (t.ex. "kr") → kontots valuta. */
export function normalizeCurrency(c: unknown, accountCurrency: string | null): string | null {
  return typeof c === "string" && /^[A-Z]{3}$/.test(c.trim()) ? c.trim() : accountCurrency;
}

/**
 * Stämmer av strategins affärer för EN miljö mot IG:s positioner och FULLSTÄNDIGA transaktionshistorik.
 * Anropas bara när både positioner och historik lästes utan fel. Returnerar antalet nya registreringar.
 */
export function reconcileStrategyDeals(env: LibraryEnv, positions: ObservedPosition[], transactions: ClosedTx[], parseMoney: (v: unknown) => number | null, accountCurrency: string | null, now = Date.now()): number {
  let list = readDeals();
  if (!list.some((d) => d.env === env && !d.recordedAt)) return 0;
  let changed = false, recorded = 0;
  const used = new Set(list.filter((d) => d.env === env).flatMap((d) => d.txKeys ?? []));
  const expired = new Set<StrategyDeal>();
  for (const d of list.filter((x) => x.env === env && !x.recordedAt)) {
    const p = positions.find((x) => x.dealId === d.dealId);
    if (p) {
      if (d.awaitingFill) { d.awaitingFill = false; d.filledSeenAt = now; changed = true; }
      // Kursen ur bekräftelsen gäller; saknas den tas den ur IG-positionen. Storleken ändras aldrig (delstängningar).
      const lvl = pos(num(p.avgEntryPrice));
      if (d.openLevel === null && lvl) { d.openLevel = lvl; changed = true; }
      if (!d.name && p.name) { d.name = p.name; changed = true; }
      continue;
    }
    if (now - d.openedAt > STRATEGY_DEAL_MAX_AGE_MS) { expired.add(d); continue; }
    if (d.awaitingFill || d.openLevel === null || !d.name) continue;
    const from = d.openedAt - OPEN_TIME_WINDOW_MS, to = (d.filledSeenAt ?? d.openedAt) + OPEN_TIME_WINDOW_MS;
    const rows = transactions.filter((t) => {
      if (t.cashTransaction === true || t.type !== "DEAL" || used.has(txKeyOf(t))) return false;
      if (parseMoney(t.profitAndLoss) === null || t.instrumentName !== d.name) return false;
      const closedAt = timeOf(t.date); if (closedAt === null || closedAt < d.openedAt - 60_000) return false;
      const sz = num(t.size); if (sz === null || sz === 0 || (sz < 0 ? "SELL" : "BUY") !== d.direction) return false;
      const ol = num(t.openLevel); if (ol === null || !sameLevel(ol, d.openLevel!)) return false;
      const openedAt = timeOf(t.openDate); if (openedAt !== null && (openedAt < from || openedAt > to)) return false;
      return true;
    });
    if (!rows.length) continue;
    // Positionen är borta: stängningsraderna ska tillsammans vara exakt den ursprungliga storleken.
    const total = rows.reduce((s, t) => s + Math.abs(num(t.size)!), 0);
    if (Math.abs(total - d.size) > 1e-9) continue;
    const currencies = new Set(rows.map((t) => normalizeCurrency(t.currency, accountCurrency)));
    if (currencies.size !== 1) continue;
    const pnl = Math.round(rows.reduce((s, t) => s + parseMoney(t.profitAndLoss)!, 0) * 100) / 100;
    const at = Math.max(...rows.map((t) => timeOf(t.date)!));
    const r = recordStrategyTrade(env, d.strategyId, { dealId: d.dealId, pnl, currency: [...currencies][0] ?? null, at, epic: d.epic }, now);
    if (!r.ok) { log.warn(`[strategi-resultat] ${d.dealId}: ${r.error}`); continue; }
    d.txKeys = rows.map(txKeyOf); d.recordedAt = now; d.txKeys.forEach((k) => used.add(k)); changed = true;
    if (!r.duplicate) recorded++;
  }
  if (expired.size) {
    for (const d of expired) log.warn(`[strategi-resultat] ${d.dealId}: ingen säker träff i IG-historiken på 7 dagar, tas bort utan att räknas`);
    list = list.filter((d) => !expired.has(d)); changed = true;
  }
  if (changed) writeDeals(list);
  return recorded;
}
