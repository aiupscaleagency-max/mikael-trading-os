import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
//  Demo server — kör dashboarden med simulerad marknadsdata.
//  Inga API-nycklar behövs. Perfekt för att se UI:t i aktion.
//
//  Kör: npx tsx src/scripts/demo.ts
// ═══════════════════════════════════════════════════════════════════════════

const PORT = 3939;

// ── Simulerad marknadsdata ──

function generateCandles(basePrice: number, count: number, volatility: number): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  const now = Date.now();
  const interval = 3600000; // 1h

  for (let i = count; i > 0; i--) {
    const change = (Math.random() - 0.48) * volatility; // Slight upward bias
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * volatility * 0.5;
    const low = Math.min(open, close) - Math.random() * volatility * 0.5;
    const volume = 500 + Math.random() * 2000;
    candles.push({
      openTime: now - i * interval,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: Number(volume.toFixed(0)),
      closeTime: now - i * interval + interval,
    });
    price = close;
  }
  return candles;
}

interface Candle { openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime: number }

const MARKETS: Record<string, { base: number; vol: number }> = {
  BTCUSDT: { base: 67500, vol: 800 },
  ETHUSDT: { base: 3420, vol: 45 },
  SOLUSDT: { base: 178, vol: 4 },
  TSLA:    { base: 248, vol: 6 },
  NVDA:    { base: 875, vol: 15 },
  AAPL:    { base: 195, vol: 3 },
};

// Pregenerera data
const CANDLE_DATA: Record<string, Candle[]> = {};
for (const [sym, cfg] of Object.entries(MARKETS)) {
  CANDLE_DATA[sym] = generateCandles(cfg.base, 300, cfg.vol);
}

