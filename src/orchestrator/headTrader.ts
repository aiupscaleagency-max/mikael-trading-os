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
import { currentStake, stakeStartPct } from "../risk/stakeLadder.js";
import { tipsPromptBlock, parseHeadTips, markUnverified, validateRawTips, type AgentTip } from "./headTips.js";
import { runRole, finalizeHermesTips, HERMES_TIMEOUTS, type ChainCtx, type FinalizeCtx, type RoleStatus } from "./hermesTeam.js";
import { igAgentData, igEnvOf } from "../server/igAgentData.js";
import { DIRECT_ANALYSIS_MAX } from "../server/igSessions.js";

/** Insats-principen (Mike 2026-10-03), på IG: en andel av IG-saldot som marginal, 1 % → högst 3 %. */
function stakeBlock(): string {
  const s = currentStake();
  if (!s) return "";
  const cur = s.currency ?? "kontovaluta";
  return `PLATTFORM: IG (CFD). Symbolerna är IG-EPICs. KÖP = lång, SÄLJ utan position = KORT (blankning är tillåten).
INSATS: ${s.pct} % av IG-saldot som marginal = ca ${s.amount.toFixed(2)} ${cur} per trade. Servern räknar fram antal kontrakt
  från IG:s regler (minsta storlek, marginal, punktvärde). Ange ALLTID take_profit och stop_loss (för SÄLJ: målpris under, stop över priset).
  • Princip: börja på 1 %. Höjs till 2 → 3 % först när avslutade affärer i SAMMA miljö (${s.env === "live" ? "IG Live" : "IG Demo"}) visar vinst och träffsäkerhet. Förlustsvit → 1 %.
  • Nu: ${s.reason} (${s.closed} avslutade, träff ${Math.round(s.winRate * 100)} %, resultat ${s.totalPnl.toFixed(2)} ${cur}).
  • quote_qty i USD används inte på IG; låt den vara.
`;
}
export type { AllReports };

export interface HeadTraderResult {
  decision: HeadTraderDecision;
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  placedOrders: Array<{ request: OrderRequest; result: OrderResult }>;
  killSwitchToggled: boolean;
  /** IG: Hannas tips per analyserat instrument, rangordnade (även vid HOLD). Saknas för andra mäklare. */
  tips?: AgentTip[];
  /** Hermes-läget: Hannas rollstatus (lyckad/misslyckad/överhoppad/avbruten) */
  hermesHead?: RoleStatus;
}

/** Underlag till Hannas verktygsfria Hermes-gren (byggs av src/orchestrator/hermesTurn.ts). */
export interface HermesHannaInput {
  ctx: ChainCtx;
  /** Gemensam prefix: system → JEV → underlag */
  prefix: string;
  epics: string[];
  /** Claudes rader (Teknisk + Risk) som JSON */
  claudeJson: string;
  /** Advisorns granskning som JSON, eller null när den saknas */
  advisorJson: string | null;
  advisorNote: string;
  /** JEV-preflight uttryckligen till Hanna (§8.6) */
  preflightLine: string;
  stake: { maxStakePct: number; minStakePct: number; amount: number | null; currency: string | null; horizonMin: number };
  finalize: Omit<FinalizeCtx, "rawRows">;
}

// Hannas egen systemprompt i Hermes-läget (§8.1): bara analys, inga order, inga verktyg.
export const HANNA_HERMES_SYSTEM = `──── DIN ROLL: HANNA (HEAD TRADER, SLUTBESLUT) ────
Du lägger inga order. Svara med analys och TIPS_JSON.
Inga verktyg i denna körning; svara med text och TIPS_JSON. Positioner och konto finns i underlaget.
Väg ihop Claudes analys, Advisorns granskning och JEV. Den granskade rekommendationen (Claude efter Advisorns skärpning) är bindande: byt aldrig riktning, höj aldrig insatsen och vidga aldrig SL. Du får bara vara försiktigare; skriv i så fall skälet i "advisorOverride" (en mening). JEV-veto ⇒ AVVAKTA, alltid.
Format (undantag från "bara JSON"): högst tre korta rader "[1] Regim: … [2] Action: … [3] Bevaka: …", sedan raden ${"TIPS_JSON"}: följd av en JSON-array med EXAKT ett objekt per EPIC i underlaget, rangordnade bäst först:
[{"epic":"…","rank":1,"action":"KÖP|SÄLJ|AVVAKTA","why":"en mening","entry":0,"tp":0,"sl":0,"sizePct":1,"horizonMin":5,"confidence":"låg|medel|hög","advisorOverride":null}]
KÖP: sl < entry < tp. SÄLJ: tp < entry < sl. AVVAKTA: tp, sl och sizePct null. horizonMin 1, 5, 15 eller 30. Ett tips är aldrig en order.`;

