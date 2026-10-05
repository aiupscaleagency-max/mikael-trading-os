import http from "node:http";
import { userAction, agentDone, agentFail, analysisStart, analysisEnd, getAnalysis } from "./agentActivity.js";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, hasLlmCredentials, getLlmDiagnostics } from "../llm/gateway.js";
import { loadState, saveState, loadRecentDecisions } from "../memory/store.js";
import { closedTrades, loadAnalyses, memorySummary } from "../memory/tradeMemory.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { computeIndicators } from "../indicators/ta.js";
import { log } from "../logger.js";
import { autoAllowed, saveExecutionMode, setExecutionMode } from "./executionModeStore.js";
import { config } from "../config.js";
import { getCostSummary } from "../cost/tracker.js";
import { handleUpdate as handleTelegramUpdate, sendMessage as sendTelegramMessage, setupWebhook as setupTelegramWebhook } from "./telegram.js";
import { getMarketSnapshot, formatSnapshotForPrompt } from "./marketContext.js";
import { detectAllPatterns, type Candle } from "./patternDetection.js";
import { startMarketStream, getCachedPrice } from "./marketStream.js";
import { initLiveLayer, handleLiveRoutes } from "./liveRoutes.js";
import { verifyAccessToken, signInWithPassword } from "../auth/supabase.js";
import { watchBybitKlines, getBybitClosedCandles, getBybitFormingCandle, BYBIT_INTERVAL } from "./bybitStream.js";
import { getJevStatus } from "./jevClient.js";
import { getSignals, refreshSignal } from "./signalEngine.js";
import { getKlineStreamStatus, getFormingCandle, getClosedCandles } from "./klineStream.js";
import { getAnalysisSession, startAnalysisSession, stopAnalysisSession, tickAnalysisSession } from "./analysisSession.js";
import { getTradeSizing, setTradePercent, refreshTradeSizing } from "../risk/tradeSizing.js";
import { getResults, recordLiveFill } from "./results.js";
import { getTradingState, invalidateTradingState } from "./tradingState.js";
import { getAnalysisSelection, setAnalysisSelection, validateAnalysisSelection } from "./analysisSelection.js";
import { validateAnalysisRequest, type AnalysisRequest } from "../orchestrator/analysisRequest.js";
import { CATEGORIES, getCategory, type Category } from "./movers.js";
import { addLiveTpSl, listLiveTpSl, removeLiveTpSl, removeLiveTpSlForSymbol, startLiveTpSl, pauseLiveTpSlForManualSale, isLiveTpSlSellingSymbol } from "./liveTpSl.js";
import { addTimedExit, cancelTimedExit, getHorizonMin, HORIZON_CHOICES, listTimedExits, MAX_AUTO_EXIT_SEC, setHorizonMin, startTradeHorizon, pauseLiveExitsForManualSale, isLiveTimedExitSelling } from "./tradeHorizon.js";
import { adjustLiveSpend, checkOrderGate, needsApproval, recordLiveSpend, liveAllowedByServer, addPendingOrder, listPendingOrders, getPendingOrder, updatePendingOrder, isExpired, getLiveSpentTodayUsd, liveStakeCapUsd, testStakeCapUsd, MAX_LIVE_DAILY_SPEND_USD, type PendingOrder } from "./orderGate.js";

// ═══════════════════════════════════════════════════════════════════════════
//  AUTH-GATE
//
//  Allt under /api/ kräver en giltig Supabase-session, levererad som
//  httpOnly-cookie. Tre undantag, och bara tre:
//   - /api/auth/login + /api/auth/logout  (annars går det inte att logga in)
//   - /api/telegram/webhook               (Telegram kan inte skicka cookies —
//                                          verifieras mot Telegrams egen
//                                          secret-token istället)
//
//  Fail-closed: saknas Supabase-konfiguration returnerar verifyAccessToken
//  null, och då nekas requesten. Ingen väg genom den här koden får släppa
//  igenom trafik när auth inte kan verifieras.
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_COOKIE = "tos_session";

const AUTH_EXEMPT_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/mode",
]);

// TILLFÄLLIGT: DASHBOARD_NO_LOGIN=true släpper in dashboarden utan inloggning,
// men bara från den egna datorn. Tunnlar (X-Forwarded-For), andra värdnamn
// (DNS-rebinding) och andra webbsidor i webbläsaren (Origin) nekas fortfarande.
// Ta bort raden i .env för att slå på inloggningen igen.
function isLocalNoLogin(req: http.IncomingMessage): boolean {
  if (process.env.DASHBOARD_NO_LOGIN !== "true") return false;
  const ip = req.socket.remoteAddress ?? "";
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") return false;
  if (req.headers["x-forwarded-for"] || req.headers["forwarded"]) return false;
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (host !== "localhost" && host !== "127.0.0.1") return false;
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return false;
  return true;
}

// Tailscale: samma "utan inloggning" även via Mikes tailnet (mobil, andra datorn).
// Bara när DASHBOARD_TAILNET_HOSTS anger värdnamnet, anslutningen kommer från
// `tailscale serve` på den här datorn (127.0.0.1) och avsändaren har en
// Tailscale-adress (100.64.0.0/10 eller fd7a:115c:a1e0::/48). Funnel/internet nekas.
function isTailnetNoLogin(req: http.IncomingMessage): boolean {
  if (process.env.DASHBOARD_NO_LOGIN !== "true") return false;
  const hosts = (process.env.DASHBOARD_TAILNET_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length) return false;
  const ip = req.socket.remoteAddress ?? "";
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") return false;
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!hosts.includes(host)) return false;
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() ?? "";
  const tailnetIp = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(fwd) || /^fd7a:115c:a1e0:/i.test(fwd);
  if (!tailnetIp) return false;
  const origin = req.headers.origin;
  if (origin) {
    const o = origin.toLowerCase().replace(/:\d+$/, "");
    if (!hosts.some((h) => o === `https://${h}`)) return false;
  }
  return true;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// json() svarar alltid 200 — den här behövs för fel-koder.
