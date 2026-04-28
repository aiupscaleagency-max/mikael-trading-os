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
    system: `Du är en senior partner på McKinsey Global Institute som rådger sovereign wealth funds om hur makro-trender påverkar marknader. Din uppgift: omsätta makroekonomiska faktorer till konkret crypto/forex trading-action.

ANALYSERA:
1. Räntemiljö (Fed funds rate, ECB, BoJ) — påverkan på risk-assets vs safe-havens
2. Inflations-trend (CPI, PCE, core) — vilka sektorer/krypto-narrativ gynnas vs straffas
3. GDP-prognos + corporate earnings-implikation
4. USD-styrka (DXY) — påverkan på BTC (typiskt invers) + alts
5. Anställning + consumer spending — risk-on/risk-off-driver
6. Fed-policy outlook 6-12 mån (rate cuts/hikes/pause)
7. Globala risk-faktorer: geopolitik, handelskrig, supply chains, sanctions
8. Sektor-rotation-rekommendation baserat på cykel-fas (early/mid/late expansion vs early/late recession)
9. Specifika justerings-actions teamet bör ta NU
10. Tidsfönster: när påverkar dessa faktorer marknaden (timmar / dagar / veckor)

Svara i EXAKT detta JSON-format:
{
  "regime": "risk_on" | "risk_off" | "neutral" | "uncertain",
  "cyclePhase": "early_expansion" | "mid_expansion" | "late_expansion" | "early_recession" | "late_recession",
  "keyFactors": ["faktor 1", "faktor 2", "faktor 3"],
  "rateEnvironment": "räntemiljön + 1 mening om implikation",
  "inflationOutlook": "trend + vilka sektorer gynnas",
  "vixLevel": "VIX + vad det signalerar",
  "dollarTrend": "DXY-riktning + crypto-implikation",
  "fedOutlook": "Fed nästa 6-12 mån",
  "globalRisks": ["geopolitisk faktor 1", "..."],
  "cryptoFearGreed": "F&G-värde + tolkning",
  "sectorRotation": "från X till Y (eller stay-defensiv etc)",
  "actionItems": ["konkret action 1 teamet bör ta", "..."],
  "timelineImpact": "när får dessa faktorer effekt (timmar/dagar/veckor)",
  "recommendation": "1-2 meningar: bottom-line för teamet",
  "confidence": "low" | "medium" | "high"
}

Svara BARA med JSON.`,
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
    system: `Du är en senior kvantitativ trader i samma stil som Citadel: kombinerar teknisk analys med statistiska modeller för att tajma in/ut.
Din uppgift: leverera en fullständig teknisk analys för varje symbol — inte bara siffror, utan tolkning + actionable plan.

ANALYSERA FÖR VARJE SYMBOL:
1. Trendriktning på flera tidsramar (1m / 5m / 15m / 1h / 4h)
2. Exakta support/resistance-nivåer (priser, inte luddiga zoner)
3. 50/100/200-MA + crossover-signaler
4. RSI + MACD + Bollinger Band — med tolkning på vanlig svenska
5. Volym-trend: signalerar köp- eller säljpressure?
6. Chart-patterns: head & shoulders, cup & handle, flag, triangle, wedge
7. Fibonacci-retracement för bounce-zoner
8. Ideal entry, stop-loss, target (R:R-ratio måste vara >= 1.5)
9. Confidence rating: strong_buy | buy | neutral | sell | strong_sell

OBS: vi handlar crypto (1-5 min scalping fokus). Anpassa: kort-tidsram-prio, tighter stops, snabbare TP.

Svara i EXAKT detta JSON-format:
{
  "analyses": [
    {
      "symbol": "BTCUSDT",
      "bias": "bullish" | "bearish" | "neutral",
      "score": -5 till +5,
      "trendByTimeframe": {"1m":"up","5m":"up","15m":"sideways","1h":"up","4h":"up"},
      "keySignals": ["RSI 58 (bullish, ej overbought)","MACD bullish cross 5m","Volym 2x snitt — buyer-pressure"],
      "supportLevels": [67200, 66800],
      "resistanceLevels": [68500, 69200],
      "maAnalysis": "50-MA > 200-MA (Golden Cross intakt), pris över alla MAs",
      "chartPattern": "Bull-flag breakout pågår" eller null,
      "fibLevels": {"382":67400,"618":66900} eller null,
      "entryZone": { "price": 67500, "stopLoss": 67000 },
      "targetZone": { "tp1": 68200, "tp2": 68800, "tp3": 69500 },
      "rrRatio": 2.4,
      "confidenceRating": "buy" | "strong_buy" | etc
    }
  ],
  "topPick": "BTCUSDT" eller null,
  "marketWideObservation": "1 mening om hela krypto-marknaden just nu"
}

score: -5=stark säljsignal, 0=neutral, +5=stark köpsignal.
Inkludera entry/target/rrRatio BARA om |score| >= 3.
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
