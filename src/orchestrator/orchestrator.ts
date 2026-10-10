import type { Config } from "../config.js";
import { track, agentSkip, turnPhase, turnEnd, analysisStart, analysisEnd, getAnalysis, type AnalysisOrder, type AnalysisResult } from "../server/agentActivity.js";
import type { AgentState } from "../memory/store.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import type { RiskManager } from "../risk/riskManager.js";
import type { StrategyEngine } from "../strategies/types.js";
import {
  runMacroAnalyst,
  runTechnicalAnalyst,
  runSentimentAnalyst,
} from "./specialists.js";
import {
  runRiskAnalyst,
  runQuantAnalyst,
  runOptionsStrategist,
  runExecutionOptimizer,
  runPortfolioStrategist,
} from "./advancedSpecialists.js";
import { runClaudeAdvisor } from "./advisor.js";
import { jevTurnPreflight } from "../llm/jev.js";
import { runResearcher, type ResearchReport, formatResearchForPrompt } from "./researcher.js";
import { runHeadTrader, type HeadTraderResult } from "./headTrader.js";
import { canSpend } from "../cost/tracker.js";
import { loadRecentDecisions } from "../memory/store.js";
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

// ═══════════════════════════════════════════════════════════════════════════
//  Orchestrator — dirigenten som koordinerar det ultimata trading-teamet.
//
//  Flöde per turn:
//  1. Kör 7 specialister (Haiku) + Claude Advisor (Sonnet) PARALLELLT
//  2. Kör Exekverings-optimerare (behöver teknisk analys-resultat)
//  3. Skicka allt till Head Trader (Opus) som syntetiserar + fattar beslut
//
//  Kostnad: 7x Haiku + 1x Sonnet + 1x Opus per turn
// ═══════════════════════════════════════════════════════════════════════════

