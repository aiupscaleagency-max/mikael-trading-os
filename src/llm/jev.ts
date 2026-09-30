import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  JEV (TypeSafe System One) — beslutslagret framför de stora modellerna.
//
//  Enkla förgreningar ska inte kosta en stor modell. Före varje trading-turn
//  frågar vi JEV (under en sekund) om turen är rutin eller om den behöver
//  en oberoende granskning av Advisorn. Rutin → Advisorn hoppas över och
//  sparar ett helt modellanrop. Allt annat → Advisorn körs som vanligt.
//
//  Säkerhet:
//    - Nyckeln läses från TYPESAFE_API_KEY (miljövariabel, aldrig i git).
//    - Bara anonymiserade band skickas: antal positioner, P&L-riktning,
//      läge. Inga symboler, priser, strategier eller källdata lämnar maskinen.
//    - Fail-open: svarar inte JEV körs Advisorn precis som förut.
//    - LIVE-läge kör alltid Advisorn, oavsett vad JEV säger.
// ═══════════════════════════════════════════════════════════════════════════

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_TIMEOUT_MS = 8_000;

export interface TurnSignals {
  mode: "paper" | "live";
  executionMode: string;
  openPositions: number;
  maxOpenPositions: number;
  dailyPnlUsd: number;
  maxDailyLossUsd: number;
  hasUserInstruction: boolean;
}

export interface JevTurnDecision {
  status: "ready" | "skipped" | "unavailable";
  runAdvisor: boolean;
  depth?: string;
  reviewProbability?: number;
  detail: string;
}

type JevAnswer = { choice?: string; noul?: number };

function band(value: number, limit: number): string {
  if (limit <= 0) return "unknown";
  const ratio = Math.abs(value) / limit;
  if (ratio < 0.25) return "low";
  if (ratio < 0.75) return "medium";
  return "high";
}

export function buildTurnRequest(s: TurnSignals) {
  return {
    model: "jev-latest",
    state: {
      task: "Sanitized category: scheduled crypto trading turn. Decide whether an independent strategic review is worth one extra large-model call.",
      mode: s.mode,
      execution_mode: s.executionMode,
      position_load: band(s.openPositions, s.maxOpenPositions),
      daily_pnl_direction: s.dailyPnlUsd >= 0 ? "flat_or_positive" : "negative",
      daily_loss_budget_used: s.dailyPnlUsd < 0 ? band(s.dailyPnlUsd, s.maxDailyLossUsd) : "none",
      manual_instruction: s.hasUserInstruction,
      constraints: ["advisory only", "risk manager keeps veto", "no market data included"],
    },
    questions: {
      execution_depth: {
        type: "choice",
        instructions: "How much analysis does this trading turn justify?",
        criteria: {
          fast: "Routine turn, low exposure, nothing unusual",
          standard: "Normal turn with open positions to manage",
          deep: "Elevated exposure, losses or a manual instruction",
        },
      },
      needs_independent_review: {
        type: "noul",
        instructions: "Does this turn justify an independent strategic review before the head trader decides?",
        criteria: {
          true: "Exposure, drawdown or unusual conditions make a second opinion valuable",
          false: "Routine turn where a second opinion adds cost but little value",
        },
      },
    },
  };
}

/** Rent beslut utifrån JEV:s svar; testbart utan nätverk. */
export function decideFromAnswers(answers: Record<string, JevAnswer>, mode: "paper" | "live"): JevTurnDecision {
  const depth = answers.execution_depth?.choice;
  const review = answers.needs_independent_review?.noul;
  if (!depth && typeof review !== "number") {
    return { status: "unavailable", runAdvisor: true, detail: "JEV gav inga användbara svar" };
  }
  const routine = depth === "fast" && typeof review === "number" && review < 0.5;
  const runAdvisor = mode === "live" || !routine;
  const reviewText = typeof review === "number" ? review.toFixed(2) : "?";
  return {
    status: "ready",
    runAdvisor,
    depth,
    reviewProbability: review,
    detail: `depth=${depth ?? "?"} review=${reviewText}${mode === "live" ? " (live: advisor alltid på)" : ""}`,
  };
}

export async function jevTurnPreflight(signals: TurnSignals): Promise<JevTurnDecision> {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key || process.env.JEV_ENABLED === "false") {
    return { status: "skipped", runAdvisor: true, detail: "JEV avstängd eller TYPESAFE_API_KEY saknas" };
  }

  try {
    const res = await fetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildTurnRequest(signals)),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { answers?: Record<string, JevAnswer> };
    const decision = decideFromAnswers(body.answers ?? {}, signals.mode);
    log.info(`[JEV] ${decision.detail} → advisor ${decision.runAdvisor ? "körs" : "hoppas över"}`);
    return decision;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[JEV] Otillgänglig (${msg}) — kör Advisorn som vanligt.`);
    return { status: "unavailable", runAdvisor: true, detail: `JEV otillgänglig: ${msg}` };
  }
}
