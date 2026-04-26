import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { DecisionRecord } from "../types.js";

// Persistent minne på disk. JSON-filer i ./data/. Enkelt, transparent, och du
// kan läsa filerna själv. Om du senare vill flytta detta till Supabase/Postgres
// räcker det att byta ut denna modul.

const DATA_DIR = path.resolve(process.cwd(), "data");
const DECISIONS_FILE = path.join(DATA_DIR, "decisions.jsonl");
const STATE_FILE = path.join(DATA_DIR, "state.json");

export interface AgentState {
  killSwitchActive: boolean;
  dailyRealizedPnlUsdt: number;
  dailyPnlResetAt: number; // epoch ms för senaste 00:00 UTC
  // Sparar entry-priser för öppna positioner (symbol -> {qty, avgPrice, openedAt})
  openPositions: Record<string, { quantity: number; avgEntryPrice: number; openedAt: number }>;
}

const DEFAULT_STATE: AgentState = {
  killSwitchActive: false,
  dailyRealizedPnlUsdt: 0,
  dailyPnlResetAt: 0,
  openPositions: {},
};

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadState(): Promise<AgentState> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as AgentState;
    // Dagligt PnL rullar över vid UTC-midnatt.
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    if (parsed.dailyPnlResetAt < midnight.getTime()) {
      parsed.dailyRealizedPnlUsdt = 0;
      parsed.dailyPnlResetAt = midnight.getTime();
    }
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    return { ...DEFAULT_STATE, dailyPnlResetAt: midnight.getTime() };
  }
}

export async function saveState(state: AgentState): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export async function appendDecision(
  record: Omit<DecisionRecord, "id">,
): Promise<DecisionRecord> {
  await ensureDataDir();
  const full: DecisionRecord = { id: crypto.randomUUID(), ...record };
  // JSONL — en rad per beslut, enkelt att tail:a, lätt att parsa stegvis.
  await fs.appendFile(DECISIONS_FILE, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export async function loadRecentDecisions(limit = 20): Promise<DecisionRecord[]> {
  try {
    const raw = await fs.readFile(DECISIONS_FILE, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const records: DecisionRecord[] = [];
    // Läs bakifrån så vi alltid får de senaste.
    for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
      try {
        records.push(JSON.parse(lines[i]!) as DecisionRecord);
      } catch {
        /* hoppa över trasig rad */
      }
    }
    return records.reverse();
  } catch {
    return [];
  }
}

/** Liten sammanfattning som agenten får som kontext för att "lära" sig. */
export async function summarizePastPerformance(): Promise<string> {
  const decisions = await loadRecentDecisions(50);
  const closed = decisions.filter((d) => d.outcome);
  if (closed.length === 0) {
    return "Inga stängda trades ännu. Detta är agentens första trades.";
  }
  const total = closed.reduce((sum, d) => sum + (d.outcome?.realizedPnlUsdt ?? 0), 0);
  const wins = closed.filter((d) => (d.outcome?.realizedPnlUsdt ?? 0) > 0).length;
  const winRate = ((wins / closed.length) * 100).toFixed(1);
  const recent = closed.slice(-5).map((d) => {
    const pnl = (d.outcome?.realizedPnlUsdt ?? 0).toFixed(2);
    return `  - ${d.symbol} ${d.action}: ${pnl} USDT — ${d.reasoning.slice(0, 80)}`;
  });
  return [
    `Historik (senaste ${closed.length} stängda trades):`,
    `  Total PnL: ${total.toFixed(2)} USDT`,
    `  Win rate: ${winRate}%`,
    `  Senaste 5:`,
    ...recent,
  ].join("\n");
}
