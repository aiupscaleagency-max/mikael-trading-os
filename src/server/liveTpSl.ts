// ═══════════════════════════════════════════════════════════════════════════
// TP/SL för LIVE-köp på Bybit EU (marknadsorder).
//
// Bybit tar TP/SL tillsammans med limit-ordrar. Ett marknadsköp i LIVE får
// därför sin TP/SL här: boten bevakar priset och säljer innehavet när priset
// når TP (vinst) eller SL (förlust). Du godkände TP/SL när du godkände köpet.
// Bevakningen sparas i data/live-tpsl.json och fortsätter efter omstart, men
// den fungerar bara medan boten är igång.
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { log } from "../logger.js";
import { getCachedPrice } from "./marketStream.js";
import { recordLiveFill } from "./results.js";

const FILE = path.resolve("data/live-tpsl.json");

export interface LiveTpSl {
  id: string;
  broker: string;
  symbol: string;
  qty: number;
  entry: number;
  takeProfit?: number;
  stopLoss?: number;
  openedAt: number;
  pendingOrderId?: string;
  pendingExecutedQty?: number;
  status?: "closing" | "needs_review";
  lastError?: string;
  attempts?: number;
  manualResyncRequired?: boolean;
}

let watches: LiveTpSl[] = load();
let timer: NodeJS.Timeout | null = null;
const selling = new Set<string>();
const retryAt = new Map<string, number>();
const lastPx = new Map<string, number>();

function load(): LiveTpSl[] {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as LiveTpSl[];
    return Array.isArray(parsed) ? parsed.map((w) => w.status === "closing" && !w.pendingOrderId
      ? { ...w, status: "needs_review" as const, lastError: "Omstart under TP/SL-försäljning; ordern kan ha accepterats, avstämning krävs" }
      : w) : [];
  } catch { return []; }
}

