import Anthropic from "@anthropic-ai/sdk";
import { trackClaudeCall } from "../cost/tracker.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { computeIndicators } from "../indicators/ta.js";
import { loadRecentDecisions, summarizePastPerformance } from "../memory/store.js";
import type {
  RiskReport,
  QuantReport,
  OptionsReport,
  ExecutionReport,
  PortfolioReport,
} from "./types.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Advanced Specialist Agents — utökade analyser för risk, kvant,
//  optioner, exekvering och portföljstrategi.
//
//  Samma mönster som specialists.ts:
//    Varje specialist → Haiku 4.5 (snabb, billig, fokuserad)
//    Ingen av dem lägger order — bara analyserar och rapporterar.
// ═══════════════════════════════════════════════════════════════════════════

const SPECIALIST_MODEL = "claude-haiku-4-5-20251001";

// ── Risk-analytiker ──

export async function runRiskAnalyst(
  apiKey: string,
  broker: BrokerAdapter,
  config: {
    maxPositionUsd: number;
    maxTotalExposureUsd: number;
    maxDailyLossUsd: number;
    maxOpenPositions: number;
  },
): Promise<RiskReport> {
  log.agent("[Team] Risk-analytiker startar…");

  const [account, positions] = await Promise.all([
    broker.getAccount(),
    broker.getPositions(),
  ]);

  const totalExposure = positions.reduce(
    (sum, p) => sum + p.quantity * p.currentPrice,
    0,
  );
  const totalUnrealizedPnl = positions.reduce(
    (sum, p) => sum + p.unrealizedPnlUsdt,
    0,
  );

  const dataContext = JSON.stringify({
    accountBalance: account.totalValueUsdt,
    positions: positions.map((p) => ({
      symbol: p.symbol,
      baseAsset: p.baseAsset,
      quantity: p.quantity,
      avgEntry: p.avgEntryPrice,
      currentPrice: p.currentPrice,
      unrealizedPnl: p.unrealizedPnlUsdt,
      exposureUsd: p.quantity * p.currentPrice,
    })),
    totalExposure,
    totalUnrealizedPnl,
    riskLimits: config,
    positionCount: positions.length,
  });

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 1500,
    system: `Du är senior risk-analytiker på Bridgewater Associates, tränad i Ray Dalios principer om radikal transparens och rigorös risk-bedömning. Din uppgift: utvärdera nuvarande portfölj med samma rigor som Bridgewaters All Weather-team.

ANALYSERA:
1. Korrelations-analys mellan alla open positioner (är allt egentligen samma trade?)
2. Sektor/narrativ-koncentration (alla i AI-tokens? L1? memes?)
3. Geografisk exposure + valuta-risk (för forex)
4. Ränte-känslighet per position
5. Recession stress-test: simulerad drawdown om risk-off
6. Likviditets-rating per holding (kan du stänga snabbt utan slippage?)
7. Single-position-risk: någon för stor andel av portföljen?
8. Tail-risk-scenarier (svarta svanar) med sannolikhet
9. Hedging-strategier för top 3 risker
10. Rebalanserings-förslag med exakta procentsatser

Svara i EXAKT detta JSON-format:
{
  "portfolioHeat": 0-100,
  "correlationRisk": "low" | "medium" | "high",
  "correlatedPairs": [{"pair":"BTC-ETH","correlation":0.92,"comment":"effektivt 1 trade"}],
  "sectorConcentration": {"AI":40, "L1":30, "memes":20, "stables":10},
  "liquidityRating": [{"sym":"BTCUSDT","rating":"excellent"},{"sym":"DOGEUSDT","rating":"good"}],
  "stressTest": {"recession_minus10pct": -1500, "flash_crash_minus20pct": -3000, "comment":"vid ett 10% risk-off-event tappar portföljen ~$1500"},
  "tailRisks": [{"scenario":"Stablecoin depeg","probability":"low","impact":"-30%"}, {"scenario":"Flash crash på Binance","probability":"medium","impact":"-15%"}],
  "hedgingStrategies": ["Trim BTC -10% och köp gold-stablecoin","Open SHORT på DOGE som hedge mot meme-rally-omkastning"],
  "rebalancingActions": [{"action":"REDUCE","sym":"DOGEUSDT","fromPct":20,"toPct":10}, {"action":"ADD","sym":"BTCUSDT","fromPct":30,"toPct":40}],
  "maxDrawdownScenario": "beskrivning av värsta troliga scenario + förlust",
  "suggestedPositionSize": 500,
  "overallRisk": "conservative" | "moderate" | "aggressive" | "dangerous",
  "warnings": ["specifik varning 1", "..."],
  "vetoCandidates": ["lista trades teamet INTE bör ta nu"],
  "recommendation": "1-2 meningar: bottom-line för teamet",
  "confidence": "low" | "medium" | "high"
}

portfolioHeat = total exponering / totalt kapital * 100.
suggestedPositionSize = max USD för nästa position givet nuvarande risk.
Svara BARA med JSON.`,
    messages: [{ role: "user", content: `Här är riskdata:\n${dataContext}` }],
  });
  trackClaudeCall("risk", SPECIALIST_MODEL, response.usage).catch(() => {});

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const parsed = JSON.parse(text) as Omit<RiskReport, "role" | "rawText">;
    log.agent(`[Risk] Nivå: ${parsed.overallRisk}, Heat: ${parsed.portfolioHeat}%`);
    return { role: "risk_analyst", ...parsed, rawText: text };
  } catch {
    log.warn("[Risk] Kunde inte parsa JSON, returnerar fallback.");
    return {
      role: "risk_analyst",
      portfolioHeat: 0,
      correlationRisk: "medium",
      correlatedPairs: [],
      maxDrawdownScenario: "Parsningsfel — manuell granskning krävs",
      suggestedPositionSize: 0,
      overallRisk: "aggressive",
      warnings: ["Parsningsfel — avvakta"],
      recommendation: "Kunde inte analysera risk. Avvakta nya positioner.",
      confidence: "low",
      rawText: text,
    };
  }
}

