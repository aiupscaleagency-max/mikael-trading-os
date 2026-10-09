import { dataDir, dataPath } from "../dataDir.js";
import http from "node:http";
import { userAction, agentDone, agentFail, analysisStart, analysisEnd, getAnalysis } from "./agentActivity.js";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, hasLlmCredentials } from "../llm/gateway.js";
import { loadState, saveState, loadRecentDecisions } from "../memory/store.js";
import { closedTrades, loadAnalyses, memorySummary } from "../memory/tradeMemory.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { computeIndicators } from "../indicators/ta.js";
import { log } from "../logger.js";
import { autoAllowed, saveExecutionMode, setExecutionMode } from "./executionModeStore.js";
import { config } from "../config.js";
import { getCostSummary } from "../cost/tracker.js";
import { IgBroker, IG_EXECUTION_OFF } from "../brokers/ig.js";
import { igMarketData } from "./igMarketData.js";
import { handleIgRoutes } from "./igRoutes.js";
import { igOrderExecutionEnabled } from "../integrations/igConnection.js";
import { currentStake } from "../risk/stakeLadder.js";
import { handleUpdate as handleTelegramUpdate, sendMessage as sendTelegramMessage, setupWebhook as setupTelegramWebhook } from "./telegram.js";
import { getMarketSnapshot, formatSnapshotForPrompt } from "./marketContext.js";
import { detectAllPatterns, type Candle } from "./patternDetection.js";
import { BinanceClient, type BinanceCredentials } from "./integrations/binance.js";
import { startPositionMonitor, recordEntry as recordPositionEntry, getMonitorStatus, setMonitorEnabled, setLiveAutoSell, initLessonsFromDisk } from "./positionMonitor.js";
import { OandaClient, type OandaCredentials } from "./integrations/oanda.js";
import { startMarketStream, getCachedPrice, getCachedTicker, getMarketStreamStatus } from "./marketStream.js";
import { initLiveLayer, handleLiveRoutes } from "./liveRoutes.js";
import { computePositionSize, validateOrderRisk } from "../risk/eliteRisk.js";
import { verifyAccessToken, signInWithPassword } from "../auth/supabase.js";
import { getSignals, refreshSignal } from "./signalEngine.js";
import { getKlineStreamStatus, getFormingCandle, getClosedCandles } from "./klineStream.js";
import { getResults, recordLiveFill } from "./results.js";
import { CATEGORIES, getCategory, type Category } from "./movers.js";
import { addLiveTpSl, listLiveTpSl, removeLiveTpSl, removeLiveTpSlForSymbol, startLiveTpSl } from "./liveTpSl.js";
import { addTimedExit, cancelTimedExit, cancelTimedExitForDeal, getHorizonMin, HORIZON_CHOICES, listTimedExits, MAX_AUTO_EXIT_SEC, setHorizonMin, startTradeHorizon } from "./tradeHorizon.js";
import { adjustLiveSpend, checkOrderGate, needsApproval, recordLiveSpend, liveAllowedByServer, addPendingOrder, listPendingOrders, getPendingOrder, updatePendingOrder, isExpired, getLiveSpentTodayUsd, MAX_LIVE_STAKE_USD, testStakeCapUsd, MAX_LIVE_DAILY_SPEND_USD, type PendingOrder } from "./orderGate.js";

// In-memory keys (per server-instans). DUAL-MODE: separat live + testnet samtidigt.
let binanceLiveCreds: BinanceCredentials | null = null;
let binanceTestnetCreds: BinanceCredentials | null = null;
let oandaCreds: OandaCredentials | null = null;

// Säkerhetslås för LIVE-mode (riktiga pengar)
// MAX_LIVE_STAKE_USD, MAX_TEST_STAKE_USD och dagsgränsen bor i orderGate.ts
const MAX_LIVE_DAILY_LOSS_USD = parseFloat(process.env.MAX_LIVE_DAILY_LOSS_USD || "10");
let liveDailyLossUsd = 0; // resettas vid midnatt
let lastResetDay = new Date().getUTCDate();

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

// Helper: välj rätt creds baserat på mode-param ("testnet" default)
function resolveBinanceCreds(mode: "testnet" | "live"): BinanceCredentials | null {
  return mode === "live" ? binanceLiveCreds : binanceTestnetCreds;
}