/**
 * Hannas Hermes-gren (§8.1, §12 steg 3). Körs FÖRE verktygsloopen och skickar aldrig verktyg:
 * ingen toolDefinitions(), ingen runTool, inga orderutkast. Tipsen tolkas med headTips.ts.
 */
export async function runHeadTraderHermes(h: HermesHannaInput, reports: AllReports): Promise<HeadTraderResult> {
  const prompt = `${h.prefix}
──── CLAUDES ANALYS (Teknisk + Risk) ────
${h.claudeJson}

──── ADVISORNS GRANSKNING ────
${h.advisorJson ?? h.advisorNote}

──── JEV-PREFLIGHT ────
${h.preflightLine}

${HANNA_HERMES_SYSTEM}`;
  const run = await runRole<Array<Record<string, unknown>>>({
    role: "head", agent: "head", order: ["claude", "chatgpt"], prompt, timeoutMs: HERMES_TIMEOUTS.head,
    validate: (text) => { const v = validateRawTips(text, h.epics); return v.ok ? { ok: true, reason: null, value: v.rows } : { ok: false, reason: `ogiltig TIPS_JSON: ${v.reason}`, value: null }; },
    // Rollinstruktionen finns redan sist i prompten; systemfältet upprepar den inte
    paid: { modelRole: "head", directDefault: "claude-sonnet-4-6", system: "Följ rollinstruktionen sist i meddelandet.", user: prompt, maxTokens: 1500 },
  }, h.ctx);
  const empty: HeadTraderResult = {
    decision: { role: "head_trader", regime: reports.macro.regime, actions: [], briefingSummary: "", rawText: run.text ?? "" },
    toolCalls: [], placedOrders: [], killSwitchToggled: false, hermesHead: run.status,
  };
  if (run.status.status !== "lyckad" || !run.value || run.text === null) return empty;
  const parsed = parseHeadTips(run.text, h.epics, { maxStakePct: h.stake.maxStakePct, minStakePct: h.stake.minStakePct, stakeAmount: h.stake.amount, currency: h.stake.currency, defaultHorizonMin: h.stake.horizonMin });
  const tips = finalizeHermesTips(parsed.tips, { ...h.finalize, rawRows: run.value });
  return { ...empty, decision: { ...empty.decision, briefingSummary: parsed.cleanedText || "(inget sammandrag)", rawText: run.text }, tips };
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
  /** Hermes-läget (LLM_ROUTE=hermes): verktygsfri gren före verktygsloopen. Saknas = exakt som förut. */
  hermes?: HermesHannaInput;
}): Promise<HeadTraderResult> {
  if (params.hermes) return runHeadTraderHermes(params.hermes, params.reports);
  const { apiKey, config, state, broker, brokers, risk, engines, reports } = params;

  // Tradingminnet: hur TEST-affärerna gått + tidigare beslut för de här paren
  const [pastPerf, memory] = await Promise.all([
    summarizePastPerformance(),
    memorySummary(params.symbols ?? []).catch(() => ""),
  ]);
  const performance = memory ? `${pastPerf}\n\n${memory}` : pastPerf;

  const igEnv = igEnvOf(broker);
  // IG: krav på tips per instrument läggs till prompten (additivt; modell/provider oförändrade)
  const systemPrompt = buildHeadTraderPrompt(config, state, performance) + (igEnv ? tipsPromptBlock() : "");
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
  // IG: upp till direktanalysens 10 instrument (tidigare 5, så 7 valda fick inget paket). Källa per rad + IG-livepris.
  if (picked.length > 0 && picked.length <= (igEnv ? DIRECT_ANALYSIS_MAX : 5)) {
    // Tidsramar efter Mikes horisont (1–30 min → korta ramar)
    const { shortIntervals } = await import("../server/tradeHorizon.js");
    const jobs = picked.flatMap((sym) => shortIntervals().map((iv) => ({ sym, iv })));
    const rows = (await Promise.all(jobs.map(async ({ sym, iv }) => {
      try {
        if (igEnv) {
          const r = await igAgentData.klines(igEnv, sym, iv, 150, () => broker.getKlines(sym, iv, 150));
          const live = r.igLive ? ` · IG-livepris ${+r.igLive.price.toPrecision(8)} (${r.igLive.source}${r.igLive.ageSec !== null ? `, ${r.igLive.ageSec} s` : ""})` : " · IG-livepris saknas";
          if (!r.klines.length) return `${sym} ${iv}: inga ljus (${r.note ?? "okänt skäl"})${live}`;
          return `${sym} ${iv} [källa: ${r.source}${live}]: ${JSON.stringify(computeIndicators(r.klines))}`;
        }
        return `${sym} ${iv}: ${JSON.stringify(computeIndicators(await broker.getKlines(sym, iv, 150)))}`;
      }
      catch { return null; } // Hanna kan hämta själv med get_indicators
    }))).filter((r): r is string => r !== null);
    if (rows.length) indicatorPack = `\n\n──── INDIKATORER (redan hämtade, anropa inte get_indicators för dessa igen; changePct24 = ändring över de senaste 24 ljusen i den tidsramen, inte 24 timmar; "Tiingo (ej IG-pris)" = research-data, ordrar prissätts av IG) ────\n${rows.join("\n")}`;
  }

  // Smalt team: säg det rakt ut, så att stubb-rapporterna inte räknas som HOLD-röster
  if (process.env.TEAM_LEAN !== "false") {
    indicatorPack += "\n\n──── SMALT TEAM ────\nMakro, Sentiment, Kvant, Portfölj, Exekvering och Lars är avstängda: ignorera deras rapporter. Besluta på Teknisk + Risk (+ Advisor om den körts) + indikatorerna ovan. Konsensusregeln gäller bara dessa.";
  }

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

      // IG: Hannas tips per instrument (TIPS_JSON) tolkas och tas bort ur den läsbara sammanfattningen
      let tips: AgentTip[] | undefined;
      let summaryText = rawText;
      if (igEnv) {
        const stake = currentStake();
        const { getHorizonMin } = await import("../server/tradeHorizon.js");
        const parsed = parseHeadTips(rawText, params.symbols ?? [], { maxStakePct: stake?.pct ?? 1, minStakePct: stakeStartPct(), stakeAmount: stake?.amount ?? null, currency: stake?.currency ?? null, defaultHorizonMin: getHorizonMin() });
        tips = parsed.tips; summaryText = parsed.cleanedText || rawText;
        // Inget IG-livepris för instrumentet (bara Tiingo): nivåerna märks overifierade
        for (const t of tips) if (!igAgentData.igLive(igEnv, t.epic)) markUnverified(t);
        if (!parsed.found) log.warn("[Head Trader] TIPS_JSON saknades eller kunde inte läsas; alla instrument märks AVVAKTA utan tips");
      }

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
          briefingSummary: summaryText,
          rawText,
        },
        toolCalls: recordedToolCalls,
        placedOrders: toolCtx.sideEffects.placedOrders,
        killSwitchToggled: toolCtx.sideEffects.killSwitchToggled,
        ...(tips ? { tips } : {}),
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
Dagens PnL: ${state.dailyRealizedPnlUsdt.toFixed(2)} (IG-kontots valuta)
${stakeBlock()}Position-sizing (USD per trade):
  • DEFAULT: ${config.risk.defaultPositionUsd} (din standardstorlek)
  • MIN: ${config.risk.minPositionUsd} | MAX: ${config.risk.maxPositionUsd}
  • Total exponering: max ${config.risk.maxTotalExposureUsd} USD
  • Anpassa storlek mellan MIN och MAX baserat på conviction:
    - Hög conviction (≥3 specialister överens, Advisor stödjer) → upp mot MAX
    - Medium conviction → DEFAULT
    - Låg conviction → ner mot MIN
  • Karin's suggestedSizeMultiplier multiplicerar din valda storlek (vol-justerat).
  • Risk Manager blockerar orders utanför MIN/MAX — håll dig inom ramen.

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