// ── Kvant-analytiker ──

export async function runQuantAnalyst(
  apiKey: string,
  broker: BrokerAdapter,
  symbols: string[],
): Promise<QuantReport> {
  log.agent("[Team] Kvant-analytiker startar…");

  // Samla klines + historik
  const symbolData: Array<{
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
      symbolData.push({ symbol, indicators, ticker });
    } catch (err) {
      log.warn(`[Kvant] Kunde inte hämta ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const [pastPerformance, recentDecisions] = await Promise.all([
    summarizePastPerformance(),
    loadRecentDecisions(30),
  ]);

  const dataContext = JSON.stringify({
    symbolData,
    pastPerformance,
    recentDecisions: recentDecisions.map((d) => ({
      action: d.action,
      symbol: d.symbol,
      reasoning: d.reasoning.slice(0, 100),
      outcome: d.outcome
        ? { pnl: d.outcome.realizedPnlUsdt }
        : null,
    })),
  });

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 2000,
    system: `Du är en quant researcher på Renaissance Technologies — letar statistiska kanter i marknaden via data-driven mönster-detektion. Din uppgift: hitta hidden patterns och anomalier som ger oss matematisk fördel.

ANALYSERA:
1. Volatilitets-regim + suggestedSizeMultiplier (0.5-1.5x)
2. Sharpe-estimat baserat på historiska beslut + vinrate
3. Säsongs-patterns: är vissa månader/dagar historiskt bättre för denna symbol?
4. Day-of-week performance (mån-fre)
5. Korrelation med major events (Fed-möten, CPI-rapporter)
6. Trend-score vs mean-reversion-score per symbol
7. Statistical edge-summary: vad ger DENNA symbol en kvantifierbar fördel just nu?
8. Unusual on-chain/options activity (om data finns)
9. Pre-event vs post-event-mönster (FOMC, CPI)
10. Sektor-rotation-signaler som påverkar dessa symboler

Svara i EXAKT detta JSON-format:
{
  "volatilityRegime": "low" | "medium" | "high" | "extreme",
  "estimatedSharpe": 0.0,
  "winRate": 0.0,
  "symbolScores": [
    {
      "symbol": "BTCUSDT",
      "trendScore": -5 till +5,
      "meanReversionScore": -5 till +5,
      "volatility": 0.0,
      "regime": "trending" | "ranging" | "breakout" | "breakdown",
      "suggestedSizeMultiplier": 0.0,
      "seasonalEdge": "Bullish bias historiskt under Q1" eller "neutral",
      "dayOfWeekBias": "Måndagar starkast historiskt" eller "ingen tydlig",
      "statisticalEdge": "Vad ger denna symbol kvantifierbar edge just nu (1 mening)"
    }
  ],
  "macroEventCorrelation": "Fed-möte i 3 dagar — historiskt -0.4 korrelation 24h post",
  "patternAnomalies": ["Volym 3-sigma över snitt på BTC senaste 4h"],
  "sectorRotation": "Pengar flödar från memes till L1 senaste 7d",
  "recommendation": "1-2 meningar: kvantitativ bottom-line",
  "confidence": "low" | "medium" | "high"
}

trendScore: +5 = stark trend, -5 = ingen trendkraft.
meanReversionScore: +5 = stark mean-rev-setup, -5 = undvik mean-rev.
suggestedSizeMultiplier: 0.5-1.5. 1.0 standard. <1 vid hög vol, >1 vid låg vol + stark edge.
Svara BARA med JSON.`,
    messages: [{ role: "user", content: `Här är kvantdata:\n${dataContext}` }],
  });
  trackClaudeCall("quant", SPECIALIST_MODEL, response.usage).catch(() => {});

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const parsed = JSON.parse(text) as Omit<QuantReport, "role" | "rawText">;
    log.agent(`[Kvant] Regim: ${parsed.volatilityRegime}, Sharpe: ${parsed.estimatedSharpe}`);
    return { role: "quant_analyst", ...parsed, rawText: text };
  } catch {
    log.warn("[Kvant] Parsningsfel.");
    return {
      role: "quant_analyst",
      volatilityRegime: "medium",
      estimatedSharpe: 0,
      winRate: 0,
      symbolScores: [],
      recommendation: "Kunde inte analysera. Avvakta.",
      confidence: "low",
      rawText: text,
    };
  }
}

// ── Options-strateg ──

export async function runOptionsStrategist(
  apiKey: string,
  broker: BrokerAdapter,
  symbols: string[],
): Promise<OptionsReport> {
  log.agent("[Team] Options-strateg startar…");

  // Samla underliggande priser + ATR-baserad IV-estimering
  const symbolData: Array<{
    symbol: string;
    price: number;
    atr14Pct: number;
    changePct24h: number;
    volume24h: number;
  }> = [];

  for (const symbol of symbols.slice(0, 6)) {
    try {
      const [klines, ticker] = await Promise.all([
        broker.getKlines(symbol, "1d", 30),
        broker.getTicker(symbol),
      ]);
      const indicators = computeIndicators(klines);
      const atr14Pct = indicators.atr14 != null && ticker.price > 0
        ? (indicators.atr14 / ticker.price) * 100
        : 0;
      symbolData.push({
        symbol,
        price: ticker.price,
        atr14Pct,
        changePct24h: ticker.changePct24h,
        volume24h: ticker.volume24h,
      });
    } catch (err) {
      log.warn(`[Options] Kunde inte hämta ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const positions = await broker.getPositions();

  const dataContext = JSON.stringify({
    broker: broker.name,
    symbolData,
    currentPositions: positions.map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      avgEntry: p.avgEntryPrice,
      currentPrice: p.currentPrice,
      unrealizedPnl: p.unrealizedPnlUsdt,
    })),
  });

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 2000,
    system: `Du är en options-strateg i ett trading-team. Din ENDA uppgift är att bedöma implicit volatilitet och föreslå optionsstrategier.

OBS: Optionsstrategier är bara relevanta när brokern stödjer det (t.ex. Alpaca). ATR-baserad IV-estimering ges som proxy.

Du får underliggande priser, ATR-baserad IV-proxy, och positioner. Analysera och svara i EXAKT detta JSON-format:
{
  "ivRank": "low" | "normal" | "high" | "extreme",
  "optimalStrategy": "sell_premium" | "buy_directional" | "iron_condor" | "spread" | "straddle" | "none",
  "opportunities": [
    {
      "symbol": "AAPL",
      "strategy": "kort beskrivning av strategin",
      "strike": "155P / 170C",
      "expiry": "30-45 DTE",
      "reasoning": "kort motivering"
    }
  ],
  "rollOpportunities": ["beskrivning av roll-möjlighet"],
  "recommendation": "1-2 meningar: options-insikter för teamet",
  "confidence": "low" | "medium" | "high"
}

Sätt ivRank baserat på ATR-proxy: låg ATR → "low", hög ATR → "high".
Om brokern inte stödjer optioner, returnera tomma opportunities och "none" som optimalStrategy.
Svara BARA med JSON.`,
    messages: [{ role: "user", content: `Här är optionsdata:\n${dataContext}` }],
  });
  trackClaudeCall("options", SPECIALIST_MODEL, response.usage).catch(() => {});

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const parsed = JSON.parse(text) as Omit<OptionsReport, "role" | "rawText">;
    log.agent(`[Options] IV-rank: ${parsed.ivRank}, Strategi: ${parsed.optimalStrategy}`);
    return { role: "options_strategist", ...parsed, rawText: text };
  } catch {
    log.warn("[Options] Parsningsfel.");
    return {
      role: "options_strategist",
      ivRank: "normal",
      optimalStrategy: "none",
      opportunities: [],
      rollOpportunities: [],
      recommendation: "Kunde inte analysera optioner. Avvakta.",
      confidence: "low",
      rawText: text,
    };
  }
}

