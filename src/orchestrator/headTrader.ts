import Anthropic from "@anthropic-ai/sdk";
import { track, agentNote } from "../server/agentActivity.js";
import { createLlmClient, modelFor } from "../llm/gateway.js";
import { trackClaudeCall } from "../cost/tracker.js";
import type { Config } from "../config.js";
import type { AgentState } from "../memory/store.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import type { RiskManager } from "../risk/riskManager.js";
import { toolDefinitions, runTool, type ToolContext } from "../agent/tools.js";
import { computeIndicators } from "../indicators/ta.js";
import type { StrategyEngine } from "../strategies/types.js";
import { summarizePastPerformance } from "../memory/store.js";
import { memorySummary } from "../memory/tradeMemory.js";
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

const headTraderModel = () => modelFor("head", "claude-sonnet-4-6");

// AllReports definieras i orchestrator.ts och importeras därifrån.
// Den lokala kopian saknade fältet 'research' (Lars/Perplexity), vilket
// gjorde att destrukturering av det gav typfel trots att fältet finns
// i objektet som faktiskt skickas in.
import type { AllReports } from "./orchestrator.js";
import { getTradePercent, percentageAmount } from "../risk/tradeSizing.js";

/** Insatsen följer valt kontos aktuella värde och användarens procent. */
function stakeBlock(equity: number): string {
  const pct = getTradePercent(), usd = percentageAmount(equity, equity, pct);
  return `INSATS: ${pct} % av valt kontos aktuella värde $${equity.toFixed(2)} = $${usd.toFixed(2)} per trade.
  Procenten höjs aldrig automatiskt. TEST och LIVE använder samma princip med separata saldon.
  Riskkontrollen och tillgängligt saldo kan begränsa beloppet. Alla ordrar kräver manuellt godkännande.
`;
}
export type { AllReports };

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
  /** Paren JEV valt: deras indikatorer skickas med direkt (färre verktygsanrop). */
  symbols?: string[];
  timeframe?: string;
}): Promise<HeadTraderResult> {
  const { apiKey, config, state, broker, brokers, risk, engines, reports } = params;

  // Tradingminnet: hur TEST-affärerna gått + tidigare beslut för de här paren
  const [pastPerf, memory] = await Promise.all([
    summarizePastPerformance(),
    memorySummary(params.symbols ?? []).catch(() => ""),
  ]);
  const performance = memory ? `${pastPerf}\n\n${memory}` : pastPerf;

  const systemPrompt = buildHeadTraderPrompt(config, state, performance, (await broker.getAccount()).totalValueUsdt);
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

  // Indikatorer för de valda paren (15m/1h/4h) i ett paket, så Hanna inte behöver
  // hämta dem ett anrop i taget. Bara när JEV valt få par (annars blir paketet för stort).
  let indicatorPack = "";
  const picked = params.symbols ?? [];
  if (picked.length > 0 && picked.length <= 5) {
    // Tidsramar efter Mikes horisont (1–30 min → korta ramar)
    const { shortIntervals } = await import("../server/tradeHorizon.js");
    const jobs = picked.flatMap((sym) => (params.timeframe ? [params.timeframe] : shortIntervals()).map((iv) => ({ sym, iv })));
    const rows = (await Promise.all(jobs.map(async ({ sym, iv }) => {
      try { return `${sym} ${iv}: ${JSON.stringify(computeIndicators(await broker.getKlines(sym, iv, 150)))}`; }
      catch { return null; } // Hanna kan hämta själv med get_indicators
    }))).filter((r): r is string => r !== null);
    if (rows.length) indicatorPack = `\n\n──── INDIKATORER (redan hämtade, anropa inte get_indicators för dessa igen; changePct24 = ändring över de senaste 24 ljusen i den tidsramen, inte 24 timmar) ────\n${rows.join("\n")}`;
  }

  indicatorPack += "\n\n──── TVÅ AGENTER ────\nJEV har gjort förkontrollen. Teknisk och Hanna är de enda agentrollerna. Riskgränser verifieras av deterministisk kod och ordergrinden; ingen separat Risk-, Advisor- eller Research-agent har körts. Null-rapporter är saknade analyser, aldrig HOLD-röster.";

  // Mikes tidshorisont (1/5/15/30 min): korta trades, TP/SL därefter
  {
    const { horizonPrompt } = await import("../server/tradeHorizon.js");
    indicatorPack += horizonPrompt();
  }

  const userMessage = params.userInstruction
    ? `${briefingContent}${indicatorPack}\n\n──── SPECIAL INSTRUKTION ────\n${params.userInstruction}`
    : `${briefingContent}${indicatorPack}`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const client = createLlmClient(apiKey);
  const MAX_ITERATIONS = 12;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Prompt caching: system prompt och tools är identiska varje iteration → cacha
    // Cache TTL = 5 min, perfekt för tool-use-loopen (alla iterationer inom sek).
    // Read: 90% billigare input. Write: +25% på första anropet. Net win efter 2+ iter.
    const response = await client.messages.create({
      model: headTraderModel(),
      max_tokens: 4096,
      system: [
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      tools: toolDefinitions(),
      messages,
    });
    trackClaudeCall("head", response.model || headTraderModel(), response.usage).catch(() => {});

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
          regime: reports.macro?.regime ?? "uncertain",
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
      const input = tu.input as Record<string, unknown>;
      agentNote("head", `verktyg: ${tu.name}`);
      const output = tu.name === "place_order"
        ? await track("broker", `${String(input.side ?? "")} ${String(input.symbol ?? "")}`.trim() || "lägger order",
            () => runTool(tu.name, input, toolCtx), {
              from: "head", coin: input.symbol ? String(input.symbol) : null,
              stopped: (o) => {
                const r = o as { error?: unknown; accepted?: boolean; reason?: unknown } | null;
                if (r?.error) return `stoppad: ${String(r.error).slice(0, 100)}`;
                if (r?.accepted === false) return `stoppad av riskkontrollen: ${String(r.reason ?? "").slice(0, 100)}`;
                return null;
              },
              done: (o) => ((o as { executed?: boolean } | null)?.executed === false ? "väntar på ditt OK" : "order skickad"),
            })
        : await runTool(tu.name, input, toolCtx);
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
      regime: reports.macro?.regime ?? "uncertain",
      actions: [],
      briefingSummary: "(Max iterationer nådda)",
      rawText: "",
    },
    toolCalls: recordedToolCalls,
    placedOrders: toolCtx.sideEffects.placedOrders,
    killSwitchToggled: toolCtx.sideEffects.killSwitchToggled,
  };
}