function initIntegrationsFromEnv(): void {
  // Samma namn som config.ts och .env.example:
  //   BINANCE_API_KEY/SECRET           = TESTNET (låtsaspengar)
  //   BINANCE_LIVE_API_KEY/SECRET      = LIVE (riktiga pengar)
  // BINANCE_TESTNET_API_KEY/SECRET läses också (äldre namn för testnet).
  // Live-nycklar tas ALDRIG från BINANCE_API_KEY, så en testnet-nyckel kan
  // inte av misstag bli "live" och tvärtom.
  const liveKey = process.env.BINANCE_LIVE_API_KEY;
  const liveSecret = process.env.BINANCE_LIVE_API_SECRET;
  if (liveKey && liveSecret) {
    binanceLiveCreds = { apiKey: liveKey, apiSecret: liveSecret, testnet: false };
    log.ok(`Binance LIVE-nycklar hittade (används bara när MODE=live)`);
  }
  const tnKey = process.env.BINANCE_TESTNET_API_KEY || process.env.BINANCE_API_KEY;
  const tnSecret = process.env.BINANCE_TESTNET_API_SECRET || process.env.BINANCE_API_SECRET;
  if (tnKey && tnSecret) {
    binanceTestnetCreds = { apiKey: tnKey, apiSecret: tnSecret, testnet: true };
    log.ok(`Binance TESTNET auto-init`);
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
// IG är plattformen: Binance-/Oanda-nycklar läses inte längre in (inga Binance/Oanda-anrop i körvägen).
void initIntegrationsFromEnv;
log.info(`IG: TEST = IG Demo, LIVE = IG Live. Orderläge Demo ${igOrderExecutionEnabled("demo") ? "PÅ" : "AV"} · Live ${igOrderExecutionEnabled("live") ? "PÅ" : "AV"}`);

// Starta autonom Position Monitor — ladda lärdomar + entries från disk FÖRST
// så agenten kommer ihåg över restarts
// Binance-positionsmonitorn startas inte längre (IG-positioner stängs med tidshorisont/Sälj nu).
initLessonsFromDisk().catch(err => log.warn(`[lessons] init fail: ${err instanceof Error ? err.message : String(err)}`));
void startPositionMonitor;

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
  const isIg = p.venue.startsWith("broker:") && brokers[p.venue.slice("broker:".length)] instanceof IgBroker;
  const gate = await checkOrderGate(isIg
    ? { live: p.live, side: p.side, unitsOrder: true, opening: !p.closeDealId, source: `godkänd:${p.source}` }
    : { live: p.live, side: p.side, quoteUsd, source: `godkänd:${p.source}` });
  // Spärrad just nu (t.ex. kill switch) → ordern får ligga kvar och kan godkännas senare
  if (!gate.ok) return { ok: false, error: gate.error, keepPending: true };
  try {
    if (p.venue === "binance") {
      const creds = resolveBinanceCreds(p.live ? "live" : "testnet");
      if (!creds) return { ok: false, error: `Binance ${p.live ? "LIVE" : "TEST"} är inte kopplad` };
      const client = new BinanceClient(creds);
      const order = p.quantity !== undefined
        ? await client.placeMarketOrder({ symbol: p.symbol, side: p.side, quantity: p.quantity })
        : await client.placeMarketOrder({ symbol: p.symbol, side: p.side, quoteOrderQty: p.quoteUsd });
      if (p.live && p.side === "BUY") recordLiveSpend(parseFloat(order.cummulativeQuoteQty) || p.quoteUsd || 0);
      log.trade(`[GODKÄND] ${p.side} ${p.symbol} via Binance ${p.live ? "LIVE" : "TEST"}`);
      return { ok: true, result: order };
    }
    if (p.venue.startsWith("broker:") && brokers[p.venue.slice("broker:".length)] instanceof IgBroker) {
      return executeIgOrder(p, brokers[p.venue.slice("broker:".length)] as IgBroker);
    }
    if (p.venue.startsWith("broker:")) {
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
      const isMarket = p.orderType !== "LIMIT";
      // Tidshorisont: läs saldot FÖRE köpet, så att den automatiska försäljningen
      // aldrig rör mynt du redan hade
      const wantsTimedExit = p.side === "BUY" && isMarket && !!p.horizonSec && p.horizonSec <= MAX_AUTO_EXIT_SEC;
      let baseline: number | undefined;
      if (wantsTimedExit) {
        const baseCoin = p.symbol.toUpperCase().replace("/", "").replace(/(USDT|USDC|USD|EUR)$/, "");
        baseline = await broker.getAccount().then((a) => a.balances.find((x) => x.asset === baseCoin)?.free ?? 0).catch(() => undefined);
      }
      let order;
      try {
        order = await broker.placeOrder({
          symbol: p.symbol,
          side: p.side,
          type: isMarket ? "MARKET" : "LIMIT",
          quoteOrderQty: quantity === undefined ? p.quoteUsd : undefined,
          quantity,
          price: p.orderType === "LIMIT" ? p.limitPrice : undefined,
          takeProfit: p.takeProfit,
          stopLoss: p.stopLoss,
        });
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
      if (p.live && p.side === "SELL") removeLiveTpSlForSymbol(p.symbol);
      if (p.live && p.side === "BUY" && isMarket && (p.takeProfit !== undefined || p.stopLoss !== undefined)
        && (order.executedQty > 0 || !/reject|cancel/i.test(order.status))) {
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
          const qtyHeld = order.executedQty > 0 ? order.executedQty : entryPx > 0 ? (Number(quoteUsd) || 0) / entryPx : 0;
          addTimedExit({
            broker: name, symbol: p.symbol, qty: qtyHeld, live: p.live, horizonSec: p.horizonSec, baseline,
            tpslId, paperGroup: !p.live && name === "bybit-paper" ? order.orderId : undefined,
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

// ─── IG: nytt förslag i Väntande ordrar (från dashboarden, popupen eller strategier) ───
// Insatsen är en andel (%) av IG-saldot i kontovalutan = marginalen ordern får använda.
export async function createIgPendingOrder(b: Record<string, unknown>, broker: IgBroker): Promise<
  { ok: true; pendingOrder: PendingOrder; quote: unknown } | { ok: false; error: string; status?: number; quote?: unknown }> {
  const symbol = String(b.symbol ?? "").trim();
  const side = b.side === "SELL" ? "SELL" : b.side === "BUY" ? "BUY" : null;
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(symbol) || !side) return { ok: false, error: "Välj ett IG-instrument (EPIC) och KÖP/SÄLJ" };
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const orderType = b.orderType === "LIMIT" ? "LIMIT" as const : "MARKET" as const;
  const limitPrice = orderType === "LIMIT" ? num(b.limitPrice) : undefined;
  let takeProfit = num(b.takeProfit), stopLoss = num(b.stopLoss);
  for (const [label, v] of [["Limitpris", limitPrice], ["Målpris", takeProfit], ["Stop-loss", stopLoss]] as const) {
    if (v !== undefined && !(Number.isFinite(v) && v > 0)) return { ok: false, error: `${label} måste vara ett pris över 0` };
  }
  if (orderType === "LIMIT" && limitPrice === undefined) return { ok: false, error: "Limit-order kräver ett pris" };
  let account, ticker;
  try { [account, ticker] = await Promise.all([broker.getAccount(), broker.getTicker(symbol)]); }
  catch (err) { return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) }; }
  if (takeProfit === undefined || stopLoss === undefined) {
    const lv = await broker.defaultLevels(symbol, side).catch(() => null);
    if (lv) { takeProfit ??= lv.takeProfit; stopLoss ??= lv.stopLoss; }
  }
  const ref = limitPrice ?? ticker.price;
  const sign = side === "BUY" ? 1 : -1;
  if (takeProfit !== undefined && sign * (takeProfit - ref) <= 0) return { ok: false, error: side === "BUY" ? `Målpris ska vara över priset (${ref})` : `Vid SÄLJ (kort) ska målpriset vara under priset (${ref})` };
  if (stopLoss !== undefined && sign * (ref - stopLoss) <= 0) return { ok: false, error: side === "BUY" ? `Stop-loss ska vara under priset (${ref})` : `Vid SÄLJ (kort) ska stop-loss vara över priset (${ref})` };
  const pct = Math.min(3, Math.max(0.1, Number(b.stakePct) || currentStake()?.pct || 1));
  const quantity = num(b.quantity);
  const stakeAmount = Math.round(((account.balance ?? 0) * pct / 100) * 100) / 100;
  const q = await broker.stakeQuote({ epic: symbol, direction: side, stake: stakeAmount, stopLoss, takeProfit }).catch((e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }) as { ok: boolean; reason?: string });
  if (!q.ok && quantity === undefined) return { ok: false, error: q.reason ?? "Storleken kunde inte räknas fram", quote: q };
  const gate = await checkOrderGate({ live: broker.mode === "live", side, unitsOrder: true, opening: true, source: String(b.source || "dashboard") });
  if (!gate.ok) return { ok: false, error: gate.error };
  const hz = Number(b.horizonSec);
  const horizonSec = Number.isFinite(hz) && hz > 0 ? Math.round(Math.min(hz, 30 * 86400)) : undefined;
  const p = await addPendingOrder({
    source: String(b.source || "dashboard").slice(0, 60), venue: `broker:${broker.name}`, live: broker.mode === "live",
    symbol, side, name: igMarketData.nameOf(symbol) ?? undefined, stakePct: pct, stakeAmount, currency: account.currency,
    ...(quantity !== undefined ? { quantity } : {}),
    ...(orderType === "LIMIT" ? { orderType, limitPrice } : {}),
    ...(takeProfit !== undefined ? { takeProfit } : {}), ...(stopLoss !== undefined ? { stopLoss } : {}),
    refPrice: ref, reason: b.reason ? String(b.reason).slice(0, 200) : undefined,
    ...(horizonSec ? { horizonSec } : {}),
  });
  return { ok: true, pendingOrder: p, quote: q };
}

// ─── IG: godkänd order → IG (granskning + bekräftelse i Codex igOrders) ───
// Orderläget AV (standard): inget skickas, ordern ligger kvar med ett tydligt besked.
// Okänt utfall: markeras som misslyckad och skickas ALDRIG om automatiskt.
async function executeIgOrder(p: PendingOrder, broker: IgBroker): Promise<{ ok: true; result: unknown } | { ok: false; error: string; keepPending?: boolean }> {
  if (!broker.executionEnabled()) {
    return { ok: false, keepPending: true, error: `${IG_EXECUTION_OFF} (IG ${broker.env === "live" ? "Live" : "Demo"}). Inget skickades till IG.` };
  }
  if ((broker.mode === "live") !== p.live) return { ok: false, error: "Miljön (Demo/Live) har ändrats sedan ordern skapades. Lägg den igen." };
  try {
    if (p.closeDealId) {
      const r = await broker.closePosition(p.closeDealId, p.symbol);
      cancelTimedExitForDeal(p.closeDealId);
      log.trade(`[GODKÄND] stäng ${p.symbol} (${p.closeDealId}) via ${broker.name}`);
      return { ok: true, result: r };
    }
    const order = await broker.placeOrder({
      symbol: p.symbol, side: p.side, type: p.orderType === "LIMIT" ? "LIMIT" : "MARKET",
      price: p.orderType === "LIMIT" ? p.limitPrice : undefined,
      quantity: p.quantity, stakeAmount: p.stakeAmount,
      takeProfit: p.takeProfit, stopLoss: p.stopLoss,
    });
    if (order.dealId && p.orderType !== "LIMIT" && p.horizonSec && p.horizonSec <= MAX_AUTO_EXIT_SEC) {
      addTimedExit({ broker: broker.name, symbol: p.symbol, qty: order.executedQty, live: p.live, horizonSec: p.horizonSec, baseline: 0, dealId: order.dealId });
    }
    log.trade(`[GODKÄND] ${p.side} ${p.symbol} via ${broker.name} · ${order.status}${order.dealId ? ` · deal ${order.dealId}` : ""}`);
    return { ok: true, result: order };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    return { ok: false, error: msg, keepPending: msg.startsWith(IG_EXECUTION_OFF) };
  }
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
      const gate = await checkOrderGate({ live: mode === "live", side: "SELL", source: "chat:close_all" });
      if (!gate.ok) { closes.push({ symbol: symInfo.symbol, qty: p.qty, ok: false, error: gate.error }); continue; }
      if (needsApproval()) {
        const stepSize = symInfo.stepSize || 0.000001;
        const qtyRounded = Math.floor(p.qty / stepSize) * stepSize;
        await addPendingOrder({ source: "chat:close_all", venue: "binance", live: mode === "live", symbol: symInfo.symbol, side: "SELL", quantity: qtyRounded, reason: "Stäng allt (chatten)" });
        closes.push({ symbol: symInfo.symbol, qty: qtyRounded, ok: false, error: "Väntar på ditt godkännande" });
        continue;
      }
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
    // Samma order-grind som allt annat (kill switch, LIVE-lås, max belopp, dagsgräns)
    if (mode === "live" && getLiveSpentTodayUsd() + amt * n > MAX_LIVE_DAILY_SPEND_USD) {
      return { ok: false, error: `Dagens LIVE-gräns är $${MAX_LIVE_DAILY_SPEND_USD}. ${n} × $${amt} skulle gå över (redan $${getLiveSpentTodayUsd().toFixed(2)} i dag).` };
    }
    const perOrderGate = await checkOrderGate({ live: mode === "live", side: "BUY", quoteUsd: amt, source: "chat:place_market_orders" });
    if (!perOrderGate.ok) return { ok: false, error: perOrderGate.error };
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
    // Pre-trade orderbook-check: avbryt om förväntad slippage > 50 bps (LIVE) eller 100 bps (TESTNET)
    const maxSlippageBps = mode === "live" ? 50 : 100;
    if (needsApproval()) {
      const queued = [];
      for (const s of shuffled) {
        queued.push(await addPendingOrder({ source: "chat:place_market_orders", venue: "binance", live: mode === "live", symbol: s.symbol, side: "BUY", quoteUsd: amt, reason: "Köp från chatten" }));
      }
      return {
        ok: true,
        executed: false,
        waiting_for_approval: queued.length,
        message: "Inga ordrar är lagda än. De väntar på Mikes godkännande under Väntande ordrar.",
        orders: queued.map(q => ({ id: q.id, symbol: q.symbol, quoteUsd: q.quoteUsd })),
      };
    }
    const fills = await Promise.all(shuffled.map(async (s) => {
      try {
        // Slippage-skydd: kolla orderbok-djup först (snabbt — publik endpoint, ingen rate-cost)
        try {
          const slip = await client.estimateSlippage(s.symbol, "BUY", amt);
          if (!slip.fillable) {
            return { symbol: s.symbol, ok: false, error: `Orderbok för tunn — kan ej fylla $${amt}` };
          }
          if (slip.slippageBps > maxSlippageBps) {
            return { symbol: s.symbol, ok: false, error: `Slippage ${slip.slippageBps.toFixed(0)} bps > cap ${maxSlippageBps} — skipped` };
          }
        } catch { /* slippage-check failure ska inte blocka, fortsätt med order */ }

        const fill = await client.placeMarketOrder({ symbol: s.symbol, side: "BUY", quoteOrderQty: amt });
        if (mode === "live") recordLiveSpend(parseFloat(fill.cummulativeQuoteQty) || amt);
        const fillPrice = parseFloat(fill.cummulativeQuoteQty) / parseFloat(fill.executedQty);
        // Registrera entry till PositionMonitor så den vet när auto-sell ska triggas
        recordPositionEntry(s.baseAsset, mode, fillPrice, parseFloat(fill.executedQty));
        // Invalidera portfolio-cache så nästa /portfolio-trades hämtar färska siffror
        portfolioStatsCache.delete(mode);
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
  if (!hasLlmCredentials()) throw new Error("AI_GATEWAY_API_KEY eller ANTHROPIC_API_KEY ej satt");
  const anthropic = createLlmClient();

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
      // Pattern-detection kan crasha på korta arrayer — gör det optional
      let patterns1h: string[] = [], patterns4h: string[] = [];
      try {
        const candles1h: Candle[] = klines1h.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
        patterns1h = detectAllPatterns(candles1h).slice(-5).map(p => p.type);
      } catch (e) { /* skip */ }
      try {
        const candles4h: Candle[] = klines4h.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
        patterns4h = detectAllPatterns(candles4h).slice(-3).map(p => p.type);
      } catch (e) { /* skip */ }
      // Enkla indikatorer — robust mot korta arrays
      if (!klines1h || klines1h.length < 25) {
        return { symbol: sym, price, error: `Otillräckligt med klines (${klines1h?.length || 0}) för indikatorer` };
      }
      const closes = klines1h.map(k => k.close);
      const len = closes.length;
      const sma20 = closes.slice(-Math.min(20, len)).reduce((s,c) => s+c, 0) / Math.min(20, len);
      const sma50 = closes.slice(-Math.min(50, len)).reduce((s,c) => s+c, 0) / Math.min(50, len);
      // Index plockas ut i lokala variabler: closes är garanterat icke-tom
      // här (klines1h kontrolleras ovan), men TypeScript ser inte det genom
      // en index-access, och ?? 0 skulle tyst ge 0 % förändring vid ett fel.
      const lastClose = closes[len - 1] ?? 0;
      const baseClose = closes[Math.max(0, len - 25)] ?? lastClose;
      const change24h = baseClose > 0 ? ((lastClose - baseClose) / baseClose) * 100 : 0;
      // RSI (14)
      let gains = 0, losses = 0;
      const rsiStart = Math.max(1, len-15);
      for (let i = rsiStart; i < len; i++) {
        const cur = closes[i], prev = closes[i - 1];
        if (cur === undefined || prev === undefined) continue;
        const diff = cur - prev;
        if (diff > 0) gains += diff; else losses -= diff;
      }
      const rs = gains / (losses || 1);
      const rsi14 = 100 - (100 / (1 + rs));
      return {
        symbol: sym, price, change_24h_pct: change24h.toFixed(2),
        sma20: sma20.toFixed(2), sma50: sma50.toFixed(2),
        trend: price > sma20 && sma20 > sma50 ? "UPTREND" : (price < sma20 && sma20 < sma50 ? "DOWNTREND" : "RANGING"),
        rsi14: rsi14.toFixed(1),
        patterns_1h: patterns1h,
        patterns_4h: patterns4h,
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

  // Hämta LIVE equity för dynamisk advisor-kontext (ej hårdkodat belopp)
  let userEquityHint = "";
  try {
    const eq = await userClient.getTotalEquity();
    userEquityHint = `Mike's nuvarande ${mode}-saldo: total $${eq.totalUsdt.toFixed(2)}, cash $${eq.cashUsdt.toFixed(2)}, ${eq.positions.length} öppna positioner.`;
  } catch { /* fallback utan saldo */ }

  const advisorSystem = `Du är ADVISOR — Mike's senior trading-AI på Claude Opus. Mike's huvud-agent (Hanna, Haiku) konsulterar dig för djup analys.

Din roll:
- Strikt data-driven. Inga magkänslor utan stöd i siffrorna.
- Referera ALLTID till Mike's faktiska historik när du gör rekommendationer ("din SOLUSDT-history visar 3W/1L").
- Time-of-day och weekday-bias: notera om vi är i lågvolym-ASIA, högvolym-US, eller weekend (krypto = 24/7 men volym dippar).
- Kombinera: trend (SMA20 vs SMA50) + momentum (RSI) + chart-mönster + Mike's egna edge per symbol.
- Var konkret: rekommendera SPECIFIKA symbols + amount.
- Om setup är dålig — säg det rakt ut, ingen FOMO. "Vänta" är ett legitimt råd.
- Svara KORT (max 6 punkter, ADHD-vänligt). Mike vill action eller "vänta", inte essäer.

Mode: ${mode === "live"
  ? `LIVE — RIKTIGA PENGAR (säkerhetslås max $${MAX_LIVE_STAKE_USD}/trade, daglig $${MAX_LIVE_DAILY_LOSS_USD}). Pusha INTE Mike över dessa.`
  : `TESTNET — gratis demo-pengar. INGEN $-gräns, men håll dig inom Mike's faktiska saldo. Var generös med rekommendationer i testnet.`}
${userEquityHint}`;

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
import { addKlineSymbol, removeKlineSymbol } from "./klineStream.js";
import { addTickerBase } from "./marketStream.js";
interface UserStream { ws: WebSocket; listenKey: string; keepAlive: NodeJS.Timeout; client: BinanceClient }
const userStreams: Map<"testnet" | "live", UserStream> = new Map();
const userStreamRetryAttempt = new Map<"testnet" | "live", number>();

async function startUserDataStream(mode: "testnet" | "live"): Promise<void> {
  const creds = resolveBinanceCreds(mode);
  if (!creds) return;
  if (userStreams.has(mode)) return;
  try {
    const client = new BinanceClient(creds);
    const listenKey = await client.createListenKey();
    const wsUrl = `${client.getWsUrl()}/${listenKey}`;
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      log.ok(`[binance-${mode}] user-data-stream öppnad (real-time order/balance events)`);
      userStreamRetryAttempt.set(mode, 0); // återställ backoff vid lyckad anslutning
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Invalidera portfolio-cache vid varje event så nästa request hämtar färska siffror
        portfolioStatsCache.delete(mode);
        broadcastUserStream(msg.e || "update", { mode, ...msg });
        // Logga viktiga event för observability
        if (msg.e === "executionReport" && (msg.X === "FILLED" || msg.X === "PARTIALLY_FILLED")) {
          log.ok(`[binance-${mode}] ${msg.X} ${msg.S} ${msg.s} qty=${msg.z} avg=${msg.Z && msg.z ? (parseFloat(msg.Z) / parseFloat(msg.z)).toFixed(6) : "?"}`);
        }
      } catch { /* ignore malformed */ }
    });
    ws.on("error", (err) => log.warn(`[binance-${mode}] WS error: ${err.message}`));
    ws.on("close", (code, reason) => {
      const entry = userStreams.get(mode);
      if (entry) {
        clearInterval(entry.keepAlive);
        entry.client.closeListenKey(entry.listenKey).catch(() => { /* best-effort */ });
      }
      userStreams.delete(mode);
      const attempt = (userStreamRetryAttempt.get(mode) || 0) + 1;
      userStreamRetryAttempt.set(mode, attempt);
      const delayMs = Math.min(120_000, 5000 * Math.pow(2, Math.min(attempt - 1, 5)));
      log.warn(`[binance-${mode}] WS stängd code=${code} — återansluter om ${delayMs / 1000}s (försök ${attempt})`);
      setTimeout(() => startUserDataStream(mode), delayMs);
    });
    // Keep-alive listenKey var 30 min (Binance spec: behövs för att hindra invalidering vid 60min)
    const keepAlive = setInterval(() => {
      client.keepAliveListenKey(listenKey).catch((e) => log.warn(`[binance-${mode}] keepAlive fail: ${e.message}`));
    }, 30 * 60 * 1000);
    userStreams.set(mode, { ws, listenKey, keepAlive, client });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const attempt = (userStreamRetryAttempt.get(mode) || 0) + 1;
    userStreamRetryAttempt.set(mode, attempt);
    // Vid 410 (permission saknas): vänta 5min innan vi retry:ar — det kräver manuell key-fix
    const isPermError = errMsg.includes("410") || errMsg.includes("permission");
    const delayMs = isPermError ? 300_000 : Math.min(120_000, 30_000 * Math.pow(2, Math.min(attempt - 1, 3)));
    log.warn(`[binance-${mode}] user-data-stream init fail: ${errMsg} — retry om ${delayMs / 1000}s (försök ${attempt})`);
    setTimeout(() => startUserDataStream(mode), delayMs);
  }
}
// ─── AKTIVERAD: WS-streams med graceful failure-handling ───
// Tidigare pausade pga 410 på createListenKey. Nu med:
//  - Bättre felmeddelande som diagnoserar 410 → 'API-key permission saknas'
//  - Exponential backoff vid återanslutning (5s, 30s, 120s)
//  - Polling fortsätter parallellt som fallback om WS misslyckas
void startUserDataStream; // Binance-användarströmmen används inte med IG

// ─── PUBLIC MARKET STREAM (price-cache i realtid) ───
// Eliminerar REST-polling för pris-data. Alla services kan läsa O(1) från memory.
// Källa: wss://stream.binance.com:9443/ws/!miniTicker@arr (mainnet, publik, ingen auth).
startMarketStream(); // IG-kvoter (src/server/igMarketData.ts)

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
  igMarketData.setActiveEnv(name === "ig" ? "live" : "demo");
}
/** Aktiv mäklare: IG Live bara när den uttryckligen valts, annars IG Demo. */
function activeName(brokers: Record<string, BrokerAdapter>): string | undefined {
  return activeBrokerName && brokers[activeBrokerName] ? activeBrokerName : brokers["ig-demo"] ? "ig-demo" : Object.keys(brokers)[0];
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
  // Bybit-websocket, live-lampor och strategibiblioteket (src/server/liveRoutes.ts)
  initLiveLayer(brokers, broadcastEvent);
  // Startad i LIVE (MODE=live + LIVE_TRADING_CONFIRMED) → Bybit LIVE är aktiv
  // mäklare direkt, så att en LIVE-order aldrig tyst blir TEST efter omstart.
  if (liveAllowedByServer() && brokers.ig && !activeBrokerName) {
    setActiveBrokerName("ig");
    log.warn("LIVE: aktiv mäklare = IG Live (riktiga pengar, varje order väntar på Godkänn)");
  } else if (!activeBrokerName && brokers["ig-demo"]) setActiveBrokerName("ig-demo");
  // IG sätter TP/SL (limit/stop) direkt på positionen hos IG, så botens egen
  // TP/SL-bevakning (src/server/liveTpSl.ts, för Bybit-marknadsköp) startas inte.
  void startLiveTpSl;
  startTradeHorizon(brokers, broadcastEvent);

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

      // ── IG: status/anslutning, saldo, pengar för en order, marknadsdata (src/server/igRoutes.ts) ──
      if (await handleIgRoutes(url, method, req, res, readBody, brokers, () => activeName(brokers), broadcastEvent, (o) => addPendingOrder(o as never))) return;

      // Binance/Oanda är inte längre plattformar: inga anrop dit från körvägen.
      if (url.pathname.startsWith("/api/binance/") || url.pathname.startsWith("/api/oanda/")) {
        jsonStatus(res, 410, { ok: false, error: "Borttagen: plattformen är IG (TEST = IG Demo, LIVE = IG Live)." });
        return;
      }

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
          const one = refreshSignal(symbolParam.toUpperCase(), interval);
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
        const symbol = (url.searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
        const interval = url.searchParams.get("interval") ?? "1m";
        const limit = Math.min(1000, parseInt(url.searchParams.get("limit") ?? "200", 10));
        const closed = getClosedCandles(symbol, interval);
        json(res, {
          symbol, interval,
          closed: closed.slice(-limit),
          forming: getFormingCandle(symbol, interval),
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
        const list = Object.entries(brokers).map(([name, broker]) => {
          const ig = broker instanceof IgBroker ? broker : null;
          const st = ig?.status();
          return {
            name,
            mode: broker.mode,
            label: ig ? (ig.env === "live" ? "IG Live" : "IG Demo") : name,
            env: ig?.env ?? null,
            connected: st?.status === "connected",
            connection: st ? { status: st.status, error: st.error, currency: st.account?.currency ?? null, accountType: st.account?.accountType ?? null } : null,
            executionEnabled: ig ? ig.executionEnabled() : false,
            active: (activeBrokerName ?? Object.keys(brokers)[0]) === name,
          };
        });
        json(res, { brokers: list, activeBroker: activeBrokerName ?? Object.keys(brokers)[0] ?? null });
        return;
      }

      // ── Byt aktiv broker ──
      if (url.pathname === "/api/active-broker" && method === "POST") {
        const body = await readBody(req);
        const { broker: name } = JSON.parse(body) as { broker: string };
        if (!brokers[name]) {
          jsonStatus(res, 400, { error: `Broker '${name}' finns inte. Tillgängliga: ${Object.keys(brokers).join(", ")}` });
          return;
        }
        if (brokers[name]!.mode === "live" && !liveAllowedByServer()) {
          jsonStatus(res, 409, { error: "IG Live är låst. Riktiga pengar slås bara på i .env (MODE=live, LIVE_TRADING_CONFIRMED=true) och omstart." });
          return;
        }
        setActiveBrokerName(name);
        broadcastEvent("broker-changed", { activeBroker: name, env: igMarketData.getActiveEnv() });
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
                  liveAllowedByServer() && activeBrokerName === "ig" ? "live" :
                  config.executionMode === "approve" ? "propose" : "live",
          activeBroker: activeBrokerName,
          // Ärligt svar till UI:t: kan LIVE över huvud taget användas just nu?
          liveAllowed: liveAllowedByServer(),
          liveKeys: { ig: !!brokers.ig && (brokers.ig as IgBroker).status().credentialsComplete },
          platform: "IG", env: igMarketData.getActiveEnv(),
          execution: { demo: igOrderExecutionEnabled("demo"), live: igOrderExecutionEnabled("live") },
          limits: { maxLiveStakeUsd: MAX_LIVE_STAKE_USD, maxTestStakeUsd: testStakeCapUsd(), maxLiveDailySpendUsd: MAX_LIVE_DAILY_SPEND_USD, liveSpentTodayUsd: getLiveSpentTodayUsd() },
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
          if (brokers.ig) setActiveBrokerName("ig");
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
        if (activeBrokerName === "ig" || !activeBrokerName) setActiveBrokerName("ig-demo");
        broadcastEvent("mode-changed", { uiMode, mode: config.mode, executionMode: config.executionMode });
        json(res, { ok: true, uiMode, mode: config.mode, executionMode: config.executionMode, activeBroker: activeBrokerName });
        return;
      }

      // Resultatfönstret: affärer + öppna innehav med vinst/förlust (?mode=TEST|LIVE)
      if (url.pathname === "/api/results" && method === "GET") {
        const q = url.searchParams.get("mode");
        const mode = q === "LIVE" || q === "TEST" ? q : (activeBrokerName === "ig" ? "LIVE" : "TEST");
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
          const movers = await getCategory(cat, iv, 10);
          json(res, { ok: true, interval: iv, cat, categories: CATEGORIES, feePct: null, source: `IG ${igMarketData.getActiveEnv() === "live" ? "Live" : "Demo"}`, note: movers.note ?? null, movers: [...movers] });
        } catch (err) {
          jsonStatus(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // Egna instrument = IG-bevakningslistan (EPICs verifierade mot kontot). Bybit-uppslaget används inte.
      if (url.pathname === "/api/custom-symbols" && method === "GET") {
        const w = igMarketData.watchlistDetailed();
        json(res, { symbols: w.map((x) => ({ symbol: x.epic, base: x.name ?? x.epic, epic: x.epic, name: x.name, category: x.category })), all: w.map((x) => x.epic) });
        return;
      }
      if (url.pathname === "/api/custom-symbols" && method === "POST") {
        try {
          const b = JSON.parse((await readBody(req)) || "{}") as { symbol?: string; epic?: string };
          const added = await igMarketData.addWatch(String(b.epic ?? b.symbol ?? "").trim());
          userAction(`lade till ${added.name ?? added.epic}`, { coin: added.epic });
          json(res, { ok: true, symbol: { symbol: added.epic, base: added.name ?? added.epic, epic: added.epic, name: added.name }, all: igMarketData.watchlist() });
        } catch (err) {
          jsonStatus(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      {
        const m = url.pathname.match(/^\/api\/custom-symbols\/([A-Za-z0-9._-]{2,100})$/);
        if (m && method === "DELETE") {
          igMarketData.removeWatch(m[1]!);
          json(res, { ok: true, removed: m[1], all: igMarketData.watchlist() });
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
        const b = JSON.parse(await readBody(req)) as { symbol?: string; side?: string; quoteUsd?: number; source?: string; broker?: string; reason?: string; orderType?: string; limitPrice?: number; takeProfit?: number; stopLoss?: number; sellAll?: boolean };
        {
          const igName = b.broker || activeName(brokers);
          const igb = igName ? brokers[igName] : undefined;
          if (igb instanceof IgBroker) {
            const r = await createIgPendingOrder(b as Record<string, unknown>, igb);
            if (r.ok) {
              broadcastEvent("pending-orders", { id: r.pendingOrder.id });
              userAction(`la ${r.pendingOrder.side} ${r.pendingOrder.name ?? r.pendingOrder.symbol} i kön (${igb.env === "live" ? "IG Live" : "IG Demo"})`, { to: "orders", coin: r.pendingOrder.symbol });
              json(res, r);
            } else jsonStatus(res, r.status ?? 400, r);
            return;
          }
        }
        const symbol = String(b.symbol || "").toUpperCase();
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
        // Tidshorisont i sekunder (köp ≤ 30 min säljs automatiskt när tiden är slut)
        const hz = Number((b as { horizonSec?: unknown }).horizonSec);
        const horizonSec = side === "BUY" && Number.isFinite(hz) && hz > 0 ? Math.round(Math.min(hz, 30 * 86400)) : undefined;
        const brokerName = b.broker || activeBrokerName || Object.keys(brokers)[0];
        const broker = brokerName ? brokers[brokerName] : undefined;
        // TP/SL på marknadsorder: Bybit (LIVE bevakas av boten) och TEST-kontot klarar det
        const tpslOnMarket = broker?.name === "bybit" || broker?.name === "bybit-paper";
        if ((takeProfit !== undefined || stopLoss !== undefined) && orderType !== "LIMIT" && !tpslOnMarket) { jsonStatus(res, 400, { ok: false, error: "TP/SL kräver en limit-order" }); return; }
        if (orderType === "MARKET" && side === "BUY" && (takeProfit !== undefined || stopLoss !== undefined)) {
          const ref = getCachedPrice(symbol) ?? getCachedPrice(symbol.replace(/USDC$/, "USDT"));
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
          jsonStatus(res, 409, { ok: false, error: "Ingen mäklare är kopplad på servern. Lägg in Alpaca- eller Binance-nycklar i .env." });
          return;
        }
        const live = broker.mode === "live";
        if (!sellAll && !(quoteUsd > 0)) { jsonStatus(res, 400, { ok: false, error: "Skriv ett belopp i USD" }); return; }
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
          quoteUsd: sellAll ? undefined : quoteUsd,
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

      // ── Tidshorisont (1/5/15/30 min) + automatiska stängningar ──
      if (url.pathname === "/api/trade-horizon" && method === "GET") {
        json(res, { minutes: getHorizonMin(), choices: HORIZON_CHOICES });
        return;
      }
      if (url.pathname === "/api/trade-horizon" && method === "POST") {
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
        if (!runAgentCallback) {
          jsonStatus(res, 500, { error: "Agent-callback ej konfigurerad" });
          return;
        }
        userAction("startade en analys (Kör analys)", { to: "orchestrator" });

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
        analysisStart("manuell", instruction);
        runAgentCallback(instruction)
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
          const dir = dataPath("sync");
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
          const file = dataPath("sync", `${clientId}.json`);
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
                  systemPrompt = `${profile.system}\n\n---\n\n${marketBlock}\n\n**VIKTIGT:** Använd alltid datan ovan när du svarar — det är IG-data (se datastatus per instrument: live/fördröjt/inaktuellt). Hänvisa till specifika nivåer, RSI-värden, trender. Du HAR realtidsdata. Vägra inte ge konkreta rekommendationer.`;
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

      // ── Binance public prices (för PROPOSE-mode — riktiga marknadspriser, ingen auth) ──
      // Riktiga ljus från Binance publika API (ingen nyckel behövs). Används av
      // dashboardens stora diagram när den är kopplad till boten.
      if (url.pathname === "/api/binance/klines" && method === "GET") {
        const symbol = (url.searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
        const interval = url.searchParams.get("interval") ?? "1h";
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "300", 10) || 300, 1), 1000);
        const okIntervals = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]);
        if (!/^[A-Z0-9]{2,20}$/.test(symbol) || !okIntervals.has(interval)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Ogiltig symbol eller intervall", klines: [] }));
          return;
        }
        try {
          const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
          if (!r.ok) {
            json(res, { error: `Binance svarade ${r.status}`, klines: [] });
            return;
          }
          const rows = (await r.json()) as Array<[number, string, string, string, string, string]>;
          const klines = rows.map((k) => ({
            time: Math.floor(k[0] / 1000),
            open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]),
            close: parseFloat(k[4]), volume: parseFloat(k[5]),
          }));
          json(res, { symbol, interval, klines, source: "binance-public" });
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err), klines: [] });
        }
        return;
      }

      if (url.pathname === "/api/binance/prices" && method === "GET") {
        const symbolsParam = url.searchParams.get("symbols") || "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,DOTUSDT,POLUSDT";
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
        if (!apiKey || !apiSecret) { jsonStatus(res, 400, { error: "apiKey + apiSecret krävs" }); return; }
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
        if (!creds) { jsonStatus(res, 400, { ok: false, error: `Binance ${mode === "live" ? "LIVE" : "TEST"} är inte kopplad (nycklar saknas i .env)` }); return; }
        // Samma order-grind som allt annat: kill switch, LIVE-lås, max belopp, dagsgräns
        const gate = await checkOrderGate({ live: mode === "live", side, quoteUsd: quoteOrderQty, source: "dashboard:binance" });
        if (!gate.ok) { json(res, { ok: false, error: `🛡 ${gate.error}` }); return; }
        if (needsApproval()) {
          const p = await addPendingOrder({ source: "dashboard:binance", venue: "binance", live: mode === "live", symbol, side, quoteUsd: quoteOrderQty, reason: "Knapp i dashboarden" });
          json(res, { ok: true, pending: true, pendingOrder: p, message: "Ordern väntar på ditt godkännande (Väntande ordrar)." });
          return;
        }
        try {
          const client = new BinanceClient(creds);
          const order = await client.placeMarketOrder({ symbol, side, quoteOrderQty, clientOrderId });
          if (mode === "live" && side === "BUY") recordLiveSpend(quoteOrderQty);
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
        if (!hasLlmCredentials()) { json(res, { ok: false, error: "AI_GATEWAY_API_KEY eller ANTHROPIC_API_KEY ej satt" }); return; }
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { ok: false, error: `Binance ${mode} ej konfigurerat` }); return; }

        try {
          const client = new BinanceClient(creds);
          const anthropic = createLlmClient();

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

Säkerhetslås: ${mode === "live"
  ? `LIVE-mode: max $${MAX_LIVE_STAKE_USD}/trade, daglig loss-cap $${MAX_LIVE_DAILY_LOSS_USD}`
  : `TESTNET-mode: INGEN gräns. Mike har $${equity.totalUsdt.toFixed(2)} (cash $${equity.cashUsdt.toFixed(2)}). Kör vad han ber om inom hans saldo.`}

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

          // Multi-tool-loop: Claude kan returnera FLERA tool_uses i samma svar och
          // kan kedja flera turn:s. Loopa tills inga fler tool_uses returneras.
          let currentReply = reply;
          let replyText = "";
          const toolNames: string[] = [];
          const executedResults: Record<string, unknown> = {};
          const MAX_TURNS = 5;
          for (let turn = 0; turn < MAX_TURNS; turn++) {
            const toolUses = currentReply.content.filter(b => b.type === "tool_use") as Anthropic.ToolUseBlock[];
            const textBlocks = currentReply.content.filter(b => b.type === "text") as Anthropic.TextBlock[];
            replyText = textBlocks.map(b => b.text).join("");
            if (toolUses.length === 0) break;
            // Exekvera alla tool_uses parallellt
            const toolResults = await Promise.all(toolUses.map(async (tu) => {
              toolNames.push(tu.name);
              const result = await executeChatTool(tu.name, tu.input as Record<string, unknown>, mode, client, symbols, userQuotes);
              executedResults[tu.id] = result;
              return { tool_use_id: tu.id, content: JSON.stringify(result) };
            }));
            // Lägg in i conversation: assistant turn + alla tool_results
            messages.push({ role: "assistant", content: currentReply.content });
            messages.push({
              role: "user",
              content: toolResults.map(tr => ({ type: "tool_result" as const, tool_use_id: tr.tool_use_id, content: tr.content })),
            });
            currentReply = await anthropic.messages.create({
              model: "claude-haiku-4-5",
              max_tokens: 1024,
              system: systemPrompt,
              tools,
              messages,
            });
          }

          json(res, {
            ok: true,
            reply: replyText,
            toolCall: toolNames.length > 0 ? toolNames.join(",") : undefined,
            executed: Object.keys(executedResults).length > 0 ? executedResults : null,
          });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // GET /api/monitor/status — autonom auto-sell-monitor status
      if (url.pathname === "/api/monitor/status" && method === "GET") {
        json(res, { ok: true, ...getMonitorStatus() });
        return;
      }
      // POST /api/monitor/toggle { enabled: boolean } — slå på/av monitor
      if (url.pathname === "/api/monitor/toggle" && method === "POST") {
        const body = await readBody(req);
        const { enabled } = JSON.parse(body) as { enabled: boolean };
        setMonitorEnabled(!!enabled);
        json(res, { ok: true, enabled: !!enabled });
        return;
      }
      // GET /api/monitor/lessons — full lärdoms-historik + symbol-edges (för UI Agent Learnings-panel)
      if (url.pathname === "/api/monitor/lessons" && method === "GET") {
        const status = getMonitorStatus();
        json(res, {
          ok: true,
          totalLessons: status.totalLessons,
          symbolEdges: status.symbolEdges,
          recentSales: status.recentSales,
        });
        return;
      }
      // POST /api/monitor/live-enable { enabled: boolean } — aktivera LIVE auto-sell
      if (url.pathname === "/api/monitor/live-enable" && method === "POST") {
        const body = await readBody(req);
        const { enabled } = JSON.parse(body) as { enabled: boolean };
        setLiveAutoSell(!!enabled);
        json(res, { ok: true, liveEnabled: !!enabled });
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
        if (!apiToken || !accountId) { jsonStatus(res, 400, { error: "apiToken + accountId krävs" }); return; }
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
        if (!oandaCreds) { jsonStatus(res, 400, { ok: false, error: "Oanda ej konfigurerat" }); return; }
        const body = await readBody(req);
        const { symbol, side, units, clientOrderId } = JSON.parse(body) as { symbol: string; side: "BUY" | "SELL"; units: number; clientOrderId?: string };
        const oandaGate = await checkOrderGate({ live: !oandaCreds.practice, side, unitsOrder: true, source: "dashboard:oanda" });
        if (!oandaGate.ok) { json(res, { ok: false, error: `🛡 ${oandaGate.error}` }); return; }
        if (needsApproval()) {
          json(res, { ok: false, error: "Godkännande-läge är på. Oanda-ordrar kan inte köas än, så ingen order lades." });
          return;
        }
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
            testnet: { configured: !!binanceTestnetCreds, wsConnected: userStreams.has("testnet") },
            live: { configured: !!binanceLiveCreds, wsConnected: userStreams.has("live") },
            marketStream: getMarketStreamStatus(),
          },
          oanda: oandaCreds ? { configured: true, mode: oandaCreds.practice ? "practice" : "live" } : { configured: false },
          safety: {
            maxLiveStakeUsd: MAX_LIVE_STAKE_USD,
            maxLiveDailyLossUsd: MAX_LIVE_DAILY_LOSS_USD,
            liveDailyLossUsd,
            maxTestStakeUsd: testStakeCapUsd(),
            maxLiveDailySpendUsd: MAX_LIVE_DAILY_SPEND_USD,
            liveSpentTodayUsd: getLiveSpentTodayUsd(),
            liveAllowed: liveAllowedByServer(),
            executionMode: config.executionMode,
          },
        });
        return;
      }

      // GET /api/binance/orderbook?symbol=&mode=&limit= — depth + slippage-uppskattning
      if (url.pathname === "/api/binance/orderbook" && method === "GET") {
        const mode = (url.searchParams.get("mode") === "live" ? "live" : "testnet") as "testnet" | "live";
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { ok: false, error: `Binance ${mode} ej konfigurerat` }); return; }
        const symbol = url.searchParams.get("symbol") || "BTCUSDT";
        const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
        const limit = ([5, 10, 20, 50, 100].includes(limitParam) ? limitParam : 20) as 5 | 10 | 20 | 50 | 100;
        try {
          const client = new BinanceClient(creds);
          const ob = await client.getOrderBook(symbol, limit);
          json(res, { ok: true, mode, symbol, ...ob });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // GET /api/binance/slippage?symbol=&side=&size=&mode= — pre-trade slippage estimate
      if (url.pathname === "/api/binance/slippage" && method === "GET") {
        const mode = (url.searchParams.get("mode") === "live" ? "live" : "testnet") as "testnet" | "live";
        const creds = resolveBinanceCreds(mode);
        if (!creds) { json(res, { ok: false, error: `Binance ${mode} ej konfigurerat` }); return; }
        const symbol = url.searchParams.get("symbol") || "BTCUSDT";
        const side = (url.searchParams.get("side") === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
        const size = parseFloat(url.searchParams.get("size") || "100");
        try {
          const client = new BinanceClient(creds);
          const est = await client.estimateSlippage(symbol, side, size);
          json(res, { ok: true, mode, symbol, side, size, ...est });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // GET /api/binance/cached-price?symbol= — O(1) lookup från WS-cachen
      if (url.pathname === "/api/binance/cached-price" && method === "GET") {
        const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
        const price = getCachedPrice(symbol);
        const ticker = getCachedTicker(symbol);
        json(res, { ok: price !== null, symbol, price, ticker, source: "ws-cache" });
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
