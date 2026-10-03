import fs from "node:fs";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// INSATS-TRAPPA (Mike 2026-10-03): 1 % av kontot per trade, sedan stegvis
// upp mot 3–5 % när TEST-resultaten visar att det fungerar.
// ═══════════════════════════════════════════════════════════════════════════
// Räknas på avslutade TEST-trades (sälj i låtsaskontot, data/bybit-paper.json):
//   start                                        → 1 %
//   ≥10 avslutade, total vinst > 0               → 2 %
//   ≥20 avslutade, vinst > 0, träffsäkerhet ≥50 % → 3 %
//   ≥40 avslutade, vinst > 0, träffsäkerhet ≥55 % → 4 %
//   ≥60 avslutade, vinst > 0, träffsäkerhet ≥55 % → 5 % (tak)
// Går de senaste 10 med förlust → tillbaka till 1 %.
// STAKE_PCT_START / STAKE_PCT_MAX i .env ändrar golv och tak.
// ═══════════════════════════════════════════════════════════════════════════

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
  if (Date.now() - cache.at < 10_000) return cache.level;
  cache = { at: Date.now(), level: compute() };
  return cache.level;
}

function compute(): StakeLevel | null {
  let s: PaperFile;
  try { s = JSON.parse(fs.readFileSync(FILE, "utf8")) as PaperFile; } catch {
    // Inget sparat ännu: låtsaskontot startar på PAPER_START_USDC
    if (process.env.BYBIT_PAPER === "false") return null;
    s = { usdc: Number(process.env.PAPER_START_USDC ?? 10_000) || 10_000, holdings: {}, fills: [] };
  }
  const equity = s.usdc + Object.values(s.holdings ?? {}).reduce((t, h) => t + h.qty * h.avg, 0);
  const closed = (s.fills ?? []).filter((f) => f.side === "SELL" && typeof f.pnl === "number");
  const pnls = closed.map((f) => f.pnl as number);
  const total = pnls.reduce((t, p) => t + p, 0);
  const winRate = pnls.length ? pnls.filter((p) => p > 0).length / pnls.length : 0;
  const last10 = pnls.slice(-10).reduce((t, p) => t + p, 0);

  const start = Number(process.env.STAKE_PCT_START ?? 1) || 1;
  const max = Number(process.env.STAKE_PCT_MAX ?? 5) || 5;
  let pct = start, reason = "start: 1 % tills agenterna visat resultat";
  const n = pnls.length;
  if (n >= 10 && last10 < 0) reason = "senaste 10 trades gick med förlust: tillbaka till 1 %";
  else if (n >= 60 && total > 0 && winRate >= 0.55) { pct = 5; reason = `${n} trades, vinst, ${Math.round(winRate * 100)} % träff`; }
  else if (n >= 40 && total > 0 && winRate >= 0.55) { pct = 4; reason = `${n} trades, vinst, ${Math.round(winRate * 100)} % träff`; }
  else if (n >= 20 && total > 0 && winRate >= 0.5) { pct = 3; reason = `${n} trades, vinst, ${Math.round(winRate * 100)} % träff`; }
  else if (n >= 10 && total > 0) { pct = 2; reason = `${n} trades med vinst`; }
  else if (n > 0) reason = `${n} av 10 trades klara innan nästa steg`;
  pct = Math.min(Math.max(pct, start), max);
  return { pct, usd: Math.floor(equity * pct) / 100, equityUsd: equity, closed: n, winRate, totalPnl: total, reason };
}
