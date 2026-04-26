import Anthropic from "@anthropic-ai/sdk";
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
    system: `Du är en risk-analytiker i ett trading-team. Din ENDA uppgift är att bedöma portföljens risknivå och föreslå hantering.

Du får positioner, kontobalans och riskgränser. Analysera och svara i EXAKT detta JSON-format:
{
  "portfolioHeat": 0-100,
  "correlationRisk": "low" | "medium" | "high",
  "correlatedPairs": ["BTC-ETH", "SOL-AVAX"],
  "maxDrawdownScenario": "beskrivning av värsta scenario med estimerad förlust",
  "suggestedPositionSize": 500,
  "overallRisk": "conservative" | "moderate" | "aggressive" | "dangerous",
  "warnings": ["varning 1", "varning 2"],
  "recommendation": "1-2 meningar: vad teamet bör göra",
  "confidence": "low" | "medium" | "high"
}

portfolioHeat = total exponering / totalt kapital * 100.
suggestedPositionSize = max USD för nästa position givet nuvarande risk.
Svara BARA med JSON. Ingen annan text.`,
    messages: [{ role: "user", content: `Här är riskdata:\n${dataContext}` }],
  });

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
    system: `Du är en kvantitativ analytiker i ett trading-team. Din ENDA uppgift är att analysera volatilitet, statistik och historisk prestation.

Du får indikator-data per symbol + historiska beslut. Analysera och svara i EXAKT detta JSON-format:
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
      "regime": "trending" | "ranging" | "breakout" | "breakdown"
    }
  ],
  "recommendation": "1-2 meningar: kvantitativa insikter för teamet",
  "confidence": "low" | "medium" | "high"
}

trendScore: +5 = stark trend (ride the wave), -5 = ingen trendkraft.
meanReversionScore: +5 = stark mean-reversion-setup (köp dippen), -5 = undvik mean-reversion.
volatility: annualiserad volatilitet i procent.
winRate: historisk vinstandel 0.0 - 1.0.
Svara BARA med JSON.`,
    messages: [{ role: "user", content: `Här är kvantdata:\n${dataContext}` }],
  });

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
    system: `Du är en portfölj-strateg i ett trading-team. Din ENDA uppgift är att bedöma portföljens diversifiering och föreslå ombalansering.

Du får positioner, kontobalans och exponering. Analysera och svara i EXAKT detta JSON-format:
{
  "diversificationScore": 0-100,
  "sectorConcentration": [
    {
      "sector": "crypto_major" | "crypto_alt" | "tech" | "finance" | "energy" | "health" | "commodities",
      "percentage": 0.0
    }
  ],
  "rebalancingNeeded": true/false,
  "suggestedChanges": [
    {
      "action": "increase" | "decrease" | "add" | "remove",
      "asset": "BTCUSDT",
      "reasoning": "kort motivering"
    }
  ],
  "assetAllocation": {
    "crypto": 60,
    "stocks": 20,
    "options": 5,
    "cash": 15
  },
  "recommendation": "1-2 meningar: portföljstrategi för teamet",
  "confidence": "low" | "medium" | "high"
}

diversificationScore: 0 = helt koncentrerad, 100 = väl diversifierad.
assetAllocation: procentuell fördelning, ska summera till ~100.
Svara BARA med JSON.`,
    messages: [{ role: "user", content: `Här är portföljdata:\n${dataContext}` }],
  });

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
