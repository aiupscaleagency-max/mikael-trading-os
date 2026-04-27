// ═══════════════════════════════════════════════════════════════════════════
//  COST TRACKER — spårar varje Claude/Perplexity-anrop, beräknar kostnad,
//  håller dagliga/veckliga totaler och agerar circuit breaker via cap.
//
//  Lagring: enkel append-only JSONL-fil per dag i data/cost/.
//  Aggregation: läses on-demand, billigt ändå (~10-20 anrop/dag).
//
//  ENDAST FÖR DETTA KONTOR — när Fas 2 (multi-tenant) byggs, blir detta
//  per-user (med user_id i loggen + RLS i db).
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";

// Pris per miljon tokens (USD)
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-haiku-4-5":          { in: 1, out: 5 },
  "claude-sonnet-4-6":         { in: 3, out: 15 },
  "claude-opus-4-6":           { in: 15, out: 75 },
  "claude-opus-4-7":           { in: 15, out: 75 },
  "perplexity-sonar-pro":      { in: 1, out: 1 },
};

export interface CostEntry {
  timestamp: number;
  agent: string;       // "macro", "advisor", "head", "researcher" etc.
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionId?: string;  // Knyter ihop multipla anrop till en session
}

const COST_DIR = path.join(process.cwd(), "data", "cost");

async function ensureDir(): Promise<void> {
  await fs.mkdir(COST_DIR, { recursive: true });
}

function dayFile(d: Date = new Date()): string {
  const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(COST_DIR, `${iso}.jsonl`);
}

function calcCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { in: 5, out: 25 }; // default conservative om okänd modell
  return (inputTokens * p.in / 1_000_000) + (outputTokens * p.out / 1_000_000);
}

// ── Spåra ett anrop ──
export async function trackClaudeCall(
  agent: string,
  model: string,
  usage: { input_tokens: number; output_tokens: number },
  sessionId?: string,
): Promise<CostEntry> {
  const entry: CostEntry = {
    timestamp: Date.now(),
    agent,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    costUsd: calcCostUsd(model, usage.input_tokens, usage.output_tokens),
    sessionId,
  };

  await ensureDir();
  await fs.appendFile(dayFile(), JSON.stringify(entry) + "\n", "utf8");

  log.info(`[Cost] ${agent} (${model}): in=${entry.inputTokens} out=${entry.outputTokens} = $${entry.costUsd.toFixed(4)}`);
  return entry;
}

// Perplexity-anrop spårat separat (annan API, samma logik)
export async function trackPerplexityCall(
  agent: string,
  inputTokens: number,
  outputTokens: number,
  sessionId?: string,
): Promise<CostEntry> {
  return trackClaudeCall(agent, "perplexity-sonar-pro", { input_tokens: inputTokens, output_tokens: outputTokens }, sessionId);
}

// ── Aggregering ──
async function readDay(d: Date): Promise<CostEntry[]> {
  const f = dayFile(d);
  try {
    const content = await fs.readFile(f, "utf8");
    return content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as CostEntry);
  } catch {
    return [];
  }
}

export async function getDailySpend(d: Date = new Date()): Promise<number> {
  const entries = await readDay(d);
  return entries.reduce((s, e) => s + e.costUsd, 0);
}

export async function getWeeklySpend(): Promise<number> {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    total += await getDailySpend(d);
  }
  return total;
}

export async function getMonthlySpend(): Promise<number> {
  let total = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    total += await getDailySpend(d);
  }
  return total;
}

export interface CostSummary {
  todayUsd: number;
  weekUsd: number;
  monthUsd: number;
  byAgent: Record<string, { calls: number; costUsd: number }>;
  byModel: Record<string, { calls: number; costUsd: number }>;
  recentCalls: CostEntry[];          // Senaste 50
  dailyCap: number;
  weeklyCap: number;
  capStatus: "ok" | "warning" | "exceeded";
}

export async function getCostSummary(opts: {
  dailyCapUsd: number;
  weeklyCapUsd: number;
}): Promise<CostSummary> {
  const today = await readDay(new Date());
  const todayUsd = today.reduce((s, e) => s + e.costUsd, 0);
  const weekUsd = await getWeeklySpend();
  const monthUsd = await getMonthlySpend();

  // Aggregera per agent (idag) och per modell (idag)
  const byAgent: Record<string, { calls: number; costUsd: number }> = {};
  const byModel: Record<string, { calls: number; costUsd: number }> = {};
  for (const e of today) {
    byAgent[e.agent] ??= { calls: 0, costUsd: 0 };
    byAgent[e.agent].calls++;
    byAgent[e.agent].costUsd += e.costUsd;
    byModel[e.model] ??= { calls: 0, costUsd: 0 };
    byModel[e.model].calls++;
    byModel[e.model].costUsd += e.costUsd;
  }

  // Senaste 50 anrop (kanske från flera dagar — slå ihop senaste 3 dagars filer)
  const recent: CostEntry[] = [...today];
  for (let i = 1; i <= 3 && recent.length < 50; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    recent.push(...(await readDay(d)));
  }
  const recentCalls = recent.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);

  let capStatus: "ok" | "warning" | "exceeded" = "ok";
  if (todayUsd >= opts.dailyCapUsd) capStatus = "exceeded";
  else if (todayUsd >= opts.dailyCapUsd * 0.8) capStatus = "warning";
  else if (weekUsd >= opts.weeklyCapUsd) capStatus = "exceeded";

  return {
    todayUsd,
    weekUsd,
    monthUsd,
    byAgent,
    byModel,
    recentCalls,
    dailyCap: opts.dailyCapUsd,
    weeklyCap: opts.weeklyCapUsd,
    capStatus,
  };
}

// ── Circuit breaker ──
// Returnerar true om vi får köra, false om cap är nått.
export async function canSpend(opts: {
  dailyCapUsd: number;
  weeklyCapUsd: number;
}): Promise<{ allowed: boolean; reason?: string; spent?: { today: number; week: number } }> {
  const today = await getDailySpend();
  if (today >= opts.dailyCapUsd) {
    return {
      allowed: false,
      reason: `Daglig cap nådd: $${today.toFixed(2)} >= $${opts.dailyCapUsd}`,
      spent: { today, week: await getWeeklySpend() },
    };
  }
  const week = await getWeeklySpend();
  if (week >= opts.weeklyCapUsd) {
    return {
      allowed: false,
      reason: `Veckans cap nådd: $${week.toFixed(2)} >= $${opts.weeklyCapUsd}`,
      spent: { today, week },
    };
  }
  return { allowed: true, spent: { today, week } };
}

// Wrapper för Anthropic-anrop som spårar automatiskt.
// Använd istället för client.messages.create direkt.
export async function trackedAnthropicCall<T extends { usage?: { input_tokens: number; output_tokens: number } }>(
  agent: string,
  model: string,
  call: () => Promise<T>,
  sessionId?: string,
): Promise<T> {
  const response = await call();
  if (response.usage) {
    await trackClaudeCall(agent, model, response.usage, sessionId).catch((err) => {
      log.warn(`[Cost] Failed to track ${agent}: ${err}`);
    });
  }
  return response;
}
