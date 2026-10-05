import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrokerAdapter } from "../brokers/adapter.js";

// En gemensam procent, vald av användaren. Den höjs aldrig av handelsresultat.
const FILE = path.resolve("data/trade-sizing.json");
let percent = 1;
try { const n = Number(JSON.parse(readFileSync(FILE, "utf8")).percent); if (Number.isFinite(n) && n >= 0.1 && n <= 5) percent = n; } catch { /* Standard: 1 %. */ }
export function getTradePercent(): number { return percent; }
export function getTradeFeeRate(): number {
  const n = Number(process.env.PAPER_FEE ?? 0.001);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : 0.001;
}
export function setTradePercent(value: unknown): boolean {
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n < 0.1 || n > 5) return false;
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE + ".tmp", JSON.stringify({ percent: n }));
  renameSync(FILE + ".tmp", FILE);
  percent = n;
  return true;
}
export interface TradeSizing {
  equity: number; available: number; percent: number; amount: number;
  feeRate: number; mode: "TEST" | "LIVE"; broker: string; updatedAt: number;
}
const accounts = new Map<string, { equity: number; available: number; updatedAt: number }>();
export function percentageAmount(equity: number, available: number, pct = percent): number {
  if (![equity, available, pct].every(Number.isFinite) || equity < 0 || available < 0 || pct <= 0) return 0;
  return Math.floor(Math.min(equity * pct / 100, available) * 100) / 100;
}
export function cachedTradeEquity(name: string): number | null {
  const a = accounts.get(name);
  return a && Date.now() - a.updatedAt <= 60_000 ? a.equity : null;
}
export async function refreshTradeSizing(broker: BrokerAdapter): Promise<void> {
  const a = await broker.getAccount();
  if (!Number.isFinite(a.totalValueUsdt) || a.totalValueUsdt < 0) throw new Error("Ogiltigt kontovärde");
  const cash = a.balances.find((b) => b.asset === "USDC")?.free ?? 0;
  if (!Number.isFinite(cash) || cash < 0) throw new Error("Ogiltigt tillgängligt saldo");
  accounts.set(broker.name, { equity: a.totalValueUsdt, available: cash, updatedAt: Date.now() });
}
export async function getTradeSizing(broker: BrokerAdapter): Promise<TradeSizing> {
  await refreshTradeSizing(broker);
  const a = accounts.get(broker.name)!;
  return { ...a, percent, amount: percentageAmount(a.equity, a.available), feeRate: getTradeFeeRate(),
    mode: broker.mode === "live" ? "LIVE" : "TEST", broker: broker.name };
}