function jsonStatus(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Skydd mot dubbelklick på Godkänn
const approvingIds = new Set<string>();

// ─── Godkänd väntande order → lägg den på riktigt (TEST eller LIVE) ───
// Kör hela order-grinden IGEN vid godkännandet: kill switch eller LIVE-lås kan
// ha ändrats sedan ordern skapades.
async function executeApprovedOrder(
  p: PendingOrder,
  brokers: Record<string, BrokerAdapter>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; keepPending?: boolean }> {
  // Agentens förslag kan vara i antal mynt (t.ex. 3.29 st) utan belopp. Räkna då
  // ut beloppet från aktuellt pris, så att samma gränser ($ per order) gäller.
  let quoteUsd = p.quoteUsd;
  if (p.side === "BUY" && !(Number(quoteUsd) > 0) && Number(p.quantity) > 0) {
    let px = getCachedPrice(p.symbol);
    if (!px && p.venue.startsWith("broker:")) {
      const b = brokers[p.venue.slice("broker:".length)];
      px = b ? await b.getTicker(p.symbol).then((t) => Number(t.price) || null).catch(() => null) : null;
    }
    if (px) quoteUsd = Math.round(Number(p.quantity) * px * 100) / 100;
  }
  if (p.venue === "broker:bybit" && brokers.bybit) await refreshTradeSizing(brokers.bybit);
  if (p.venue === "broker:bybit-paper" && brokers["bybit-paper"]) await refreshTradeSizing(brokers["bybit-paper"]);
  const gate = await checkOrderGate({ live: p.live, side: p.side, quoteUsd, source: `godkänd:${p.source}` });
  // Spärrad just nu (t.ex. kill switch) → ordern får ligga kvar och kan godkännas senare
  if (!gate.ok) return { ok: false, error: gate.error, keepPending: true };
  try {
    if (p.venue.startsWith("broker:")) {
      if (!["broker:bybit", "broker:bybit-paper"].includes(p.venue)) return { ok: false, error: "Endast Bybit EU stöds" };
      const name = p.venue.slice("broker:".length);
      const broker = brokers[name];
      if (!broker) return { ok: false, error: `Mäklaren ${name} är inte kopplad längre` };
      if ((broker.mode === "live") !== p.live) {
        return { ok: false, error: "Mäklarens läge (TEST/LIVE) har ändrats sedan ordern skapades. Lägg den igen." };
      }
      // "Sälj allt": antalet = det du har fritt just nu
      let quantity = p.quantity;
      if (p.side === "SELL" && p.sellAll) {
        const base = p.symbol.toUpperCase().replace("/", "").replace(/(USDT|USDC|USD|EUR)$/, "");
        const acc = await broker.getAccount();
        quantity = acc.balances.find((b) => b.asset === base)?.free ?? 0;
        if (!(quantity > 0)) return { ok: false, error: `Du har inga ${base} att sälja.` };
      }
      const isMarket = p.orderType !== "LIMIT";
      // Tidshorisont: läs saldot FÖRE köpet, så att den automatiska försäljningen
      // aldrig rör mynt du redan hade
      const wantsTimedExit = p.side === "BUY" && !!p.horizonSec && p.horizonSec <= MAX_AUTO_EXIT_SEC;
      let baseline: number | undefined;
      if (wantsTimedExit) {
        const baseCoin = p.symbol.toUpperCase().replace("/", "").replace(/(USDT|USDC|USD|EUR)$/, "");
        baseline = await broker.getAccount().then((a) => { const b = a.balances.find((x) => x.asset === baseCoin); return (b?.free ?? 0) + (b?.locked ?? 0); });
      }
      // LIVE-köp: reservera beloppet mot dagstaket INNAN ordern skickas, så att
      // två snabba godkännanden inte båda kommer igenom. Ges tillbaka vid fel.
      const reserved = p.live && p.side === "BUY" ? Number(quoteUsd) || 0 : 0;
      if (reserved) {
        recordLiveSpend(reserved);
        if (getLiveSpentTodayUsd() > MAX_LIVE_DAILY_SPEND_USD + 1e-9) {
          adjustLiveSpend(-reserved);
          return { ok: false, error: `Dagens LIVE-gräns $${MAX_LIVE_DAILY_SPEND_USD} är nådd.`, keepPending: true };
        }
      }
      if (p.live && p.side === "SELL") {
        if (isLiveTimedExitSelling(p.symbol) || isLiveTpSlSellingSymbol(p.symbol)) return {ok:false,error:"En automatisk försäljning stäms av. Vänta innan du avslutar samma innehav.",keepPending:true};
        const reason = "Manuellt LIVE-avslut: återstående skydd kräver avstämning";
        pauseLiveExitsForManualSale(p.symbol, reason);
        pauseLiveTpSlForManualSale(p.symbol, reason);
      }
      let order;
      try {
        const orderRequest = {
          symbol: p.symbol,
          side: p.side,
          type: isMarket ? "MARKET" : "LIMIT",
          quoteOrderQty: quantity === undefined ? p.quoteUsd : undefined,
          quantity,
          price: p.orderType === "LIMIT" ? p.limitPrice : undefined,
          takeProfit: p.live && wantsTimedExit ? undefined : p.takeProfit,
          stopLoss: p.live && wantsTimedExit ? undefined : p.stopLoss,
        };
        if (p.tradeId) {
          if (p.live || p.side !== "SELL" || !isMarket) throw new Error("Lottavslut stöds endast för TEST spot-marknadsförsäljning");
          const paper = broker as unknown as { getTimedExitQuantity: (symbol: string, id: string) => Promise<number | null>; placeTimedExitOrder: (order: import("../types.js").OrderRequest, id: string) => Promise<import("../types.js").OrderResult> };
          const remaining = await paper.getTimedExitQuantity(p.symbol, p.tradeId);
          if (!(remaining !== null && remaining > 0) || quantity === undefined || quantity > remaining + 1e-12) throw new Error("Den valda tradens antal har ändrats; skapa ett nytt avslut");
          order = await paper.placeTimedExitOrder({ ...orderRequest, type: "MARKET" }, p.tradeId);
        } else { order = await broker.placeOrder({ ...orderRequest, type: isMarket ? "MARKET" : "LIMIT" }); }
      } catch (err) {
        if (reserved) adjustLiveSpend(-reserved);
        throw err;
      }
      if (reserved) adjustLiveSpend((order.cummulativeQuoteQty || reserved) - reserved);
      // LIVE-loggen för resultatfönstret
      if (p.live && order.executedQty > 0) {
        recordLiveFill({ symbol: p.symbol, side: p.side, qty: order.executedQty, price: order.avgFillPrice || (order.cummulativeQuoteQty / order.executedQty), usd: order.cummulativeQuoteQty || undefined, kind: p.sellAll ? "Sälj allt" : p.source === "agent" ? "agent" : "manuell" });
      }
      let tpslId: string | undefined;
      // LIVE marknadsköp med TP/SL: boten bevakar och säljer vid TP eller SL
      // Du sålde själv i LIVE → gamla TP/SL-bevakningar för myntet tas bort
      if (p.live && p.side === "SELL" && order.executedQty > 0) {
        const left = await broker.getPositions().catch(() => null);
        const base = p.symbol.replace(/USDC$/, "");
        if (left && !left.some((ps) => ps.baseAsset === base && ps.quantity > 1e-12)) {
          removeLiveTpSlForSymbol(p.symbol);
          for (const exit of listTimedExits().filter((x) => x.live && x.symbol === p.symbol && !x.pendingBuyOrderId)) cancelTimedExit(exit.id);
        }
      }
      if (p.live && p.side === "BUY" && (p.takeProfit !== undefined || p.stopLoss !== undefined)
        && order.executedQty > 0 && /^(filled|cancelled|canceled|PartiallyFilledCanceled)$/i.test(order.status)) {
        const entry = order.avgFillPrice || p.refPrice || getCachedPrice(p.symbol) || 0;
        // Fyllnaden syns ibland inte efter 1 s: uppskatta antalet (säljet tar ändå bara det som finns)
        const qty = order.executedQty > 0 ? order.executedQty : entry > 0 ? (Number(quoteUsd) || 0) / entry : 0;
        tpslId = addLiveTpSl({ broker: name, symbol: p.symbol, qty, entry, takeProfit: p.takeProfit, stopLoss: p.stopLoss });
      }
      // Tidshorisont ≤ 30 min: köpet säljs automatiskt när tiden är slut
      if (wantsTimedExit && p.horizonSec && (order.executedQty > 0 || !/reject|cancel/i.test(order.status))) {
        if (baseline === undefined) {
          log.warn(`[horisont] kunde inte läsa saldot före köpet av ${p.symbol}, ingen automatisk försäljning. Sälj själv.`);
        } else {
          const entryPx = order.avgFillPrice || p.refPrice || getCachedPrice(p.symbol) || 0;
          const pendingBuy = !/^(filled|cancelled|canceled|rejected|expired|PartiallyFilledCanceled|PartiallyFilledCancelled|Deactivated)$/i.test(order.status);
          const qtyHeld = order.executedQty > 0 ? order.executedQty : Number(p.quantity) || (entryPx > 0 ? (Number(quoteUsd) || 0) / entryPx : 1);
          addTimedExit({
            broker: name, symbol: p.symbol, qty: qtyHeld, live: p.live, horizonSec: p.horizonSec, baseline,
            tpslId, takeProfit: p.takeProfit, stopLoss: p.stopLoss, refPrice: p.refPrice, buyRecordedQty: order.executedQty, ...(pendingBuy ? { pendingBuyOrderId: order.orderId } : {}), paperGroup: !p.live && name === "bybit-paper" ? order.orderId : undefined,
          });
        }
      }
      log.trade(`[GODKÄND] ${p.side} ${p.symbol} via ${name} ${p.live ? "LIVE" : "TEST"} · status ${order.status}`);
      return { ok: true, result: order };
    }
    return { ok: false, error: `Okänd order-väg: ${p.venue}` };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

import { addCustomSymbol, removeCustomSymbol, listCustomSymbols } from "./customSymbols.js";
import { addKlineSymbol, removeKlineSymbol } from "./klineStream.js";
import { addTickerBase } from "./marketStream.js";

// ─── PUBLIC MARKET STREAM (price-cache i realtid) ───
// Eliminerar REST-polling för pris-data. Alla services kan läsa O(1) från memory.
// Källa: Bybit EU:s publika spotström.
startMarketStream();

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
//    POST /api/active-broker        → Byt aktiv broker { broker: "bybit-paper"|"bybit" }
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
  invalidateTradingState();
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

const verifiedAnalysisMarkets = new Map<string, number>();
async function verifyAnalysisMarkets(selection: {selectedSymbols:string[]}, broker: BrokerAdapter | undefined): Promise<void> {
  if (!broker) throw new Error("Analysens Bybit-konto saknas");
  for (const symbol of selection.selectedSymbols) {
    if ((verifiedAnalysisMarkets.get(symbol) ?? 0) > Date.now() - 300_000) continue;
    const ticker = await broker.getTicker(symbol);
    if (!Number.isFinite(ticker.price) || ticker.price <= 0) throw new Error(`Bybit EU-paret ${symbol} kunde inte verifieras`);
    verifiedAnalysisMarkets.set(symbol, Date.now());
    addTickerBase(symbol.replace(/USDC$/, ""), true);
  }
}

let anthropicApiKey: string | null = null;
let runAgentCallback: ((request: AnalysisRequest) => Promise<void>) | null = null;

export function setApiKey(key: string): void {
  anthropicApiKey = key;
}

export function setRunAgentCallback(cb: (request: AnalysisRequest) => Promise<void>): void {
  runAgentCallback = cb;
}

export function startServer(
  port: number,
  brokers: Record<string, BrokerAdapter>,
): http.Server {
  const uiDir = path.resolve(import.meta.dirname, "ui");
  // Bybit-websocket, live-lampor och strategibiblioteket (src/server/liveRoutes.ts)
  initLiveLayer(brokers, broadcastEvent);
  // Startad i LIVE (MODE=live + LIVE_TRADING_CONFIRMED) → Bybit LIVE är aktiv
  // mäklare direkt, så att en LIVE-order aldrig tyst blir TEST efter omstart.
  if (liveAllowedByServer() && brokers.bybit && !activeBrokerName) {
    activeBrokerName = "bybit";
    log.warn("LIVE: aktiv mäklare = Bybit EU (riktiga pengar, varje order väntar på Godkänn)");
  }
  // TP/SL för LIVE-marknadsköp (src/server/liveTpSl.ts)
  startLiveTpSl(brokers, broadcastEvent);
  startTradeHorizon(brokers, broadcastEvent);
  const refreshSizing = () => Promise.all(Object.values(brokers).map((b) => refreshTradeSizing(b).catch((err) => log.warn(`Kontovärdering: ${err instanceof Error ? err.message : String(err)}`))));
  void refreshSizing();
  const sessionTimer = setInterval(() => {
    void tickAnalysisSession(async (s) => {
      if (!runAgentCallback || config.executionMode !== "approve") throw new Error("Sessionen kräver en redo agent och manuellt godkännande");
      if (getAnalysis()?.status === "running") throw new Error("En annan analys pågår; nästa försök sker på nästa intervall");
      if (s.broker === "bybit" && !liveAllowedByServer()) throw new Error("LIVE är låst");
      activeBrokerName = s.broker;
      setTradePercent(s.percent); setHorizonMin(s.horizonMinutes);
      await getTradeSizing(brokers[s.broker]!);
      analysisStart("schema", `Session ${s.id}`, {broker:s.broker,requestId:s.id,selectedSymbols:s.selectedSymbols,timeframe:s.timeframe});
      try { await runAgentCallback({ selectedSymbols: s.selectedSymbols, timeframe: s.timeframe, requestId: s.id, instruction: `Session: ${s.percent} % av kontovärdet per trade, tidshorisont ${s.horizonMinutes} min. Endast Bybit EU spot. Alla förslag kräver Mikes manuella godkännande.` }); }
      catch (err) { analysisEnd({ status: "failed", reason: err instanceof Error ? err.message : String(err) }); throw err; }
      if (getAnalysis()?.status === "running") { analysisEnd({ status: "stopped", reason: "Analysen avbröts av befintliga spärrar" }); throw new Error("Analysen kördes inte; kontrollera kill switch och AI-budget"); }
    }).catch((err) => log.error(`Sessionsbevakning: ${String(err)}`));
  }, 1000);
  const sizingTimer = setInterval(() => { void refreshSizing(); }, 15_000);


  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const method = req.method ?? "GET";

    // CORS — wildcard är oförenligt med cookies (och skulle låta vilken sida
    // som helst anropa API:et med användarens session). Dashboarden är
    // same-origin, så bara en explicit konfigurerad origin tillåts.
    const allowedOrigin = process.env.PUBLIC_URL;
    if (allowedOrigin && req.headers.origin === allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      // ── AUTH-GATE (före all routing) ──
      if (url.pathname === "/api/telegram/webhook") {
        // Telegram signerar inte requests men skickar en delad secret-token
        // i en header när webhooken registrerats med den. Saknas den i miljön
        // är webhooken osäker och stängs helt hellre än att lämnas öppen.
        const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
        const provided = req.headers["x-telegram-bot-api-secret-token"];
        if (!expected || provided !== expected) {
          log.warn("Telegram-webhook avvisad: saknad eller felaktig secret-token");
          jsonStatus(res, 401, { error: "unauthorized" });
          return;
        }
      } else if (url.pathname.startsWith("/api/") && !AUTH_EXEMPT_PATHS.has(url.pathname) && !(isLocalNoLogin(req) || isTailnetNoLogin(req))) {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        const session = await verifyAccessToken(token);
        if (!session) {
          jsonStatus(res, 401, { error: "unauthorized" });
          return;
        }
        if (session.status !== "active") {
          // Kontot finns men får inte handla (suspenderat/avslutat). Tas
          // nästa request, så en suspendering slår igenom direkt utan att
          // vi behöver återkalla token hos Supabase.
          log.warn(`Nekade request från konto med status=${session.status}`);
          jsonStatus(res, 403, { error: "account_not_active", status: session.status });
          return;
        }
      }

      // ── Live-lagret: /api/live/*, /api/bybit/*, /api/strategies* ──
      if (await handleLiveRoutes(url, method, req, res)) return;

      // ── Login: sätter sessionen som httpOnly-cookie ──
      if (url.pathname === "/api/auth/login" && method === "POST") {
        let email = "", password = "";
        try {
          ({ email, password } = JSON.parse(await readBody(req)) as { email: string; password: string });
        } catch {
          jsonStatus(res, 400, { error: "invalid_body" });
          return;
        }
        if (!email || !password) {
          jsonStatus(res, 400, { error: "email + password krävs" });
          return;
        }
        const signed = await signInWithPassword(email, password);
        if (!signed) {
          // Medvetet ospecifikt: avslöja inte om adressen finns.
          log.warn(`Misslyckad inloggning för ${email.slice(0, 3)}***`);
          jsonStatus(res, 401, { error: "invalid_credentials" });
          return;
        }
        // Token går ALDRIG ut i bodyn — bara som cookie JavaScript inte når.
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie":
            `${SESSION_COOKIE}=${encodeURIComponent(signed.accessToken)}` +
            `; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${signed.expiresIn}`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Talar om för dashboarden om inloggningsskärmen ska hoppas över.
      // Samma kontroll som släpper igenom API-anropen, så svaret är bara
      // true från den egna datorn med DASHBOARD_NO_LOGIN=true.
      if (url.pathname === "/api/auth/mode" && method === "GET") {
        json(res, { noLogin: isLocalNoLogin(req) || isTailnetNoLogin(req) });
        return;
      }

      if (url.pathname === "/api/auth/logout" && method === "POST") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // ── Chart-biblioteket, serverat lokalt ──
      // TradingView Lightweight Charts (Apache 2.0) ligger i node_modules och
      // serveras härifrån istället för via CDN. Systemet ska fungera utan
      // internetåtkomst till tredjepart — bara börsen behöver nås.
      if (url.pathname === "/vendor/lightweight-charts.js" && method === "GET") {
        try {
          const libPath = path.resolve(
            import.meta.dirname,
            "../../node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js",
          );
          const js = await fs.readFile(libPath, "utf8");
          res.writeHead(200, {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=86400",
          });
          res.end(js);
        } catch {
          res.writeHead(404);
          res.end("// lightweight-charts saknas — kör npm install");
        }
        return;
      }

      // ── Signaler: indikatorer + LONG/SHORT per valutapar ──
      // Driver signalpanelen i dashboarden. Varje post innehåller riktning,
      // entry, stop-loss, target, R:R och skälen bakom — allt räknat på
      // STÄNGDA ljus.
      if (url.pathname === "/api/signals" && method === "GET") {
        const symbolParam = url.searchParams.get("symbol");
        if (symbolParam) {
          const interval = url.searchParams.get("interval") ?? "1m";
          await watchBybitKlines(symbolParam.toUpperCase().replace(/USDT$/, "USDC"), interval);
          const one = refreshSignal(symbolParam.toUpperCase().replace(/USDT$/, "USDC"), interval);
          json(res, { signals: one ? [one] : [], stream: getKlineStreamStatus() });
          return;
        }
        json(res, { signals: getSignals(), stream: getKlineStreamStatus() });
        return;
      }

      // ── Ljus för diagram ──
      // Stängda ljus plus det som byggs just nu. Det pågående är markerat
      // separat så gränssnittet kan rita det annorlunda och aldrig av
      // misstag behandla det som färdigt.
      if (url.pathname === "/api/candles" && method === "GET") {
        const symbol = (url.searchParams.get("symbol") ?? "BTCUSDC").toUpperCase();
        const interval = url.searchParams.get("interval") ?? "1m";
        if (!/^[A-Z0-9]{2,16}USDC$/.test(symbol) || !BYBIT_INTERVAL[interval]) { jsonStatus(res, 400, { error: "Välj ett Bybit EU USDC-par och ett giltigt intervall" }); return; }
        const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") ?? "200", 10) || 200));
        await watchBybitKlines(symbol, interval);
        const closed = getBybitClosedCandles(symbol, interval);
        json(res, {
          symbol, interval,
          closed: closed.slice(-limit),
          forming: getBybitFormingCandle(symbol, interval),
          source: "bybit-eu",
          stream: getKlineStreamStatus(),
        });
        return;
      }

      // ── SSE stream ──
      if (url.pathname === "/api/events" && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Bekräfta anslutningen direkt även när inga handelsbeslut skickas.
        res.write(": ansluten\n\n");
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
        if (getAnalysisSession()?.status === "running" || getAnalysis()?.status === "running") { jsonStatus(res, 409, { error: "Stoppa sessionen eller vänta tills analysen är klar innan du byter konto" }); return; }
        const body = await readBody(req);
        const { broker: name } = JSON.parse(body) as { broker: string };
        if (!brokers[name]) {
          jsonStatus(res, 400, { error: `Broker '${name}' finns inte. Tillgängliga: ${Object.keys(brokers).join(", ")}` });
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
                  liveAllowedByServer() && activeBrokerName === "bybit" ? "live" :
                  config.executionMode === "approve" ? "propose" : "live",
          activeBroker: activeBrokerName,
          // Ärligt svar till UI:t: kan LIVE över huvud taget användas just nu?
          liveAllowed: liveAllowedByServer(),
          liveKeys: { bybit: !!brokers.bybit },
          limits: { maxLiveStakeUsd: liveStakeCapUsd(), maxTestStakeUsd: testStakeCapUsd(), maxLiveDailySpendUsd: MAX_LIVE_DAILY_SPEND_USD, liveSpentTodayUsd: getLiveSpentTodayUsd() },
        });
        return;
      }

      // POST /api/mode
      //  - "paper"   → TEST. Ändrar INTE godkännande-läget.
      //  - "propose" → TEST + varje order väntar på godkännande (säkrare riktning, tillåten).
      //  - "live"    → bara om servern redan är startad med MODE=live och
      //                LIVE_TRADING_CONFIRMED=true i .env. Webbläsaren kan aldrig slå på
      //                riktiga pengar och skriver aldrig i .env.
      if (url.pathname === "/api/mode" && method === "POST") {
        if (getAnalysisSession()?.status === "running" || getAnalysis()?.status === "running") { jsonStatus(res, 409, { error: "Vänta tills analysen är klar och stoppa sessionen innan du byter läge" }); return; }
        const body = await readBody(req);
        const { uiMode } = JSON.parse(body) as { uiMode: "paper" | "propose" | "live" };

        if (uiMode === "live") {
          if (!liveAllowedByServer()) {
            jsonStatus(res, 409, {
              ok: false,
              error: "LIVE är låst. Riktiga pengar slås bara på i .env (MODE=live, LIVE_TRADING_CONFIRMED=true och live-nycklar) följt av omstart. Ingenting har ändrats.",
            });
            return;
          }
          log.warn("Dashboard bad om LIVE-vy (servern är redan startad i LIVE)");
          if (brokers.bybit) activeBrokerName = "bybit";
          broadcastEvent("mode-changed", { uiMode: "live", mode: config.mode, executionMode: config.executionMode });
          json(res, { ok: true, uiMode: "live", mode: config.mode, executionMode: config.executionMode });
          return;
        }

        if (uiMode === "propose" && config.executionMode !== "approve") {
          (config as { executionMode: string }).executionMode = "approve";
          log.warn("Godkännande-läge PÅ via dashboard (gäller tills omstart)");
        }
        if (uiMode !== "paper" && uiMode !== "propose") {
          jsonStatus(res, 400, { ok: false, error: `Okänt läge: ${String(uiMode)}` });
          return;
        }
        // TEST-knappen byter tillbaka till TEST-mäklaren (låtsaskontot)
        const testBroker = brokers["bybit-paper"] ? "bybit-paper" : brokers["bybit-demo"] ? "bybit-demo" : null;
        if (testBroker && activeBrokerName === "bybit") activeBrokerName = testBroker;
        broadcastEvent("mode-changed", { uiMode, mode: config.mode, executionMode: config.executionMode });
        json(res, { ok: true, uiMode, mode: config.mode, executionMode: config.executionMode, activeBroker: activeBrokerName });
        return;
      }

      if (url.pathname === "/api/llm-status" && method === "GET") { json(res, {...getLlmDiagnostics(),jev:getJevStatus(),pipeline:["JEV", "Teknisk agent", "Hanna"],port}); return; }
      if (["/api/trading-state", "/api/selected-symbols"].includes(url.pathname)) {
        const body = method === "POST" ? JSON.parse(await readBody(req)) as Record<string, unknown> : {};
        const name = String(body.broker ?? url.searchParams.get("broker") ?? (url.searchParams.get("mode") === "LIVE" ? "bybit" : activeBrokerName || "bybit-paper"));
        if (name !== "bybit" && name !== "bybit-paper") { jsonStatus(res, 400, {error: "Välj Bybit TEST eller LIVE"}); return; }
        const mode = name === "bybit" ? "LIVE" : "TEST";
        if (url.pathname === "/api/trading-state" && method === "GET") { json(res, await getTradingState(brokers, name)); return; }
        if (url.pathname === "/api/selected-symbols" && method === "GET") { json(res, {broker: name, ...getAnalysisSelection(mode)}); return; }
        if (url.pathname === "/api/selected-symbols" && method === "POST") {
          if (getAnalysisSession()?.status === "running" || getAnalysis()?.status === "running") { jsonStatus(res, 409, {error: "Vänta tills analysen är klar eller stoppa sessionen"}); return; }
          try { const checked = validateAnalysisSelection(body); await verifyAnalysisMarkets(checked, brokers[name]); const selection = setAnalysisSelection(mode, checked); broadcastEvent("selection", {broker: name}); json(res, {ok: true, broker: name, ...selection}); }
          catch (err) { jsonStatus(res, 400, {error: err instanceof Error ? err.message : "Ogiltigt urval"}); }
          return;
        }
        jsonStatus(res, 405, {error: "Metoden stöds inte"}); return;
      }

      // Resultatfönstret: affärer + öppna innehav med vinst/förlust (?mode=TEST|LIVE)
      if (url.pathname === "/api/results" && method === "GET") {
        const q = url.searchParams.get("mode");
        const mode = q === "LIVE" || q === "TEST" ? q : (activeBrokerName === "bybit" ? "LIVE" : "TEST");
        json(res, await getResults(brokers, mode, listLiveTpSl()));
        return;
      }

      // LIVE-köp som boten bevakar för TP/SL
      if (url.pathname === "/api/live-tpsl" && method === "GET") {
        json(res, { watches: listLiveTpSl() });
        return;
      }
      {
        const m = url.pathname.match(/^\/api\/live-tpsl\/([\w-]+)$/);
        if (m && method === "DELETE") {
          const ok = removeLiveTpSl(m[1] as string);
          if (ok) userAction(`tog bort LIVE TP/SL-bevakning ${m[1]}`, { to: "orders" });
          json(res, { ok });
          return;
        }
      }

      // ── Auto / manuellt för agenternas ordrar (knappen på Trade-sidan) ──
      // AUTO = agenterna lägger ordrar själva inom gränserna. Bara i TEST.
      // MANUELL = varje order hamnar i Väntande ordrar och väntar på Godkänn.
      if (url.pathname === "/api/execution-mode" && method === "POST") {
        if (getAnalysisSession()?.status === "running" || getAnalysis()?.status === "running") { jsonStatus(res, 409, { error: "Stoppa sessionen och vänta på analysen innan du ändrar godkännandeläge" }); return; }
        const { executionMode } = JSON.parse(await readBody(req)) as { executionMode?: string };
        if (executionMode !== "auto" && executionMode !== "approve") {
          jsonStatus(res, 400, { ok: false, error: "Välj auto eller approve." });
          return;
        }
        if (executionMode === "auto" && !autoAllowed()) {
          jsonStatus(res, 409, { ok: false, error: "AUTO går bara i TEST. I LIVE kräver varje order alltid Godkänn." });
          return;
        }
        setExecutionMode(executionMode);
        await saveExecutionMode(executionMode).catch((e) => log.warn(`Kunde inte spara auto/manuellt: ${(e as Error).message}`));
        log.warn(`Agenternas ordrar: ${executionMode === "auto" ? "AUTO (läggs direkt inom gränserna, TEST)" : "MANUELL (varje order väntar på Godkänn)"} — valt på Trade-sidan`);
        broadcastEvent("mode-changed", { mode: config.mode, executionMode: config.executionMode });
        json(res, { ok: true, executionMode: config.executionMode, autoAllowed: autoAllowed() });
        return;
      }

      // ── Egna mynt (tips från grupper) ──
      // Tradingminnet: sammanfattningen Hanna får + stängda TEST-affärer
      if (url.pathname === "/api/trade-memory" && method === "GET") {
        const [summary, trades, analyses] = await Promise.all([memorySummary(), closedTrades(), loadAnalyses(20)]);
        json(res, { summary, trades: trades.slice(-50), analyses });
        return;
      }
      // Mest rörelse just nu: ?interval=1|5|15|30 (saknas = vald tidshorisont)
      if (url.pathname === "/api/movers" && method === "GET") {
        try {
          const iv = Number(url.searchParams.get("interval")) || getHorizonMin();
          const c = url.searchParams.get("cat") || "move";
          const cat = (c in CATEGORIES ? c : "move") as Category;
          json(res, { ok: true, interval: iv, cat, categories: CATEGORIES, feePct: 0.5, movers: await getCategory(cat, iv, 10) });
        } catch (err) {
          jsonStatus(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (url.pathname === "/api/custom-symbols" && method === "GET") {
        json(res, { symbols: listCustomSymbols(), all: config.crypto.symbols });
        return;
      }
      if (url.pathname === "/api/custom-symbols" && method === "POST") {
        try {
          const b = JSON.parse((await readBody(req)) || "{}") as { symbol?: string; note?: string };
          const c = await addCustomSymbol(String(b.symbol ?? ""), b.note);
          void addKlineSymbol(c.symbol).catch((err) => log.warn(`[egna mynt] kline: ${err instanceof Error ? err.message : String(err)}`));
          addTickerBase(c.base, c.usdc);
          broadcastEvent("markets-changed", { symbol: c.symbol, action: "added" });
          userAction(`lade till ${c.base}`, { coin: c.symbol });
          json(res, { ok: true, symbol: c, all: config.crypto.symbols });
        } catch (err) {
          jsonStatus(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      {
        const m = url.pathname.match(/^\/api\/custom-symbols\/([A-Za-z0-9]{2,20})$/);
        if (m && method === "DELETE") {
          try {
            const c = removeCustomSymbol(m[1]!);
            removeKlineSymbol(c.symbol);
            broadcastEvent("markets-changed", { symbol: c.symbol, action: "removed" });
            json(res, { ok: true, removed: c.base, all: config.crypto.symbols });
          } catch (err) {
            jsonStatus(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }
      }

      // ── Väntande ordrar (EXECUTION_MODE=approve) ──
      if (url.pathname === "/api/pending-orders" && method === "GET") {
        json(res, { orders: await listPendingOrders(), executionMode: config.executionMode });
        return;
      }

      // POST /api/pending-orders — lägg en order som väntar på godkännande
      // body: { symbol, side, quoteUsd, source?, broker? }  (broker saknas = aktiv broker)
      if (url.pathname === "/api/pending-orders" && method === "POST") {
        const b = JSON.parse(await readBody(req)) as { symbol?: string; side?: string; quoteUsd?: number; source?: string; broker?: string; reason?: string; orderType?: string; limitPrice?: number; takeProfit?: number; stopLoss?: number; sellAll?: boolean; quantity?: number; tradeId?: string };
        const symbol = String(b.symbol || "").toUpperCase().replace(/[\/-]/g, "").replace(/USDT$/, "USDC");
        const side = b.side === "SELL" ? "SELL" : b.side === "BUY" ? "BUY" : null;
        const quoteUsd = Number(b.quoteUsd);
        if (!/^[A-Z0-9/]{3,20}$/.test(symbol) || !side) {
          jsonStatus(res, 400, { ok: false, error: "symbol och side (BUY/SELL) krävs" });
          return;
        }
        // Limit-order och TP/SL (valfritt). Utan dem blir det en marknadsorder som förut.
        const orderType = b.orderType === "LIMIT" ? "LIMIT" as const : "MARKET" as const;
        const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
        const limitPrice = orderType === "LIMIT" ? num(b.limitPrice) : undefined;
        const takeProfit = num(b.takeProfit), stopLoss = num(b.stopLoss);
        for (const [label, v] of [["Limitpris", limitPrice], ["TP", takeProfit], ["SL", stopLoss]] as const) {
          if (v !== undefined && !(Number.isFinite(v) && v > 0)) { jsonStatus(res, 400, { ok: false, error: `${label} måste vara ett pris över 0` }); return; }
        }
        if (orderType === "LIMIT" && limitPrice === undefined) { jsonStatus(res, 400, { ok: false, error: "Limit-order kräver ett pris" }); return; }
        const sellAll = side === "SELL" && b.sellAll === true;
        const quantity = b.quantity === undefined ? undefined : Number(b.quantity);
        if (quantity !== undefined && (side !== "SELL" || !Number.isFinite(quantity) || quantity <= 0)) { jsonStatus(res, 400, {error: "Ogiltigt antal för avslut"}); return; }
        const tradeId = typeof b.tradeId === "string" ? b.tradeId : undefined;
        if (tradeId && (side !== "SELL" || orderType !== "MARKET" || sellAll || !quantity || !/^[a-zA-Z0-9-]{1,100}$/.test(tradeId))) { jsonStatus(res, 400, {error: "Välj en TEST-trade och ett giltigt antal"}); return; }
        // Tidshorisont i sekunder (köp ≤ 30 min säljs automatiskt när tiden är slut)
        const hz = Number((b as { horizonSec?: unknown }).horizonSec);
        const horizonSec = side === "BUY" && Number.isFinite(hz) && hz > 0 ? Math.round(Math.min(hz, MAX_AUTO_EXIT_SEC)) : side === "BUY" ? getHorizonMin() * 60 : undefined;
        const brokerName = b.broker || activeBrokerName || Object.keys(brokers)[0];
        const broker = brokerName ? brokers[brokerName] : undefined;
        // TP/SL på marknadsorder: Bybit (LIVE bevakas av boten) och TEST-kontot klarar det
        const tpslOnMarket = broker?.name === "bybit" || broker?.name === "bybit-paper";
        if ((takeProfit !== undefined || stopLoss !== undefined) && orderType !== "LIMIT" && !tpslOnMarket) { jsonStatus(res, 400, { ok: false, error: "TP/SL kräver en limit-order" }); return; }
        if (orderType === "MARKET" && side === "BUY" && (takeProfit !== undefined || stopLoss !== undefined)) {
          const ref = getCachedPrice(symbol);
          if (ref && takeProfit !== undefined && takeProfit <= ref) { jsonStatus(res, 400, { ok: false, error: `TP ska vara över nuvarande pris (${ref})` }); return; }
          if (ref && stopLoss !== undefined && stopLoss >= ref) { jsonStatus(res, 400, { ok: false, error: `SL ska vara under nuvarande pris (${ref})` }); return; }
        }
        if (side === "SELL" && limitPrice !== undefined) {
          if (takeProfit !== undefined && takeProfit >= limitPrice) { jsonStatus(res, 400, { ok: false, error: "När du säljer ska TP vara under säljpriset" }); return; }
          if (stopLoss !== undefined && stopLoss <= limitPrice) { jsonStatus(res, 400, { ok: false, error: "När du säljer ska SL vara över säljpriset" }); return; }
        }
        if (side === "BUY" && limitPrice !== undefined) {
          if (takeProfit !== undefined && takeProfit <= limitPrice) { jsonStatus(res, 400, { ok: false, error: "TP ska vara över köppriset" }); return; }
          if (stopLoss !== undefined && stopLoss >= limitPrice) { jsonStatus(res, 400, { ok: false, error: "SL ska vara under köppriset" }); return; }
        }
        if (!broker) {
          jsonStatus(res, 409, { ok: false, error: "Ingen Bybit-mäklare är kopplad på servern." });
          return;
        }
        const live = broker.mode === "live";
        if (tradeId && live) { jsonStatus(res, 400, {error: "LIVE-innehav har ännu ingen verifierad lottjournal"}); return; }
        if (!sellAll && quantity === undefined && !(quoteUsd > 0)) { jsonStatus(res, 400, { ok: false, error: "Skriv ett belopp i USD" }); return; }
        // LIVE-köp: måste gå att sälja tillbaka (Bybits minsta order + marginal)
        const minBuy = (broker as { minBuyUsd?: (s: string) => Promise<number> }).minBuyUsd;
        if (live && side === "BUY" && minBuy) {
          const need = await minBuy.call(broker, symbol).catch(() => 0);
          if (need > 0 && quoteUsd < need) {
            json(res, { ok: false, error: `${symbol} kräver minst $${need.toFixed(2)} per köp för att kunna säljas tillbaka. Välj BTC (minst $1.10) eller höj beloppet.` });
            return;
          }
        }
        const gate = await checkOrderGate({ live, side, quoteUsd: sellAll ? undefined : quoteUsd, source: b.source || "dashboard" });
        if (!gate.ok) { json(res, { ok: false, error: gate.error }); return; }
        const p = await addPendingOrder({
          source: String(b.source || "dashboard").slice(0, 60),
          venue: `broker:${brokerName}`,
          live,
          symbol,
          side,
          quoteUsd: sellAll || quantity !== undefined ? undefined : quoteUsd,
          ...(quantity !== undefined ? {quantity} : {}),
          ...(tradeId ? {tradeId} : {}),
          ...(sellAll ? { sellAll: true } : {}),
          ...(orderType === "LIMIT" ? { orderType, limitPrice } : {}),
          ...(takeProfit !== undefined ? { takeProfit } : {}),
          ...(stopLoss !== undefined ? { stopLoss } : {}),
          reason: b.reason ? String(b.reason).slice(0, 200) : undefined,
          ...(horizonSec ? { horizonSec } : {}),
        });
        broadcastEvent("pending-orders", { id: p.id });
        userAction(`la ${side} ${symbol} ${sellAll ? "allt" : `$${quoteUsd}`} i kön (${live ? "LIVE" : "TEST"})`, { to: "orders", coin: symbol });
        json(res, { ok: true, pendingOrder: p });
        return;
      }

      // POST /api/pending-orders/:id/approve | /reject
      {
        const m = url.pathname.match(/^\/api\/pending-orders\/([0-9a-f-]{36})\/(approve|reject)$/);
        if (m && method === "POST") {
          const id = m[1] as string;
          const action = m[2] as string;
          if (approvingIds.has(id)) { json(res, { ok: false, error: "Ordern håller redan på att läggas" }); return; }
          // Lås direkt (före första await) så att ett dubbelklick aldrig skickar två ordrar
          if (action === "approve") approvingIds.add(id);
          const p = await getPendingOrder(id);
          if (!p) { approvingIds.delete(id); jsonStatus(res, 404, { ok: false, error: "Ordern finns inte" }); return; }
          if (p.status !== "pending") { approvingIds.delete(id); json(res, { ok: false, error: `Ordern är redan ${p.status}` }); return; }
          if (action === "approve" && isExpired(p)) {
            approvingIds.delete(id);
            await updatePendingOrder(id, { status: "expired" });
            broadcastEvent("pending-orders", { id });
            json(res, { ok: false, error: "Förslaget är för gammalt (tiden har gått ut). Kör en ny analys." });
            return;
          }
          if (action === "reject") {
            const upd = await updatePendingOrder(id, { status: "rejected" });
            log.info(`Väntande order avvisad: ${p.side} ${p.symbol}`);
            userAction(`avvisade ${p.side} ${p.symbol}`, { to: "orders", coin: p.symbol });
            broadcastEvent("pending-orders", { id });
            json(res, { ok: true, order: upd });
            return;
          }
          userAction(`godkände ${p.side} ${p.symbol}`, { to: "broker", coin: p.symbol });
          let result: Awaited<ReturnType<typeof executeApprovedOrder>>;
          // Låset släpps först när statusen är sparad (annars kan ett nytt
          // godkännande hinna se "pending" och skicka ordern en gång till)
          try { result = await executeApprovedOrder(p, brokers); } catch (err) { approvingIds.delete(id); throw err; }
          if (!result.ok && result.keepPending) {
            approvingIds.delete(id);
            json(res, { ok: false, order: p, error: `${result.error} Ordern ligger kvar och väntar.` });
            return;
          }
          let upd: Awaited<ReturnType<typeof updatePendingOrder>>;
          try {
            upd = await updatePendingOrder(id, result.ok
              ? { status: "done", result: result.result }
              : { status: "failed", error: result.error });
          } finally { approvingIds.delete(id); }
          broadcastEvent("pending-orders", { id });
          // Utfallet syns i trädet: lagd eller fel, med orsaken
          if (result.ok) agentDone("broker", `${p.side} ${p.symbol} lagd`);
          else agentFail("broker", `${p.side} ${p.symbol}: ${String(result.error).slice(0, 100)}`);
          json(res, { ok: result.ok, order: upd, error: result.ok ? undefined : result.error });
          return;
        }
      }

      if (url.pathname === "/api/analysis-session" && method === "GET") { json(res, { session: getAnalysisSession(), now: Date.now() }); return; }
      if (url.pathname === "/api/analysis-session" && method === "POST") {
        const b = JSON.parse(await readBody(req)) as Record<string, unknown>;
        if (b.action === "stop") stopAnalysisSession();
        else if (b.action === "start") {
          if (!runAgentCallback) { jsonStatus(res, 409, { error: "Agenten är inte redo" }); return; }
          if (getAnalysis()?.status === "running") { jsonStatus(res, 409, { error: "En analys körs redan" }); return; }
          if (config.executionMode !== "approve") { jsonStatus(res, 409, { error: "Session kräver manuellt godkännande-läge" }); return; }
          const name = String(b.broker);
          if (!brokers[name] || !["bybit", "bybit-paper"].includes(name)) { jsonStatus(res, 409, { error: "Kontot är inte kopplat" }); return; }
          if (name === "bybit" && !liveAllowedByServer()) { jsonStatus(res, 403, { error: "LIVE är låst på servern" }); return; }
          try { const selection = validateAnalysisSelection(b); await verifyAnalysisMarkets(selection, brokers[name]); setAnalysisSelection(name === "bybit" ? "LIVE" : "TEST", selection); startAnalysisSession({ ...b, ...selection }, selection.selectedSymbols); invalidateTradingState(); }
          catch (err) { jsonStatus(res, 400, { error: err instanceof Error ? err.message : String(err) }); return; }
        } else { jsonStatus(res, 400, { error: "Välj start eller stop" }); return; }
        json(res, { ok: true, session: getAnalysisSession(), now: Date.now() }); return;
      }

      // Samma kontovärde och procent styr alla beloppsval.
      if (url.pathname === "/api/trade-sizing" && (method === "GET" || method === "POST")) {
        const name = url.searchParams.get("broker") || activeBrokerName || (config.mode === "live" ? "bybit" : "bybit-paper");
        const broker = ["bybit", "bybit-paper"].includes(name) ? brokers[name] : undefined;
        if (!broker) { jsonStatus(res, 409, { error: "Bybit-kontot saknas", amount: 0 }); return; }
        if (method === "POST") {
          if (getAnalysisSession()?.status === "running") { jsonStatus(res, 409, { error: "Stoppa sessionen innan du ändrar insatsen" }); return; }
          const b = JSON.parse(await readBody(req)) as { percent?: unknown };
          if (!setTradePercent(b.percent)) { jsonStatus(res, 400, { error: "Välj 0,1–5 % per trade" }); return; }
        }
        const sizing = await getTradeSizing(broker);
        json(res, { ...sizing, ok: true });
        return;
      }

      // ── Tidshorisont (1/5/15/30 min) + automatiska stängningar ──
      if (url.pathname === "/api/trade-horizon" && method === "GET") {
        json(res, { minutes: getHorizonMin(), choices: HORIZON_CHOICES, exits: listTimedExits(), now: Date.now() });
        return;
      }
      if (url.pathname === "/api/trade-horizon" && method === "POST") {
        if (getAnalysisSession()?.status === "running") { jsonStatus(res, 409, { error: "Stoppa sessionen innan du ändrar tidshorisonten" }); return; }
        const b = JSON.parse((await readBody(req)) || "{}") as { minutes?: unknown };
        const m = setHorizonMin(b.minutes);
        if (m === null) { jsonStatus(res, 400, { ok: false, error: `Välj ${HORIZON_CHOICES.join(", ")} min` }); return; }
        userAction(`tidshorisont ${m} min`);
        broadcastEvent("trade-horizon", { minutes: m });
        json(res, { ok: true, minutes: m });
        return;
      }
      if (url.pathname === "/api/timed-exits" && method === "GET") {
        json(res, { exits: listTimedExits(), now: Date.now() });
        return;
      }
      {
        const m = url.pathname.match(/^\/api\/timed-exits\/([\w-]+)$/);
        if (m && method === "DELETE") { json(res, { ok: cancelTimedExit(m[1] as string) }); return; }
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
        userAction(`kill switch ${active ? "PÅ — inga köp" : "av"}`);
        json(res, { ok: true, active });
        return;
      }

      // ── Ask Agent (manuell fråga till valfri agent) ──
      if (url.pathname === "/api/ask-agent" && method === "POST") {
        const body = await readBody(req);
        const { agent, question } = JSON.parse(body) as { agent: string; question: string };

        const agentConfig = AGENT_PROMPTS[agent];
        if (!agentConfig) {
          jsonStatus(res, 400, { error: `Okänd agent: '${agent}'. Tillgängliga: ${Object.keys(AGENT_PROMPTS).join(", ")}` });
          return;
        }
        if (!anthropicApiKey && !hasLlmCredentials()) {
          jsonStatus(res, 500, { error: "ANTHROPIC_API_KEY ej konfigurerad" });
          return;
        }

        log.agent(`[Manual] Fråga till ${agent}: ${question.slice(0, 80)}...`);

        try {
          const client = createLlmClient(anthropicApiKey);

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
          jsonStatus(res, 500, { error: `Agent-fel: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }

      // ── Run Agent (trigga ny analys-turn, valfritt med Mikes instruktion) ──
      if (url.pathname === "/api/run-agent" && method === "POST") {
        if (getAnalysisSession()?.status === "running" || getAnalysis()?.status === "running") { jsonStatus(res, 409, { error: "En session eller analys pågår redan" }); return; }
        if (!runAgentCallback) {
          jsonStatus(res, 500, { error: "Agent-callback ej konfigurerad" });
          return;
        }
        userAction("startade en analys (Kör analys)", { to: "orchestrator" });

        let request: AnalysisRequest;
        try {
          const parsed = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
          const selection = validateAnalysisSelection(parsed);
          const broker = parsed.broker ?? activeBrokerName ?? "bybit-paper";
          if (broker !== "bybit" && broker !== "bybit-paper") throw new Error("Ogiltigt Bybit-konto");
          await verifyAnalysisMarkets(selection, brokers[broker]);
          request = validateAnalysisRequest({ ...selection, broker, instruction: typeof parsed.instruction === "string" ? parsed.instruction.trim().slice(0, 2000) : undefined,
            requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined }, selection.selectedSymbols);
          setAnalysisSelection(broker === "bybit" ? "LIVE" : "TEST", selection);
        } catch (err) { jsonStatus(res, 400, { error: err instanceof Error ? err.message : "Ogiltigt analysval" }); return; }
        log.info(`[API] Manuell analys: ${request.selectedSymbols.join(", ")} · ${request.timeframe}`);
        analysisStart("manuell", request.instruction, {...request, broker:request.broker || "bybit-paper"});
        json(res, { ok: true, message: "Analysen startar", selectedSymbols: request.selectedSymbols, timeframe: request.timeframe });
        runAgentCallback(request)
          .then(() => {
            // Turen kom aldrig till agenterna (t.ex. kill switch eller ingen mäklare).
            if (getAnalysis()?.status === "running") analysisEnd({ status: "stopped", reason: "Analysen kördes inte: kill switch på eller ingen mäklare kopplad." });
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`Manuell turn misslyckades: ${msg}`);
            if (getAnalysis()?.status === "running") analysisEnd({ status: "failed", reason: `Analysen misslyckades: ${msg.slice(0, 200)}` });
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
            jsonStatus(res, 400, { error: "clientId + state krävs" });
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
          jsonStatus(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (url.pathname === "/api/sync/load" && method === "GET") {
        const clientId = (url.searchParams.get("clientId") || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
        if (!clientId) {
          jsonStatus(res, 400, { error: "clientId krävs" });
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
            if (!anthropicApiKey && !hasLlmCredentials()) return "❌ Anthropic API-nyckel ej konfigurerad i backend.";
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
            const client = createLlmClient(anthropicApiKey);
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

      if (url.pathname === "/api/integrations/status" && method === "GET") {
        json(res, { bybit: { configured: !!brokers.bybit }, paper: { configured: !!brokers["bybit-paper"] },
          safety: { liveAllowed: liveAllowedByServer(), executionMode: config.executionMode,
            maxTestStakeUsd: testStakeCapUsd(), maxLiveStakeUsd: liveStakeCapUsd(),
            maxLiveDailySpendUsd: MAX_LIVE_DAILY_SPEND_USD, liveSpentTodayUsd: getLiveSpentTodayUsd() } });
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

  // Upptagen port = en bot kör redan. Avsluta i stället för att köra en andra
  // agent-loop i bakgrunden (dubbla analyser, dubbel AI-kostnad).
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(`Port ${port} används redan — en bot kör redan. Den här kopian stängs.`);
      process.exit(1);
    }
    log.error(`Dashboard-servern: ${err.message}`);
  });

  server.on("close", () => { clearInterval(sizingTimer); clearInterval(sessionTimer); });
  server.listen(port, () => {
    log.ok(`Dashboard: http://localhost:${port}`);
    if (process.env.DASHBOARD_NO_LOGIN === "true") {
      log.warn("DASHBOARD_NO_LOGIN=true — dashboarden öppen utan inloggning, bara från den här datorn.");
    }
    // Sätt upp Telegram-webhook om token finns
    // Telegram-webhooken kräver en publik https-adress. Utan PUBLIC_URL i .env
    // sätts ingen webhook (localhost går inte att nå utifrån).
    const publicUrl = process.env.PUBLIC_URL || "";
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