4. ⏱ TIMING: Du HAR TILLSTÅND att vänta 1-5 minuter på optimal entry.
   Om Tomas rapport säger entryReady=false eller waitMinutes>0:
   - Skriv tydligt 'väntar X min på Y' i ditt svar
   - Sätt order när conditions uppfylls (eller säg till user att retry)
   Bättre att vänta 2 min och få optimal entry än att tvinga trade NU.

5. KRÄVS: Du MÅSTE använda Tomas multi-timeframe-data (1m/5m/15m/1h/4h/1d/1w/1M).
   Trade endast om majoritet av tidsramar är samma riktning som din side (BUY/SELL).
   Om 1m bullish men 1d bearish → skip (counter-trend = farligt).

6. Kolla portföljen (get_all_positions) om du inte redan sett den.
7. Lägg order via place_order om tydlig setup. Risk managern kontrollerar.
   Vid KÖP: sätt alltid take_profit (vinstmål) och stop_loss (förlustgräns), t.ex. teknikerns tp1 och stopLoss. Saknas de sätts +3 % / −1,5 % i TEST.

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

/** Reservtext när en specialist svarat med andra fält än schemat. */
function rawReport(name: string, report: { rawText?: string } | undefined): string {
  const raw = (report?.rawText ?? "").trim().slice(0, 2500);
  return `── ${name.toUpperCase()} (rådata, avvek från schemat) ──\n${raw || "(tom)"}\n\n`;
}

