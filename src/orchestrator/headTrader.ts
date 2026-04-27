import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { AgentState } from "../memory/store.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import type { RiskManager } from "../risk/riskManager.js";
import { toolDefinitions, runTool, type ToolContext } from "../agent/tools.js";
import type { StrategyEngine } from "../strategies/types.js";
import { summarizePastPerformance } from "../memory/store.js";
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
  HeadTraderDecision,
} from "./types.js";
import { log } from "../logger.js";
import type { OrderRequest, OrderResult } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Head Trader — teamets beslutsfattare.
//
//  Får rapporter från ALLA 9 specialister + tillgång till execution-tools.
//  Modell: Sonnet 4.6 (kostnadsoptimerad — 5x billigare än Opus, fortfarande
//  starkt reasoning för syntetisering. Advisor (Opus 4.7) ger strategisk djup-vy
//  separat. Mike kan höja till Opus 4.7 efter 7-dagars utvärdering om kvaliteten
//  inte räcker.)
// ═══════════════════════════════════════════════════════════════════════════

const HEAD_TRADER_MODEL = "claude-sonnet-4-6";

export interface AllReports {
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

export interface HeadTraderResult {
  decision: HeadTraderDecision;
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  placedOrders: Array<{ request: OrderRequest; result: OrderResult }>;
  killSwitchToggled: boolean;
}

export async function runHeadTrader(params: {
  apiKey: string;
  config: Config;
  state: AgentState;
  broker: BrokerAdapter;
  brokers: Record<string, BrokerAdapter>;
  risk: RiskManager;
  engines: StrategyEngine[];
  reports: AllReports;
  userInstruction?: string;
}): Promise<HeadTraderResult> {
  const { apiKey, config, state, broker, brokers, risk, engines, reports } = params;

  const performance = await summarizePastPerformance();

  const systemPrompt = buildHeadTraderPrompt(config, state, performance);
  const briefingContent = formatAllReports(reports);

  const toolCtx: ToolContext = {
    broker,
    brokers,
    risk,
    config,
    state,
    engines,
    sideEffects: { placedOrders: [], killSwitchToggled: false },
  };

  const recordedToolCalls: Array<{ name: string; input: unknown; output: unknown }> = [];

  const userMessage = params.userInstruction
    ? `${briefingContent}\n\n──── SPECIAL INSTRUKTION ────\n${params.userInstruction}`
    : briefingContent;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const client = new Anthropic({ apiKey });
  const MAX_ITERATIONS = 12;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const response = await client.messages.create({
      model: HEAD_TRADER_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: toolDefinitions(),
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const rawText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      return {
        decision: {
          role: "head_trader",
          regime: reports.macro.regime,
          actions: toolCtx.sideEffects.placedOrders.map((o) => ({
            engine: "head_trader",
            action: o.request.side === "BUY" ? "buy" as const : "sell" as const,
            symbol: o.request.symbol,
            sizeUsd: o.result.cummulativeQuoteQty,
            reasoning: "Se fulltext",
            confidence: "high" as const,
          })),
          briefingSummary: rawText,
          rawText,
        },
        toolCalls: recordedToolCalls,
        placedOrders: toolCtx.sideEffects.placedOrders,
        killSwitchToggled: toolCtx.sideEffects.killSwitchToggled,
      };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      log.agent(`[Head Trader] → tool: ${tu.name}`, tu.input);
      const output = await runTool(tu.name, tu.input as Record<string, unknown>, toolCtx);
      recordedToolCalls.push({ name: tu.name, input: tu.input, output });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(output),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    decision: {
      role: "head_trader",
      regime: reports.macro.regime,
      actions: [],
      briefingSummary: "(Max iterationer nådda)",
      rawText: "",
    },
    toolCalls: recordedToolCalls,
    placedOrders: toolCtx.sideEffects.placedOrders,
    killSwitchToggled: toolCtx.sideEffects.killSwitchToggled,
  };
}

function buildHeadTraderPrompt(config: Config, state: AgentState, performance: string): string {
  return `Du är HEAD TRADER i Mikaels trading-team. Du har precis fått rapporter från NIO specialister:

═══ DITT TEAM (9 specialister) ═══
1. Makro-analytiker — regim, olja, VIX, dollar, krypto-sentiment
2. Teknisk analytiker — indikator-scores, bias, entry/target-zoner
3. Sentiment-analytiker — Reddit-stämning, politiker-aktivitet, contrary signals
4. Risk-analytiker — portföljhetta, korrelation, drawdown-scenarier
5. Kvant-analytiker — volatilitet, Sharpe, trend vs mean-reversion
6. Options-strateg — IV-rank, premium-selling, roll-möjligheter
7. Portfölj-strateg — diversifiering, rebalansering, sektorkoncentration
8. Exekverings-optimerare — ordertyp, timing, DCA vs lump sum
9. Claude Advisor — strategisk rådgivare, contrarian, beteendefinans

═══ DIN ROLL ═══
Du SYNTETISERAR alla 9 rapporter och fattar det slutgiltiga beslutet. Du har verktyg för att lägga order, hämta ytterligare data, eller aktivera kill-switch.

═══ SYSTEMSTATUS ═══
Mode: ${config.mode.toUpperCase()} | Execution: ${config.executionMode}
Kill-switch: ${state.killSwitchActive ? "AKTIV" : "OK"}
Dagens PnL: ${state.dailyRealizedPnlUsdt.toFixed(2)} USDT
Risk: max ${config.risk.maxPositionUsd} USD/position, max ${config.risk.maxTotalExposureUsd} USD total

═══ HISTORIK ═══
${performance}

═══ BESLUTSPROCESS ═══
1. Läs ALLA nio rapporter. Vikta dem:
   - Risk + Advisor = VETO-KRAFT (om båda säger avvakta → du avvaktar)
   - Makro + Sentiment = KONTEXT (regim + stämning)
   - Teknisk + Kvant = SIGNALER (entry/exit-triggers)
   - Options + Portfölj = STRUKTUR (hur handeln ska se ut)
   - Exekvering = TAKTIK (ordertyp, timing, sizing)

2. KONSENSUS-CHECK:
   - Om >= 5 av 9 säger "avvakta/bearish" → HOLD
   - Om Risk-analytikern säger "critical" → HOLD oavsett
   - Om Advisor flaggar beteende-bias → dubbelkolla din logik

3. OM TRADE: Använd exekverings-optimeraren för ordertyp/timing.
   Respektera risk-analytikerns position-sizing.

4. Kolla portföljen (get_all_positions) om du inte redan sett den.
5. Lägg order via place_order om tydlig setup. Risk managern kontrollerar.

═══ OUTPUT-FORMAT ═══
Avsluta alltid med en "Rule of 3"-sammanfattning:

[1] Regim: ...
[2] Action: ...
[3] Bevaka: ...

═══ ABSOLUTA REGLER ═══
- Du kan INTE kringgå risk managern.
- Risk-analytiker + Advisor har VETO. Respektera dem.
- Hellre HOLD än en osäker trade. Kapitalbevarande > avkastning.
- Mikael bestämmer insatserna (via config). Du bestämmer timing och exit.`;
}

function formatAllReports(reports: AllReports): string {
  const { macro, technical, sentiment, risk, quant, options, execution, portfolio, advisor } = reports;

  let out = `═══ RAPPORTER FRÅN 9 SPECIALISTER ═══\n\n`;

  // 1. Makro
  out += `── [1/9] MAKRO-ANALYTIKER ──\n`;
  out += `Regim: ${macro.regime.toUpperCase()} (confidence: ${macro.confidence})\n`;
  out += `Nyckelfaktorer: ${macro.keyFactors.join(" | ")}\n`;
  out += `Olja: ${macro.oilSummary} | VIX: ${macro.vixLevel} | Dollar: ${macro.dollarTrend}\n`;
  out += `Crypto F&G: ${macro.cryptoFearGreed}\n`;
  out += `Rekommendation: ${macro.recommendation}\n\n`;

  // 2. Teknisk
  out += `── [2/9] TEKNISK ANALYTIKER ──\n`;
  out += `Top pick: ${technical.topPick ?? "Ingen"}\n`;
  for (const a of technical.analyses) {
    out += `  ${a.symbol}: ${a.bias} (score ${a.score}) — ${a.keySignals.join(", ")}`;
    if (a.entryZone) out += ` | Entry: ${a.entryZone.price}, SL: ${a.entryZone.stopLoss}`;
    if (a.targetZone) out += ` | TP: ${a.targetZone.tp1}/${a.targetZone.tp2}/${a.targetZone.tp3}`;
    out += `\n`;
  }
  out += `\n`;

  // 3. Sentiment
  out += `── [3/9] SENTIMENT-ANALYTIKER ──\n`;
  out += `Stämning: ${sentiment.overallSentiment}\n`;
  out += `Narrativ: ${sentiment.topNarratives.join(" | ")}\n`;
  out += `Politiker: ${sentiment.politicianActivity}\n`;
  out += `Contrary signal: ${sentiment.contrarySignal ? "JA — möjlig reversal" : "Nej"}\n\n`;

  // 4. Risk
  out += `── [4/9] RISK-ANALYTIKER ──\n`;
  out += `Risknivå: ${risk.riskLevel.toUpperCase()} | Portföljhetta: ${risk.portfolioHeatPct}%\n`;
  out += `Korrelation: ${risk.correlationRisk} — ${risk.correlationDetails}\n`;
  out += `Max drawdown: ${risk.maxDrawdownScenario.description} (${risk.maxDrawdownScenario.estimatedLossUsd} USD / ${risk.maxDrawdownScenario.estimatedLossPct}%)\n`;
  out += `Positionsstorlek: max ${risk.suggestedPositionSizing.maxNewPositionUsd} USD — ${risk.suggestedPositionSizing.reasoning}\n`;
  if (risk.warnings.length > 0) out += `VARNINGAR: ${risk.warnings.join(" | ")}\n`;
  out += `Rekommendation: ${risk.recommendation}\n\n`;

  // 5. Kvant
  out += `── [5/9] KVANT-ANALYTIKER ──\n`;
  out += `Volatilitet: ${quant.volatilityRegime} | Sharpe: ${quant.sharpeEstimate} | Win rate: ${(quant.winRateFromHistory * 100).toFixed(0)}%\n`;
  for (const s of quant.symbolScores) {
    out += `  ${s.symbol}: trend=${s.trendScore} meanRev=${s.meanReversionScore} vol=${s.volatilityPct}% regime=${s.regime}\n`;
  }
  out += `Rekommendation: ${quant.recommendation}\n\n`;

  // 6. Options
  out += `── [6/9] OPTIONS-STRATEG ──\n`;
  if (!options.applicable) {
    out += `Ej tillämpbar (brokern stödjer inte optioner)\n\n`;
  } else {
    out += `IV-miljö: ${options.overallIvEnvironment}\n`;
    for (const iv of options.ivAssessments) {
      out += `  ${iv.symbol}: IV=${iv.ivRank} strategi=${iv.optimalStrategy} — ${iv.strategyDetails}\n`;
    }
    if (options.rollOpportunities.length > 0) out += `Roll-möjligheter: ${options.rollOpportunities.join(" | ")}\n`;
    out += `Rekommendation: ${options.recommendation}\n\n`;
  }

  // 7. Portfölj
  out += `── [7/9] PORTFÖLJ-STRATEG ──\n`;
  out += `Diversifiering: ${portfolio.diversificationScore}/100 | Rebalansering: ${portfolio.rebalancingNeeded ? "JA" : "Nej"}\n`;
  out += `Cash-allokering: ${portfolio.cashAllocationPct}%\n`;
  for (const s of portfolio.sectorConcentration) {
    out += `  ${s.sector}: ${s.weightPct}% (risk: ${s.risk})\n`;
  }
  if (portfolio.rebalancingActions.length > 0) {
    out += `Föreslagna ändringar:\n`;
    for (const a of portfolio.rebalancingActions) {
      out += `  ${a.action} ${a.symbol}: ${a.currentWeightPct}% → ${a.targetWeightPct}% — ${a.reasoning}\n`;
    }
  }
  out += `Rekommendation: ${portfolio.recommendation}\n\n`;

  // 8. Exekvering
  out += `── [8/9] EXEKVERINGS-OPTIMERARE ──\n`;
  out += `Urgency: ${execution.urgency}\n`;
  for (const t of execution.tradeOptimizations) {
    out += `  ${t.symbol}: ${t.orderType} ${t.timing} ${t.executionStyle} (splits=${t.dcaSplits}, slippage=${t.expectedSlippageBps}bps) — ${t.reasoning}\n`;
  }
  out += `Råd: ${execution.generalAdvice}\n\n`;

  // 9. Advisor
  out += `── [9/9] CLAUDE ADVISOR ──\n`;
  out += `Outlook: ${advisor.strategicOutlook.toUpperCase()} | Marknadscykel: ${advisor.marketCyclePhase}\n`;
  out += `Insikter: ${advisor.keyInsights.join(" | ")}\n`;
  if (advisor.blindSpots.length > 0) out += `Blinda fläckar: ${advisor.blindSpots.join(" | ")}\n`;
  if (advisor.behavioralWarnings.length > 0) out += `Beteende-varningar: ${advisor.behavioralWarnings.join(" | ")}\n`;
  out += `Contrarian: ${advisor.contrarian}\n`;
  out += `Portföljråd: ${advisor.portfolioAdvice}\n\n`;

  out += `═══ DITT UPPDRAG ═══\n`;
  out += `Syntetisera ALLA 9 rapporter. Vikta risk + advisor högst. Lägg order om tydlig setup, annars HOLD.`;

  return out;
}
