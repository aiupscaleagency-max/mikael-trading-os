// ═══════════════════════════════════════════════════════════════════════════
// TP/SL för LIVE-köp på Bybit EU (marknadsorder).
//
// Bybit tar TP/SL tillsammans med limit-ordrar. Ett marknadsköp i LIVE får
// därför sin TP/SL här: boten bevakar priset och säljer innehavet när priset
// når TP (vinst) eller SL (förlust). Du godkände TP/SL när du godkände köpet.
// Bevakningen sparas i data/live-tpsl.json och fortsätter efter omstart, men
// den fungerar bara medan boten är igång.
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { log } from "../logger.js";
import { getCachedPrice } from "./marketStream.js";

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
}

let watches: LiveTpSl[] = load();
let timer: NodeJS.Timeout | null = null;
const selling = new Set<string>();
const retryAt = new Map<string, number>();
const lastPx = new Map<string, number>();

function load(): LiveTpSl[] {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as LiveTpSl[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function save(): void {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(watches, null, 2));
  } catch (err) {
    log.warn(`[LIVE TP/SL] kunde inte spara: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function listLiveTpSl(): LiveTpSl[] { return [...watches]; }

export function addLiveTpSl(w: Omit<LiveTpSl, "id" | "openedAt">): void {
  if (!(w.qty > 0) || (w.takeProfit === undefined && w.stopLoss === undefined)) return;
  const entry: LiveTpSl = { ...w, id: `tpsl-${Date.now()}`, openedAt: Date.now() };
  watches.push(entry);
  save();
  log.trade(`[LIVE TP/SL] bevakar ${w.symbol} ${w.qty} · TP ${w.takeProfit ?? "–"} · SL ${w.stopLoss ?? "–"}`);
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
      if (selling.has(w.id) || (retryAt.get(w.id) ?? 0) > Date.now()) continue;
      const broker = brokers[w.broker];
      if (!broker) continue;
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
      void broker.placeOrder({ symbol: w.symbol, side: "SELL", type: "MARKET", quantity: w.qty })
        .then((r) => {
          removeLiveTpSl(w.id);
          log.trade(`[LIVE TP/SL] ${why}: sålde ${w.symbol} ${r.executedQty || w.qty} @ ~${price} · status ${r.status}`);
          onEvent?.("live-tpsl", { symbol: w.symbol, why, price });
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`[LIVE TP/SL] kunde inte sälja ${w.symbol} vid ${why}: ${msg}`);
          // Inget kvar att sälja → sluta bevaka; annat fel → försök igen nästa varv
          if (/inga .* att sälja/.test(msg)) removeLiveTpSl(w.id);
          else retryAt.set(w.id, Date.now() + 60_000);
        })
        .finally(() => selling.delete(w.id));
    }
  }, 5_000);
  if (watches.length) log.info(`[LIVE TP/SL] bevakar ${watches.length} LIVE-köp`);
}
