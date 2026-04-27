import Anthropic from "@anthropic-ai/sdk";
import type { AdvisorReport } from "./types.js";
import { log } from "../logger.js";
import { trackClaudeCall } from "../cost/tracker.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Claude Advisor — strategisk rådgivare som kör parallellt med specialisterna.
//
//  Modellval:
//    Specialister → Haiku 4.5 (snabb, billig, fokuserad)
//    Advisor      → Opus 4.6  (strategiskt djup, samma nivå som Head Trader)
//    Head Trader  → Opus 4.6  (bäst reasoning för slutgiltigt beslut)
//
//  Advisor är en "second brain" som ser helheten. Istället för att
//  analysera enskilda trades fokuserar den på:
//    - Marknadscykler och historiska analogier
//    - Beteendefinans-fällor (bias-detektion)
//    - Contrarian-perspektiv och svansrisker
//    - Portfölj-nivå-effekter
// ═══════════════════════════════════════════════════════════════════════════

const ADVISOR_MODEL = "claude-opus-4-7";

export async function runClaudeAdvisor(
  apiKey: string,
  context: {
    currentPositions: Array<{
      symbol: string;
      quantity: number;
      avgEntryPrice: number;
      currentPrice: number;
    }>;
    recentDecisions: Array<{
      action: string;
      symbol?: string;
      reasoning: string;
      timestamp: number;
    }>;
    dailyPnl: number;
    accountValue: number;
    activeEngines: string[];
  },
): Promise<AdvisorReport> {
  log.agent("[Team] Claude Advisor startar…");

  const dataContext = JSON.stringify({
    positions: context.currentPositions.map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      avgEntry: p.avgEntryPrice,
      current: p.currentPrice,
      pnlPct: ((p.currentPrice - p.avgEntryPrice) / p.avgEntryPrice * 100).toFixed(2) + "%",
    })),
    recentDecisions: context.recentDecisions,
    dailyPnl: context.dailyPnl,
    accountValue: context.accountValue,
    activeEngines: context.activeEngines,
    positionCount: context.currentPositions.length,
    totalExposure: context.currentPositions.reduce(
      (sum, p) => sum + p.quantity * p.currentPrice,
      0,
    ),
  });

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: ADVISOR_MODEL,
    max_tokens: 2500,
    system: `Du är en strategisk rådgivare ("Claude Advisor") i ett AI-trading-team. Du är INTE en specialist — du är en erfaren generalist som ser helheten.

Ditt syfte:
1. TÄNK PÅ HELHETEN — inte enskilda trades. Hur ser portföljen ut som helhet? Är exponeringen balanserad?
2. LETA EFTER MÖNSTER som teamet kan missa — recency bias (övervärderar senaste data), confirmation bias (söker bekräftelse), overtrading (handlar för mycket), disposition effect (håller förlorare för länge, säljer vinnare för tidigt).
3. TÄNK PÅ VAD SOM KAN GÅ FEL — svansrisker, svarta svanar, korrelerade positioner som alla faller samtidigt, likviditetsrisker.
4. GE ETT CONTRARIAN-PERSPEKTIV — om teamet är bullish, argumentera för bear-caset. Om teamet är bearish, argumentera för bull-caset. Inte för att vara jobbig, utan för att stresstesta tesen.
5. BEDÖM RISKNIVÅN — tar teamet för mycket eller för lite risk givet marknadsläget? Är position-sizing vettig?
6. PORTFÖLJEFFEKTER — korrelation mellan positioner, sektorkoncentration, valutaexponering, tidsdiversifiering.

Analysera kontexten och svara i EXAKT detta JSON-format:
{
  "strategicOutlook": "strongly_bullish" | "bullish" | "neutral" | "bearish" | "strongly_bearish",
  "marketCyclePhase": "accumulation" | "markup" | "distribution" | "markdown",
  "keyInsights": ["insikt 1", "insikt 2", "insikt 3"],
  "blindSpots": ["sak teamet kan missa 1", "sak 2"],
  "behavioralWarnings": ["bias-varning 1", "bias-varning 2"],
  "contrarian": "djävulens advokat-argument i 2-3 meningar",
  "portfolioAdvice": "1-2 meningar om portföljens helhetsbild och vad som bör justeras",
  "confidence": "low" | "medium" | "high"
}

Viktiga riktlinjer:
- keyInsights: max 5 punkter, fokusera på saker som INTE är uppenbara
- blindSpots: saker specialisterna troligen INTE tänkt på (makro-korrelationer, event-risk, likviditet)
- behavioralWarnings: specifika kognitiva fällor baserat på teamets senaste beslut
- contrarian: ALLTID motsäg den rådande uppfattningen — det är ditt jobb
- Skriv allt på svenska
- Svara BARA med JSON. Ingen annan text.`,
    messages: [{ role: "user", content: `Här är teamets nuvarande läge:\n${dataContext}` }],
  });
  trackClaudeCall("advisor", ADVISOR_MODEL, response.usage).catch(() => {});

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const parsed = JSON.parse(text) as Omit<AdvisorReport, "role" | "rawText">;
    log.agent(`[Advisor] Outlook: ${parsed.strategicOutlook}, Cykel: ${parsed.marketCyclePhase}, Confidence: ${parsed.confidence}`);
    return { role: "claude_advisor", ...parsed, rawText: text };
  } catch {
    log.warn("[Advisor] Kunde inte parsa JSON, returnerar fallback.");
    return {
      role: "claude_advisor",
      strategicOutlook: "neutral",
      marketCyclePhase: "accumulation",
      keyInsights: ["Parsningsfel — manuell granskning krävs"],
      blindSpots: ["Kunde inte analysera — alla blinda fläckar är aktiva"],
      behavioralWarnings: ["Avsaknad av advisor-analys kan leda till overconfidence"],
      contrarian: "Utan strategisk rådgivning bör teamet vara extra försiktigt och minska positionsstorlekar.",
      portfolioAdvice: "Avvakta tills advisor-analysen fungerar. Gör inga stora förändringar.",
      confidence: "low",
      rawText: text,
    };
  }
}
