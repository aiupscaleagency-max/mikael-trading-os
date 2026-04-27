import type { Config } from "../config.js";
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
}): Promise<OrchestratorResult> {
  const { config, state, broker, brokers, risk, engines, userInstruction } = params;
  const apiKey = config.anthropicApiKey;

  const totalStart = Date.now();

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
    throw new Error(`Spend cap reached: ${spendCheck.reason}`);
  }
  log.info(`[Cost] Dagens spend: $${spendCheck.spent?.today.toFixed(2)} / cap $${config.costCap.dailyUsd} | Vecka: $${spendCheck.spent?.week.toFixed(2)} / $${config.costCap.weeklyUsd}`);

  // ── Fas 1: Alla specialister + Advisor parallellt ──
  // ── Fas 0: Lars (Perplexity Research) ──
  // Hämtar färska nyheter/makro/geopolitik som specialisterna kan använda.
  log.info("╔══ ORCHESTRATOR: Fas 0 — Lars (Research) hämtar färsk webbkontext ══╗");
  const research = await runResearcher(config.perplexity.apiKey);

  log.info("╔══ ORCHESTRATOR: Fas 1 — specialist-analys (parallellt) ══╗");
  const specialistStart = Date.now();

  const allSymbols = [...config.crypto.symbols, ...config.stocks.symbols];

  const recentDecisions = await loadRecentDecisions(20);
  const positions = await broker.getPositions().catch(() => []);
  const account = await broker.getAccount().catch(() => ({ totalValueUsdt: 0 }));

  const [macro, technical, sentiment, riskReport, quant, options, portfolio, advisor] =
    await Promise.all([
      runMacroAnalyst(apiKey).catch((err): MacroReport => {
        log.error(`Makro-analytiker kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "macro_analyst", regime: "uncertain", keyFactors: ["Analytiker ej tillgänglig"], oilSummary: "Okänt", vixLevel: "Okänt", dollarTrend: "Okänt", cryptoFearGreed: "Okänt", recommendation: "Avvakta", confidence: "low", rawText: "" };
      }),

      runTechnicalAnalyst(apiKey, broker, allSymbols, engines).catch((err): TechnicalReport => {
        log.error(`Teknisk analytiker kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "technical_analyst", analyses: [], topPick: null, rawText: "" };
      }),

      runSentimentAnalyst(apiKey).catch((err): SentimentReport => {
        log.error(`Sentiment-analytiker kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "sentiment_analyst", overallSentiment: "neutral", topNarratives: [], politicianActivity: "Ej tillgänglig", contrarySignal: false, rawText: "" };
      }),

      runRiskAnalyst(apiKey, broker, {
        maxPositionUsd: config.risk.maxPositionUsd,
        maxTotalExposureUsd: config.risk.maxTotalExposureUsd,
        maxDailyLossUsd: config.risk.maxDailyLossUsd,
        maxOpenPositions: config.risk.maxOpenPositions,
      }).catch((err): RiskReport => {
        log.error(`Risk-analytiker kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "risk_analyst", portfolioHeatPct: 0, correlationRisk: "medium", correlationDetails: "Ej tillgänglig", maxDrawdownScenario: { description: "Okänt", estimatedLossUsd: 0, estimatedLossPct: 0 }, suggestedPositionSizing: { maxNewPositionUsd: 0, reasoning: "Ej tillgänglig" }, riskLevel: "high", warnings: ["Risk-analys misslyckades"], recommendation: "Avvakta.", rawText: "" };
      }),

      runQuantAnalyst(apiKey, broker, allSymbols).catch((err): QuantReport => {
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

      runPortfolioStrategist(apiKey, broker).catch((err): PortfolioReport => {
        log.error(`Portfölj-strateg kraschade: ${err instanceof Error ? err.message : String(err)}`);
        return { role: "portfolio_strategist", diversificationScore: 0, sectorConcentration: [], rebalancingNeeded: false, rebalancingActions: [], cashAllocationPct: 100, recommendation: "Ej tillgänglig.", confidence: "low", rawText: "" };
      }),

      runClaudeAdvisor(apiKey, {
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
      }).catch((err): AdvisorReport => {
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

  const execution = await runExecutionOptimizer(apiKey, proposedTrades).catch((err): ExecutionReport => {
    log.error(`Exekverings-optimerare kraschade: ${err instanceof Error ? err.message : String(err)}`);
    return { role: "execution_optimizer", tradeOptimizations: [], generalAdvice: "Ej tillgänglig.", urgency: "low", rawText: "" };
  });
  const execMs = Date.now() - execStart;

  log.info(
    `╠══ Specialister klara på ${(specialistMs / 1000).toFixed(1)}s + exec ${(execMs / 1000).toFixed(1)}s ══╣\n` +
    `  Makro: ${macro.regime} (${macro.confidence})\n` +
    `  Teknisk: ${technical.analyses.length} symboler, top=${technical.topPick ?? "–"}\n` +
    `  Sentiment: ${sentiment.overallSentiment}, contrary=${sentiment.contrarySignal}\n` +
    `  Risk: ${riskReport.riskLevel}, heat=${riskReport.portfolioHeatPct}%\n` +
    `  Kvant: vol=${quant.volatilityRegime}, sharpe=${quant.sharpeEstimate}\n` +
    `  Options: IV=${options.overallIvEnvironment}, applicable=${options.applicable}\n` +
    `  Portfölj: diversifiering=${portfolio.diversificationScore}, rebalans=${portfolio.rebalancingNeeded}\n` +
    `  Advisor: ${advisor.strategicOutlook}, cykel=${advisor.marketCyclePhase}\n` +
    `  Exekvering: ${execution.tradeOptimizations.length} trades, urgency=${execution.urgency}`,
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

  const headTrader = await runHeadTrader({
    apiKey, config, state, broker, brokers, risk, engines,
    reports: allReports,
    userInstruction,
  });

  const headMs = Date.now() - headStart;
  const totalMs = Date.now() - totalStart;

  log.info(
    `╚══ Turn klart: ${(totalMs / 1000).toFixed(1)}s ` +
    `(specialister ${(specialistMs / 1000).toFixed(1)}s + ` +
    `exec ${(execMs / 1000).toFixed(1)}s + ` +
    `head trader ${(headMs / 1000).toFixed(1)}s) ══╝`,
  );

  return {
    headTrader,
    reports: allReports,
    timingMs: { specialists: specialistMs, execution: execMs, headTrader: headMs, total: totalMs },
  };
}
