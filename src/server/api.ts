import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadState, saveState, loadRecentDecisions } from "../memory/store.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { computeIndicators } from "../indicators/ta.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getCostSummary } from "../cost/tracker.js";
import { handleUpdate as handleTelegramUpdate, sendMessage as sendTelegramMessage, setupWebhook as setupTelegramWebhook } from "./telegram.js";
import { getMarketSnapshot, formatSnapshotForPrompt } from "./marketContext.js";
import { detectAllPatterns, type Candle } from "./patternDetection.js";
import { BinanceClient, type BinanceCredentials } from "./integrations/binance.js";
import { OandaClient, type OandaCredentials } from "./integrations/oanda.js";

// In-memory keys (per server-instans). DUAL-MODE: separat live + testnet samtidigt.
let binanceLiveCreds: BinanceCredentials | null = null;
let binanceTestnetCreds: BinanceCredentials | null = null;
let oandaCreds: OandaCredentials | null = null;

// Säkerhetslås för LIVE-mode (riktiga pengar)
const MAX_LIVE_STAKE_USD = parseFloat(process.env.MAX_LIVE_STAKE_USD || "5");
const MAX_LIVE_DAILY_LOSS_USD = parseFloat(process.env.MAX_LIVE_DAILY_LOSS_USD || "10");
let liveDailyLossUsd = 0; // resettas vid midnatt
let lastResetDay = new Date().getUTCDate();

// Helper: välj rätt creds baserat på mode-param ("testnet" default)
function resolveBinanceCreds(mode: "testnet" | "live"): BinanceCredentials | null {
  return mode === "live" ? binanceLiveCreds : binanceTestnetCreds;
}

function initIntegrationsFromEnv(): void {
  // Live-keys (binance.com / mainnet)
  const liveKey = process.env.BINANCE_API_KEY;
  const liveSecret = process.env.BINANCE_API_SECRET;
  const explicitTestnet = process.env.BINANCE_TESTNET === "true";
  if (liveKey && liveSecret && !explicitTestnet) {
    binanceLiveCreds = { apiKey: liveKey, apiSecret: liveSecret, testnet: false };
    log.ok(`Binance LIVE auto-init (mainnet)`);
  }
  // Testnet-keys (separat så båda kan köras parallellt)
  const tnKey = process.env.BINANCE_TESTNET_API_KEY;
  const tnSecret = process.env.BINANCE_TESTNET_API_SECRET;
  if (tnKey && tnSecret) {
    binanceTestnetCreds = { apiKey: tnKey, apiSecret: tnSecret, testnet: true };
    log.ok(`Binance TESTNET auto-init (parallellt med live)`);
  } else if (liveKey && liveSecret && explicitTestnet) {
    // Bakåtkompat: om gamla BINANCE_TESTNET=true → använd som testnet
    binanceTestnetCreds = { apiKey: liveKey, apiSecret: liveSecret, testnet: true };
    log.ok(`Binance TESTNET auto-init (fallback från BINANCE_TESTNET=true)`);
  }

  log.info(`Säkerhetslås LIVE: max stake $${MAX_LIVE_STAKE_USD} · daily loss-cap $${MAX_LIVE_DAILY_LOSS_USD}`);

  const ot = process.env.OANDA_API_KEY || process.env.OANDA_API_TOKEN;
  const oa = process.env.OANDA_ACCOUNT_ID;
  const op = process.env.OANDA_PRACTICE !== "false";
  if (ot && oa) {
    oandaCreds = { apiToken: ot, accountId: oa, practice: op };
    log.ok(`Oanda auto-init (mode: ${op ? "PRACTICE" : "LIVE"})`);
  }
}
initIntegrationsFromEnv();

// ─── Portfolio-stats cache (60s TTL för att inte spam:a Binance API) ───
type PortfolioStats = Awaited<ReturnType<BinanceClient["getPortfolioTradeStats"]>>;
const portfolioStatsCache = new Map<"testnet" | "live", { ts: number; data: PortfolioStats }>();
const PORTFOLIO_TTL_MS = 5 * 60_000; // 5 min — invalideras vid WS-event vid behov
function getCachedPortfolioStats(mode: "testnet" | "live"): PortfolioStats | null {
  const c = portfolioStatsCache.get(mode);
  if (c && Date.now() - c.ts < PORTFOLIO_TTL_MS) return c.data;
  return null;
}
function setCachedPortfolioStats(mode: "testnet" | "live", data: PortfolioStats): void {
  portfolioStatsCache.set(mode, { ts: Date.now(), data });
}