// Simulerade positioner
const POSITIONS = [
  { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", quantity: 0.0234, avgEntryPrice: 65200, currentPrice: 67832, unrealizedPnlUsdt: 61.58, openedAt: Date.now() - 86400000 * 3 },
  { symbol: "ETHUSDT", baseAsset: "ETH", quoteAsset: "USDT", quantity: 1.5, avgEntryPrice: 3380, currentPrice: 3425, unrealizedPnlUsdt: 67.50, openedAt: Date.now() - 86400000 },
];

// Simulerade beslut
const DECISIONS = [
  { id: "d1", timestamp: Date.now() - 900000, mode: "paper", action: "buy", symbol: "BTCUSDT", reasoning: "📊 [1] Regim: RISK-ON — VIX på 14.2, olja stabil, S&P rallying.\n📈 [2] BTC momentum-entry: SMA20 > SMA50 på 4H, RSI 58, MACD histogram positivt och stigande. Volym 140% av snitt. Score 5/6.\n⚡ [3] Entry $67,200 med trailing stop 2%. TP-stege: $70,560 → $73,920 → $80,640.", toolCalls: [] },
  { id: "d2", timestamp: Date.now() - 600000, mode: "paper", action: "buy", symbol: "ETHUSDT", reasoning: "📊 [1] Regim: RISK-ON — krypto Fear & Greed på 62 (greed men inte extreme).\n📈 [2] ETH följer BTC-uppgång. SMA20 korsade SMA50 för 3 candles sedan. RSI 52 — sund zon. MACD histogram positivt.\n⚡ [3] Entry $3,380. SL: $3,310 (-2.1%). Bevaka BTC-korrelation.", toolCalls: [] },
  { id: "d3", timestamp: Date.now() - 300000, mode: "paper", action: "hold", symbol: undefined, reasoning: "📊 [1] Regim: RISK-ON — oförändrad sedan senaste turn. VIX stabilt låg.\n📈 [2] HOLD — BTC och ETH i linje med plan. SOL neutral (score 2/6, otillräckligt). NVDA saknar aktuell data (marknad stängd).\n⚡ [3] Nästa check: bevaka om BTC bryter $68,500-resistans. Om ja → överväg öka position.", toolCalls: [] },
];

// Simulerade team-rapporter
const TEAM = {
  macro: { regime: "RISK_ON", confidence: "high", keyFactors: ["VIX 14.2 — låg stress", "Olja stabil $72", "S&P 500 ATH", "Fed pausar räntehöjningar"], oilSummary: "WTI $72.30 (+0.4%), stabil efter OPEC-möte", vixLevel: "14.2 — extremt låg, risk-on", dollarTrend: "DXY 104.1, sidledes", cryptoFearGreed: "62 — Greed (inte extreme)", recommendation: "Risk-on regim. Gynnsamt för momentum-trades." },
  technical: { analyses: [{ symbol: "BTCUSDT", bias: "bullish", score: 5, keySignals: ["SMA20 > SMA50","RSI 58","MACD+","Volym 140%"] }, { symbol: "ETHUSDT", bias: "bullish", score: 4, keySignals: ["SMA-korsning","RSI 52","MACD+"] }, { symbol: "SOLUSDT", bias: "neutral", score: 2, keySignals: ["Sidledes","RSI 48"] }], topPick: "BTCUSDT" },
  sentiment: { overallSentiment: "greed", topNarratives: ["Bitcoin ETF inflöden fortsätter", "Krypto-reglering i fokus", "Trump pro-crypto uttalanden"], politicianActivity: "Pelosi köpte NVDA $500k+, McCaul köpte MSFT", contrarySignal: false },
  risk: { riskLevel: "medium", portfolioHeatPct: 34, correlationRisk: "medium", correlationDetails: "BTC-ETH korrelation 0.87 — hög. Crypto-exposure dominerar.", maxDrawdownScenario: { description: "Krypto-krasch -20% från nuvarande nivåer", estimatedLossUsd: 412, estimatedLossPct: 3.2 }, suggestedPositionSizing: { maxNewPositionUsd: 85, reasoning: "Portföljen har utrymme men crypto-koncentrationen begränsar" }, warnings: ["Hög BTC-ETH korrelation — effektivt en position"], recommendation: "Diversifiera bort från crypto. Överväg aktie-positioner." },
  quant: { volatilityRegime: "medium", sharpeEstimate: 1.8, winRateFromHistory: 0.67, symbolScores: [{ symbol: "BTCUSDT", trendScore: 4, meanReversionScore: -1, volatilityPct: 3.2, regime: "trending" }, { symbol: "ETHUSDT", trendScore: 3, meanReversionScore: 0, volatilityPct: 4.1, regime: "trending" }, { symbol: "SOLUSDT", trendScore: 1, meanReversionScore: 2, volatilityPct: 5.8, regime: "ranging" }], recommendation: "BTC och ETH i trendregim — momentum-strategi optimal. SOL ranging, undvik.", confidence: "high" },
  options: { applicable: false, ivAssessments: [], rollOpportunities: [], overallIvEnvironment: "normal", recommendation: "Brokern stödjer inte optioner i demo." },
  portfolio: { diversificationScore: 28, sectorConcentration: [{ sector: "crypto_major", weightPct: 72, risk: "high" }, { sector: "stocks_tech", weightPct: 18, risk: "medium" }, { sector: "cash", weightPct: 10, risk: "low" }], rebalancingNeeded: true, rebalancingActions: [{ action: "reduce", symbol: "BTCUSDT", currentWeightPct: 45, targetWeightPct: 30, reasoning: "Överexponerad mot BTC" }, { action: "increase", symbol: "NVDA", currentWeightPct: 8, targetWeightPct: 15, reasoning: "Tech-aktier underrepresenterade" }], cashAllocationPct: 25, recommendation: "Portföljen är kraftigt crypto-tung. Minska BTC-exponering och öka aktier.", confidence: "high" },
  execution: { tradeOptimizations: [{ symbol: "BTCUSDT", orderType: "limit", timing: "wait_for_dip", executionStyle: "dca", dcaSplits: 3, expectedSlippageBps: 5, limitPriceOffset: -0.3, reasoning: "BTC nära resistans $68,500 — vänta på pullback till SMA20" }], generalAdvice: "Marknaden är likvid. Limit-orders föredragna för bättre fills.", urgency: "medium" },
  advisor: { strategicOutlook: "bullish", marketCyclePhase: "markup", keyInsights: ["Vi är i en markup-fas — trender tenderar att fortsätta längre än förväntat", "Crypto Fear & Greed på 62 är upphöjt men INTE extremt — ingen contrary signal ännu", "Pelosis NVDA-köp är en stark signal — hon har historiskt timing rätt"], blindSpots: ["Teamet underskattar geopolitisk risk — Mellanöstern-eskalering kan trigga flash-crash", "Dollarns sidledsriktning maskerar potentiell EUR-svaghet som påverkar crypto"], behavioralWarnings: ["Disposition effect-risk: Vi håller vinnare (BTC/ETH) men har inte definierat exit-kriterier", "Recency bias: De senaste 3 analyserna har alla varit bullish — ifrågasätt om det är genuin signal eller groupthink"], contrarian: "Om alla indikatorer pekar uppåt bör man fråga: vem säljer? Volymen sjunker trots prisuppgång — det klassiska tecknet på en rally som tappar kraft.", portfolioAdvice: "Portföljen är för krypto-tung (72%). En 20% BTC-korrigering skulle radera all vinst. Flytta 15% till defensiva aktier eller cash.", confidence: "high" },
  timing: { specialists: 4200, execution: 1100, headTrader: 8300, total: 13600 }
};

// ── SMA/EMA för indikator-data ──
function calcIndicators(candles: Candle[]) {
  const closes = candles.map(c => c.close);
  const sma = (p: number) => closes.length >= p ? closes.slice(-p).reduce((a,b)=>a+b,0)/p : null;
  return {
    lastClose: closes[closes.length-1] ?? 0,
    sma20: sma(20), sma50: sma(50), ema20: sma(20),
    rsi14: 58, atr14: candles.length > 14 ? (MARKETS[Object.keys(MARKETS)[0]!]!.vol * 0.8) : null,
    macd: { macd: 120, signal: 80, histogram: 40 },
    changePct24: 2.34,
  };
}

// ── Server ──

const uiDir = path.resolve(import.meta.dirname, "../server/ui");
let sseClients: Set<http.ServerResponse> = new Set();
let activeBroker = "binance";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const json = (data: unknown) => { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify(data)); };
  const body = (): Promise<string> => new Promise(r => { let b=""; req.on("data", c => b += c); req.on("end", () => r(b)); });

  // SSE
  if (url.pathname === "/api/events") {
    res.writeHead(200, {"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"});
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // Klines
  if (url.pathname === "/api/klines") {
    const sym = url.searchParams.get("symbol") ?? "BTCUSDT";
    const candles = CANDLE_DATA[sym] ?? CANDLE_DATA["BTCUSDT"]!;
    json({ symbol: sym, interval: url.searchParams.get("interval") ?? "1h", klines: candles, indicators: calcIndicators(candles) });
    return;
  }

  // Ticker
  if (url.pathname === "/api/ticker") {
    const sym = url.searchParams.get("symbol") ?? "BTCUSDT";
    const candles = CANDLE_DATA[sym] ?? CANDLE_DATA["BTCUSDT"]!;
    const last = candles[candles.length-1]!;
    json({ symbol: sym, price: last.close, changePct24h: 2.34, volume24h: 1250000 });
    return;
  }

  // Status
  if (url.pathname === "/api/status") {
    json({
      binance: {
        account: { totalValueUsdt: 12847.53, balances: [{ asset: "USDT", free: 11200, locked: 0 }, { asset: "BTC", free: 0.0234, locked: 0 }, { asset: "ETH", free: 1.5, locked: 0 }], updatedAt: Date.now() },
        positions: POSITIONS, error: null,
      },
      alpaca: {
        account: { totalValueUsdt: 25430.00, balances: [{ asset: "USD", free: 22000, locked: 3430 }], updatedAt: Date.now() },
        positions: [
          { symbol: "NVDA", baseAsset: "NVDA", quoteAsset: "USD", quantity: 4, avgEntryPrice: 842, currentPrice: 878, unrealizedPnlUsdt: 144, openedAt: Date.now() - 86400000 * 5 },
        ], error: null,
      },
    });
    return;
  }

  // State
  if (url.pathname === "/api/state") {
    json({ killSwitchActive: false, dailyRealizedPnlUsdt: 23.40, dailyPnlResetAt: Date.now(), openPositions: { BTCUSDT: { quantity: 0.0234, avgEntryPrice: 65200, openedAt: Date.now() - 86400000*3 }, ETHUSDT: { quantity: 1.5, avgEntryPrice: 3380, openedAt: Date.now() - 86400000 } } });
    return;
  }

  // Decisions
  if (url.pathname === "/api/decisions") {
    json(DECISIONS);
    return;
  }

  // Brokers
  if (url.pathname === "/api/brokers") {
    json({ brokers: [
      { name: "binance", mode: "paper", active: activeBroker === "binance" },
      { name: "alpaca", mode: "paper", active: activeBroker === "alpaca" },
    ], activeBroker });
    return;
  }

  // Switch broker
  if (url.pathname === "/api/active-broker" && method === "POST") {
    const b = JSON.parse(await body()) as { broker: string };
    activeBroker = b.broker;
    json({ ok: true, activeBroker });
    return;
  }

  // Kill switch
  if (url.pathname === "/api/kill-switch" && method === "POST") {
    json({ ok: true, active: false });
    return;
  }

  // Dashboard
  if (url.pathname === "/") {
    try {
      const html = await fs.readFile(path.join(uiDir, "index.html"), "utf8");
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end(`Kunde inte ladda dashboard: ${e}`);
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║            MIKAEL TRADING OS — DEMO                     ║`);
  console.log(`║                                                          ║`);
  console.log(`║  Dashboard: http://localhost:${PORT}                       ║`);
  console.log(`║                                                          ║`);
  console.log(`║  Simulerad data — inga API-nycklar behövs.               ║`);
  console.log(`║  Ctrl+C för att stänga.                                  ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
});

// Simulera live-uppdateringar var 15:e sekund
setInterval(() => {
  // Rör priserna lite
  for (const [sym, candles] of Object.entries(CANDLE_DATA)) {
    const last = candles[candles.length-1]!;
    const cfg = MARKETS[sym]!;
    const change = (Math.random() - 0.48) * cfg.vol * 0.3;
    const newClose = last.close + change;
    const newCandle: Candle = {
      openTime: Date.now(),
      open: last.close,
      high: Math.max(last.close, newClose) + Math.random() * cfg.vol * 0.1,
      low: Math.min(last.close, newClose) - Math.random() * cfg.vol * 0.1,
      close: Number(newClose.toFixed(2)),
      volume: 500 + Math.random() * 1500,
      closeTime: Date.now() + 3600000,
    };
    candles.push(newCandle);
    if (candles.length > 500) candles.shift();
  }

  // Uppdatera positioner
  const btcPrice = CANDLE_DATA["BTCUSDT"]![CANDLE_DATA["BTCUSDT"]!.length-1]!.close;
  const ethPrice = CANDLE_DATA["ETHUSDT"]![CANDLE_DATA["ETHUSDT"]!.length-1]!.close;
  POSITIONS[0]!.currentPrice = btcPrice;
  POSITIONS[0]!.unrealizedPnlUsdt = Number(((btcPrice - 65200) * 0.0234).toFixed(2));
  POSITIONS[1]!.currentPrice = ethPrice;
  POSITIONS[1]!.unrealizedPnlUsdt = Number(((ethPrice - 3380) * 1.5).toFixed(2));

  // Pusha SSE-event
  const payload = `event: turn-complete\ndata: {}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}, 15000);

// Simulera team-rapport efter 5 sekunder
setTimeout(() => {
  const payload = `event: team-reports\ndata: ${JSON.stringify(TEAM)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}, 5000);
