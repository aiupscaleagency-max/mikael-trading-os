import { dataDir, dataPath } from "../dataDir.js";
import fs from "node:fs/promises";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { config } from "../config.js";
import { loadState } from "../memory/store.js";
import { log } from "../logger.js";
import { currentStake } from "../risk/stakeLadder.js";
import { getCachedPrice } from "./marketStream.js";

// ═══════════════════════════════════════════════════════════════════════════
//  ORDER-GRIND — en enda kontroll som ALLA order-vägar går igenom
//
//  Dashboard-knappar, chatten, agenten och väntande ordrar använder samma
//  regler så att TEST och LIVE beter sig likadant överallt:
//
//   1. Kill switch aktiv        → inga KÖP (sälj för att stänga är tillåtet)
//   2. LIVE (riktiga pengar)    → kräver MODE=live + LIVE_TRADING_CONFIRMED=true
//                                 i .env. Kan inte slås på från webbläsaren.
//   3. Max belopp per order     → LIVE: MAX_LIVE_STAKE_USD (5)
//                                 TEST: MAX_TEST_STAKE_USD (100)
//   4. Max köp per dag i LIVE   → MAX_LIVE_DAILY_SPEND_USD (10), nollas 00:00 UTC
//   5. EXECUTION_MODE=approve   → ordern läggs som VÄNTANDE och körs först när
//                                 Mike trycker Godkänn.
// ═══════════════════════════════════════════════════════════════════════════

export const MAX_LIVE_STAKE_USD = parseFloat(process.env.MAX_LIVE_STAKE_USD || "5");
export const MAX_TEST_STAKE_USD = parseFloat(process.env.MAX_TEST_STAKE_USD || "100");

/** TEST-tak per order: insats-trappan (1 % → 5 % av låtsaskontot), annars MAX_TEST_STAKE_USD. */
export function testStakeCapUsd(): number {
  if (process.env.MAX_TEST_STAKE_USD) return MAX_TEST_STAKE_USD;
  const s = currentStake();
  return s && s.usd > 0 ? s.usd : MAX_TEST_STAKE_USD;
}
export const MAX_LIVE_DAILY_SPEND_USD = parseFloat(
  process.env.MAX_LIVE_DAILY_SPEND_USD || process.env.MAX_LIVE_DAILY_LOSS_USD || "10",
);

// Dagens LIVE-köp sparas i data/live-spend.json så att $-taket per dag
// gäller även efter en omstart.
const LIVE_SPEND_FILE = dataPath("live-spend.json");
let liveSpentTodayUsd = 0;
let liveSpendDay = new Date().toISOString().slice(0, 10);
try {
  const saved = JSON.parse(readFileSync(LIVE_SPEND_FILE, "utf8")) as { day?: string; usd?: number };
  if (saved.day === liveSpendDay && Number(saved.usd) > 0) liveSpentTodayUsd = Number(saved.usd);
} catch { /* ingen fil än */ }

