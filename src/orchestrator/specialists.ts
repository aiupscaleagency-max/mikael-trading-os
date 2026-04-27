import Anthropic from "@anthropic-ai/sdk";
import { getMacroSnapshot } from "../data/macro.js";
import { searchNews, getRedditTop } from "../data/news.js";
import { getRecentPoliticianTrades, filterTopPerformers } from "../data/capitol.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { computeIndicators } from "../indicators/ta.js";
import type { StrategyEngine } from "../strategies/types.js";
import type { MacroReport, TechnicalReport, SentimentReport } from "./types.js";
import { log } from "../logger.js";
import { trackClaudeCall } from "../cost/tracker.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Specialist Agents — varje specialist kör sin analys parallellt.
//
//  Modellval:
//    Specialister → Haiku 4.5 (snabb, billig, fokuserad)
//    Head Trader  → Opus 4.6  (bäst reasoning för slutgiltigt beslut)
//
//  Varje specialist får begränsad data och en smal uppgift. Ingen av dem
//  får lägga order — bara analysera och rapportera.
// ═══════════════════════════════════════════════════════════════════════════

const SPECIALIST_MODEL = "claude-haiku-4-5-20251001";

// ── Makro-analytiker ──

export async function runMacroAnalyst(
  apiKey: string,
): Promise<MacroReport> {
  log.agent("[Team] Makro-analytiker startar…");

  // Samla rå data
  const [macro, oilNews, warNews, fedNews] = await Promise.all([
    getMacroSnapshot(),
    searchNews("oil prices OPEC energy", 8),
    searchNews("war conflict geopolitical escalation", 8),
    searchNews("Federal Reserve interest rates central bank", 8),
  ]);

  const dataContext = JSON.stringify({
    macro,
    oilNews: oilNews.map((n) => n.title),
    warNews: warNews.map((n) => n.title),
    fedNews: fedNews.map((n) => n.title),
  });

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 1500,
    system: `Du är en makro-analytiker i ett trading-team. Din ENDA uppgift är att bedöma det globala makroläget och klassificera regimen.

Du får rådata (makro-snapshot + nyhetsrubriker). Analysera och svara i EXAKT detta JSON-format:
{
  "regime": "risk_on" | "risk_off" | "neutral" | "uncertain",
  "keyFactors": ["faktor 1", "faktor 2", "faktor 3"],
  "oilSummary": "kort sammanfattning av oljemarknaden",
  "vixLevel": "kort: VIX-nivå och vad det innebär",
  "dollarTrend": "kort: dollarns riktning och implikation",
  "cryptoFearGreed": "kort: crypto sentiment",
  "recommendation": "1-2 meningar: vad teamet bör tänka på",
  "confidence": "low" | "medium" | "high"
}

Svara BARA med JSON. Ingen annan text.`,
    messages: [{ role: "user", content: `Här är dagens data:\n${dataContext}` }],
  });
  trackClaudeCall("macro", SPECIALIST_MODEL, response.usage).catch(() => {});

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const parsed = JSON.parse(text) as Omit<MacroReport, "role" | "rawText">;
    log.agent(`[Makro] Regim: ${parsed.regime}, Confidence: ${parsed.confidence}`);
    return { role: "macro_analyst", ...parsed, rawText: text };
  } catch {
    log.warn("[Makro] Kunde inte parsa JSON, returnerar fallback.");
    return {
      role: "macro_analyst",
      regime: "uncertain",
      keyFactors: ["Parsningsfel — manuell granskning krävs"],
      oilSummary: "Okänt",
      vixLevel: "Okänt",
      dollarTrend: "Okänt",
      cryptoFearGreed: "Okänt",
      recommendation: "Kunde inte analysera. Avvakta.",
      confidence: "low",
      rawText: text,
    };
  }
}

// ── Teknisk analytiker ──