function formatAllReports(reports: AllReports): string {
  const { research, macro, technical, sentiment, risk, quant, options, execution, portfolio, advisor } = reports;

  let out = `═══ RAPPORTER FRÅN TEAMET ═══\n\n`;

  // 0. Research (Lars / Perplexity) — färsk webbkontext
  if (research?.available) {
    out += `── [0] LARS (RESEARCH-ANALYTIKER) ──\n`;
    out += `${research.marketSummary}\n`;
    if (research.cryptoNews.length) out += `Crypto-nyheter: ${research.cryptoNews.slice(0,3).join(" | ")}\n`;
    if (research.macroEvents.length) out += `Makro-händelser: ${research.macroEvents.slice(0,3).join(" | ")}\n`;
    if (research.geopolitical.length) out += `Geopolitik: ${research.geopolitical.slice(0,2).join(" | ")}\n`;
    if (research.riskAlerts.length) out += `⚠ Risk-alerts: ${research.riskAlerts.join(" | ")}\n`;
    out += `\n`;
  }

  {
    const mark = out.length;
    try {
      // 1. Makro
      out += `── [1/9] MAKRO-ANALYTIKER ──\n`;
      out += `Regim: ${macro.regime.toUpperCase()} (confidence: ${macro.confidence})\n`;
      out += `Nyckelfaktorer: ${macro.keyFactors.join(" | ")}\n`;
      out += `Olja: ${macro.oilSummary} | VIX: ${macro.vixLevel} | Dollar: ${macro.dollarTrend}\n`;
      out += `Crypto F&G: ${macro.cryptoFearGreed}\n`;
      out += `Rekommendation: ${macro.recommendation}\n\n`;
    } catch {
      // Rapporten följde inte schemat — ge Head rådatan i stället för att krascha turen
      out = out.slice(0, mark) + rawReport("macro", macro);
    }
  }

  {
    const mark = out.length;
    try {
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
    } catch {
      // Rapporten följde inte schemat — ge Head rådatan i stället för att krascha turen
      out = out.slice(0, mark) + rawReport("technical", technical);
    }
  }

  {
    const mark = out.length;
    try {
      // 3. Sentiment
      out += `── [3/9] SENTIMENT-ANALYTIKER ──\n`;
      out += `Stämning: ${sentiment.overallSentiment}\n`;
      out += `Narrativ: ${sentiment.topNarratives.join(" | ")}\n`;
      out += `Politiker: ${sentiment.politicianActivity}\n`;
      out += `Contrary signal: ${sentiment.contrarySignal ? "JA — möjlig reversal" : "Nej"}\n\n`;
    } catch {
      // Rapporten följde inte schemat — ge Head rådatan i stället för att krascha turen
      out = out.slice(0, mark) + rawReport("sentiment", sentiment);
    }
  }

  {
    const mark = out.length;
    try {
      // 4. Risk
      out += `── [4/9] RISK-ANALYTIKER ──\n`;
      out += `Risknivå: ${risk.riskLevel.toUpperCase()} | Portföljhetta: ${risk.portfolioHeatPct}%\n`;
      out += `Korrelation: ${risk.correlationRisk} — ${risk.correlationDetails}\n`;
      out += `Max drawdown: ${risk.maxDrawdownScenario.description} (${risk.maxDrawdownScenario.estimatedLossUsd} USD / ${risk.maxDrawdownScenario.estimatedLossPct}%)\n`;
      out += `Positionsstorlek: max ${risk.suggestedPositionSizing.maxNewPositionUsd} USD — ${risk.suggestedPositionSizing.reasoning}\n`;
      if (risk.warnings.length > 0) out += `VARNINGAR: ${risk.warnings.join(" | ")}\n`;
      out += `Rekommendation: ${risk.recommendation}\n\n`;
    } catch {
      // Rapporten följde inte schemat — ge Head rådatan i stället för att krascha turen
      out = out.slice(0, mark) + rawReport("risk", risk);
    }
  }

  {
    const mark = out.length;
    try {
      // 5. Kvant
      out += `── [5/9] KVANT-ANALYTIKER ──\n`;
      out += `Volatilitet: ${quant.volatilityRegime} | Sharpe: ${quant.sharpeEstimate} | Win rate: ${(quant.winRateFromHistory * 100).toFixed(0)}%\n`;
      for (const s of quant.symbolScores) {
        out += `  ${s.symbol}: trend=${s.trendScore} meanRev=${s.meanReversionScore} vol=${s.volatilityPct}% regime=${s.regime}\n`;
      }
      out += `Rekommendation: ${quant.recommendation}\n\n`;
    } catch {
      // Rapporten följde inte schemat — ge Head rådatan i stället för att krascha turen
      out = out.slice(0, mark) + rawReport("quant", quant);
    }
  }

  {
    const mark = out.length;
    try {
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
    } catch {
      // Rapporten följde inte schemat — ge Head rådatan i stället för att krascha turen
      out = out.slice(0, mark) + rawReport("options", options);
    }
  }

  {
    const mark = out.length;
    try {
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
    } catch {
      // Rapporten följde inte schemat — ge Head rådatan i stället för att krascha turen
      out = out.slice(0, mark) + rawReport("portfolio", portfolio);
    }
  }

  {
    const mark = out.length;
    try {
      // 8. Exekvering
      out += `── [8/9] EXEKVERINGS-OPTIMERARE ──\n`;
      out += `Urgency: ${execution.urgency}\n`;
      for (const t of execution.tradeOptimizations) {
        out += `  ${t.symbol}: ${t.orderType} ${t.timing} ${t.executionStyle} (splits=${t.dcaSplits}, slippage=${t.expectedSlippageBps}bps) — ${t.reasoning}\n`;
      }
      out += `Råd: ${execution.generalAdvice}\n\n`;
    } catch {
      // Rapporten följde inte schemat — ge Head rådatan i stället för att krascha turen
      out = out.slice(0, mark) + rawReport("execution", execution);
    }
  }

  {
    const mark = out.length;
    try {
      // 9. Advisor
      out += `── [9/9] CLAUDE ADVISOR ──\n`;
      out += `Outlook: ${advisor.strategicOutlook.toUpperCase()} | Marknadscykel: ${advisor.marketCyclePhase}\n`;
      out += `Insikter: ${advisor.keyInsights.join(" | ")}\n`;
      if (advisor.blindSpots.length > 0) out += `Blinda fläckar: ${advisor.blindSpots.join(" | ")}\n`;
      if (advisor.behavioralWarnings.length > 0) out += `Beteende-varningar: ${advisor.behavioralWarnings.join(" | ")}\n`;
      out += `Contrarian: ${advisor.contrarian}\n`;
      out += `Portföljråd: ${advisor.portfolioAdvice}\n\n`;
    } catch {
      // Rapporten följde inte schemat — ge Head rådatan i stället för att krascha turen
      out = out.slice(0, mark) + rawReport("advisor", advisor);
    }
  }

  out += `═══ DITT UPPDRAG ═══\n`;
  out += `Syntetisera ALLA 9 rapporter. Vikta risk + advisor högst. Lägg order om tydlig setup, annars HOLD.`;

  return out;
}