export interface AllReports {
  research: ResearchReport;     // Lars (Perplexity) — körs först
  macro: MacroReport;
  technical: TechnicalReport;
  sentiment: SentimentReport;
  risk: RiskReport;
  quant: QuantReport;
  options: OptionsReport;
  execution: ExecutionReport;
  portfolio: PortfolioReport;
  advisor: AdvisorReport;
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
  /** Par som försållningen valt (signalmotorn + JEV). Saknas = alla par. */
  symbols?: string[];
}): Promise<OrchestratorResult> {
  const { config, state, broker, brokers, risk, engines, userInstruction } = params;
  const apiKey = config.anthropicApiKey;

  const totalStart = Date.now();
  // "Kör analys" har redan startat posten; annars är det schemat.
  if (getAnalysis()?.status !== "running") analysisStart("schema", userInstruction);

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

  // ── Fas 1: Alla specialister + Advisor parallellt ──
  // ── Fas 0: Lars (Perplexity Research) ──
  // Hämtar färska nyheter/makro/geopolitik som specialisterna kan använda.
  log.info("╔══ ORCHESTRATOR: Fas 0 — Lars (Research) hämtar färsk webbkontext ══╗");
  turnPhase("Fas 0 · Lars hämtar research");
  // Smalt team (Mike 2026-10-03): JEV väljer paren, sedan bara Teknisk + Risk + Hanna.
  // Lars, Makro, Sentiment, Kvant, Portfölj och Exekvering hoppas över (sparar ungefär hälften).
  // TEAM_LEAN=false i .env tar tillbaka hela teamet.
  const lean = process.env.TEAM_LEAN !== "false";
  const leanNote = "smalt team: JEV → Teknisk + Risk → Hanna";
  const research = lean
    ? (agentSkip("research", leanNote), { role: "researcher", available: false, marketSummary: "Research avstängd (smalt team).", cryptoNews: [], macroEvents: [], geopolitical: [], riskAlerts: [], sources: [], rawText: "" } as ResearchReport)
    : await track("research", "hämtar färsk webbkontext", () => runResearcher(config.perplexity.apiKey), { from: "orchestrator" });

  log.info("╔══ ORCHESTRATOR: Fas 1 — specialist-analys (parallellt) ══╗");
  turnPhase("Fas 1 · JEV + specialister + advisor");
  const specialistStart = Date.now();

  const allSymbols = params.symbols?.length ? params.symbols : [...config.crypto.symbols, ...config.stocks.symbols];

  const recentDecisions = await loadRecentDecisions(20);
  const positions = await broker.getPositions().catch(() => []);
  const account = await broker.getAccount().catch(() => ({ totalValueUsdt: 0 }));

  // ── JEV: behöver den här turen Advisorn, eller är den rutin? ──
  const jev = await track("jev", "avgör om advisorn behövs", () => jevTurnPreflight({
    mode: config.mode,
    executionMode: config.executionMode,
    openPositions: positions.length,
    maxOpenPositions: config.risk.maxOpenPositions,
    dailyPnlUsd: state.dailyRealizedPnlUsdt,
    maxDailyLossUsd: config.risk.maxDailyLossUsd,
    hasUserInstruction: Boolean(userInstruction),
  }), { from: "research", done: (v) => v.runAdvisor ? `advisorn körs (${v.detail})` : `rutin, advisorn hoppas över (${v.detail})` });
  if (!jev.runAdvisor) agentSkip("advisor", `JEV: rutinturn (${jev.detail})`);

  const [macro, technical, sentiment, riskReport, quant, options, portfolio, advisor] =
    await Promise.all([
            lean ? (agentSkip("macro", leanNote), Promise.resolve<MacroReport>({ role: "macro_analyst", regime: "uncertain", keyFactors: ["Hoppas över (smalt team)"], oilSummary: "–", vixLevel: "–", dollarTrend: "–", cryptoFearGreed: "–", recommendation: "–", confidence: "low", rawText: "" })) : track("macro", "läser makro", () => runMacroAnalyst(apiKey), { from: "jev", done: (r) => `${r.regime} (${r.confidence})` }).catch((err): MacroReport => {
        log.error(`Makro-analytiker kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "macro_analyst", regime: "uncertain", keyFactors: ["Analytiker ej tillgänglig"], oilSummary: "Okänt", vixLevel: "Okänt", dollarTrend: "Okänt", cryptoFearGreed: "Okänt", recommendation: "Avvakta", confidence: "low", rawText: "" };
      }),

      track("technical", `teknisk analys ${allSymbols.length} symboler`, () => runTechnicalAnalyst(apiKey, broker, allSymbols, engines), { from: "jev", done: (r) => `top ${r.topPick ?? "–"}` }).catch((err): TechnicalReport => {
        log.error(`Teknisk analytiker kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "technical_analyst", analyses: [], topPick: null, rawText: "" };
      }),

            lean ? (agentSkip("sentiment", leanNote), Promise.resolve<SentimentReport>({ role: "sentiment_analyst", overallSentiment: "neutral", topNarratives: [], politicianActivity: "–", contrarySignal: false, rawText: "" })) : track("sentiment", "läser sentiment", () => runSentimentAnalyst(apiKey), { from: "jev", done: (r) => r.overallSentiment }).catch((err): SentimentReport => {
        log.error(`Sentiment-analytiker kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "sentiment_analyst", overallSentiment: "neutral", topNarratives: [], politicianActivity: "Ej tillgänglig", contrarySignal: false, rawText: "" };
      }),

      track("risk", "räknar risk", () => runRiskAnalyst(apiKey, broker, {
        maxPositionUsd: config.risk.maxPositionUsd,
        maxTotalExposureUsd: config.risk.maxTotalExposureUsd,
        maxDailyLossUsd: config.risk.maxDailyLossUsd,
        maxOpenPositions: config.risk.maxOpenPositions,
      }), { from: "jev", done: (r) => `${r.riskLevel}, heat ${r.portfolioHeatPct}%` }).catch((err): RiskReport => {
        log.error(`Risk-analytiker kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "risk_analyst", portfolioHeatPct: 0, correlationRisk: "medium", correlationDetails: "Ej tillgänglig", maxDrawdownScenario: { description: "Okänt", estimatedLossUsd: 0, estimatedLossPct: 0 }, suggestedPositionSizing: { maxNewPositionUsd: 0, reasoning: "Ej tillgänglig" }, riskLevel: "high", warnings: ["Risk-analys misslyckades"], recommendation: "Avvakta.", rawText: "" };
      }),

            lean ? (agentSkip("quant", leanNote), Promise.resolve<QuantReport>({ role: "quant_analyst", volatilityRegime: "medium", sharpeEstimate: 0, winRateFromHistory: 0, symbolScores: [], recommendation: "Hoppas över (smalt team).", confidence: "low", rawText: "" })) : track("quant", "kvantanalys", () => runQuantAnalyst(apiKey, broker, allSymbols), { from: "jev", done: (r) => `vol ${r.volatilityRegime}` }).catch((err): QuantReport => {
        log.error(`Kvant-analytiker kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "quant_analyst", volatilityRegime: "medium", sharpeEstimate: 0, winRateFromHistory: 0, symbolScores: [], recommendation: "Ej tillgänglig.", confidence: "low", rawText: "" };
      }),

      // Olof (Options-Strateg) är borttagen — irrelevant för crypto-spot.
      // Hans volatilitets-insikter är absorberade i Karin (Kvant) och Rasmus (Risk).
      // Returnerar stub-rapport så typerna stämmer utan Anthropic-anrop.
      Promise.resolve<OptionsReport>({
        role: "options_strategist",
        ivAssessments: [],
        rollOpportunities: [],
        overallIvEnvironment: "normal",
        recommendation: "Options-strateg ej aktiv (crypto-spot mode).",
        applicable: false,
        rawText: "",
      }),

            lean ? (agentSkip("portfolio", leanNote), Promise.resolve<PortfolioReport>({ role: "portfolio_strategist", diversificationScore: 0, sectorConcentration: [], rebalancingNeeded: false, rebalancingActions: [], cashAllocationPct: 100, recommendation: "Hoppas över (smalt team).", confidence: "low", rawText: "" })) : track("portfolio", "portföljkoll", () => runPortfolioStrategist(apiKey, broker), { from: "jev", done: (r) => `diversifiering ${r.diversificationScore}` }).catch((err): PortfolioReport => {
        log.error(`Portfölj-strateg kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "portfolio_strategist", diversificationScore: 0, sectorConcentration: [], rebalancingNeeded: false, rebalancingActions: [], cashAllocationPct: 100, recommendation: "Ej tillgänglig.", confidence: "low", rawText: "" };
      }),

      !jev.runAdvisor
        ? Promise.resolve<AdvisorReport>({
            role: "claude_advisor",
            strategicOutlook: "neutral",
            marketCyclePhase: "accumulation",
            keyInsights: [`Advisor hoppades över av JEV (${jev.detail}) — rutinturn.`],
            blindSpots: [],
            behavioralWarnings: [],
            contrarian: "Ingen advisor-granskning denna turn.",
            portfolioAdvice: "Följ riskramarna som vanligt.",
            confidence: "low",
            rawText: "",
          })
        : track("advisor", "granskar helheten", () => runClaudeAdvisor(apiKey, {
            currentPositions: positions.map((p) => ({
              symbol: p.symbol, quantity: p.quantity,
              avgEntryPrice: p.avgEntryPrice, currentPrice: p.currentPrice,
            })),
            recentDecisions: recentDecisions.map((d) => ({
              action: d.action, symbol: d.symbol,
              reasoning: d.reasoning, timestamp: d.timestamp,
            })),
            dailyPnl: state.dailyRealizedPnlUsdt,
            accountValue: account.totalValueUsdt,
            activeEngines: config.engines,
          }), { from: "jev", done: (r) => `${r.strategicOutlook}, ${r.marketCyclePhase}` }).catch((err): AdvisorReport => {
            log.error(`Claude Advisor kraschade: ${err instanceof Error ? err.message : String(err)}`);
            return { role: "claude_advisor", strategicOutlook: "neutral", marketCyclePhase: "accumulation", keyInsights: ["Advisor ej tillgänglig"], blindSpots: [], behavioralWarnings: [], contrarian: "Ej tillgänglig", portfolioAdvice: "Avvakta.", confidence: "low", rawText: "" };
          }),
    ]);

  const specialistMs = Date.now() - specialistStart;

  // ── Fas 1.5: Exekverings-optimerare (behöver teknisk analys) ──
  const execStart = Date.now();
  const proposedTrades = technical.analyses
    .filter((a) => Math.abs(a.score) >= 2)
    .map((a) => ({ symbol: a.symbol, bias: a.bias, score: a.score }));

  if (!lean) turnPhase("Fas 1.5 · Emma optimerar exekvering");
  else agentSkip("execution", leanNote);
  const execution = lean
    ? ({ role: "execution_optimizer", tradeOptimizations: [], generalAdvice: "Hoppas över (smalt team).", urgency: "low", rawText: "" } as ExecutionReport)
    : await track("execution", `${proposedTrades.length} föreslagna trades`, () => runExecutionOptimizer(apiKey, proposedTrades), { from: "technical", done: (r) => `brådska ${r.urgency}` }).catch((err): ExecutionReport => {
    log.error(`Exekverings-optimerare kraschade: ${err instanceof Error ? err.message : String(err)}`);
    return { role: "execution_optimizer", tradeOptimizations: [], generalAdvice: "Ej tillgänglig.", urgency: "low", rawText: "" };
  });
  const execMs = Date.now() - execStart;

  log.info(
    `╠══ Specialister klara på ${(specialistMs / 1000).toFixed(1)}s + exec ${(execMs / 1000).toFixed(1)}s ══╣\n` +
    `  Makro: ${macro.regime} (${macro.confidence})\n` +
    `  Teknisk: ${technical.analyses?.length ?? 0} symboler, top=${technical.topPick ?? "–"}\n` +
    `  Sentiment: ${sentiment.overallSentiment}, contrary=${sentiment.contrarySignal}\n` +
    `  Risk: ${riskReport.riskLevel}, heat=${riskReport.portfolioHeatPct}%\n` +
    `  Kvant: vol=${quant.volatilityRegime}, sharpe=${quant.sharpeEstimate}\n` +
    `  Options: IV=${options.overallIvEnvironment}, applicable=${options.applicable}\n` +
    `  Portfölj: diversifiering=${portfolio.diversificationScore}, rebalans=${portfolio.rebalancingNeeded}\n` +
    `  Advisor: ${advisor.strategicOutlook}, cykel=${advisor.marketCyclePhase}\n` +
    `  Exekvering: ${execution.tradeOptimizations?.length ?? 0} trades, urgency=${execution.urgency}`,
  );

  const allReports: AllReports = {
    research,
    macro, technical, sentiment,
    risk: riskReport, quant, options,
    execution, portfolio, advisor,
  };

  // ── Fas 2: Head Trader ──
  log.info("╠══ ORCHESTRATOR: Fas 2 — Head Trader beslutar ══╣");
  const headStart = Date.now();

  turnPhase("Fas 2 · Hanna (Head Trader) beslutar");
  const headTrader = await track("head", "väger ihop alla rapporter", () => runHeadTrader({
    apiKey, config, state, broker, brokers, risk, engines,
    reports: allReports,
    userInstruction,
    symbols: allSymbols,
  }), { from: "execution", done: (r) => `${r.placedOrders.length} order` });

  const headMs = Date.now() - headStart;
  const totalMs = Date.now() - totalStart;

  log.info(
    `╚══ Turn klart: ${(totalMs / 1000).toFixed(1)}s ` +
    `(specialister ${(specialistMs / 1000).toFixed(1)}s + ` +
    `exec ${(execMs / 1000).toFixed(1)}s + ` +
    `head trader ${(headMs / 1000).toFixed(1)}s) ══╝`,
  );

  turnEnd(`Turen klar på ${(totalMs / 1000).toFixed(1)} s`);
  try {
    const { igTurnStale } = await import("../server/igTurnGuard.js");
    const stale = igTurnStale();
    if (stale) { analysisEnd({ status: "stopped", reason: stale }); throw new Error("__stale__"); }
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
    const picks = headTrader.decision.actions.map((a) => ({
      symbol: a.symbol, action: a.action, sizeUsd: a.sizeUsd, confidence: a.confidence, reasoning: a.reasoning.slice(0, 300),
    }));
    // Besked per instrument (även när Hanna avstod): Hannas beslut + teknisk analytiker, per miljö och EPIC
    let notes: AnalysisResult["notes"];
    try {
      const { igMarketData } = await import("../server/igMarketData.js");
      const { buildAgentNotes, agentNotes } = await import("../server/igAgentNotes.js");
      const env = igMarketData.getActiveEnv();
      notes = buildAgentNotes({
        env, symbols: allSymbols, picks, technical: technical.analyses ?? [], summary: headTrader.decision.briefingSummary,
        trigger: getAnalysis()?.trigger ?? null, nameOf: (e) => igMarketData.nameOf(e, env),
      });
      agentNotes.record(notes);
    } catch { /* anteckningarna är bara en spegel */ }
    analysisEnd({
      status: "done",
      regime: headTrader.decision.regime,
      summary: headTrader.decision.briefingSummary.slice(0, 1500),
      picks,
      orders,
      ...(notes ? { notes } : {}),
    });
  } catch { /* bara en spegel */ }
  return {
    headTrader,
    reports: allReports,
    timingMs: { specialists: specialistMs, execution: execMs, headTrader: headMs, total: totalMs },
  };
}
