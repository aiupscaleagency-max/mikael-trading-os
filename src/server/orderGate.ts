import fs from "node:fs/promises";
import path from "node:path";
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

let liveSpentTodayUsd = 0;
let liveSpendDay = new Date().toISOString().slice(0, 10);

function rollDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== liveSpendDay) {
    liveSpendDay = today;
    liveSpentTodayUsd = 0;
  }
}

export function getLiveSpentTodayUsd(): number {
  rollDay();
  return liveSpentTodayUsd;
}

/** Räkna upp dagens LIVE-köp. Anropas efter att ett LIVE-köp gått igenom. */
export function recordLiveSpend(usd: number): void {
  rollDay();
  if (Number.isFinite(usd) && usd > 0) liveSpentTodayUsd += usd;
}

/** Är servern startad för riktiga pengar? Bara .env kan säga ja. */
export function liveAllowedByServer(): boolean {
  return config.mode === "live" && process.env.LIVE_TRADING_CONFIRMED === "true";
}

export interface GateInput {
  live: boolean;
  side: "BUY" | "SELL";
  /** USD-belopp för köp (quoteOrderQty/notional). Okänt för sälj per antal. */
  quoteUsd?: number;
  /** Sant för ordrar i antal enheter (t.ex. Oanda) där USD-belopp inte är känt. */
  unitsOrder?: boolean;
  source: string;
}

export type GateResult = { ok: true } | { ok: false; error: string };

export async function checkOrderGate(input: GateInput): Promise<GateResult> {
  const deny = (error: string): GateResult => {
    log.warn(`🛡 Order stoppad (${input.source}): ${error}`);
    return { ok: false, error };
  };

  if (input.side === "BUY") {
    const state = await loadState().catch(() => null);
    if (state?.killSwitchActive) {
      return deny("Kill switch är på. Inga nya köp förrän du stänger av den.");
    }
  }

  if (input.live && !liveAllowedByServer()) {
    return deny(
      "LIVE (riktiga pengar) är låst. Det slås bara på i .env (MODE=live och LIVE_TRADING_CONFIRMED=true) och omstart, aldrig från webbläsaren.",
    );
  }

  if (input.side === "BUY" && !input.unitsOrder) {
    const amt = Number(input.quoteUsd);
    if (!Number.isFinite(amt) || amt <= 0) {
      return deny("Beloppet saknas eller är ogiltigt.");
    }
    const cap = input.live ? MAX_LIVE_STAKE_USD : testStakeCapUsd();
    if (amt > cap) {
      return deny(`Max $${cap} per order i ${input.live ? "LIVE" : "TEST"}. Du försökte $${amt}.`);
    }
    if (input.live && getLiveSpentTodayUsd() + amt > MAX_LIVE_DAILY_SPEND_USD) {
      return deny(
        `Dagens LIVE-gräns är $${MAX_LIVE_DAILY_SPEND_USD}. Redan köpt för $${getLiveSpentTodayUsd().toFixed(2)} i dag.`,
      );
    }
  }

  return { ok: true };
}

/** Ska ordern vänta på Mikes godkännande? */
export function needsApproval(): boolean {
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
  /** Pris när ordern föreslogs (för att visa möjlig vinst/förlust) */
  refPrice?: number;
  reason?: string;
  status: "pending" | "done" | "rejected" | "failed";
  decidedAt?: string;
  result?: unknown;
  error?: string;
}

const PENDING_FILE = path.resolve(process.cwd(), "data", "pending-orders.json");
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
  return p;
}

/** Finns redan en väntande order för samma symbol + sida? (så monitorn inte köar dubbletter) */
export async function hasPendingFor(symbol: string, side: "BUY" | "SELL", venue: string): Promise<boolean> {
  return (await load()).some((p) => p.status === "pending" && p.symbol === symbol && p.side === side && p.venue === venue);
}
