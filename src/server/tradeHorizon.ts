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
import { getTradeFeeRate } from "../risk/tradeSizing.js";
import { log } from "../logger.js";
import { expireStalePendingOrders } from "./orderGate.js";
import { recordLiveFill } from "./results.js";
import { addLiveTpSl, isLiveTpSlSelling, listLiveTpSl, onLiveTpSlSold, removeLiveTpSl } from "./liveTpSl.js";

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
  const feePct = getTradeFeeRate() * 100;
  return `\n\n──── TIDSHORISONT: ${m} MIN ────\n`
    + `Mike kör korta trades. Föreslå BARA trades som ska hållas högst ${m} min. `
    + `Bygg beslutet på de korta tidsramarna (${shortIntervals().join("/")}). `
    + `Sätt TP och SL så att de rimligen kan nås inom ${m} min (avgiften är ${feePct.toFixed(2)} % in + ${feePct.toFixed(2)} % ut, så TP måste ligga över ~${(feePct * 2).toFixed(2)} %). `
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
  /** Fritt saldo av myntet FÖRE köpet. Tidsgränsen säljer aldrig under detta,
   *  så mynt du redan ägde (eller köpt senare utan horisont) rörs aldrig. */
  baseline: number;
  /** LIVE: TP/SL-bevakningen för just detta köp */
  tpslId?: string;
  /** TEST: köpets order-id (dess TP/SL-grupp i bybit-paper) */
  paperGroup?: string;
  attempts?: number;
  status?: "waiting" | "waiting_fill" | "closing" | "retry" | "needs_review";
  lastError?: string;
  retryAt?: number;
  /** Återstående antal efter verifierade delavslut. */
  remainingQty?: number;
  /** En accepterad order utan slutstatus får inte skickas en gång till. */
  pendingOrderId?: string;
  pendingExecutedQty?: number;
  pendingBuyOrderId?: string;
  horizonSec?: number;
  buyFillStartedAt?: number;
  takeProfit?: number;
  stopLoss?: number;
  refPrice?: number;
  buyRecordedQty?: number;
}

let exits: TimedExit[] = (() => {
  const v = readJson<TimedExit[]>(EXITS_FILE, []);
  return Array.isArray(v) ? v : [];
})();
const selling = new Set<string>();
let timer: NodeJS.Timeout | null = null;

export function listTimedExits(): TimedExit[] { return exits.map((x) => ({ ...x })); }

