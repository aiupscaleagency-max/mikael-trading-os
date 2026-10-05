import { log } from "../logger.js";
import { askJev, type JevAnswer } from "../server/jevClient.js";
import { treeEvent } from "../server/treeLog.js";

// ═══════════════════════════════════════════════════════════════════════════
//  JEV (TypeSafe System One) — beslutslagret framför de stora modellerna.
//
// JEV bedömer analysdjup före Teknisk och Hanna. Rådet lägger aldrig till fler agentroller.
// Bara avidentifierade kategorier och riskband skickas; inga priser, symboler eller nycklar.
// Om JEV inte svarar behålls de två godkända rollerna och deterministiska riskspärrar.

const JEV_TIMEOUT_MS = 2_500;

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


function band(value: number, limit: number): string {
  if (limit <= 0) return "unknown";
  const ratio = Math.abs(value) / limit;
  if (ratio < 0.25) return "low";
  if (ratio < 0.75) return "medium";
  return "high";
}

export function buildTurnRequest(s: TurnSignals) {
  return {
    state: {
      task: "Sanitized category: scheduled crypto trading turn. Recommend analysis depth for the fixed technical-agent and head-trader workflow. Do not add agents.",
      mode: s.mode,
      execution_mode: s.executionMode,
      position_load: band(s.openPositions, s.maxOpenPositions),
      daily_pnl_direction: s.dailyPnlUsd >= 0 ? "flat_or_positive" : "negative",
      daily_loss_budget_used: s.dailyPnlUsd < 0 ? band(s.dailyPnlUsd, s.maxDailyLossUsd) : "none",
      manual_instruction: s.hasUserInstruction,
      constraints: ["advisory only", "risk manager keeps veto", "no market data included", "exactly two existing agent roles; no extra model calls"],
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
    return { status: "unavailable", runAdvisor: false, detail: "JEV gav inga användbara svar" };
  }
  const runAdvisor = false;
  const reviewText = typeof review === "number" ? review.toFixed(2) : "?";
  return {
    status: "ready",
    runAdvisor,
    depth,
    reviewProbability: review,
    detail: `depth=${depth ?? "?"} review=${reviewText} · två agentroller`,
  };
}

export async function jevTurnPreflight(signals: TurnSignals): Promise<JevTurnDecision> {
  if (process.env.JEV_ENABLED === "false") {
    return { status: "skipped", runAdvisor: false, detail: "JEV avstängd (JEV_ENABLED=false)" };
  }
  const { state, questions } = buildTurnRequest(signals);
  const verdict = await askJev(state, JEV_TIMEOUT_MS, questions);
  if (!verdict.available) {
    log.warn(`[JEV] Otillgänglig (${verdict.note}) — behåller Teknisk och Hanna samt riskspärrarna.`);
    treeEvent({ branch: "tur", jev: { available: false, route: verdict.mode }, outcome: "två agentroller behålls", why: `JEV otillgänglig: ${verdict.note}` });
    return { status: "unavailable", runAdvisor: false, detail: `JEV otillgänglig: ${verdict.note}` };
  }
  const decision = decideFromAnswers(verdict.answers, signals.mode);
  log.info(`[JEV] ${decision.detail} via ${verdict.mode} → Teknisk och Hanna, inga extra roller`);
  treeEvent({
    branch: "tur", jev: { available: true, route: verdict.mode, latencyMs: verdict.latencyMs, depth: decision.depth, review: decision.reviewProbability },
    outcome: "JEV → Teknisk → Hanna", why: decision.detail,
  });
  return decision;
}