// ── Exekverings-optimerare ──

export async function runExecutionOptimizer(
  apiKey: string,
  proposedTrades: Array<{ symbol: string; bias: string; score: number }>,
): Promise<ExecutionReport> {
  log.agent("[Team] Exekverings-optimerare startar…");

  const dataContext = JSON.stringify({
    proposedTrades,
    timestamp: new Date().toISOString(),
  });

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 1500,
    system: `Du är en exekverings-optimerare i ett trading-team. Din ENDA uppgift är att bestämma HUR trades ska exekveras för att minimera slippage och maximera fill-kvalitet.

Du får föreslagna trades (symbol + bias + score). Optimera och svara i EXAKT detta JSON-format:
{
  "recommendations": [
    {
      "symbol": "BTCUSDT",
      "orderType": "market" | "limit" | "stop_limit",
      "timing": "immediate" | "wait_for_dip" | "scale_in" | "avoid",
      "entryMethod": "lump_sum" | "dca_2" | "dca_3" | "dca_5",
      "limitPrice": 65000 (valfritt, bara för limit/stop_limit),
      "expectedSlippage": 0.05,
      "reasoning": "kort motivering"
    }
  ],
  "marketConditions": "liquid" | "normal" | "thin" | "volatile",
  "overallAdvice": "1-2 meningar: generella exekveringsråd",
  "confidence": "low" | "medium" | "high"
}

expectedSlippage = förväntad slippage i procent.
entryMethod: dca_2/3/5 = dela upp i 2/3/5 delar, lump_sum = allt på en gång.
timing: "avoid" om score är för låg eller marknaden är ogynsam.
Svara BARA med JSON.`,
    messages: [{ role: "user", content: `Här är föreslagna trades:\n${dataContext}` }],
  });
  trackClaudeCall("execution", SPECIALIST_MODEL, response.usage).catch(() => {});

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const parsed = JSON.parse(text) as Omit<ExecutionReport, "role" | "rawText">;
    log.agent(`[Exekvering] ${parsed.recommendations.length} trades optimerade, marknad: ${parsed.marketConditions}`);
    return { role: "execution_optimizer", ...parsed, rawText: text };
  } catch {
    log.warn("[Exekvering] Parsningsfel.");
    return {
      role: "execution_optimizer",
      recommendations: [],
      marketConditions: "normal",
      overallAdvice: "Kunde inte optimera. Använd market orders med försiktighet.",
      confidence: "low",
      rawText: text,
    };
  }
}

