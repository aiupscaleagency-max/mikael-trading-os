// ═══════════════════════════════════════════════════════════════════════════
//  Orchestrator Types — teamets gemensamma språk
//
//  9 specialister + 1 Head Trader. Varje specialist producerar en Report.
//  Head Trader läser alla rapporter och fattar det slutgiltiga beslutet.
// ═══════════════════════════════════════════════════════════════════════════

export type AgentRole =
  | "macro_analyst"
  | "technical_analyst"
  | "sentiment_analyst"
  | "risk_analyst"
  | "quant_analyst"
  | "options_strategist"
  | "execution_optimizer"
  | "portfolio_strategist"
  | "claude_advisor"
  | "head_trader";

export type MarketRegime = "risk_on" | "risk_off" | "neutral" | "uncertain";

export interface MacroReport {
  role: "macro_analyst";
  regime: MarketRegime;
  keyFactors: string[];
  oilSummary: string;
  vixLevel: string;
  dollarTrend: string;
  cryptoFearGreed: string;
  recommendation: string;
  confidence: "low" | "medium" | "high";
  rawText: string;
}

export interface TechnicalReport {
  role: "technical_analyst";
  analyses: Array<{
    symbol: string;
    bias: "bullish" | "bearish" | "neutral";
    score: number;
    keySignals: string[];
    entryZone?: { price: number; stopLoss: number };
    targetZone?: { tp1: number; tp2: number; tp3: number };
  }>;
  topPick: string | null;
  rawText: string;
}

export interface SentimentReport {
  role: "sentiment_analyst";
  overallSentiment: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
  topNarratives: string[];
  politicianActivity: string;
  contrarySignal: boolean;
  rawText: string;
}

export interface RiskReport {
  role: "risk_analyst";
  portfolioHeatPct: number;
  correlationRisk: "low" | "medium" | "high";
  correlationDetails: string;
  maxDrawdownScenario: {
    description: string;
    estimatedLossUsd: number;
    estimatedLossPct: number;
  };
  suggestedPositionSizing: {
    maxNewPositionUsd: number;
    reasoning: string;
  };
  riskLevel: "low" | "medium" | "high" | "critical";
  warnings: string[];
  recommendation: string;
  rawText: string;
}

export interface QuantReport {
  role: "quant_analyst";
  volatilityRegime: "low" | "medium" | "high" | "extreme";
  sharpeEstimate: number;
  winRateFromHistory: number;
  symbolScores: Array<{
    symbol: string;
    trendScore: number;
    meanReversionScore: number;
    volatilityPct: number;
    regime: "trending" | "ranging" | "breakout" | "choppy";
  }>;
  recommendation: string;
  confidence: "low" | "medium" | "high";
  rawText: string;
}

export interface OptionsReport {
  role: "options_strategist";
  ivAssessments: Array<{
    symbol: string;
    ivRank: "high" | "low" | "normal";
    atrPct: number;
    optimalStrategy: "sell_premium" | "buy_directional" | "iron_condor" | "spread" | "none";
    strategyDetails: string;
    suggestedStrikes: { put: number; call: number } | null;
  }>;
  rollOpportunities: string[];
  overallIvEnvironment: "high" | "low" | "normal";
  recommendation: string;
  applicable: boolean;
  rawText: string;
}

export interface ExecutionReport {
  role: "execution_optimizer";
  tradeOptimizations: Array<{
    symbol: string;
    orderType: "market" | "limit";
    timing: "now" | "wait_for_dip" | "wait_for_breakout" | "next_session";
    executionStyle: "dca" | "lump_sum" | "scale_in";
    dcaSplits: number;
    expectedSlippageBps: number;
    limitPriceOffset: number;
    reasoning: string;
  }>;
  generalAdvice: string;
  urgency: "low" | "medium" | "high";
  rawText: string;
}

export interface PortfolioReport {
  role: "portfolio_strategist";
  diversificationScore: number;
  sectorConcentration: Array<{
    sector: string;
    weightPct: number;
    risk: "low" | "medium" | "high";
  }>;
  rebalancingNeeded: boolean;
  rebalancingActions: Array<{
    action: "reduce" | "increase" | "close" | "open";
    symbol: string;
    currentWeightPct: number;
    targetWeightPct: number;
    reasoning: string;
  }>;
  cashAllocationPct: number;
  recommendation: string;
  confidence: "low" | "medium" | "high";
  rawText: string;
}

export interface AdvisorReport {
  role: "claude_advisor";
  strategicOutlook: "strongly_bullish" | "bullish" | "neutral" | "bearish" | "strongly_bearish";
  marketCyclePhase: "accumulation" | "markup" | "distribution" | "markdown";
  keyInsights: string[];
  blindSpots: string[];
  behavioralWarnings: string[];
  contrarian: string;
  portfolioAdvice: string;
  confidence: "low" | "medium" | "high";
  rawText: string;
}

export type SpecialistReport =
  | MacroReport
  | TechnicalReport
  | SentimentReport
  | RiskReport
  | QuantReport
  | OptionsReport
  | ExecutionReport
  | PortfolioReport
  | AdvisorReport;

export interface HeadTraderDecision {
  role: "head_trader";
  regime: MarketRegime;
  actions: Array<{
    engine: string;
    action: "buy" | "sell" | "hold" | "sell_put" | "sell_call";
    symbol: string;
    sizeUsd: number;
    reasoning: string;
    confidence: "low" | "medium" | "high";
  }>;
  briefingSummary: string;
  rawText: string;
}