export function addTimedExit(e: Omit<TimedExit, "id" | "openedAt" | "exitAt" | "attempts"> & { horizonSec: number }): void {
  if (!Number.isFinite(e.qty) || !Number.isFinite(e.baseline) || !Number.isFinite(e.horizonSec) || !(e.qty > 0) || !(e.horizonSec > 0) || e.horizonSec > MAX_AUTO_EXIT_SEC || !(e.baseline >= 0)) return;
  const now = Date.now();
  const entry: TimedExit = {
    id: `exit-${now}-${Math.random().toString(36).slice(2, 7)}`,
    broker: e.broker, symbol: e.symbol, qty: e.qty, live: e.live,
    openedAt: now, exitAt: now + e.horizonSec * 1000,
    baseline: e.baseline, tpslId: e.tpslId, paperGroup: e.paperGroup, attempts: 0,
    takeProfit: e.takeProfit, stopLoss: e.stopLoss, refPrice: e.refPrice, buyRecordedQty: e.buyRecordedQty ?? 0,
    pendingBuyOrderId: e.pendingBuyOrderId, horizonSec: e.horizonSec, status: e.pendingBuyOrderId ? "waiting_fill" : "waiting",
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

/** Kör ett varv. Exporterat så att fel, omstart och delavslut kan testas utan timer. */
export async function processTimedExits(brokers: Record<string, BrokerAdapter>, onEvent?: (e: string, d: unknown) => void): Promise<void> {
  for (const x of [...exits]) {
    if (x.status === "needs_review" && !x.pendingOrderId) continue;
    if (!exits.some((e) => e.id === x.id) || (!x.pendingBuyOrderId && x.exitAt > Date.now()) || (x.retryAt ?? 0) > Date.now() || selling.has(x.id)) continue;

    if (x.tpslId && isLiveTpSlSelling(x.tpslId)) continue;
    const symbolKey = `${x.broker}:${baseOf(x.symbol)}`;
    if (selling.has(symbolKey)) continue;
    selling.add(x.id);
    selling.add(symbolKey);
    let orderAttempted = false;
    try {
      const broker = brokers[x.broker];
      if (!broker) throw new Error(`Mäklaren ${x.broker} saknas; stängningen väntar`);
      const groupBroker = broker as BrokerAdapter & { getOrderResult?: (symbol: string, id: string) => Promise<import("../types.js").OrderResult | null>; getTimedExitQuantity?: (symbol: string, group: string) => Promise<number | null>; placeTimedExitOrder?: (order: Parameters<BrokerAdapter["placeOrder"]>[0], group: string) => ReturnType<BrokerAdapter["placeOrder"]> };
      if (x.pendingBuyOrderId) {
        if (!groupBroker.getOrderResult) throw new Error("Köporderns fyllning kan inte verifieras");
        const buy = await groupBroker.getOrderResult(x.symbol, x.pendingBuyOrderId);
        if (!buy) throw new Error("Köporderns status saknas; inväntar verifiering");
        const newlyBought = Math.max(0, buy.executedQty - (x.buyRecordedQty ?? 0));
        if (x.live && newlyBought > 0) recordLiveFill({ symbol: x.symbol, side: "BUY", qty: newlyBought, price: buy.avgFillPrice || x.refPrice || 0, kind: "LIMIT fyllt" });
        x.buyRecordedQty = Math.max(x.buyRecordedQty ?? 0, buy.executedQty);
        if (buy.executedQty > 0 && !x.buyFillStartedAt) {
          x.buyFillStartedAt = Date.now(); x.openedAt = x.buyFillStartedAt;
          x.exitAt = x.openedAt + (x.horizonSec ?? 60) * 1000;
        }
        const terminal = /^(FILLED|CANCELED|CANCELLED|PARTIALLYFILLEDCANCELED|PARTIALLYFILLEDCANCELLED|REJECTED|EXPIRED|DEACTIVATED)$/i.test(buy.status);
        if (!terminal) {
          if (x.buyFillStartedAt && x.exitAt <= Date.now()) await broker.cancelOrder(x.symbol, x.pendingBuyOrderId);
          writeJson(EXITS_FILE, exits); continue;
        }
        if (!(buy.executedQty > 0)) { removeExit(x.id); continue; }
        x.qty = buy.executedQty; x.remainingQty = buy.executedQty; x.status = "waiting";
        if (x.live && !x.tpslId && x.exitAt > Date.now() && (x.takeProfit !== undefined || x.stopLoss !== undefined)) {
          const entry = buy.avgFillPrice || x.refPrice || 0;
          if (!(entry > 0)) throw new Error("Fyllningspriset saknas; TP/SL kan inte aktiveras säkert");
          x.tpslId = addLiveTpSl({ broker: x.broker, symbol: x.symbol, qty: x.remainingQty, entry, takeProfit: x.takeProfit, stopLoss: x.stopLoss });
        }
        delete x.pendingBuyOrderId;
        writeJson(EXITS_FILE, exits);
        if (x.exitAt > Date.now()) continue;
      }
      if (x.pendingOrderId) {
        if (!groupBroker.getOrderResult) continue;
        const result = await groupBroker.getOrderResult(x.symbol, x.pendingOrderId);
        if (!result) throw new Error("Väntande orders slutstatus kunde inte verifieras");
        const delta = Math.max(0, result.executedQty - (x.pendingExecutedQty ?? 0));
        x.remainingQty = Math.max(0, (x.remainingQty ?? x.qty) - delta);
        x.pendingExecutedQty = result.executedQty;
        for (const sibling of exits) if (sibling.id !== x.id && sibling.broker === x.broker && baseOf(sibling.symbol) === baseOf(x.symbol) && sibling.baseline > x.baseline) sibling.baseline = Math.max(x.baseline, sibling.baseline - delta);
        if (x.live && delta > 0) recordLiveFill({ symbol: x.symbol, side: "SELL", qty: delta, price: result.avgFillPrice, kind: "tid ute" });
        if (!/^(FILLED|CANCELED|CANCELLED|PARTIALLYFILLEDCANCELED|PARTIALLYFILLEDCANCELLED|REJECTED|EXPIRED|DEACTIVATED)$/i.test(result.status)) { writeJson(EXITS_FILE, exits); continue; }
        delete x.pendingOrderId;
        delete x.pendingExecutedQty;
        if (x.remainingQty <= Math.max(1e-12, x.qty * 1e-10)) { removeExit(x.id); continue; }
        writeJson(EXITS_FILE, exits);
      }
      let remaining = x.remainingQty ?? x.qty;
      const watch = x.tpslId ? listLiveTpSl().find((w) => w.id === x.tpslId) : undefined;
      if (watch && watch.qty < remaining) {
        const soldByTpSl = remaining - watch.qty;
        for (const sibling of exits) if (sibling.id !== x.id && sibling.broker === x.broker && baseOf(sibling.symbol) === baseOf(x.symbol) && sibling.baseline > x.baseline) sibling.baseline = Math.max(x.baseline, sibling.baseline - soldByTpSl);
        remaining = watch.qty; x.remainingQty = remaining;
        writeJson(EXITS_FILE, exits);
      }
      if (x.paperGroup && groupBroker.getTimedExitQuantity) {
        const owned = await groupBroker.getTimedExitQuantity(x.symbol, x.paperGroup);
        if (owned === null) throw new Error("Köpets ägda antal kunde inte verifieras");
        remaining = Math.min(remaining, owned);
      }
      if (remaining <= 0) { removeExit(x.id); continue; }
      // Ta bort köpets TP/SL innan ordern skickas så att två bevakare inte säljer samtidigt.
      if (x.tpslId) removeLiveTpSl(x.tpslId);
      if (x.paperGroup) await broker.cancelOrder(x.symbol, x.paperGroup);
      const acc = await broker.getAccount();
      const balance = acc.balances.find((b) => b.asset.toUpperCase() === baseOf(x.symbol));
      const free = balance?.free ?? 0;
      const total = free + (balance?.locked ?? 0);
      // Gemensam bottennivå skyddar gamla innehav när flera köp av samma mynt stängs.
      const siblings = exits.filter((e) => e.broker === x.broker && baseOf(e.symbol) === baseOf(x.symbol));
      const baseline = Math.min(...siblings.map((e) => e.baseline));
      const qty = Math.min(remaining, Math.max(0, x.paperGroup && groupBroker.getTimedExitQuantity ? free : free - baseline));
      if (!(qty > 0)) {
        if (total <= baseline && siblings.length === 1) { removeExit(x.id); continue; }
        throw new Error("Inget verifierat fritt antal att stänga; innehavet kan vara låst eller ägandet oklart");
      }
      x.status = "closing";
      writeJson(EXITS_FILE, exits);
      const order = { symbol: x.symbol, side: "SELL" as const, type: "MARKET" as const, quantity: qty };
      orderAttempted = true;
      const r = x.paperGroup && groupBroker.placeTimedExitOrder
        ? await groupBroker.placeTimedExitOrder(order, x.paperGroup) : await broker.placeOrder(order);
      const executed = Number.isFinite(r.executedQty) ? Math.max(0, Math.min(qty, r.executedQty)) : 0;
      x.remainingQty = Math.max(0, remaining - executed);
      for (const sibling of siblings) if (sibling.id !== x.id && sibling.baseline > baseline) sibling.baseline = Math.max(baseline, sibling.baseline - executed);
      if (x.live && executed > 0) recordLiveFill({ symbol: x.symbol, side: "SELL", qty: executed, price: r.avgFillPrice, usd: r.cummulativeQuoteQty || undefined, kind: "tid ute" });
      const terminal = /^(FILLED|CANCELED|CANCELLED|PARTIALLYFILLEDCANCELED|PARTIALLYFILLEDCANCELLED|REJECTED|EXPIRED|DEACTIVATED)$/i.test(r.status);
      if (!terminal) {
        x.pendingOrderId = r.orderId;
        x.pendingExecutedQty = executed;
        x.status = "needs_review";
        x.lastError = `Order ${r.orderId} har status ${r.status}; avstämning krävs före nästa försök`;
        writeJson(EXITS_FILE, exits);
      } else if (x.remainingQty <= Math.max(1e-12, x.qty * 1e-10)) {
        removeExit(x.id);
      } else {
        throw new Error(`Delavslut: ${executed} sålt, ${x.remainingQty} återstår (${r.status})`);
      }
      log.trade(`[horisont] tiden ute: ${x.symbol} ${executed} @ ~${r.avgFillPrice} · status ${r.status}`);
      onEvent?.("timed-exit", { ...x, executedQty: executed, price: r.avgFillPrice });
    } catch (err) {
      x.attempts = (x.attempts ?? 0) + 1;
      x.status = "retry";
      x.lastError = err instanceof Error ? err.message : String(err);
      if (orderAttempted && /timeout|timed out|ECONN|fetch failed|socket|network/i.test(x.lastError)) {
        x.status = "needs_review";
        x.lastError += "; ordern kan ha accepterats, kontrollera mäklaren före nytt försök";
      }
      x.retryAt = Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(x.attempts - 1, 5));
      writeJson(EXITS_FILE, exits);
      log.error(`[horisont] ${x.symbol}: ${x.lastError}. Nytt försök väntar (${x.attempts}).`);
      onEvent?.("timed-exit", { ...x });
    } finally {
      selling.delete(x.id);
      selling.delete(symbolKey);
    }
  }
}

/** Startar bevakningen (var 5:e s). Tidsgränsen ändras aldrig av ett återförsök. */
export function startTradeHorizon(brokers: Record<string, BrokerAdapter>, onEvent?: (e: string, d: unknown) => void): void {
  if (timer) return;
  // TP/SL-hooken är bara en signal: saldot/ägandet verifieras vid nästa varv.
  onLiveTpSlSold((tpslId) => {
    for (const x of exits.filter((e) => e.tpslId === tpslId)) {
      for (const sibling of exits) if (sibling.broker === x.broker && baseOf(sibling.symbol) === baseOf(x.symbol) && sibling.baseline > x.baseline) sibling.baseline = Math.max(x.baseline, sibling.baseline - x.qty);
      x.remainingQty = 0; x.exitAt = Date.now(); x.retryAt = 0;
    }
    writeJson(EXITS_FILE, exits);
  });
  timer = setInterval(() => {
    void expireStalePendingOrders().then((n) => { if (n > 0) onEvent?.("pending-orders", { expired: n }); }).catch((err) => log.warn(`[horisont] kunde inte föråldra förslag: ${String(err)}`));
    void processTimedExits(brokers, onEvent);
  }, 5_000);
  log.info(`[horisont] trades ${horizonMin} min · ${exits.length} automatiska stängningar väntar`);
}