function buildHeadTraderPrompt(config: Config, state: AgentState, performance: string, equity: number): string {
  return `Du är HANNA, den andra agenten i Mikaels trading-system.
JEV har gjort förkontrollen och Teknisk analytiker har granskat valda par. Du väger underlaget och föreslår beslut.
Riskgränser, storlek, befintligt spotinnehav och godkännande kontrolleras av deterministisk kod. Inga andra AI-roller har körts.

═══ SYSTEMSTATUS ═══
Mode: ${config.mode.toUpperCase()} | Execution: ${config.executionMode}
Kill-switch: ${state.killSwitchActive ? "AKTIV" : "OK"}
Dagens PnL: ${state.dailyRealizedPnlUsdt.toFixed(2)} USDC
${stakeBlock(equity)}Position-sizing (USD per trade):
  • Vald procent av kontovärdet är standardstorleken, inte ett fast dollarbelopp.
  • Total exponering och dagliga spärrar verifieras av riskkontrollen.
  • Ändra aldrig användarens valda procent automatiskt.
  • Risk Manager blockerar orders utanför MIN/MAX — håll dig inom ramen.

═══ HISTORIK ═══
${performance}

═══ BESLUTSPROCESS ═══
1. Läs den tekniska analysen och de verifierade indikatorerna för det valda analysintervallet.
2. Bedöm endast de valda paren. Saknade analyser, tidsramar eller rapporter får aldrig behandlas som noll eller som röster.
3. Kontrollera konto och öppna spotinnehav med verktygen. Den deterministiska riskkontrollen har veto.
4. Välj HOLD med tydligt skäl om underlaget saknas eller en setup är osäker. Annars föreslå entry, mål och stop-loss.
5. Använd place_order för förslaget; risk- och godkännandegrindarna kontrollerar ordern.
   Vid KÖP ska take_profit och stop_loss finnas. Beräkna mål efter avgifter och använd den valda procenten av kontovärdet.
6. Om entry ännu inte är lämplig: förklara vad som behöver hända. Hitta inte på data för andra tidsramar eller att en framtida order har skickats.

═══ OUTPUT-FORMAT ═══
Avsluta alltid med en "Rule of 3"-sammanfattning:

[1] Regim: ...
[2] Action: ...
[3] Bevaka: ...

═══ ABSOLUTA REGLER ═══
- Du kan INTE kringgå risk managern.
- Den deterministiska riskkontrollen har veto. Inga extra agentanrop ska startas.
- Hellre HOLD än en osäker trade. Kapitalbevarande > avkastning.
- Mikael bestämmer insatserna (via config). Du bestämmer timing och exit.`;
}

function formatAllReports(reports: AllReports): string {
  const technical = reports.technical;
  let out = "═══ TVÅ AGENTER · VERIFIERAT UNDERLAG ═══\n";
  if (!technical) out += "Teknisk analys är otillgänglig. Behandla inga saknade värden som noll eller som HOLD.\n";
  else {
    out += `Teknisk analys: ${JSON.stringify({ analyses: technical.analyses, topPick: technical.topPick })}\n`;
  }
  out += "Makro, Sentiment, Kvant, Portfölj, Exekvering, Options, Research och Advisor har inte körts.\n";
  out += "Risk kontrolleras i kod före orderförslag: belopp, exponering, befintligt spotinnehav och godkännandegrind. Ingen Risk-LLM har körts.\n";
  out += "Hanna: bedöm bara valda par utifrån verkligt underlag och riskverktygen. Tydlig setup kan bli förslag; annars HOLD med skäl.\n";
  return out;
}