// ─── Chat-tool executor — utför Claude's tool_use mot riktiga Binance-orders ───
async function executeChatTool(
  toolName: string,
  input: Record<string, unknown>,
  mode: "testnet" | "live",
  client: BinanceClient,
  symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; minNotional: number; minQty: number; stepSize: number }>,
  userQuotes: string[],
): Promise<unknown> {
  if (toolName === "get_account_status") {
    const eq = await client.getTotalEquity();
    return {
      total_usdt: eq.totalUsdt,
      cash_usdt: eq.cashUsdt,
      cash_breakdown: eq.cashBreakdown,
      open_positions_count: eq.positions.length,
      top_positions: eq.positions.slice(0, 5).map(p => ({ asset: p.asset, qty: p.qty, value_usdt: p.valueUsdt })),
    };
  }
  if (toolName === "close_all_positions") {
    const eq = await client.getTotalEquity();
    const STABLES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDP"];
    const closes: Array<{ symbol: string; qty: number; ok: boolean; error?: string }> = [];
    for (const p of eq.positions) {
      if (STABLES.includes(p.asset)) continue;
      // Försök sälja mot USDT först, sen USDC
      const symInfo = symbols.find(s => s.baseAsset === p.asset && (s.quoteAsset === "USDT" || s.quoteAsset === "USDC"));
      if (!symInfo) { closes.push({ symbol: p.asset, qty: p.qty, ok: false, error: "Ingen tradable USDT/USDC-pair" }); continue; }
      try {
        // Avrunda qty till stepSize
        const stepSize = symInfo.stepSize || 0.000001;
        const qtyRounded = Math.floor(p.qty / stepSize) * stepSize;
        if (qtyRounded <= 0) { closes.push({ symbol: symInfo.symbol, qty: p.qty, ok: false, error: "qty < stepSize" }); continue; }
        const fill = await client.placeMarketOrder({ symbol: symInfo.symbol, side: "SELL", quantity: qtyRounded });
        closes.push({ symbol: symInfo.symbol, qty: qtyRounded, ok: !!fill });
      } catch (e) {
        closes.push({ symbol: symInfo.symbol, qty: p.qty, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { closed: closes, total_attempted: closes.length, successful: closes.filter(c => c.ok).length };
  }
  if (toolName === "consult_advisor") {
    const question = String(input.question || "");
    const symbols = Array.isArray(input.symbols) ? (input.symbols as string[]) : [];
    if (!question) return { ok: false, error: "consult_advisor kräver 'question'" };
    try {
      const result = await consultAdvisor(question, symbols, client, mode);
      return { ok: true, advisor_recommendation: result.recommendation, supporting_data_keys: Object.keys(result.data) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (toolName === "place_market_orders") {
    const n = Math.min(Math.max(1, Number(input.n_trades) || 1), 10);
    const amt = Number(input.amount_per_trade) || 5;
    let quotePref = String(input.quote_preference || "AUTO");
    if (quotePref === "AUTO") {
      // Välj quote Mike har mest av
      quotePref = userQuotes.includes("USDC") ? "USDC" : (userQuotes.includes("USDT") ? "USDT" : "USDT");
    }
    // LIVE säkerhetslås
    if (mode === "live" && amt > MAX_LIVE_STAKE_USD) {
      return { ok: false, error: `LIVE-säkerhetslås: max $${MAX_LIVE_STAKE_USD}/trade. Du försökte $${amt}.` };
    }
    if (mode === "live" && liveDailyLossUsd >= MAX_LIVE_DAILY_LOSS_USD) {
      return { ok: false, error: `Daglig loss-cap nådd ($${liveDailyLossUsd.toFixed(2)} / $${MAX_LIVE_DAILY_LOSS_USD}). Trading pausad.` };
    }
    // Filtrera symbols
    const skipBases = new Set(["EUR", "GBP", "JPY", "TRY", "BRL", "ARS", "RON", "ZAR", "UAH", "NGN"]);
    const eligible = symbols.filter(s => s.quoteAsset === quotePref && amt >= s.minNotional && !skipBases.has(s.baseAsset));
    if (eligible.length === 0) {
      const sameQuote = symbols.filter(s => s.quoteAsset === quotePref);
      const lowestMin = sameQuote.length ? Math.min(...sameQuote.map(s => s.minNotional)) : 5;
      return { ok: false, error: `Inga ${quotePref}-pairs accepterar $${amt}. Lägsta min är $${lowestMin.toFixed(2)}.` };
    }
    // Plocka random N (utan duplicates)
    const shuffled = [...eligible].sort(() => Math.random() - 0.5).slice(0, n);
    const fills = await Promise.all(shuffled.map(async (s) => {
      try {
        const fill = await client.placeMarketOrder({ symbol: s.symbol, side: "BUY", quoteOrderQty: amt });
        const fillPrice = parseFloat(fill.cummulativeQuoteQty) / parseFloat(fill.executedQty);
        return { symbol: s.symbol, ok: true, qty: parseFloat(fill.executedQty), fill_price: fillPrice, order_id: fill.orderId };
      } catch (e) {
        return { symbol: s.symbol, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
    }));
    return {
      ok: true,
      requested: n,
      filled: fills.filter(f => f.ok).length,
      failed: fills.filter(f => !f.ok).length,
      orders: fills,
    };
  }
  return { ok: false, error: `Okänt verktyg: ${toolName}` };
}

// ─── ADVISOR — senior trading-AI på Opus med marknadskontext + historik + patterns ───
// VIKTIGT: marknadsdata hämtas ALLTID via mainnet (publika endpoints, ingen auth/rate-limit-konflikt
// med testnet). Bara user-specifik data (trades, positions) använder mode-clienten.
async function consultAdvisor(
  question: string,
  symbols: string[],
  userClient: BinanceClient,
  mode: "testnet" | "live",
): Promise<{ recommendation: string; data: Record<string, unknown> }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY ej satt");
  const anthropic = new Anthropic({ apiKey });

  // Mainnet-client för publik marknadsdata — använder LIVE creds om de finns,
  // annars en publik client utan auth (klines + price är opublic)
  const liveCredsForData = binanceLiveCreds || { apiKey: "public", apiSecret: "public", testnet: false };
  const marketClient = new BinanceClient(liveCredsForData);

  const targetSyms = symbols.length > 0 ? symbols : ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

  // Hämta marknadsdata för varje symbol parallellt: 1h + 4h klines + ticker
  const marketData = await Promise.all(targetSyms.slice(0, 5).map(async (sym) => {
    try {
      const [klines1h, klines4h, price] = await Promise.all([
        marketClient.getKlines(sym, "1h", 100),
        marketClient.getKlines(sym, "4h", 100),
        marketClient.getPrice(sym),
      ]);
      const candles1h: Candle[] = klines1h.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
      const patterns1h = detectAllPatterns(candles1h).slice(-5);
      const candles4h: Candle[] = klines4h.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
      const patterns4h = detectAllPatterns(candles4h).slice(-3);
      // Enkla indikatorer
      const closes = klines1h.map(k => k.close);
      const sma20 = closes.slice(-20).reduce((s,c) => s+c, 0) / 20;
      const sma50 = closes.slice(-50).reduce((s,c) => s+c, 0) / 50;
      const change24h = ((klines1h[klines1h.length-1].close - klines1h[klines1h.length-25].close) / klines1h[klines1h.length-25].close) * 100;
      // RSI
      let gains = 0, losses = 0;
      for (let i = klines1h.length-15; i < klines1h.length; i++) {
        const diff = klines1h[i].close - klines1h[i-1].close;
        if (diff > 0) gains += diff; else losses -= diff;
      }
      const rs = gains / (losses || 1);
      const rsi14 = 100 - (100 / (1 + rs));
      return {
        symbol: sym, price, change_24h_pct: change24h.toFixed(2),
        sma20: sma20.toFixed(2), sma50: sma50.toFixed(2),
        trend: price > sma20 && sma20 > sma50 ? "UPTREND" : (price < sma20 && sma20 < sma50 ? "DOWNTREND" : "RANGING"),
        rsi14: rsi14.toFixed(1),
        patterns_1h: patterns1h.map(p => `${p.type}@${p.candle.time}`),
        patterns_4h: patterns4h.map(p => `${p.type}@${p.candle.time}`),
      };
    } catch (e) {
      return { symbol: sym, error: e instanceof Error ? e.message : String(e) };
    }
  }));

  // Hämta Mike's historik (FIFO trade-stats) — använd userClient (mode-specifik)
  const portfolioStats = await userClient.getPortfolioTradeStats();
  const tradeHistory = {
    total_trades: portfolioStats.totalTrades,
    closed_trades: portfolioStats.closedTrades,
    wins: portfolioStats.wins, losses: portfolioStats.losses,
    win_rate_pct: portfolioStats.closedTrades > 0 ? Math.round((portfolioStats.wins / portfolioStats.closedTrades) * 100) : null,
    realized_pnl_usdt: portfolioStats.realizedPnlUsdt.toFixed(2),
    fees_usdt: portfolioStats.feesUsdt.toFixed(2),
    per_symbol: portfolioStats.perSymbol.slice(0, 10),
    recent_trades: portfolioStats.recentTrades.slice(0, 15),
  };

  // Tid + day-of-week (vissa edges är time-baserade)
  const now = new Date();
  const timeContext = {
    iso: now.toISOString(),
    utc_hour: now.getUTCHours(),
    weekday: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getUTCDay()],
    is_weekend: now.getUTCDay() === 0 || now.getUTCDay() === 6,
    market_session: now.getUTCHours() >= 13 && now.getUTCHours() < 21 ? "US_OPEN" : (now.getUTCHours() >= 7 && now.getUTCHours() < 16 ? "EU_OPEN" : "ASIA_OFFHOURS"),
  };

  const advisorSystem = `Du är ADVISOR — Mike's senior trading-AI på Claude Opus. Mike's huvud-agent (Hanna, Haiku) konsulterar dig för djup analys.

Din roll:
- Strikt data-driven. Inga magkänslor utan stöd i siffrorna.
- Referera ALLTID till Mike's faktiska historik när du gör rekommendationer ("din SOLUSDT-history visar 3W/1L").
- Time-of-day och weekday-bias: notera om vi är i lågvolym-ASIA, högvolym-US, eller weekend (krypto = 24/7 men volym dippar).
- Kombinera: trend (SMA20 vs SMA50) + momentum (RSI) + chart-mönster + Mike's egna edge per symbol.
- Var konkret: rekommendera SPECIFIKA symbols + amount.
- Om setup är dålig — säg det rakt ut, ingen FOMO. "Vänta" är ett legitimt råd.
- Svara KORT (max 6 punkter, ADHD-vänligt). Mike vill action eller "vänta", inte essäer.

Mode: ${mode === "live" ? `LIVE — RIKTIGA PENGAR (säkerhetslås max $${MAX_LIVE_STAKE_USD}/trade, daglig $${MAX_LIVE_DAILY_LOSS_USD}). Pusha INTE Mike över dessa.` : `TESTNET — gratis demo-pengar ($50,499 USDT). INGEN $-gräns, Mike kan köra $500/trade utan problem. Var generös med rekommendationer i testnet.`}`;

  const advisorUserMsg = `Mike frågar: "${question}"

═══ MARKNADSDATA ═══
${JSON.stringify(marketData, null, 2)}

═══ MIKE'S TRADE-HISTORIK ═══
${JSON.stringify(tradeHistory, null, 2)}

═══ TIDSKONTEXT ═══
${JSON.stringify(timeContext, null, 2)}

Ge din rekommendation. Var KORT, KONKRET, REFERERA TILL DATAN OVAN.`;

  const reply = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1500,
    system: advisorSystem,
    messages: [{ role: "user", content: advisorUserMsg }],
  });

  const recommendation = reply.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlock).text).join("");
  return {
    recommendation,
    data: { market: marketData, history: tradeHistory, time: timeContext },
  };
}

// ─── Symbols cache (1 timme TTL — exchangeInfo är publik och rate-cheap) ───
const symbolsCache = new Map<"testnet" | "live", { ts: number; data: Array<{ symbol: string; baseAsset: string; quoteAsset: string; minNotional: number; minQty: number; stepSize: number }> }>();
const SYMBOLS_TTL_MS = 60 * 60_000;

// ─── SSE-subscribers för Binance user-data-stream ───
const userStreamSubscribers: http.ServerResponse[] = [];
function broadcastUserStream(event: string, payload: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const r of userStreamSubscribers) {
    try { r.write(msg); } catch { /* dead socket */ }
  }
}

// ─── Binance WebSocket User Data Stream — pushar order-fills + balans-uppdateringar i realtid ───
import WebSocket from "ws";
const userStreams: Map<"testnet" | "live", { ws: WebSocket; listenKey: string; keepAlive: NodeJS.Timeout }> = new Map();

async function startUserDataStream(mode: "testnet" | "live"): Promise<void> {
  const creds = resolveBinanceCreds(mode);
  if (!creds) return;
  if (userStreams.has(mode)) return;
  try {
    const client = new BinanceClient(creds);
    const listenKey = await client.createListenKey();
    const wsUrl = `${client.getWsUrl()}/${listenKey}`;
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => log.ok(`[binance-${mode}] user-data-stream öppnad`));
    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Invalidera portfolio-cache vid varje event så nästa request hämtar färska siffror
        portfolioStatsCache.delete(mode);
        broadcastUserStream(msg.e || "update", { mode, ...msg });
      } catch { /* ignore malformed */ }
    });
    ws.on("error", (err) => log.warn(`[binance-${mode}] WS error: ${err.message}`));
    ws.on("close", () => {
      log.warn(`[binance-${mode}] WS stängd — återansluter om 5s`);
      const entry = userStreams.get(mode);
      if (entry) clearInterval(entry.keepAlive);
      userStreams.delete(mode);
      setTimeout(() => startUserDataStream(mode), 5000);
    });
    // Keep-alive listenKey var 30 min
    const keepAlive = setInterval(() => {
      client.keepAliveListenKey(listenKey).catch((e) => log.warn(`[binance-${mode}] keepAlive fail: ${e.message}`));
    }, 30 * 60 * 1000);
    userStreams.set(mode, { ws, listenKey, keepAlive });
  } catch (err) {
    log.warn(`[binance-${mode}] user-data-stream init fail: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(() => startUserDataStream(mode), 30_000);
  }
}
// WS-streams: pausat — createListenKey returnerar 410 (proxy-issue eller permission saknas)
// Polling-baserad sync (3s + 30s portfolio) räcker tills detta är debugat.
// För att aktivera: uncomment raden nedan
// setTimeout(() => { startUserDataStream("testnet"); startUserDataStream("live"); }, 2000);

// Reset daily-loss-counter vid midnatt
setInterval(() => {
  const today = new Date().getUTCDate();
  if (today !== lastResetDay) {
    log.info(`Daglig loss-cap resettad ($${liveDailyLossUsd.toFixed(2)} → $0)`);
    liveDailyLossUsd = 0;
    lastResetDay = today;
  }
}, 60000);

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP API + Dashboard server
//
//  Endpoints:
//    GET  /                         → Dashboard HTML
//    GET  /api/status               → Portföljstatus (alla brokers)
//    GET  /api/decisions?limit=20   → Senaste beslut
//    GET  /api/state                → Agent state (kill-switch, PnL, positioner)
//    POST /api/kill-switch          → Toggle kill-switch { active: true/false }
//    GET  /api/brokers              → Lista anslutna brokers + vilken som är aktiv
//    POST /api/active-broker        → Byt aktiv broker { broker: "alpaca"|"binance"|... }
//    GET  /api/events               → SSE-stream (live-uppdateringar)
//    POST /api/ask-agent            → Ställ manuell fråga till valfri agent
//    POST /api/run-agent            → Trigga ny analys-turn
//
//  Inga externa beroenden förutom @anthropic-ai/sdk.
// ═══════════════════════════════════════════════════════════════════════════

// SSE-klienter (Server-Sent Events)
const sseClients: Set<http.ServerResponse> = new Set();

// Runtime broker selection — vilken broker agenten använder som "primär"
let activeBrokerName: string | null = null;

export function getActiveBrokerName(): string | null {
  return activeBrokerName;
}

export function setActiveBrokerName(name: string | null): void {
  activeBrokerName = name;
}

export function broadcastEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Agent system prompts för manuella frågor
const AGENT_PROMPTS: Record<string, { model: string; system: string }> = {
  macro: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Makro-Analytikern i Mikaels trading-team. Du analyserar makroekonomi: VIX, olja, dollar, crypto fear/greed, centralbanker, geopolitik. Svara koncist på svenska.",
  },
  technical: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Teknisk Analytikern i Mikaels trading-team. Du analyserar indikatorer: SMA, RSI, MACD, volym, entry/exit-zoner, bias per symbol. Svara koncist på svenska.",
  },
  sentiment: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Sentiment-Analytikern i Mikaels trading-team. Du analyserar marknadssentiment via Reddit, nyheter, politiker-trades, contrary signals. Svara koncist på svenska.",
  },
  risk: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Risk-Analytikern i Mikaels trading-team. Du bedömer portföljrisk: heat, korrelation, drawdown-scenarier, position sizing. Svara koncist på svenska.",
  },
  quant: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Kvant-Analytikern i Mikaels trading-team. Du analyserar volatilitet, Sharpe, win-rate, trend vs mean-reversion. Svara koncist på svenska.",
  },
  options: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Options-Strategen i Mikaels trading-team. Du analyserar IV-rank, premium selling, roll opportunities, optimal optionsstrategi. Svara koncist på svenska.",
  },
  portfolio: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Portfölj-Strategen i Mikaels trading-team. Du analyserar diversifiering, sektorkoncentration, rebalansering, asset allocation. Svara koncist på svenska.",
  },
  execution: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Exekverings-Optimeraren i Mikaels trading-team. Du optimerar ordertyp (market/limit), timing, DCA vs lump sum, slippage. Svara koncist på svenska.",
  },
  advisor: {
    model: "claude-opus-4-7",
    system: "Du är Claude Advisor i Mikaels trading-team. Du är en strategisk rådgivare som ser helheten: marknadscykler, beteendefinans-fällor, contrarian-perspektiv, blinda fläckar, svansrisker. Du ifrågasätter alltid teamets konsensus. Svara på svenska.",
  },
  forex: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Viktor — Forex-Specialisten i Mikaels trading-team. Du analyserar valuta-mot-valuta-trades (EUR/USD, GBP/USD, USD/JPY, AUD/USD, NZD/USD, USD/CHF, USD/CAD, EUR/GBP, EUR/JPY, GBP/JPY). Du fokuserar på: centralbanksbeslut (Fed, ECB, BoE, BoJ, RBA, RBNZ, SNB, BoC), räntedifferentialer, DXY (dollar-index), risk-on/risk-off-flöden, carry trades, och geopolitik. Du ger entry/SL/TP per pair, R:R-ratio, och flaggar viktiga events (CPI, NFP, FOMC, ECB, BoJ-intervention). Svara koncist på svenska.",
  },
  head_trader: {
    model: "claude-sonnet-4-6",
    system: "Du är Head Trader i Mikaels trading-team. Du syntetiserar alla specialisters analyser och fattar slutgiltiga handelsbeslut. Du har veto från Risk-analytikern och Advisor. Avsluta alltid med Rule of 3: [1] Regim [2] Action [3] Bevaka. Svara på svenska.",
  },
};

let anthropicApiKey: string | null = null;
let runAgentCallback: ((instruction?: string) => Promise<void>) | null = null;

export function setApiKey(key: string): void {
  anthropicApiKey = key;
}

export function setRunAgentCallback(cb: (instruction?: string) => Promise<void>): void {
  runAgentCallback = cb;
}

export function startServer(
  port: number,
  brokers: Record<string, BrokerAdapter>,
): http.Server {
  const uiDir = path.resolve(import.meta.dirname, "ui");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const method = req.method ?? "GET";

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      // ── SSE stream ──
      if (url.pathname === "/api/events" && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      // ── Status (alla brokers) ──
      if (url.pathname === "/api/status" && method === "GET") {
        const result: Record<string, unknown> = {};
        for (const [name, broker] of Object.entries(brokers)) {
          try {
            const account = await broker.getAccount();
            const positions = await broker.getPositions();
            result[name] = { account, positions, error: null };
          } catch (err) {
            result[name] = { account: null, positions: [], error: String(err) };
          }
        }
        json(res, result);
        return;
      }

      // ── Decisions ──
      if (url.pathname === "/api/decisions" && method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const decisions = await loadRecentDecisions(limit);
        json(res, decisions);
        return;
      }

      // ── State ──
      if (url.pathname === "/api/state" && method === "GET") {
        const state = await loadState();
        json(res, state);
        return;
      }

      // ── Lista brokers ──
      if (url.pathname === "/api/brokers" && method === "GET") {
        const list = Object.entries(brokers).map(([name, broker]) => ({
          name,
          mode: broker.mode,
          active: (activeBrokerName ?? Object.keys(brokers)[0]) === name,
        }));
        json(res, { brokers: list, activeBroker: activeBrokerName ?? Object.keys(brokers)[0] ?? null });
        return;
      }

      // ── Byt aktiv broker ──
      if (url.pathname === "/api/active-broker" && method === "POST") {
        const body = await readBody(req);
        const { broker: name } = JSON.parse(body) as { broker: string };
        if (!brokers[name]) {
          res.writeHead(400);
          json(res, { error: `Broker '${name}' finns inte. Tillgängliga: ${Object.keys(brokers).join(", ")}` });
          return;
        }
        activeBrokerName = name;
        broadcastEvent("broker-changed", { activeBroker: name });
        log.info(`Aktiv broker bytt till: ${name}`);
        json(res, { ok: true, activeBroker: name });
        return;
      }

      // ── Klines (candlestick data) ──
      if (url.pathname === "/api/klines" && method === "GET") {
        const symbol = url.searchParams.get("symbol") ?? "BTCUSDT";
        const interval = url.searchParams.get("interval") ?? "1h";
        const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
        const brokerName = url.searchParams.get("broker") ?? activeBrokerName ?? Object.keys(brokers)[0];
        const broker = brokerName ? brokers[brokerName] : undefined;
        if (!broker) {
          json(res, { error: "Ingen broker tillgänglig" });
          return;
        }
        try {
          const klines = await broker.getKlines(symbol, interval, Math.min(limit, 500));
          const indicators = computeIndicators(klines);
          json(res, { symbol, interval, klines, indicators });
        } catch (err) {
          json(res, { error: String(err), symbol, interval, klines: [] });
        }
        return;
      }

      // ── Ticker ──
      if (url.pathname === "/api/ticker" && method === "GET") {
        const symbol = url.searchParams.get("symbol") ?? "BTCUSDT";
        const brokerName = url.searchParams.get("broker") ?? activeBrokerName ?? Object.keys(brokers)[0];
        const broker = brokerName ? brokers[brokerName] : undefined;
        if (!broker) {
          json(res, { error: "Ingen broker tillgänglig" });
          return;
        }
        try {
          const ticker = await broker.getTicker(symbol);
          json(res, ticker);
        } catch (err) {
          json(res, { error: String(err) });
        }
        return;
      }

      // ── Cost summary (today/week/month + per-agent breakdown) ──
      // ENDAST för admin/owner. När multi-tenant byggs: scope:a per user_id.
      if (url.pathname === "/api/cost" && method === "GET") {
        const summary = await getCostSummary({
          dailyCapUsd: config.costCap.dailyUsd,
          weeklyCapUsd: config.costCap.weeklyUsd,
        });
        json(res, summary);
        return;
      }

      // ── Mode (Paper/Propose/Live) ──
      // GET → returnerar nuvarande mode + executionMode
      // POST → uppdaterar in-memory + persisterar till .env
      // För Live krävs explicit confirmation-array (6-punkts-checklista)
      if (url.pathname === "/api/mode" && method === "GET") {
        json(res, {
          mode: config.mode,
          executionMode: config.executionMode,
          // Härled UI-läge från kombination
          uiMode: config.mode === "paper" ? "paper" :
                  config.executionMode === "approve" ? "propose" : "live",
        });
        return;
      }

      if (url.pathname === "/api/mode" && method === "POST") {
        const body = await readBody(req);
        const { uiMode, confirmation } = JSON.parse(body) as {
          uiMode: "paper" | "propose" | "live";
          confirmation?: { confirmed: boolean[] };
        };

        // Live-läge kräver att alla 6 checklistor är confirmed
        if (uiMode === "live") {
          const allChecked = confirmation?.confirmed?.length === 6 &&
                             confirmation.confirmed.every((c) => c === true);
          if (!allChecked) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Live-läge kräver 6 bekräftelser." }));
            return;
          }
        }

        // Mappa UI-läge → config
        const newMode = uiMode === "paper" ? "paper" : "live";
        const newExecMode = uiMode === "propose" ? "approve" : "auto";

        // Mutera in-memory config — alla framtida agent-anrop använder nya värden
        (config as { mode: string }).mode = newMode;
        (config as { executionMode: string }).executionMode = newExecMode;

        // Persistera till .env så det överlever restart
        try {
          const envPath = "/root/mikael-trading-os/.env";
          const envContent = await fs.readFile(envPath, "utf8").catch(() => "");
          let updated = envContent;
          updated = updated.includes("\nMODE=")
            ? updated.replace(/\nMODE=[^\n]*/, `\nMODE=${newMode}`)
            : updated.replace(/^MODE=[^\n]*/, `MODE=${newMode}`);
          updated = updated.includes("\nEXECUTION_MODE=")
            ? updated.replace(/\nEXECUTION_MODE=[^\n]*/, `\nEXECUTION_MODE=${newExecMode}`)
            : updated + `\nEXECUTION_MODE=${newExecMode}`;
          updated = updated.includes("\nLIVE_TRADING_CONFIRMED=")
            ? updated.replace(/\nLIVE_TRADING_CONFIRMED=[^\n]*/, `\nLIVE_TRADING_CONFIRMED=${newMode === "live" ? "true" : "false"}`)
            : updated + `\nLIVE_TRADING_CONFIRMED=${newMode === "live" ? "true" : "false"}`;
          await fs.writeFile(envPath, updated, "utf8");
        } catch (err) {
          log.warn(`Kunde inte persistera mode till .env: ${err instanceof Error ? err.message : String(err)}`);
        }

        log.warn(`Mode bytt: ${uiMode.toUpperCase()} (mode=${newMode}, exec=${newExecMode}) via dashboard`);
        broadcastEvent("mode-changed", { uiMode, mode: newMode, executionMode: newExecMode });
        json(res, { ok: true, uiMode, mode: newMode, executionMode: newExecMode });
        return;
      }

      // ── Kill-switch ──
      if (url.pathname === "/api/kill-switch" && method === "POST") {
        const body = await readBody(req);
        const { active } = JSON.parse(body) as { active: boolean };
        const state = await loadState();
        state.killSwitchActive = active;
        await saveState(state);
        broadcastEvent("kill-switch", { active });
        log.warn(`Kill-switch ${active ? "AKTIVERAD" : "avaktiverad"} via dashboard`);
        json(res, { ok: true, active });
        return;
      }

      // ── Ask Agent (manuell fråga till valfri agent) ──
      if (url.pathname === "/api/ask-agent" && method === "POST") {
        const body = await readBody(req);
        const { agent, question } = JSON.parse(body) as { agent: string; question: string };

        const agentConfig = AGENT_PROMPTS[agent];
        if (!agentConfig) {
          res.writeHead(400);
          json(res, { error: `Okänd agent: '${agent}'. Tillgängliga: ${Object.keys(AGENT_PROMPTS).join(", ")}` });
          return;
        }
        if (!anthropicApiKey) {
          res.writeHead(500);
          json(res, { error: "ANTHROPIC_API_KEY ej konfigurerad" });
          return;
        }

        log.agent(`[Manual] Fråga till ${agent}: ${question.slice(0, 80)}...`);

        try {
          const client = new Anthropic({ apiKey: anthropicApiKey });

          // Samla kontext för agenten
          const state = await loadState();
          const recentDecisions = await loadRecentDecisions(10);
          const contextData: Record<string, unknown> = {
            killSwitch: state.killSwitchActive,
            dailyPnl: state.dailyRealizedPnlUsdt,
            openPositions: state.openPositions,
            recentDecisions: recentDecisions.map((d) => ({
              action: d.action, symbol: d.symbol, reasoning: d.reasoning.slice(0, 150),
            })),
          };

          // Hämta portföljdata om broker finns
          const activeName = activeBrokerName ?? Object.keys(brokers)[0];
          const broker = activeName ? brokers[activeName] : undefined;
          if (broker) {
            try {
              const [account, positions] = await Promise.all([
                broker.getAccount(), broker.getPositions(),
              ]);
              contextData.account = { totalValueUsdt: account.totalValueUsdt };
              contextData.positions = positions.map((p) => ({
                symbol: p.symbol, qty: p.quantity,
                entry: p.avgEntryPrice, current: p.currentPrice,
                pnl: p.unrealizedPnlUsdt,
              }));
            } catch { /* broker data optional */ }
          }

          const response = await client.messages.create({
            model: agentConfig.model,
            max_tokens: 2000,
            system: `${agentConfig.system}\n\nHär är aktuell kontext:\n${JSON.stringify(contextData)}`,
            messages: [{ role: "user", content: question }],
          });

          const responseText = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");

          log.agent(`[Manual] ${agent} svarade (${responseText.length} tecken)`);
          json(res, { agent, question, response: responseText, model: agentConfig.model });
        } catch (err) {
          log.error(`[Manual] Fel från ${agent}: ${err instanceof Error ? err.message : String(err)}`);
          res.writeHead(500);
          json(res, { error: `Agent-fel: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }

      // ── Run Agent (trigga ny analys-turn, valfritt med Mikes instruktion) ──
      if (url.pathname === "/api/run-agent" && method === "POST") {
        if (!runAgentCallback) {
          res.writeHead(500);
          json(res, { error: "Agent-callback ej konfigurerad" });
          return;
        }

        // Body kan vara tom eller ha {instruction: "Köp BTC för $50"}
        let instruction: string | undefined;
        try {
          const body = await readBody(req);
          if (body) {
            const parsed = JSON.parse(body) as { instruction?: string };
            instruction = parsed.instruction?.trim() || undefined;
          }
        } catch { /* ignore parse fel — kör utan instruktion */ }

        log.info(`[API] Manuell agent-turn triggad${instruction ? ` med instruktion: "${instruction}"` : ""}`);
        json(res, { ok: true, message: "Agent-turn startar...", instruction });

        // Kör async utan att blocka response
        runAgentCallback(instruction).catch((err) => {
          log.error(`Manuell turn misslyckades: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }

      // ── Dashboard HTML ──
      // Servera root-dashboard.html (single source of truth) framför gamla ui/index.html
      if ((url.pathname === "/" || url.pathname === "/dashboard.html") && method === "GET") {
        try {
          const rootDashboard = path.resolve(import.meta.dirname, "../../dashboard.html");
          const html = await fs.readFile(rootDashboard, "utf8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch {
          // Fallback: gamla ui/index.html
          try {
            const html = await fs.readFile(path.join(uiDir, "index.html"), "utf8");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
          } catch {
            res.writeHead(500);
            res.end("Dashboard HTML not found");
          }
        }
        return;
      }

      // ── Cross-device sync (frontend STATE delas mellan dator + mobil) ──
      // Lagrar JSON per clientId i /app/data/sync/{clientId}.json
      if (url.pathname === "/api/sync/save" && method === "POST") {
        const body = await readBody(req);
        try {
          const parsed = JSON.parse(body) as { clientId?: string; state?: unknown };
          if (!parsed.clientId || !parsed.state) {
            res.writeHead(400);
            json(res, { error: "clientId + state krävs" });
            return;
          }
          const clientId = String(parsed.clientId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
          const dir = path.resolve(process.cwd(), "data", "sync");
          await fs.mkdir(dir, { recursive: true });
          const file = path.join(dir, `${clientId}.json`);
          await fs.writeFile(file, JSON.stringify({ updatedAt: Date.now(), state: parsed.state }), "utf8");
          // Broadcast till andra devices via SSE
          broadcastEvent("sync-updated", { clientId, updatedAt: Date.now() });
          json(res, { ok: true, updatedAt: Date.now() });
        } catch (err) {
          res.writeHead(500);
          json(res, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (url.pathname === "/api/sync/load" && method === "GET") {
        const clientId = (url.searchParams.get("clientId") || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
        if (!clientId) {
          res.writeHead(400);
          json(res, { error: "clientId krävs" });
          return;
        }
        try {
          const file = path.resolve(process.cwd(), "data", "sync", `${clientId}.json`);
          const data = await fs.readFile(file, "utf8");
          json(res, JSON.parse(data));
        } catch (err) {
          // Filen finns ej än — returnera tomt
          json(res, { updatedAt: 0, state: null });
        }
        return;
      }

      // ── Telegram webhook ──
      if (url.pathname === "/api/telegram/webhook" && method === "POST") {
        const body = await readBody(req);
        try {
          const update = JSON.parse(body);
          // Helper för att fråga agent (Hanna m.fl.) — INKL live-marknadsdata
          const askAgent = async (agentKey: string, question: string): Promise<string> => {
            if (!anthropicApiKey) return "❌ Anthropic API-nyckel ej konfigurerad i backend.";
            const agentMap: Record<string, string> = {
              hanna: "head_trader",
              tomas: "technical",
              karin: "quant",
              rasmus: "risk",
              markus: "macro",
              petra: "portfolio",
              sara: "sentiment",
              lars: "macro",
              emma: "execution",
              albert: "advisor",
              viktor: "forex",
            };
            const profileKey = agentMap[agentKey] || agentKey;
            const profile = AGENT_PROMPTS[profileKey];
            if (!profile) return `❌ Okänd agent: ${agentKey}`;

            // Hämta live marknadsdata för agenter som behöver det
            // (Hanna/head_trader, technical, quant, forex, advisor, portfolio)
            const wantsMarketData = ["head_trader", "technical", "quant", "forex", "advisor", "portfolio", "risk"].includes(profileKey);
            let systemPrompt = profile.system;
            if (wantsMarketData) {
              try {
                const snap = await getMarketSnapshot();
                if (snap) {
                  const marketBlock = formatSnapshotForPrompt(snap);
                  systemPrompt = `${profile.system}\n\n---\n\n${marketBlock}\n\n**VIKTIGT:** Använd alltid datan ovan när du svarar — det är riktiga live-priser från Binance just nu. Hänvisa till specifika nivåer, RSI-värden, trender. Du HAR realtidsdata. Vägra inte ge konkreta rekommendationer.`;
                }
              } catch (err) {
                log.warn(`Market snapshot misslyckades: ${err instanceof Error ? err.message : String(err)}`);
              }
            }

            // Prompt-caching på system-promten — sparar tokens när Mike frågar flera gånger
            const client = new Anthropic({ apiKey: anthropicApiKey });
            const resp = await client.messages.create({
              model: profile.model,
              max_tokens: 800,
              system: [
                { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
              ],
              messages: [{ role: "user", content: question }],
            });
            const txt = resp.content.find((b) => b.type === "text");
            return txt && "text" in txt ? txt.text : "(inget svar)";
          };
          const getStatus = async (): Promise<string> => {
            const state = await loadState();
            const decisions = await loadRecentDecisions(3);
            const lines = [
              "<b>📊 Status — Mikael Trading OS</b>",
              `Kill-switch: ${state.killSwitchActive ? "🔴 AKTIV" : "🟢 inaktiv"}`,
              `Aktiv broker: ${activeBrokerName ?? "(default)"}`,
              `Senaste beslut:`,
              ...decisions.slice(0, 3).map((d: { symbol?: string; action?: string; amount?: number }) => `• ${d.symbol || "?"} ${d.action || ""} ${d.amount ? `$${d.amount}` : ""}`),
            ];
            return lines.join("\n");
          };
          // Asynkront — svara 200 direkt så Telegram inte retry:ar
          handleTelegramUpdate(update, { askAgent, getStatus }).catch((err) => {
            log.error(`Telegram-handler-fel: ${err instanceof Error ? err.message : String(err)}`);
          });
          json(res, { ok: true });
        } catch (err) {
          log.error(`Telegram webhook parse-fel: ${err instanceof Error ? err.message : String(err)}`);
          json(res, { ok: false });
        }
        return;
      }

      // ── Binance public prices (för PROPOSE-mode — riktiga marknadspriser, ingen auth) ──
      if (url.pathname === "/api/binance/prices" && method === "GET") {
        const symbolsParam = url.searchParams.get("symbols") || "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,DOTUSDT,MATICUSDT";
        const symbols = symbolsParam.split(",").map((s) => s.trim());
        try {
          const url2 = "https://api.binance.com/api/v3/ticker/price";
          const r = await fetch(url2);
          if (!r.ok) {
            json(res, { error: `Binance svarade ${r.status}`, prices: {} });
            return;
          }
          const all = (await r.json()) as Array<{ symbol: string; price: string }>;
          const result: Record<string, number> = {};
          for (const s of symbols) {
            const found = all.find((x) => x.symbol === s);
            if (found) result[s] = parseFloat(found.price);
          }
          json(res, { prices: result, source: "binance-public", at: Date.now() });
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err), prices: {} });
        }
        return;
      }

      // ── Binance public klines (riktiga candlesticks) ──
      if (url.pathname === "/api/binance/klines" && method === "GET") {
        const symbol = url.searchParams.get("symbol") || "BTCUSDT";
        const interval = url.searchParams.get("interval") || "1h";
        const limit = url.searchParams.get("limit") || "100";
        try {
          const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
          if (!r.ok) {
            json(res, { error: `Binance svarade ${r.status}`, candles: [] });
            return;
          }
          const raw = (await r.json()) as Array<Array<string | number>>;
          const candles = raw.map((k) => ({
            time: Math.floor((k[0] as number) / 1000),
            open: parseFloat(k[1] as string),
            high: parseFloat(k[2] as string),
            low: parseFloat(k[3] as string),
            close: parseFloat(k[4] as string),
            volume: parseFloat(k[5] as string),
          }));
          json(res, { symbol, interval, candles, source: "binance-public", at: Date.now() });
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err), candles: [] });
        }
        return;
      }

      // ═══════ BINANCE INTEGRATION (Testnet + Live samma kod) ═══════
      // POST /api/binance/setup — konfigurera API keys (testnet eller mainnet)
      if (url.pathname === "/api/binance/setup" && method === "POST") {
        const body = await readBody(req);
        const { apiKey, apiSecret, testnet } = JSON.parse(body) as { apiKey: string; apiSecret: string; testnet: boolean };
        if (!apiKey || !apiSecret) { res.writeHead(400); json(res, { error: "apiKey + apiSecret krävs" }); return; }
        try {
          const client = new BinanceClient({ apiKey, apiSecret, testnet: !!testnet });
          const hc = await client.healthCheck();
          if (!hc.ok) { json(res, { ok: false, error: hc.details }); return; }
          if (testnet) binanceTestnetCreds = { apiKey, apiSecret, testnet: true };
          else binanceLiveCreds = { apiKey, apiSecret, testnet: false };
          json(res, { ok: true, mode: hc.canTrade ? "trading" : "read-only", details: hc.details });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // GET /api/binance/account?mode=testnet|live — riktig balans + positions
      if (url.pathname === "/api/binance/account" && method === "GET") {
        const mode = (url.searchParams.get("mode") === "live" ? "live" : "testnet") as "testnet" | "live";
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { error: `Binance ${mode} ej konfigurerat` }); return; }
        try {
          const client = new BinanceClient(creds);
          const equity = await client.getTotalEquity();
          json(res, { ok: true, mode, ...equity });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // GET /api/binance/dual — hämta BÅDA samtidigt
      if (url.pathname === "/api/binance/dual" && method === "GET") {
        const result: Record<string, unknown> = {};
        for (const mode of ["testnet", "live"] as const) {
          const creds = resolveBinanceCreds(mode);
          if (!creds) { result[mode] = { configured: false }; continue; }
          try {
            const client = new BinanceClient(creds);
            const equity = await client.getTotalEquity();
            result[mode] = { configured: true, ...equity };
          } catch (err) {
            result[mode] = { configured: true, error: err instanceof Error ? err.message : String(err) };
          }
        }
        json(res, { ok: true, ...result });
        return;
      }
      // POST /api/binance/order — lägg riktig MARKET-order MED SÄKERHETSLÅS
      if (url.pathname === "/api/binance/order" && method === "POST") {
        const body = await readBody(req);
        const { mode = "testnet", symbol, side, quoteOrderQty, clientOrderId } = JSON.parse(body) as { mode?: "testnet" | "live"; symbol: string; side: "BUY" | "SELL"; quoteOrderQty: number; clientOrderId?: string };
        const creds = resolveBinanceCreds(mode);
        if (!creds) { res.writeHead(400); json(res, { error: `Binance ${mode} ej konfigurerat` }); return; }
        // SÄKERHETSLÅS — bara för LIVE-mode (testnet = ingen risk)
        if (mode === "live") {
          if (quoteOrderQty > MAX_LIVE_STAKE_USD) {
            json(res, { ok: false, error: `🛡 Säkerhetslås: max stake $${MAX_LIVE_STAKE_USD}/trade i LIVE-mode (du försökte $${quoteOrderQty})` });
            return;
          }
          if (liveDailyLossUsd >= MAX_LIVE_DAILY_LOSS_USD) {
            json(res, { ok: false, error: `🛡 Säkerhetslås: daglig förlust-cap $${MAX_LIVE_DAILY_LOSS_USD} uppnådd. Trading pausad till midnatt UTC.` });
            return;
          }
        }
        try {
          const client = new BinanceClient(creds);
          const order = await client.placeMarketOrder({ symbol, side, quoteOrderQty, clientOrderId });
          log.info(`[binance-${mode}] ORDER PLACERAD: ${side} ${symbol} $${quoteOrderQty}`);
          json(res, { ok: true, mode, order });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // GET /api/binance/trades?symbol=BTCUSDT&mode=live|testnet
      if (url.pathname === "/api/binance/trades" && method === "GET") {
        const mode = (url.searchParams.get("mode") === "live" ? "live" : "testnet") as "testnet" | "live";
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { error: `Binance ${mode} ej konfigurerat` }); return; }
        const symbol = url.searchParams.get("symbol") || "BTCUSDT";
        try {
          const client = new BinanceClient(creds);
          const trades = await client.getMyTrades(symbol, 50);
          json(res, { ok: true, mode, trades });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // GET /api/binance/portfolio-trades?mode= — full trade-historik + realized PnL + W/L
      if (url.pathname === "/api/binance/portfolio-trades" && method === "GET") {
        const mode = (url.searchParams.get("mode") === "live" ? "live" : "testnet") as "testnet" | "live";
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { ok: false, error: `Binance ${mode} ej konfigurerat` }); return; }
        try {
          const cached = getCachedPortfolioStats(mode);
          if (cached) { json(res, { ok: true, mode, ...cached, cached: true }); return; }
          const client = new BinanceClient(creds);
          const stats = await client.getPortfolioTradeStats();
          setCachedPortfolioStats(mode, stats);
          json(res, { ok: true, mode, ...stats, cached: false });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // GET /api/binance/orders/open?mode= — pending limit-orders
      if (url.pathname === "/api/binance/orders/open" && method === "GET") {
        const mode = (url.searchParams.get("mode") === "live" ? "live" : "testnet") as "testnet" | "live";
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { ok: false, error: `Binance ${mode} ej konfigurerat` }); return; }
        try {
          const client = new BinanceClient(creds);
          const orders = await client.getOpenOrders();
          json(res, { ok: true, mode, orders });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // GET /api/binance/orders/history?mode=&symbol=BTCUSDT
      if (url.pathname === "/api/binance/orders/history" && method === "GET") {
        const mode = (url.searchParams.get("mode") === "live" ? "live" : "testnet") as "testnet" | "live";
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { ok: false, error: `Binance ${mode} ej konfigurerat` }); return; }
        const symbol = url.searchParams.get("symbol") || "BTCUSDT";
        try {
          const client = new BinanceClient(creds);
          const orders = await client.getAllOrders(symbol, 50);
          json(res, { ok: true, mode, symbol, orders });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // GET /api/binance/transfers?mode= — deposits + withdrawals (mainnet bara)
      if (url.pathname === "/api/binance/transfers" && method === "GET") {
        const mode = (url.searchParams.get("mode") === "live" ? "live" : "testnet") as "testnet" | "live";
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { ok: false, error: `Binance ${mode} ej konfigurerat` }); return; }
        try {
          const client = new BinanceClient(creds);
          const [deposits, withdrawals] = await Promise.all([client.getDepositHistory(), client.getWithdrawHistory()]);
          json(res, { ok: true, mode, deposits, withdrawals });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // GET /api/binance/stream — SSE-bridge för WS user-data-stream events (real-tid order-fills)
      if (url.pathname === "/api/binance/stream" && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const id = userStreamSubscribers.length;
        userStreamSubscribers.push(res);
        res.write(`event: hello\ndata: ${JSON.stringify({ subscriberId: id, ts: Date.now() })}\n\n`);
        req.on("close", () => {
          const idx = userStreamSubscribers.indexOf(res);
          if (idx >= 0) userStreamSubscribers.splice(idx, 1);
        });
        return;
      }
      // GET /api/binance/symbols?mode= — alla tradeable USDT+USDC pairs med MIN_NOTIONAL
      if (url.pathname === "/api/binance/symbols" && method === "GET") {
        const mode = (url.searchParams.get("mode") === "live" ? "live" : "testnet") as "testnet" | "live";
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { ok: false, error: `Binance ${mode} ej konfigurerat` }); return; }
        try {
          const cached = symbolsCache.get(mode);
          if (cached && Date.now() - cached.ts < SYMBOLS_TTL_MS) { json(res, { ok: true, mode, symbols: cached.data, cached: true }); return; }
          const client = new BinanceClient(creds);
          const symbols = await client.getTradableSymbols(["USDT", "USDC"]);
          symbolsCache.set(mode, { ts: Date.now(), data: symbols });
          json(res, { ok: true, mode, symbols, cached: false });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // POST /api/chat — Mike pratar naturligt med Claude som agent med Binance-tools
      // Mike vill mänsklig dialog: "kör 5 trades på $1", "stäng allt", "vad tycker ni om BTC?"
      if (url.pathname === "/api/chat" && method === "POST") {
        const body = await readBody(req);
        const { message, mode, history } = JSON.parse(body) as {
          message: string;
          mode: "testnet" | "live";
          history?: Array<{ role: "user" | "assistant"; text: string }>;
        };
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) { json(res, { ok: false, error: "ANTHROPIC_API_KEY ej satt" }); return; }
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { ok: false, error: `Binance ${mode} ej konfigurerat` }); return; }

        try {
          const client = new BinanceClient(creds);
          const anthropic = new Anthropic({ apiKey });

          // Hämta kontext: saldo + symbols + senaste trades
          const [equity, symbols] = await Promise.all([
            client.getTotalEquity(),
            (async () => {
              const c = symbolsCache.get(mode);
              if (c && Date.now() - c.ts < SYMBOLS_TTL_MS) return c.data;
              const fresh = await client.getTradableSymbols(["USDT", "USDC"]);
              symbolsCache.set(mode, { ts: Date.now(), data: fresh });
              return fresh;
            })(),
          ]);
          // Vilka quote-assets har Mike pengar i?
          const userQuotes = equity.cashBreakdown.filter(b => b.amount >= 1).map(b => b.asset);

          const systemPrompt = `Du är Hanna — Mike's AI-trading-agent. Du pratar svenska, konkret och mänskligt (ADHD-vänligt).

Mike's konto just nu (Binance ${mode === "live" ? "MAINNET — RIKTIGA PENGAR" : "TESTNET — gratis demo"}):
- Total equity: $${equity.totalUsdt.toFixed(2)}
- Cash: $${equity.cashUsdt.toFixed(2)} (${equity.cashBreakdown.map(b => `$${b.amount.toFixed(2)} ${b.asset}`).join(", ")})
- Öppna positioner: ${equity.positions.length} ${equity.positions.length > 0 ? "(top: " + equity.positions.slice(0,3).map(p => `${p.asset} $${p.valueUsdt.toFixed(2)}`).join(", ") + ")" : ""}

Säkerhetslås: ${mode === "live" ? `LIVE-mode: max $${MAX_LIVE_STAKE_USD}/trade, daglig loss-cap $${MAX_LIVE_DAILY_LOSS_USD}` : `TESTNET-mode: INGEN gräns, Mike har $50,499 demo. Kör vad han ber om — $500, $1000, vad som helst inom hans saldo.`}

Tradable symbols på Binance ${mode}: ${symbols.length} st (USDT + USDC quote-pairs).
Mike's quote-tillgång: ${userQuotes.join(", ") || "ingen"} — välj alltid pairs där quote = en tillgång Mike har.

Regler:
- Använd verktyget place_market_orders för att lägga riktiga orders. ALDRIG simulera.
- Om Mike säger "kör N trades på $X" → kalla place_market_orders med n_trades, amount_per_trade.
- Om Mike säger "stäng allt" → kalla close_all_positions.
- Om Mike frågar status/läge → kalla get_account_status.
- Om Mike vill ha DJUP analys ("vad tycker Advisor?", "borde jag köra?", "rekommendera setups", "analysera marknaden", "vad är bäst nu?") → kalla consult_advisor med Mike's fråga. Advisor är en senior trading-AI på Opus med marknadsdata + Mike's historik + chart-mönster. Använd advisor_recommendation som-är till Mike, eventuellt med din egen sammanfattning.
- Om Mike vill prata, fråga om åsikter, brainstorma → svara i prosa utan tool-call.
- Var ALLTID konkret. Säg vad du gör, inte "jag tänker på det".
- Om belopp < min_notional för en symbol — välj annan symbol som accepterar det.`;

          // Tools — Claude kan anropa dessa direkt
          const tools: Anthropic.Tool[] = [
            {
              name: "place_market_orders",
              description: "Lägger N st MARKET BUY-orders á $X på Binance, randomly valda symboler från Mike's quote-tillgångar. Symboler filtreras automatiskt på MIN_NOTIONAL.",
              input_schema: {
                type: "object",
                properties: {
                  n_trades: { type: "number", description: "Antal trades, 1-10" },
                  amount_per_trade: { type: "number", description: "USD-belopp per trade" },
                  quote_preference: { type: "string", enum: ["USDT", "USDC", "AUTO"], description: "Quote-asset preferens. AUTO = välj baserat på Mike's saldo." },
                  symbol_filter: { type: "string", description: "Optional: 'memecoins' / 'top' / 'random'. Default: random." },
                },
                required: ["n_trades", "amount_per_trade"],
              },
            },
            {
              name: "close_all_positions",
              description: "Stänger ALLA öppna positioner via MARKET SELL. Använd när Mike säger 'stäng allt' / 'sälj allt' / 'cash out'.",
              input_schema: { type: "object", properties: {}, required: [] },
            },
            {
              name: "get_account_status",
              description: "Hämtar färsk kontoöversikt: saldo, positioner, PnL. Använd när Mike frågar 'hur går det?' / 'status' / 'läge'.",
              input_schema: { type: "object", properties: {}, required: [] },
            },
            {
              name: "consult_advisor",
              description: "Konsultera Advisor (senior trading-AI på Claude Opus). Använd när Mike vill ha djup analys: 'vad tycker Advisor?', 'borde jag köra trades nu?', 'analysera marknaden', 'rekommendera setups'. Advisor får marknadsdata (klines, RSI, MACD), chart-mönster, Mike's trade-historik (W/L per symbol), tid på dagen, och svarar med strukturerad rekommendation. Använd INTE för enkla 'kör 3 trades'-kommandon — då place_market_orders direkt.",
              input_schema: {
                type: "object",
                properties: {
                  question: { type: "string", description: "Mike's exakta fråga eller den frågeställning Advisor ska besvara" },
                  symbols: { type: "array", items: { type: "string" }, description: "Symboler att analysera (default: BTCUSDT, ETHUSDT)" },
                },
                required: ["question"],
              },
            },
          ];

          // Bygg meddelande-historik
          const messages: Anthropic.MessageParam[] = (history || []).slice(-8).map(h => ({
            role: h.role,
            content: h.text,
          }));
          messages.push({ role: "user", content: message });

          const reply = await anthropic.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            system: systemPrompt,
            tools,
            messages,
          });

          // Plocka ut text + tool_use från svaret
          let replyText = "";
          let toolCall: { name: string; input: Record<string, unknown> } | null = null;
          for (const block of reply.content) {
            if (block.type === "text") replyText += block.text;
            if (block.type === "tool_use") toolCall = { name: block.name, input: block.input as Record<string, unknown> };
          }

          // Om tool_call finns: exekvera, lägg in resultat, be Claude svara igen
          let executedResult: unknown = null;
          if (toolCall) {
            executedResult = await executeChatTool(toolCall.name, toolCall.input, mode, client, symbols, userQuotes);
            // Andra runda — Claude får tool-result och formulerar slut-svar
            messages.push({ role: "assistant", content: reply.content });
            messages.push({
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: (reply.content.find(b => b.type === "tool_use") as Anthropic.ToolUseBlock).id,
                content: JSON.stringify(executedResult),
              }],
            });
            const finalReply = await anthropic.messages.create({
              model: "claude-haiku-4-5",
              max_tokens: 1024,
              system: systemPrompt,
              tools,
              messages,
            });
            replyText = finalReply.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlock).text).join("");
          }

          json(res, { ok: true, reply: replyText, toolCall: toolCall?.name, executed: executedResult });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // GET /api/binance/safety — visa nuvarande säkerhetslås-status
      if (url.pathname === "/api/binance/safety" && method === "GET") {
        json(res, {
          maxLiveStakeUsd: MAX_LIVE_STAKE_USD,
          maxLiveDailyLossUsd: MAX_LIVE_DAILY_LOSS_USD,
          liveDailyLossUsd,
          tradingAllowed: liveDailyLossUsd < MAX_LIVE_DAILY_LOSS_USD,
        });
        return;
      }

      // ═══════ OANDA INTEGRATION (forex demo + live) ═══════
      if (url.pathname === "/api/oanda/setup" && method === "POST") {
        const body = await readBody(req);
        const { apiToken, accountId, practice } = JSON.parse(body) as { apiToken: string; accountId: string; practice: boolean };
        if (!apiToken || !accountId) { res.writeHead(400); json(res, { error: "apiToken + accountId krävs" }); return; }
        try {
          const client = new OandaClient({ apiToken, accountId, practice: practice !== false });
          const hc = await client.healthCheck();
          if (!hc.ok) { json(res, { ok: false, error: hc.details }); return; }
          oandaCreds = { apiToken, accountId, practice: practice !== false };
          json(res, { ok: true, details: hc.details });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (url.pathname === "/api/oanda/account" && method === "GET") {
        if (!oandaCreds) { json(res, { error: "Oanda ej konfigurerat" }); return; }
        try {
          const client = new OandaClient(oandaCreds);
          const summary = await client.getAccountSummary();
          const positions = await client.getOpenPositions();
          json(res, { ok: true, mode: oandaCreds.practice ? "practice" : "live", summary, positions });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (url.pathname === "/api/oanda/order" && method === "POST") {
        if (!oandaCreds) { res.writeHead(400); json(res, { error: "Oanda ej konfigurerat" }); return; }
        const body = await readBody(req);
        const { symbol, side, units, clientOrderId } = JSON.parse(body) as { symbol: string; side: "BUY" | "SELL"; units: number; clientOrderId?: string };
        try {
          const client = new OandaClient(oandaCreds);
          const order = await client.placeMarketOrder({ symbol, side, units, clientOrderId });
          json(res, { ok: true, order });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // Status båda integrationer (för UI)
      if (url.pathname === "/api/integrations/status" && method === "GET") {
        json(res, {
          binance: {
            testnet: { configured: !!binanceTestnetCreds },
            live: { configured: !!binanceLiveCreds },
          },
          oanda: oandaCreds ? { configured: true, mode: oandaCreds.practice ? "practice" : "live" } : { configured: false },
          safety: {
            maxLiveStakeUsd: MAX_LIVE_STAKE_USD,
            maxLiveDailyLossUsd: MAX_LIVE_DAILY_LOSS_USD,
            liveDailyLossUsd,
          },
        });
        return;
      }

      // ── 404 ──
      res.writeHead(404);
      res.end("Not found");
    } catch (err) {
      log.error(`Server error: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(500);
      res.end("Internal error");
    }
  });

  server.listen(port, () => {
    log.ok(`Dashboard: http://localhost:${port}`);
    // Sätt upp Telegram-webhook om token finns
    const publicUrl = process.env.PUBLIC_URL || "https://trading.aiupscale.agency";
    if (process.env.TELEGRAM_BOT_TOKEN && publicUrl.startsWith("https://")) {
      setupTelegramWebhook(publicUrl).catch((err) => {
        log.error(`Telegram-webhook setup-fel: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  });

  return server;
}

function json(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