function save(): boolean {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE + ".tmp", JSON.stringify(watches, null, 2));
    renameSync(FILE + ".tmp", FILE);
    return true;
  } catch (err) {
    log.warn(`[LIVE TP/SL] kunde inte spara: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function listLiveTpSl(): LiveTpSl[] { return [...watches]; }

export function addLiveTpSl(w: Omit<LiveTpSl, "id" | "openedAt">): string | undefined {
  if (!(w.qty > 0) || (w.takeProfit === undefined && w.stopLoss === undefined)) return undefined;
  const entry: LiveTpSl = { ...w, id: `tpsl-${Date.now()}`, openedAt: Date.now() };
  const base = (s: string) => s.toUpperCase().replace(/[/-]/g, "").replace(/(USDT|USDC|USD|EUR)$/, "");
  const paused = watches.find((x) => x.manualResyncRequired && base(x.symbol) === base(entry.symbol));
  if (paused) { entry.manualResyncRequired = true; entry.status = "needs_review"; entry.lastError = paused.lastError; }
  watches.push(entry);
  save();
  log.trade(`[LIVE TP/SL] bevakar ${w.symbol} ${w.qty} · TP ${w.takeProfit ?? "–"} · SL ${w.stopLoss ?? "–"}`);
  return entry.id;
}

/** Säljer TP/SL-bevakningen just nu? (så att tidsgränsen inte säljer samtidigt) */
export function isLiveTpSlSelling(id: string): boolean { return selling.has(id) || watches.some((w) => w.id === id && (!!w.pendingOrderId || w.status === "needs_review")); }

/** Anropas när en TP/SL-bevakning sålt (tidsgränsen för samma köp tas då bort) */
const soldHooks: Array<(id: string) => void> = [];
export function onLiveTpSlSold(cb: (id: string) => void): void { soldHooks.push(cb); }

/** Pausa alla lotter för myntet tills en manuell delförsäljning har stämts av. */
export function pauseLiveTpSlForManualSale(symbol: string, reason: string): number {
  const base = (s: string) => s.toUpperCase().replace(/[/-]/g, "").replace(/(USDT|USDC|USD|EUR)$/, "");
  const matching = watches.filter((w) => base(w.symbol) === base(symbol));
  for (const w of matching) {
    w.manualResyncRequired = true; w.status = "needs_review";
    w.lastError = `${reason}; återstående lottägande måste stämmas av före nya TP/SL-ordrar`;
  }
  if (matching.length && !save()) throw new Error("LIVE TP/SL kunde inte pausas på disk; avstå manuell order");
  return matching.length;
}

export function isLiveTpSlSellingSymbol(symbol: string): boolean {
  const base = (s: string) => s.toUpperCase().replace(/[/-]/g, "").replace(/(USDT|USDC|USD|EUR)$/, "");
  return watches.some((w) => base(w.symbol) === base(symbol) && (selling.has(w.id) || !!w.pendingOrderId));
}

/** Ta bort alla bevakningar för ett mynt (t.ex. när du själv sålt det). */
export function removeLiveTpSlForSymbol(symbol: string): void {
  const base = (s: string) => s.toUpperCase().replace(/(USDT|USDC|USD)$/, "");
  const before = watches.length;
  watches = watches.filter((w) => base(w.symbol) !== base(symbol));
  if (watches.length !== before) { save(); log.info(`[LIVE TP/SL] slutar bevaka ${base(symbol)} (sålt)`); }
}

export function removeLiveTpSl(id: string): boolean {
  const before = watches.length;
  watches = watches.filter((w) => w.id !== id);
  if (watches.length !== before) { save(); return true; }
  return false;
}

/** Startar bevakningen (var 5:e s). Säljer via samma Bybit-mäklare som köpte. */
export function startLiveTpSl(brokers: Record<string, BrokerAdapter>, onEvent?: (e: string, d: unknown) => void): void {
  if (timer) return;
  timer = setInterval(() => {
    for (const w of [...watches]) {
      if (w.manualResyncRequired || w.status === "needs_review" || selling.has(w.id) || (retryAt.get(w.id) ?? 0) > Date.now()) continue;
      const broker = brokers[w.broker];
      if (!broker) continue;
      if (w.pendingOrderId) {
        const adapter = broker as BrokerAdapter & { getOrderResult?: (symbol: string, id: string) => Promise<import("../types.js").OrderResult | null> };
        if (!adapter.getOrderResult) continue;
        selling.add(w.id);
        void adapter.getOrderResult(w.symbol, w.pendingOrderId).then((r) => {
          if (w.manualResyncRequired) return;
          if (!r) return;
          const delta = Math.max(0, r.executedQty - (w.pendingExecutedQty ?? 0));
          w.qty = Math.max(0, w.qty - delta); w.pendingExecutedQty = r.executedQty;
          if (delta > 0) recordLiveFill({ symbol: w.symbol, side: "SELL", qty: delta, price: r.avgFillPrice, kind: "TP/SL" });
          if (/^(FILLED|CANCELED|CANCELLED|PARTIALLYFILLEDCANCELED|PARTIALLYFILLEDCANCELLED|REJECTED|EXPIRED|DEACTIVATED)$/i.test(r.status)) {
            delete w.pendingOrderId; delete w.pendingExecutedQty;
            if (w.qty <= 1e-12) { removeLiveTpSl(w.id); for (const cb of soldHooks) cb(w.id); }
          }
          save();
        }).catch((err) => { log.warn(`[LIVE TP/SL] orderstatus kunde inte verifieras: ${String(err)}`); retryAt.set(w.id, Date.now() + 30_000); }).finally(() => selling.delete(w.id));
        continue;
      }
      const base = w.symbol.toUpperCase().replace(/(USDT|USDC|USD)$/, "");
      const px = getCachedPrice(w.symbol) ?? getCachedPrice(`${base}USDT`) ?? getCachedPrice(`${base}USDC`);
      if (!px) {
        // Ingen strömmad kurs: fråga Bybit direkt (högst var 30:e s per bevakning)
        retryAt.set(w.id, Date.now() + 30_000);
        void broker.getTicker(w.symbol).then((t) => { lastPx.set(w.id, Number(t.price)); retryAt.delete(w.id); }).catch(() => {});
        if (!lastPx.has(w.id)) continue;
      }
      const price = px ?? lastPx.get(w.id)!;
      lastPx.delete(w.id);
      const hitTp = w.takeProfit !== undefined && price >= w.takeProfit;
      const hitSl = w.stopLoss !== undefined && price <= w.stopLoss;
      if (!hitTp && !hitSl) continue;
      selling.add(w.id);
      const why = hitTp ? "TP (vinst)" : "SL (förlust)";
      w.status = "closing";
      try { if (!save()) throw new Error("TP/SL-bevakningen kunde inte sparas"); } catch (err) {
        delete w.status; selling.delete(w.id); retryAt.set(w.id, Date.now() + 60_000);
        log.error(`[LIVE TP/SL] avstår order eftersom bevakningen inte kunde sparas: ${String(err)}`);
        continue;
      }
      void broker.placeOrder({ symbol: w.symbol, side: "SELL", type: "MARKET", quantity: w.qty })
        .then((r) => {
          if (!w.manualResyncRequired) delete w.status;
          const executed = Math.max(0, Math.min(w.qty, r.executedQty || 0));
          w.qty = Math.max(0, w.qty - executed);
          if (!/^(FILLED|CANCELED|CANCELLED|PARTIALLYFILLEDCANCELED|PARTIALLYFILLEDCANCELLED|REJECTED|EXPIRED|DEACTIVATED)$/i.test(r.status)) {
            w.pendingOrderId = r.orderId; w.pendingExecutedQty = executed;
          } else if (w.qty <= 1e-12) {
            removeLiveTpSl(w.id);
            for (const cb of soldHooks) { try { cb(w.id); } catch { /* ignorera */ } }
          } else {
            w.attempts = (w.attempts ?? 0) + 1;
            w.lastError = `Delavslut/avvisad order: ${w.qty} återstår (${r.status})`;
            if (w.attempts >= 6) { w.status = "needs_review"; w.lastError += "; sex försök förbrukade"; }
            else retryAt.set(w.id, Date.now() + 15_000);
          }
          if (w.manualResyncRequired) w.status = "needs_review";
          save();
          if (r.executedQty > 0) recordLiveFill({ symbol: w.symbol, side: "SELL", qty: r.executedQty, price: r.avgFillPrice || price, usd: r.cummulativeQuoteQty || undefined, kind: hitTp ? "TP" : "SL" });
          log.trade(`[LIVE TP/SL] ${why}: sålde ${w.symbol} ${r.executedQty || w.qty} @ ~${price} · status ${r.status}`);
          onEvent?.("live-tpsl", { symbol: w.symbol, why, price });
        })
        .catch((err) => {
          if (!w.manualResyncRequired) delete w.status;
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`[LIVE TP/SL] kunde inte sälja ${w.symbol} vid ${why}: ${msg}`);
          // Inget kvar att sälja → sluta bevaka; annat fel → försök igen nästa varv
          w.attempts = (w.attempts ?? 0) + 1;
          w.lastError = msg;
          if (w.attempts >= 6) {
            w.status = "needs_review"; w.lastError += "; sex försök förbrukade"; save();
          } else if (/timeout|timed out|ECONN|fetch failed|socket|network/i.test(msg)) {
            w.status = "needs_review"; w.lastError = `${msg}; ordern kan ha accepterats, avstämning krävs`; save();
            onEvent?.("live-tpsl", { symbol: w.symbol, status: w.status, error: w.lastError });
          } else retryAt.set(w.id, Date.now() + 60_000);
          save();
        })
        .finally(() => selling.delete(w.id));
    }
  }, 5_000);
  if (watches.length) log.info(`[LIVE TP/SL] bevakar ${watches.length} LIVE-köp`);
}