export async function runTechnicalAnalyst(
  apiKey: string,
  broker: BrokerAdapter,
  symbols: string[],
  engines: StrategyEngine[],
): Promise<TechnicalReport> {
  log.agent("[Team] Teknisk analytiker startar…");

  // Samla indikator-data för alla symboler
  const analyses: Array<{
    symbol: string;
    indicators: ReturnType<typeof computeIndicators>;
    ticker: { price: number; changePct24h: number; volume24h: number };
  }> = [];

  for (const symbol of symbols.slice(0, 6)) {
    try {
      const [klines, ticker] = await Promise.all([
        broker.getKlines(symbol, "4h", 100),
        broker.getTicker(symbol),
      ]);
      const indicators = computeIndicators(klines);
      analyses.push({ symbol, indicators, ticker });
    } catch (err) {
      log.warn(`[Teknisk] Kunde inte hämta ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Kör motor-scans
  const motorSignals = [];
  for (const engine of engines) {
    try {
      const signals = await engine.scan();
      motorSignals.push(...signals);
    } catch {
      /* tolerera motor-fel */
    }
  }

  const dataContext = JSON.stringify({ analyses, motorSignals });

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 2000,
    system: `Du är en teknisk analytiker i ett trading-team. Din ENDA uppgift är att analysera pris, indikatorer och motor-signaler och bedöma varje symbols tekniska läge.

Du får indikator-data + motor-signaler. Analysera och svara i EXAKT detta JSON-format:
{
  "analyses": [
    {
      "symbol": "BTCUSDT",
      "bias": "bullish" | "bearish" | "neutral",
      "score": -5 till +5,
      "keySignals": ["SMA20 > SMA50", "RSI 55", ...],
      "entryZone": { "price": 65000, "stopLoss": 63000 },
      "targetZone": { "tp1": 67000, "tp2": 70000, "tp3": 75000 }
    }
  ],
  "topPick": "BTCUSDT" eller null
}

score: -5=stark säljsignal, 0=neutral, +5=stark köpsignal.
Inkludera entry/target BARA om score >= 3 eller <= -3.
Svara BARA med JSON.`,
    messages: [{ role: "user", content: dataContext }],
  });
  trackClaudeCall("technical", SPECIALIST_MODEL, response.usage).catch(() => {});

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const parsed = JSON.parse(text) as Omit<TechnicalReport, "role" | "rawText">;
    log.agent(`[Teknisk] Top pick: ${parsed.topPick ?? "ingen"}, ${parsed.analyses.length} symboler`);
    return { role: "technical_analyst", ...parsed, rawText: text };
  } catch {
    log.warn("[Teknisk] Parsningsfel.");
    return { role: "technical_analyst", analyses: [], topPick: null, rawText: text };
  }
}

// ── Sentiment-analytiker ──

export async function runSentimentAnalyst(
  apiKey: string,
): Promise<SentimentReport> {
  log.agent("[Team] Sentiment-analytiker startar…");

  const [reddit_crypto, reddit_world, reddit_stocks, politicianTrades] =
    await Promise.all([
      getRedditTop("cryptocurrency", 15),
      getRedditTop("worldnews", 15),
      getRedditTop("stockmarket", 10),
      getRecentPoliticianTrades(10).then(filterTopPerformers),
    ]);

  const dataContext = JSON.stringify({
    reddit: {
      cryptocurrency: reddit_crypto.map((r) => r.title),
      worldnews: reddit_world.map((r) => r.title),
      stockmarket: reddit_stocks.map((r) => r.title),
    },
    politicianTrades: politicianTrades.map((t) => ({
      who: t.politician,
      ticker: t.ticker,
      type: t.type,
      amount: t.amountRange,
      daysAgo: t.daysSinceTraded,
    })),
  });

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 1500,
    system: `Du är en sentiment-analytiker i ett trading-team. Din ENDA uppgift är att läsa av marknadens stämning från Reddit-posts och politiker-aktivitet.

Du får Reddit-rubriker + senaste politician-trades. Analysera och svara i EXAKT detta JSON-format:
{
  "overallSentiment": "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed",
  "topNarratives": ["berättelse 1", "berättelse 2", "berättelse 3"],
  "politicianActivity": "kort sammanfattning av vad politiker handlar",
  "contrarySignal": true/false
}

contrarySignal = true om sentimentet är extremt (extreme_fear ELLER extreme_greed), eftersom extrema nivåer historiskt signalerar reversal.
Svara BARA med JSON.`,
    messages: [{ role: "user", content: dataContext }],
  });
  trackClaudeCall("sentiment", SPECIALIST_MODEL, response.usage).catch(() => {});

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const parsed = JSON.parse(text) as Omit<SentimentReport, "role" | "rawText">;
    log.agent(`[Sentiment] ${parsed.overallSentiment}, contrary=${parsed.contrarySignal}`);
    return { role: "sentiment_analyst", ...parsed, rawText: text };
  } catch {
    log.warn("[Sentiment] Parsningsfel.");
    return {
      role: "sentiment_analyst",
      overallSentiment: "neutral",
      topNarratives: [],
      politicianActivity: "Kunde inte hämta",
      contrarySignal: false,
      rawText: text,
    };
  }
}
