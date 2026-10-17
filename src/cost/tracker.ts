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

import { dataDir, dataPath } from "../dataDir.js";
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
  // Listpriser från Vercel och OpenRouter /v1/models (2026-09-30).
  "claude-opus-5-5":           { in: 4, out: 20 },
  "claude-opus-4-8":           { in: 5, out: 25 },
  "claude-sonnet-5-5":         { in: 2, out: 10 },
  "openai/gpt-6-astra":        { in: 10, out: 50 },
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
  /** Vägen anropet gick (plan §8.2). hermes = prenumeration, 0 USD, räknas inte mot taket. */
  route?: CostRoute;
  /** Svarstid i ms (Hermes-läget: tokens/tid per analys på kostnadssidan) */
  durationMs?: number;
}

/** "gateway" = befintliga betalda kedjan (Anthropic → Vercel → OpenRouter) där exakt väg inte syns utifrån. */
export type CostRoute = "vercel" | "openrouter" | "anthropic" | "hermes" | "gateway";
export interface TrackOpts {
  route?: CostRoute;
  /** Uttrycklig kostnad (0 för prenumeration). Satt = används i stället för beräkningen från tokens. */
  costUsd?: number;
  durationMs?: number;
}

/** Rader som räknas mot API-kostnadstaket (Hermes-rader undantas uttryckligen, §8.2). */
const countsTowardCap = (e: CostEntry) => e.route !== "hermes";

const COST_DIR = dataPath("cost");

async function ensureDir(): Promise<void> {
  await fs.mkdir(COST_DIR, { recursive: true });
}

function dayFile(d: Date = new Date()): string {
  const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(COST_DIR, `${iso}.jsonl`);
}

// Gateway-id:n ("anthropic/claude-haiku-4.5") matchas mot samma pristabell.
function normalizeModel(model: string): string {
  const bare = model.replace(/^anthropic\//, "");
  return bare.replace(/^(claude-[a-z]+-\d+)\.(\d+)$/, "$1-$2");
}

function calcCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? PRICING[normalizeModel(model)] ?? { in: 5, out: 25 }; // default conservative om okänd modell
  return (inputTokens * p.in / 1_000_000) + (outputTokens * p.out / 1_000_000);
}

// ── Spåra ett anrop ──
export async function trackClaudeCall(
  agent: string,
  model: string,
  usage: { input_tokens: number; output_tokens: number },
  sessionId?: string,
  opts?: TrackOpts,
): Promise<CostEntry> {
  const entry: CostEntry = {
    timestamp: Date.now(),
    agent,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    costUsd: opts?.costUsd !== undefined ? opts.costUsd : calcCostUsd(model, usage.input_tokens, usage.output_tokens),
    sessionId,
    // Bara när de anges, så att befintliga anrop skriver exakt samma rad som förut
    ...(opts?.route ? { route: opts.route } : {}),
    ...(opts?.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
  };

  await ensureDir();
  await fs.appendFile(dayFile(), JSON.stringify(entry) + "\n", "utf8");

  log.info(`[Cost] ${agent} (${model}${entry.route ? `, ${entry.route}` : ""}): in=${entry.inputTokens} out=${entry.outputTokens} = $${entry.costUsd.toFixed(4)}${entry.durationMs !== undefined ? ` · ${(entry.durationMs / 1000).toFixed(1)} s` : ""}`);
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
  return entries.filter(countsTowardCap).reduce((s, e) => s + e.costUsd, 0);
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
  /** Hermes-läget (§12): tokens/tid per analys (prenumeration, inte kronor). Saknas när inga Hermes-rader finns. */
  hermes?: HermesCostView;
}

export interface HermesCostView {
  todayCalls: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  /** Senaste analyserna, nyast först: tokens och tid per roll */
  runs: Array<{ runId: string; at: number; totalMs: number; inputTokens: number; outputTokens: number; roles: Array<{ agent: string; model: string; inputTokens: number; outputTokens: number; ms: number | null }> }>;
}

/** Hermes-rader grupperade per analys (sessionId = körnings-ID). */
export function hermesCostView(entries: CostEntry[], today: CostEntry[], maxRuns = 10): HermesCostView | undefined {
  const h = entries.filter((e) => e.route === "hermes");
  if (!h.length) return undefined;
  const ht = today.filter((e) => e.route === "hermes");
  const byRun = new Map<string, CostEntry[]>();
  for (const e of h) { const k = e.sessionId ?? `utan-id-${e.timestamp}`; byRun.set(k, [...(byRun.get(k) ?? []), e]); }
  const runs = [...byRun.entries()].map(([runId, list]) => {
    const sorted = list.sort((a, b) => a.timestamp - b.timestamp);
    return {
      runId, at: sorted[0]!.timestamp,
      totalMs: sorted.reduce((s, e) => s + (e.durationMs ?? 0), 0),
      inputTokens: sorted.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: sorted.reduce((s, e) => s + e.outputTokens, 0),
      roles: sorted.map((e) => ({ agent: e.agent, model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens, ms: e.durationMs ?? null })),
    };
  }).sort((a, b) => b.at - a.at).slice(0, maxRuns);
  return {
    todayCalls: ht.length,
    todayInputTokens: ht.reduce((s, e) => s + e.inputTokens, 0),
    todayOutputTokens: ht.reduce((s, e) => s + e.outputTokens, 0),
    runs,
  };
}

export async function getCostSummary(opts: {
  dailyCapUsd: number;
  weeklyCapUsd: number;
}): Promise<CostSummary> {
  const today = await readDay(new Date());
  const todayUsd = today.filter(countsTowardCap).reduce((s, e) => s + e.costUsd, 0);
  const weekUsd = await getWeeklySpend();
  const monthUsd = await getMonthlySpend();

  // Aggregera per agent (idag) och per modell (idag)
  const byAgent: Record<string, { calls: number; costUsd: number }> = {};
  const byModel: Record<string, { calls: number; costUsd: number }> = {};
  for (const e of today) {
    // Lokal referens: ??= smalnar inte av typen på en index-access, så
    // byAgent[e.agent] är fortfarande "möjligen undefined" för TypeScript.
    const agentEntry = (byAgent[e.agent] ??= { calls: 0, costUsd: 0 });
    agentEntry.calls++;
    agentEntry.costUsd += e.costUsd;
    const modelEntry = (byModel[e.model] ??= { calls: 0, costUsd: 0 });
    modelEntry.calls++;
    modelEntry.costUsd += e.costUsd;
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

  const hermes = hermesCostView(recent, today);
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
    ...(hermes ? { hermes } : {}),
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
