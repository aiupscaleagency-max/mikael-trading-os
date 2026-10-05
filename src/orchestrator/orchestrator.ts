import { scopeBroker, validateAnalysisRequest, type AnalysisRequest } from "./analysisRequest.js";
import type { Config } from "../config.js";
import { track, agentSkip, turnPhase, turnEnd, analysisStart, analysisEnd, getAnalysis, type AnalysisOrder } from "../server/agentActivity.js";
import type { AgentState } from "../memory/store.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import type { RiskManager } from "../risk/riskManager.js";
import type { StrategyEngine } from "../strategies/types.js";
import { runTechnicalAnalyst } from "./specialists.js";
import { runTwoAgentPipeline } from "./twoAgentPipeline.js";
import { jevTurnPreflight } from "../llm/jev.js";
import { type ResearchReport } from "./researcher.js";
import { runHeadTrader, type HeadTraderResult } from "./headTrader.js";
import { canSpend } from "../cost/tracker.js";
import type {
  MacroReport,
  TechnicalReport,
  SentimentReport,
  RiskReport,
  QuantReport,
  OptionsReport,
  ExecutionReport,
  PortfolioReport,
  AdvisorReport,
} from "./types.js";
import { log } from "../logger.js";

// JEV-förkontroll → Teknisk analys → Hanna. Risk och ordergrindar är deterministisk kod.

export interface AllReports {
  research: ResearchReport | null;     // Null: rollen har inte körts.
  macro: MacroReport | null;
  technical: TechnicalReport | null;
  sentiment: SentimentReport | null;
  risk: RiskReport | null;
  quant: QuantReport | null;
  options: OptionsReport | null;
  execution: ExecutionReport | null;
  portfolio: PortfolioReport | null;
  advisor: AdvisorReport | null;
}

export interface OrchestratorResult {
  headTrader: HeadTraderResult;
  reports: AllReports;
  timingMs: {
    specialists: number;
    execution: number;
    headTrader: number;
    total: number;
  };
}

