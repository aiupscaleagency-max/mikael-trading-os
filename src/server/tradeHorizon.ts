// ═══════════════════════════════════════════════════════════════════════════
// Tidshorisont för trades (1 / 5 / 15 / 30 min).
//
// Mike vill korta trades och inga gamla signaler:
//  - Horisonten väljs i dashboarden och sparas i data/trade-horizon.json.
//  - Varje förslag i Väntande ordrar får ett "giltig till" och försvinner
//    (status "expired") när det blivit för gammalt.
//  - Ett köp med horisont ≤ 30 min säljs automatiskt när tiden är slut, om
//    TP/SL inte redan sålt det. Sparas i data/timed-exits.json (överlever omstart).
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { log } from "../logger.js";
import { expireStalePendingOrders } from "./orderGate.js";
import { recordLiveFill } from "./results.js";
import { removeLiveTpSlForSymbol } from "./liveTpSl.js";

export const HORIZON_CHOICES = [1, 5, 15, 30] as const;
/** Längsta horisont som säljs automatiskt (Mike: högst 30 min i början) */
export const MAX_AUTO_EXIT_SEC = 30 * 60;
/** Ett förslag gäller minst så här länge, även för 1-minuters trades */
const MIN_VALID_SEC = 120;

const HORIZON_FILE = path.resolve("data/trade-horizon.json");
const EXITS_FILE = path.resolve("data/timed-exits.json");

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; }
}
function writeJson(file: string, data: unknown): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    log.warn(`[horisont] kunde inte spara ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Vald horisont ───────────────────────────────────────────────────────

function normMin(v: unknown): number | null {
  const n = Number(v);
  return (HORIZON_CHOICES as readonly number[]).includes(n) ? n : null;
}

let horizonMin: number =
  normMin(readJson<{ minutes?: number }>(HORIZON_FILE, {}).minutes)
  ?? normMin(process.env.TRADE_HORIZON_MIN)
  ?? 1;

export function getHorizonMin(): number { return horizonMin; }

export function setHorizonMin(v: unknown): number | null {
  const n = normMin(v);
  if (n === null) return null;
  horizonMin = n;
  writeJson(HORIZON_FILE, { minutes: n });
  log.info(`[horisont] trades ${n} min`);
  return n;
}

/** Hur länge ett förslag får ligga och vänta innan det försvinner */
export function validitySec(horizonSec: number): number {
  return Math.max(MIN_VALID_SEC, Math.round(horizonSec));
}

/** Text till Hanna: vilken horisont och hur TP/SL ska sättas */
export function horizonPrompt(): string {
  const m = horizonMin;
  return `\n\n──── TIDSHORISONT: ${m} MIN ────\n`
    + `Mike kör korta trades. Föreslå BARA trades som ska hållas högst ${m} min. `
    + `Bygg beslutet på de korta tidsramarna (${shortIntervals().join("/")}). `
    + `Sätt TP och SL så att de rimligen kan nås inom ${m} min (avgiften är 0,25 % in + 0,25 % ut, så TP måste ligga över ~0,5 %). `
    + `Förslaget försvinner efter ${Math.round(validitySec(m * 60) / 60)} min om Mike inte godkänt det, och positionen säljs automatiskt när ${m} min gått. `
    + `Finns ingen tydlig rörelse för den horisonten: HOLD.`;
}

/** Tidsramar som passar horisonten (används för Hannas indikatorpaket) */
export function shortIntervals(): string[] {
  return horizonMin <= 5 ? ["1m", "5m", "15m"] : ["5m", "15m", "1h"];
}

// ─── Automatisk försäljning när tiden är slut ────────────────────────────

export interface TimedExit {
  id: string;
  broker: string;
  symbol: string;
  qty: number;
  live: boolean;
  openedAt: number;
  exitAt: number;
}

let exits: TimedExit[] = (() => {
  const v = readJson<TimedExit[]>(EXITS_FILE, []);
  return Array.isArray(v) ? v : [];
})();
const selling = new Set<string>();
let timer: NodeJS.Timeout | null = null;

export function listTimedExits(): TimedExit[] { return [...exits]; }

export function addTimedExit(e: Omit<TimedExit, "id" | "openedAt" | "exitAt"> & { horizonSec: number }): void {
  if (!(e.qty > 0) || !(e.horizonSec > 0) || e.horizonSec > MAX_AUTO_EXIT_SEC) return;
  const now = Date.now();
  const entry: TimedExit = {
    id: `exit-${now}-${Math.random().toString(36).slice(2, 7)}`,
    broker: e.broker, symbol: e.symbol, qty: e.qty, live: e.live,
    openedAt: now, exitAt: now + e.horizonSec * 1000,
  };
  exits.push(entry);
  writeJson(EXITS_FILE, exits);
  log.trade(`[horisont] ${e.symbol} säljs automatiskt om ${Math.round(e.horizonSec / 60)} min (${e.live ? "LIVE" : "TEST"})`);
}

function removeExit(id: string): void {
  const before = exits.length;
  exits = exits.filter((x) => x.id !== id);
  if (exits.length !== before) writeJson(EXITS_FILE, exits);
}

export function cancelTimedExit(id: string): boolean {
  const before = exits.length;
  removeExit(id);
  return exits.length !== before;
}

const baseOf = (s: string) => s.toUpperCase().replace("/", "").replace(/(USDT|USDC|USD|EUR)$/, "");

/** Startar bevakningen (var 5:e s): gamla förslag tas bort, tid-ute-positioner säljs. */
export function startTradeHorizon(brokers: Record<string, BrokerAdapter>, onEvent?: (e: string, d: unknown) => void): void {
  if (timer) return;
  timer = setInterval(() => {
    // 1) Förslag som blivit för gamla
    void expireStalePendingOrders()
      .then((n) => { if (n > 0) { log.info(`[horisont] ${n} förslag för gamla, borttagna`); onEvent?.("pending-orders", { expired: n }); } })
      .catch(() => {});
    // 2) Positioner vars tid är slut
    const now = Date.now();
    for (const x of [...exits]) {
      if (x.exitAt > now || selling.has(x.id)) continue;
      const broker = brokers[x.broker];
      if (!broker) { removeExit(x.id); continue; }
      selling.add(x.id);
      void (async () => {
        try {
          // Sälj högst det som finns kvar (TP/SL eller du själv kan redan ha sålt)
          const acc = await broker.getAccount();
          const free = acc.balances.find((b) => b.asset === baseOf(x.symbol))?.free ?? 0;
          const qty = Math.min(x.qty, free);
          if (!(qty > 0)) { removeExit(x.id); log.info(`[horisont] ${x.symbol}: redan sålt, inget att stänga`); return; }
          const r = await broker.placeOrder({ symbol: x.symbol, side: "SELL", type: "MARKET", quantity: qty });
          removeExit(x.id);
          if (x.live) {
            removeLiveTpSlForSymbol(x.symbol);
            if (r.executedQty > 0) recordLiveFill({ symbol: x.symbol, side: "SELL", qty: r.executedQty, price: r.avgFillPrice, usd: r.cummulativeQuoteQty || undefined, kind: "tid ute" });
          }
          log.trade(`[horisont] tiden ute: sålde ${x.symbol} ${r.executedQty || qty} @ ~${r.avgFillPrice} (${x.live ? "LIVE" : "TEST"}) · status ${r.status}`);
          onEvent?.("timed-exit", { symbol: x.symbol, price: r.avgFillPrice });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`[horisont] kunde inte sälja ${x.symbol} när tiden gick ut: ${msg}`);
          // Under minsta order eller inget att sälja → sluta försöka; annars nytt försök om 1 min
          if (/kräver minst|inga .* att sälja|insufficient/i.test(msg)) removeExit(x.id);
          else { const e = exits.find((y) => y.id === x.id); if (e) { e.exitAt = Date.now() + 60_000; writeJson(EXITS_FILE, exits); } }
        } finally {
          selling.delete(x.id);
        }
      })();
    }
  }, 5_000);
  log.info(`[horisont] trades ${horizonMin} min · ${exits.length} automatiska stängningar väntar`);
}
