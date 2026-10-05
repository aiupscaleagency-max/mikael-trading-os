import fs from "node:fs";
import path from "node:path";
import { cachedTradeEquity, getTradePercent } from "./tradeSizing.js";
import { getCachedPrice } from "../server/marketStream.js";

// Kontobaserad insats. Användaren väljer procent; inga automatiska höjningar.

const FILE = path.resolve("data/bybit-paper.json");

export interface StakeLevel {
  pct: number;
  usd: number;
  equityUsd: number;
  closed: number;
  winRate: number;
  totalPnl: number;
  reason: string;
}

interface Fill { side: string; qty: number; price: number; pnl?: number }
interface PaperFile { usdc: number; holdings: Record<string, { qty: number; avg: number }>; fills: Fill[] }

let cache: { at: number; level: StakeLevel | null } = { at: 0, level: null };

/** Nuvarande insats för TEST-kontot, eller null om låtsaskontot inte finns. */
export function currentStake(): StakeLevel | null {
  if (Date.now() - cache.at < 10_000 && cache.level?.pct === getTradePercent()) return cache.level;
  cache = { at: Date.now(), level: compute() };
  return cache.level;
}

function compute(): StakeLevel | null {
  let s: PaperFile;
  try { s = JSON.parse(fs.readFileSync(FILE, "utf8")) as PaperFile; } catch {
    // Inget sparat ännu: låtsaskontot startar på PAPER_START_USDC
    if (process.env.BYBIT_PAPER === "false") return null;
    s = { usdc: Number(process.env.PAPER_START_USDC ?? 1_000_000) || 1_000_000, holdings: {}, fills: [] };
  }
  const equity = cachedTradeEquity("bybit-paper") ?? (s.usdc + Object.entries(s.holdings ?? {}).reduce((t, [coin, h]) => t + h.qty * (getCachedPrice(`${coin}USDC`) ?? h.avg), 0));
  const closed = (s.fills ?? []).filter((f) => f.side === "SELL" && typeof f.pnl === "number");
  const pnls = closed.map((f) => f.pnl as number);
  const total = pnls.reduce((t, p) => t + p, 0);
  const winRate = pnls.length ? pnls.filter((p) => p > 0).length / pnls.length : 0;
  const pct = getTradePercent();
  const reason = `${pct} % av aktuellt kontovärde; ändras bara när du väljer en annan procent`;
  const n = pnls.length;
  return { pct, usd: Math.floor(equity * pct) / 100, equityUsd: equity, closed: n, winRate, totalPnl: total, reason };
}