// ── Portfölj-strateg ──

export async function runPortfolioStrategist(
  apiKey: string,
  broker: BrokerAdapter,
): Promise<PortfolioReport> {
  log.agent("[Team] Portfölj-strateg startar…");

  const [account, positions] = await Promise.all([
    broker.getAccount(),
    broker.getPositions(),
  ]);

  const totalExposure = positions.reduce(
    (sum, p) => sum + p.quantity * p.currentPrice,
    0,
  );
  const availableCapital = account.totalValueUsdt - totalExposure;

  const dataContext = JSON.stringify({
    accountBalance: account.totalValueUsdt,
    availableCapital,
    totalExposure,
    positions: positions.map((p) => ({
      symbol: p.symbol,
      baseAsset: p.baseAsset,
      quoteAsset: p.quoteAsset,
      quantity: p.quantity,
      avgEntry: p.avgEntryPrice,
      currentPrice: p.currentPrice,
      unrealizedPnl: p.unrealizedPnlUsdt,
      exposureUsd: p.quantity * p.currentPrice,
      weightPct: account.totalValueUsdt > 0
        ? ((p.quantity * p.currentPrice) / account.totalValueUsdt * 100)
        : 0,
    })),
    positionCount: positions.length,
  });

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 2000,
    system: `Du är senior portfolio-strateg på BlackRock som hanterar multi-asset portföljer för institutionella kunder. Din uppgift: bygga en optimerad allokering anpassad till crypto/forex-trading med tydlig core-vs-satellite-struktur.

ANALYSERA:
1. Diversifierings-score (0-100, baserat på korrelations-spridning)
2. Sektor/narrativ-konc (BTC/ETH majors, alts, memes, AI-tokens, L1s, stables)
3. Core vs satellite-positioner (BTC/ETH = core, högvol-alts = satellite)
4. Förväntad annual return-range baserat på historiska data
5. Förväntad max drawdown vid bear-market
6. Rebalansering: triggers + exakta %-justeringar
7. Cash-allokering (frigjord för nya scalp-trades)
8. DCA-schema om Mike vill köpa månadsvis (för core-positions)
9. Benchmark att mäta mot (BTC buy-and-hold, eller HOLD-10-index)
10. One-page investment policy: 1 mening Mike kan följa

Svara i EXAKT detta JSON-format:
{
  "diversificationScore": 0-100,
  "sectorConcentration": [
    {"sector": "majors_btc_eth" | "L1_alts" | "memes" | "AI_tokens" | "stables" | "forex" | "commodities", "percentage": 0.0}
  ],
  "coreVsSatellite": {
    "core": [{"asset":"BTCUSDT","weightPct":40,"role":"long-term anchor"}],
    "satellite": [{"asset":"SOLUSDT","weightPct":15,"role":"L1 momentum-play"}]
  },
  "expectedAnnualReturn": {"low": 15, "expected": 35, "high": 80, "comment": "spann baserat på historisk crypto-data"},
  "expectedMaxDrawdown": -45,
  "rebalancingNeeded": true,
  "rebalancingTriggers": ["om någon position > 25% av portföljen", "varje måndag morgon", "vid >5% drift från target"],
  "suggestedChanges": [
    {"action": "decrease" | "increase" | "add" | "remove", "asset": "DOGEUSDT", "fromPct": 25, "toPct": 10, "reasoning": "för stor enkel-position"}
  ],
  "dcaPlan": "Köp $500 BTC + $300 ETH var måndag" eller "ej relevant — tradar scalp",
  "benchmark": "60% BTC + 30% ETH + 10% cash som riktmärke",
  "investmentPolicyOneLine": "60% core (BTC/ETH) + 30% satellite (top L1s) + 10% cash, rebalansera om position > 25%",
  "recommendation": "1-2 meningar: portfölj-strategi just nu",
  "confidence": "low" | "medium" | "high"
}

Svara BARA med JSON.`,
    messages: [{ role: "user", content: `Här är portföljdata:\n${dataContext}` }],
  });
  trackClaudeCall("portfolio", SPECIALIST_MODEL, response.usage).catch(() => {});

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const parsed = JSON.parse(text) as Omit<PortfolioReport, "role" | "rawText">;
    log.agent(`[Portfölj] Diversifiering: ${parsed.diversificationScore}/100, Rebalansering: ${parsed.rebalancingNeeded}`);
    return { role: "portfolio_strategist", ...parsed, rawText: text };
  } catch {
    log.warn("[Portfölj] Parsningsfel.");
    return {
      role: "portfolio_strategist",
      diversificationScore: 0,
      sectorConcentration: [],
      rebalancingNeeded: false,
      suggestedChanges: [],
      assetAllocation: { crypto: 0, stocks: 0, options: 0, cash: 100 },
      recommendation: "Kunde inte analysera portfölj. Avvakta.",
      confidence: "low",
      rawText: text,
    };
  }
}