function persistLiveSpend(): void {
  try {
    mkdirSync(path.dirname(LIVE_SPEND_FILE), { recursive: true });
    writeFileSync(LIVE_SPEND_FILE, JSON.stringify({ day: liveSpendDay, usd: liveSpentTodayUsd }));
  } catch (err) {
    log.warn(`Kunde inte spara dagens LIVE-köp: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function rollDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== liveSpendDay) {
    liveSpendDay = today;
    liveSpentTodayUsd = 0;
    persistLiveSpend();
  }
}

export function getLiveSpentTodayUsd(): number {
  rollDay();
  return liveSpentTodayUsd;
}

/** Räkna upp dagens LIVE-köp. Anropas efter att ett LIVE-köp gått igenom. */
export function recordLiveSpend(usd: number): void {
  rollDay();
  if (Number.isFinite(usd) && usd > 0) { liveSpentTodayUsd += usd; persistLiveSpend(); }
}

/** Justera dagens LIVE-köp (t.ex. ge tillbaka en reservation när köpet misslyckades). */
export function adjustLiveSpend(deltaUsd: number): void {
  rollDay();
  if (!Number.isFinite(deltaUsd) || deltaUsd === 0) return;
  liveSpentTodayUsd = Math.max(0, liveSpentTodayUsd + deltaUsd);
  persistLiveSpend();
}

/** Är servern startad för riktiga pengar? Bara .env kan säga ja. */
export function liveAllowedByServer(): boolean {
  return config.mode === "live" && process.env.LIVE_TRADING_CONFIRMED?.trim().toLowerCase() === "true";
}

export interface GateInput {
  live: boolean;
  side: "BUY" | "SELL";
  /** USD-belopp för köp (quoteOrderQty/notional). Okänt för sälj per antal. */
  quoteUsd?: number;
  /** Sant för ordrar i antal enheter (t.ex. IG-kontrakt) där USD-belopp inte är känt. */
  unitsOrder?: boolean;
  /** IG/CFD: ordern öppnar en ny position (även SÄLJ = kort). Kill switch stoppar då även sälj. */
  opening?: boolean;
  source: string;
  /** IG-EPIC (för sessionens försökslista) */
  symbol?: string;
}

/** Krav E5: försök som räknats mot agentsessionens tak (följer den väntande ordern). */
export interface SessionAttemptTag { env: "demo" | "live"; sessionId: string; no: number }
export type SessionAttemptOutcome = "föreslagen" | "accepterad" | "avvisad" | "okänd" | "stoppad" | "nekad" | "utgick";
export type GateResult = { ok: true; sessionAttempt?: SessionAttemptTag } | { ok: false; error: string };

// Agentsessioner (igSessions): räknar/spärrar agenternas nya orderförsök, och schemalagda
// omgångar tvingar alltid fram Godkänn. Sätts av run.ts; null = ingen session-logik.
type SessionHookResult = string | null | { attempt: SessionAttemptTag };
let sessionHook: ((input: GateInput) => SessionHookResult) | null = null;
let attemptOutcome: ((tag: SessionAttemptTag, outcome: SessionAttemptOutcome, note?: string | null) => boolean) | null = null;
let approvalOverride: (() => boolean) | null = null;
// Tillfälliga spärrar (t.ex. medan agentteamet granskar en inklistrad signal: granskning ≠ order).
const blocks = new Set<(input: GateInput) => string | null>();
export function addOrderGateBlock(fn: (input: GateInput) => string | null): () => void { blocks.add(fn); return () => { blocks.delete(fn); }; }
export function setOrderGateSessionHook(hook: ((input: GateInput) => SessionHookResult) | null, forceApproval: (() => boolean) | null = null,
  outcome: ((tag: SessionAttemptTag, outcome: SessionAttemptOutcome, note?: string | null) => boolean) | null = null): void {
  sessionHook = hook; approvalOverride = forceApproval; attemptOutcome = outcome;
}
/** Skriver utfallet för ett sessionsförsök (accepterad/avvisad/okänd/stoppad/nekad/utgick). Räkningen står kvar. */
export function reportSessionAttempt(tag: SessionAttemptTag | null | undefined, outcome: SessionAttemptOutcome, note: string | null = null): void {
  if (!tag || !attemptOutcome) return;
  try { attemptOutcome(tag, outcome, note); } catch { /* utfallet är bara visning; räkningen är redan gjord */ }
}

/** Öppnar ordern en ny position (eller ökar en)? IG/CFD anger det uttryckligen med `opening`:
 *  stängning/minskning (även KÖP som stänger en kort) är aldrig "ny" och stoppas aldrig av kill switch
 *  eller tillfälliga spärrar. Andra handelsplatser utan `opening`: KÖP = ny position. */
export function isOpeningOrder(input: Pick<GateInput, "side" | "opening" | "unitsOrder">): boolean {
  if (typeof input.opening === "boolean") return input.opening;
  if (input.unitsOrder) return true; // IG utan uttrycklig flagga: försiktigt, behandla som ny
  return input.side === "BUY";
}

export async function checkOrderGate(input: GateInput): Promise<GateResult> {
  const deny = (error: string): GateResult => {
    log.warn(`🛡 Order stoppad (${input.source}): ${error}`);
    return { ok: false, error };
  };

  const opening = isOpeningOrder(input);
  if (opening) {
    const state = await loadState().catch(() => null);
    if (state?.killSwitchActive) {
      return deny("Kill switch är på. Inga nya positioner förrän du stänger av den.");
    }
  }

  if (opening && !input.source.startsWith("godkänd:")) {
    for (const b of blocks) { const why = b(input); if (why) return deny(why); }
  }
  let sessionAttempt: SessionAttemptTag | undefined;
  if (sessionHook) {
    const why = sessionHook(input);
    if (typeof why === "string") return deny(why);
    if (why && typeof why === "object") sessionAttempt = why.attempt;
  }
  // Ett försök som redan räknats och sedan stoppas av en senare spärr är fortfarande ett försök.
  const denyCounted = (error: string): GateResult => { reportSessionAttempt(sessionAttempt, "stoppad", error); return deny(error); };

  if (input.live && !liveAllowedByServer()) {
    return denyCounted(
      "LIVE (riktiga pengar) är låst. Det slås bara på i .env (MODE=live och LIVE_TRADING_CONFIRMED=true) och omstart, aldrig från webbläsaren.",
    );
  }

  if (input.side === "BUY" && !input.unitsOrder) {
    const amt = Number(input.quoteUsd);
    if (!Number.isFinite(amt) || amt <= 0) {
      return denyCounted("Beloppet saknas eller är ogiltigt.");
    }
    const cap = input.live ? MAX_LIVE_STAKE_USD : testStakeCapUsd();
    if (amt > cap) {
      return denyCounted(`Max $${cap} per order i ${input.live ? "LIVE" : "TEST"}. Du försökte $${amt}.`);
    }
    if (input.live && getLiveSpentTodayUsd() + amt > MAX_LIVE_DAILY_SPEND_USD) {
      return denyCounted(
        `Dagens LIVE-gräns är $${MAX_LIVE_DAILY_SPEND_USD}. Redan köpt för $${getLiveSpentTodayUsd().toFixed(2)} i dag.`,
      );
    }
  }

  return sessionAttempt ? { ok: true, sessionAttempt } : { ok: true };
}

/** Ska ordern vänta på Mikes godkännande? */
export function needsApproval(): boolean {
  if (approvalOverride?.()) return true;
  return config.executionMode === "approve";
}

// ─── Väntande ordrar ──────────────────────────────────────────────────────

export interface PendingOrder {
  id: string;
  createdAt: string;
  source: string;
  /** "binance" eller "broker:<namn>" (t.ex. broker:alpaca) */
  venue: string;
  live: boolean;
  symbol: string;
  side: "BUY" | "SELL";
  quoteUsd?: number;
  quantity?: number;
  /** Saknas = MARKET (som förut) */
  orderType?: "MARKET" | "LIMIT";
  limitPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  /** F1: strategi i Strategibiblioteket som ordern kom från (bara när den är känd). Stängda affärer räknas på den. */
  strategyId?: string;
  /** Krav E5: försöket som räknats mot agentsessionens tak (utfallet skrivs dit) */
  sessionAttempt?: SessionAttemptTag;
  /** Pris när ordern föreslogs (för att visa möjlig vinst/förlust) */
  refPrice?: number;
  /** Sälj hela innehavet (antalet räknas fram när ordern godkänns) */
  sellAll?: boolean;
  reason?: string;
  /** Tidshorisont i sekunder (1–30 min säljs automatiskt när tiden är slut) */
  horizonSec?: number;
  /** IG: instrumentets namn, insats i kontovalutan, stängning av befintlig position */
  name?: string;
  stakePct?: number;
  stakeAmount?: number;
  currency?: string;
  closeDealId?: string;
  /** IG: uträkning när förslaget skapades (kontovaluta). Visas i popupen/kön; ändrar inget i ordern. */
  quoteInfo?: { size: number | null; unit: string | null; contractSize: number | null; margin: number | null; exposure: number | null; moneyAtTp: number | null; moneyAtSl: number | null; minSize: number | null; basis?: string };
  /** Förslaget försvinner (status "expired") efter den här tiden */
  expiresAt?: string;
  status: "pending" | "done" | "rejected" | "failed" | "expired";
  decidedAt?: string;
  result?: unknown;
  error?: string;
}

const PENDING_FILE = dataPath("pending-orders.json");
let pending: PendingOrder[] | null = null;

async function load(): Promise<PendingOrder[]> {
  if (pending) return pending;
  try {
    pending = JSON.parse(await fs.readFile(PENDING_FILE, "utf8")) as PendingOrder[];
  } catch {
    pending = [];
  }
  return pending;
}

async function save(): Promise<void> {
  if (!pending) return;
  // Behåll alla väntande + de 200 senaste avgjorda
  const open = pending.filter((p) => p.status === "pending");
  const decided = pending.filter((p) => p.status !== "pending").slice(-200);
  pending = [...decided, ...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await fs.mkdir(path.dirname(PENDING_FILE), { recursive: true });
  await fs.writeFile(PENDING_FILE, JSON.stringify(pending, null, 2), "utf8");
}

export async function listPendingOrders(): Promise<PendingOrder[]> {
  return [...(await load())].reverse();
}

export async function addPendingOrder(
  o: Omit<PendingOrder, "id" | "createdAt" | "status">,
): Promise<PendingOrder> {
  const list = await load();
  const entry: PendingOrder = {
    ...o,
    refPrice: o.refPrice ?? o.limitPrice ?? getCachedPrice(o.symbol) ?? undefined,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  // Med tidshorisont: förslaget gäller lika länge som traden (minst 2 min)
  if (entry.horizonSec && entry.horizonSec > 0 && !entry.expiresAt) {
    entry.expiresAt = new Date(Date.now() + Math.max(120, entry.horizonSec) * 1000).toISOString();
  }
  list.push(entry);
  await save();
  log.agent(
    `[VÄNTAR PÅ GODKÄNNANDE] ${entry.side} ${entry.symbol}` +
      `${entry.quoteUsd ? ` $${entry.quoteUsd}` : ""} via ${entry.venue} (${entry.live ? "LIVE" : "TEST"}) från ${entry.source}`,
  );
  return entry;
}

export async function getPendingOrder(id: string): Promise<PendingOrder | undefined> {
  return (await load()).find((p) => p.id === id);
}

export async function updatePendingOrder(id: string, patch: Partial<PendingOrder>): Promise<PendingOrder | undefined> {
  const list = await load();
  const p = list.find((x) => x.id === id);
  if (!p) return undefined;
  Object.assign(p, patch, { decidedAt: new Date().toISOString() });
  await save();
  // Krav E5: nekad eller utgången räknas ändå som förbrukat försök; utfallet visas i sessionen.
  if (patch.status === "rejected") reportSessionAttempt(p.sessionAttempt, "nekad", "Nekad i Väntande ordrar");
  if (patch.status === "expired") reportSessionAttempt(p.sessionAttempt, "utgick", "Förslaget gick ut utan Godkänn");
  return p;
}

/** Är förslaget för gammalt (giltighetstiden passerad)? */
export function isExpired(p: PendingOrder, now = Date.now()): boolean {
  return p.status === "pending" && !!p.expiresAt && Date.parse(p.expiresAt) <= now;
}

/** Markerar för gamla förslag som "expired". Returnerar hur många. */
export async function expireStalePendingOrders(): Promise<number> {
  const list = await load();
  const now = Date.now();
  let n = 0;
  for (const p of list) {
    if (isExpired(p, now)) { p.status = "expired"; p.decidedAt = new Date(now).toISOString(); n++; reportSessionAttempt(p.sessionAttempt, "utgick", "Förslaget gick ut utan Godkänn"); }
  }
  if (n) await save();
  return n;
}

/** Finns redan en väntande order för samma symbol + sida? (så monitorn inte köar dubbletter) */
export async function hasPendingFor(symbol: string, side: "BUY" | "SELL", venue: string): Promise<boolean> {
  return (await load()).some((p) => p.status === "pending" && p.symbol === symbol && p.side === side && p.venue === venue);
}