export async function runOrchestratedTurn(params: {
  config: Config;
  state: AgentState;
  broker: BrokerAdapter;
  brokers: Record<string, BrokerAdapter>;
  risk: RiskManager;
  engines: StrategyEngine[];
  userInstruction?: string;
  request: AnalysisRequest;
}): Promise<OrchestratorResult> {
  const request = validateAnalysisRequest(params.request, params.config.crypto.symbols);
  const { state, risk, engines } = params;
  const config: Config = { ...params.config, crypto: { ...params.config.crypto, symbols: request.selectedSymbols } };
  const broker = scopeBroker(params.broker, request.selectedSymbols);
  const brokers = Object.fromEntries(Object.entries(params.brokers).map(([name, adapter]) => [name, scopeBroker(adapter, request.selectedSymbols)]));
  const userInstruction = request.instruction;
  const allSymbols = request.selectedSymbols;
  const apiKey = config.anthropicApiKey;

  const totalStart = Date.now();
  // "Kör analys" har redan startat posten; annars är det schemat.
  if (getAnalysis()?.status !== "running") analysisStart("schema", userInstruction, { broker: broker.name, requestId: request.requestId, selectedSymbols: request.selectedSymbols, timeframe: request.timeframe });

  // ── CIRCUIT BREAKER: Spend-cap-koll innan vi ens börjar ──
  // Stoppar session om dagen/veckan redan överskridit cap. Skyddar mot
  // oväntade kostnader. Mike kan höja cap i .env om hon vill.
  const spendCheck = await canSpend({
    dailyCapUsd: config.costCap.dailyUsd,
    weeklyCapUsd: config.costCap.weeklyUsd,
  });
  if (!spendCheck.allowed) {
    log.warn(`╔══ SESSION SKIPPAD: ${spendCheck.reason} ══╗`);
    log.warn(`Dagens spend: $${spendCheck.spent?.today.toFixed(2)} / cap $${config.costCap.dailyUsd}`);
    log.warn(`Veckans spend: $${spendCheck.spent?.week.toFixed(2)} / cap $${config.costCap.weeklyUsd}`);
    log.warn(`Höj cap i .env (MAX_DAILY_SPEND_USD / MAX_WEEKLY_SPEND_USD) eller vänta tills cap rullar.`);
    analysisEnd({ status: "stopped", reason: `Dagens AI-tak är nått ($${spendCheck.spent?.today.toFixed(2)} av $${config.costCap.dailyUsd}). Analysen körs igen efter midnatt (UTC) eller när taket höjs.` });
    throw new Error(`Spend cap reached: ${spendCheck.reason}`);
  }
  log.info(`[Cost] Dagens spend: $${spendCheck.spent?.today.toFixed(2)} / cap $${config.costCap.dailyUsd} | Vecka: $${spendCheck.spent?.week.toFixed(2)} / $${config.costCap.weeklyUsd}`);

  // Mikes val: JEV först, sedan Teknisk och Hanna. Äldre TEAM_LEAN=false lägger inte till agenter.
  const leanNote = "Två agenter: JEV → Teknisk → Hanna. Övriga roller körs inte.";
  for (const role of ["research", "macro", "sentiment", "quant", "portfolio", "execution", "advisor", "options"]) agentSkip(role, leanNote);
  agentSkip("risk", "Deterministiska riskgränser, ingen separat AI-agent");
  const positions = await broker.getPositions();
  let specialistMs = 0;
  let headMs = 0;
  const execMs = 0;
  let allReports: AllReports = { research: null, macro: null, technical: null, sentiment: null, risk: null, quant: null,
    options: null, execution: null, portfolio: null, advisor: null };
  const pipeline = await runTwoAgentPipeline({
    jev: async () => {
      turnPhase("Förkontroll · JEV");
      return track("jev", "förkontroll före agentanalys", () => jevTurnPreflight({
        mode: config.mode, executionMode: config.executionMode, openPositions: positions.length,
        maxOpenPositions: config.risk.maxOpenPositions, dailyPnlUsd: state.dailyRealizedPnlUsdt,
        maxDailyLossUsd: config.risk.maxDailyLossUsd, hasUserInstruction: Boolean(userInstruction),
      }), { from: "orchestrator", done: (v) => `${v.status}: ${v.detail}; två agentroller behålls` })
        .catch((err) => { log.warn(`[JEV] förkontrollen misslyckades: ${String(err)}`); return { status: "unavailable" as const, runAdvisor: false, detail: "JEV otillgänglig; befintliga två agentroller och riskspärrar behålls" }; });
    },
    technical: async () => {
      const started = Date.now();
      turnPhase("Agent 1 · Teknisk analys");
      const report = await track("technical", `analyserar ${allSymbols.length} valda par @ ${request.timeframe}`, () =>
        runTechnicalAnalyst(apiKey, broker, allSymbols, engines, request.timeframe), { from: "jev", done: (r) => `top ${r.topPick ?? "–"}` })
        .catch((err) => { log.error(`[Teknisk] analysen misslyckades: ${String(err)}`); return null; });
      specialistMs = Date.now() - started;
      return report;
    },
    head: async (technical) => {
      allReports = { ...allReports, technical };
      const started = Date.now();
      turnPhase("Agent 2 · Hanna beslutar");
      const head = await track("head", "väger teknisk analys mot deterministiska riskgränser", () => runHeadTrader({
        apiKey, config, state, broker, brokers, risk, engines, reports: allReports, userInstruction,
        symbols: allSymbols, timeframe: request.timeframe,
      }), { from: "technical", done: (r) => `${r.placedOrders.length} order` });
      headMs = Date.now() - started;
      return head;
    },
  }).catch((err) => {
    if (!allReports.technical) agentSkip("head", "Teknisk analys saknas; ingen extra AI-kostnad eller order");
    const reason = err instanceof Error ? err.message : String(err);
    analysisEnd({ status: "failed", reason });
    turnEnd(`Turen avbröts: ${reason}`);
    throw err;
  });
  const headTrader = pipeline.head;
  const totalMs = Date.now() - totalStart;

  log.info(
    `╚══ Turn klart: ${(totalMs / 1000).toFixed(1)}s ` +
    `(specialister ${(specialistMs / 1000).toFixed(1)}s + ` +
    `exec ${(execMs / 1000).toFixed(1)}s + ` +
    `head trader ${(headMs / 1000).toFixed(1)}s) ══╝`,
  );

  turnEnd(`Turen klar på ${(totalMs / 1000).toFixed(1)} s`);
  try {
    const orders: AnalysisOrder[] = headTrader.toolCalls
      .filter((c) => c.name === "place_order")
      .map((c) => {
        const i = (c.input ?? {}) as Record<string, unknown>;
        const o = (c.output ?? {}) as { error?: unknown; accepted?: boolean; reason?: unknown; executed?: boolean };
        const status = o.error ? `stoppad: ${String(o.error).slice(0, 120)}`
          : o.accepted === false ? `stoppad av riskkontrollen: ${String(o.reason ?? "").slice(0, 120)}`
          : o.executed === false ? "väntar på ditt OK (Väntande ordrar)"
          : "skickad";
        const usd = Number(i.quote_qty);
        return { symbol: String(i.symbol ?? "?"), side: String(i.side ?? "?"), usd: Number.isFinite(usd) ? usd : null, status };
      });
    analysisEnd({
      status: "done",
      regime: headTrader.decision.regime,
      summary: headTrader.decision.briefingSummary.slice(0, 1500),
      picks: headTrader.decision.actions.map((a) => ({
        symbol: a.symbol, action: a.action, sizeUsd: a.sizeUsd, confidence: a.confidence, reasoning: a.reasoning.slice(0, 300),
      })),
      orders,
    });
  } catch { /* bara en spegel */ }
  return {
    headTrader,
    reports: allReports,
    timingMs: { specialists: specialistMs, execution: execMs, headTrader: headMs, total: totalMs },
  };
}
