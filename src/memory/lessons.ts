// ═══════════════════════════════════════════════════════════════════════════
// Persistent lärdoms-storage för Position Monitor + Advisor
//
// Mike's krav: "att de lär upp sig" — agenterna ska komma ihåg över restarts.
// Disk-persistering via ./data/lessons.json (volume-mountad i Docker).
// Vid container-restart läses tidigare sells + entries in från disk.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const LESSONS_FILE = path.join(DATA_DIR, "lessons.json");
const ENTRIES_FILE = path.join(DATA_DIR, "position-entries.json");

export interface SaleLesson {
  symbol: string;
  mode: "testnet" | "live";
  pnl: number;
  pnlPct: number | null;
  reason: string;
  advisorVerdict: string;
  advisorReasoning: string;
  holdMinutes: number;
  rsi: number;
  patterns: string[];
  time: number;
  orderId: number;
}

export interface PersistedEntry {
  key: string; // ${mode}-${asset}
  entryPrice: number;
  qty: number;
  openedAt: number;
  mode: "testnet" | "live";
  trailingStopPrice?: number;
  highWatermark?: number;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadLessons(): Promise<SaleLesson[]> {
  try {
    await ensureDir();
    const raw = await fs.readFile(LESSONS_FILE, "utf8");
    const parsed = JSON.parse(raw) as SaleLesson[];
    return Array.isArray(parsed) ? parsed.slice(-500) : [];
  } catch { return []; }
}

export async function saveLessons(lessons: SaleLesson[]): Promise<void> {
  try {
    await ensureDir();
    // Behåll max 500 senaste (CL ~30 dagar trading)
    await fs.writeFile(LESSONS_FILE, JSON.stringify(lessons.slice(-500), null, 2), "utf8");
  } catch (e) {
    log.warn(`[lessons] save fail: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function loadEntries(): Promise<PersistedEntry[]> {
  try {
    await ensureDir();
    const raw = await fs.readFile(ENTRIES_FILE, "utf8");
    const parsed = JSON.parse(raw) as PersistedEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export async function saveEntries(entries: PersistedEntry[]): Promise<void> {
  try {
    await ensureDir();
    await fs.writeFile(ENTRIES_FILE, JSON.stringify(entries, null, 2), "utf8");
  } catch (e) {
    log.warn(`[entries] save fail: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Aggregat-statistik per symbol — Advisor får detta som "edge per symbol"
export function aggregateLessonsBySymbol(lessons: SaleLesson[]): Array<{
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgPnl: number;
  totalPnl: number;
  avgHoldMin: number;
  bestPattern: string | null;
}> {
  const map = new Map<string, { wins: number; losses: number; totalPnl: number; totalHold: number; patternWins: Map<string, number> }>();
  for (const l of lessons) {
    let s = map.get(l.symbol);
    if (!s) { s = { wins: 0, losses: 0, totalPnl: 0, totalHold: 0, patternWins: new Map() }; map.set(l.symbol, s); }
    if (l.pnl > 0) s.wins++; else if (l.pnl < 0) s.losses++;
    s.totalPnl += l.pnl;
    s.totalHold += l.holdMinutes;
    // Räkna upp pattern som "fungerade" (vid vinst)
    if (l.pnl > 0) {
      for (const p of l.patterns) {
        s.patternWins.set(p, (s.patternWins.get(p) || 0) + 1);
      }
    }
  }
  return Array.from(map.entries()).map(([symbol, s]) => {
    const trades = s.wins + s.losses;
    let bestPattern: string | null = null;
    let bestCount = 0;
    for (const [pattern, count] of s.patternWins) {
      if (count > bestCount) { bestCount = count; bestPattern = pattern; }
    }
    return {
      symbol,
      trades,
      wins: s.wins,
      losses: s.losses,
      winRatePct: trades > 0 ? Math.round((s.wins / trades) * 100) : 0,
      avgPnl: trades > 0 ? s.totalPnl / trades : 0,
      totalPnl: s.totalPnl,
      avgHoldMin: trades > 0 ? Math.round(s.totalHold / trades) : 0,
      bestPattern,
    };
  }).sort((a, b) => b.trades - a.trades);
}
