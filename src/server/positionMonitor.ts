// ═══════════════════════════════════════════════════════════════════════════
// Position Monitor — autonom auto-sell vid bearish chart-mönster
//
// Mike's krav: agenterna säljer automatiskt när rätt mönster visar.
// Körs var 5:e min, kollar alla öppna positioner, säljer vid 2+ signaler.
//
// SÄKERHET (start-config):
// - TESTNET-only första 7 dagarna (LIVE_AUTO_SELL_ENABLED=false som default)
// - Max 20 auto-sells/dag per mode
// - Min hold-tid: 10 min (förhindrar omedelbar churn efter köp)
// - Killswitch via setMonitorEnabled(false)
// ═══════════════════════════════════════════════════════════════════════════

import { BinanceClient, type BinanceCredentials } from "./integrations/binance.js";
import { detectAllPatterns, type Candle, type PatternType } from "./patternDetection.js";
import { sendMessage as sendTelegramMessage } from "./telegram.js";
import { log } from "../logger.js";

const CHECK_INTERVAL_MS = 5 * 60_000;
const TAKE_PROFIT_PCT = 10;
const STOP_LOSS_PCT = -5;
const RSI_OVERBOUGHT = 75;
const MAX_AUTO_SELLS_PER_DAY = 20;
const MIN_HOLD_MINUTES = 10;

// Bearish-mönster som triggar SELL
const BEARISH_PATTERNS: PatternType[] = [
  "bearish_engulfing",
  "double_top",
  "head_shoulders",
  "evening_star",
  "dark_cloud_cover",
  "shooting_star",
];

interface MonitorState {
  enabled: boolean;
  liveEnabled: boolean;
  autoSellsToday: { testnet: number; live: number };
  lastResetDay: number;
  // Track entry-pris per position (sym → { entryPrice, qty, openedAt })
  positionEntries: Map<string, { entryPrice: number; qty: number; openedAt: number; mode: "testnet" | "live" }>;
  // Sales-log för audit
  recentSales: Array<{ symbol: string; mode: string; pnl: number; reason: string; time: number; orderId: number }>;
}

const state: MonitorState = {
  enabled: true,
  liveEnabled: false, // TESTNET-only första 7 dagarna
  autoSellsToday: { testnet: 0, live: 0 },
  lastResetDay: new Date().getUTCDate(),
  positionEntries: new Map(),
  recentSales: [],
};

export function setMonitorEnabled(enabled: boolean): void {
  state.enabled = enabled;
  log.info(`[PositionMonitor] ${enabled ? "AKTIVERAD" : "PAUSAD"}`);
}

export function setLiveAutoSell(enabled: boolean): void {
  state.liveEnabled = enabled;
  log.info(`[PositionMonitor] LIVE auto-sell ${enabled ? "AKTIVERAD" : "PAUSAD"}`);
}

export function getMonitorStatus(): { enabled: boolean; liveEnabled: boolean; salesToday: typeof state.autoSellsToday; recentSales: typeof state.recentSales } {
  return {
    enabled: state.enabled,
    liveEnabled: state.liveEnabled,
    salesToday: state.autoSellsToday,
    recentSales: state.recentSales.slice(-20),
  };
}

// Registrera entry när Hanna lägger en BUY (anropas från api.ts efter place_market_orders)
export function recordEntry(symbol: string, mode: "testnet" | "live", entryPrice: number, qty: number): void {
  state.positionEntries.set(`${mode}-${symbol}`, { entryPrice, qty, openedAt: Date.now(), mode });
  log.info(`[PositionMonitor] Entry registrerad: ${mode} ${symbol} @ $${entryPrice.toFixed(6)} qty ${qty}`);
}

function resetDailyCounters(): void {
  const today = new Date().getUTCDate();
  if (today !== state.lastResetDay) {
    state.autoSellsToday = { testnet: 0, live: 0 };
    state.lastResetDay = today;
    log.info("[PositionMonitor] Daily counters resettade");
  }
}

// Beräkna RSI(14) från klines
function computeRSI(closes: number[]): number {
  if (closes.length < 15) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return 100 - (100 / (1 + rs));
}

// Analysera EN position och returnera SELL-beslut
async function analyzePosition(
  asset: string,
  qty: number,
  marketClient: BinanceClient,
  mode: "testnet" | "live",
): Promise<{ shouldSell: boolean; reason: string; currentPrice: number; entryPrice: number | null; pnlPct: number | null } | null> {
  // Försök USDC först (Mike's LIVE-quote), sen USDT (TESTNET-quote)
  const candidateSymbols = [`${asset}USDC`, `${asset}USDT`];
  let symbol: string | null = null;
  let currentPrice = 0;
  let klines: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  for (const s of candidateSymbols) {
    try {
      const [price, k] = await Promise.all([
        marketClient.getPrice(s),
        marketClient.getKlines(s, "1h", 50),
      ]);
      if (price > 0 && k.length >= 20) {
        symbol = s; currentPrice = price; klines = k; break;
      }
    } catch { /* try next */ }
  }
  if (!symbol || klines.length < 20) return null;

  const entry = state.positionEntries.get(`${mode}-${asset}`);
  const entryPrice = entry?.entryPrice ?? null;
  const pnlPct = entryPrice ? ((currentPrice - entryPrice) / entryPrice) * 100 : null;

  // Min hold-tid skydd
  if (entry && (Date.now() - entry.openedAt) < MIN_HOLD_MINUTES * 60_000) {
    return { shouldSell: false, reason: "Min hold-tid (10 min) ej uppfylld", currentPrice, entryPrice, pnlPct };
  }

  // Signal 1: TP eller SL
  let tpSlSignal = false;
  let tpSlReason = "";
  if (pnlPct !== null) {
    if (pnlPct >= TAKE_PROFIT_PCT) { tpSlSignal = true; tpSlReason = `TP +${pnlPct.toFixed(1)}%`; }
    else if (pnlPct <= STOP_LOSS_PCT) { tpSlSignal = true; tpSlReason = `SL ${pnlPct.toFixed(1)}%`; }
  }

  // Signal 2: Bearish chart-pattern (på senaste 5 candles)
  let patternSignal = false;
  let patternReason = "";
  try {
    const candles: Candle[] = klines.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
    const allPatterns = detectAllPatterns(candles);
    const recentBearish = allPatterns.filter(p => BEARISH_PATTERNS.includes(p.type) && p.candle.time >= klines[klines.length - 5].time);
    if (recentBearish.length > 0) {
      patternSignal = true;
      patternReason = recentBearish.map(p => p.type).join("+");
    }
  } catch { /* pattern detection optional */ }

  // Signal 3: RSI överköpt
  const closes = klines.map(k => k.close);
  const rsi = computeRSI(closes);
  const rsiSignal = rsi >= RSI_OVERBOUGHT;

  // 2 av 3 signaler krävs (eller hard SL/TP ensamt räcker)
  const signals = [tpSlSignal, patternSignal, rsiSignal];
  const signalCount = signals.filter(Boolean).length;
  const hardTriggerSL = pnlPct !== null && pnlPct <= STOP_LOSS_PCT;
  const hardTriggerTP = pnlPct !== null && pnlPct >= TAKE_PROFIT_PCT;
  const shouldSell = hardTriggerSL || hardTriggerTP || signalCount >= 2;

  const reasonParts: string[] = [];
  if (tpSlSignal) reasonParts.push(tpSlReason);
  if (patternSignal) reasonParts.push(`pattern: ${patternReason}`);
  if (rsiSignal) reasonParts.push(`RSI ${rsi.toFixed(0)}`);
  const reason = reasonParts.length > 0 ? reasonParts.join(", ") : `inga starka signaler (RSI ${rsi.toFixed(0)})`;

  return { shouldSell, reason, currentPrice, entryPrice, pnlPct };
}

// Kör en check-cykel — anropas av setInterval
async function runCheckCycle(testnetCreds: BinanceCredentials | null, liveCreds: BinanceCredentials | null): Promise<void> {
  if (!state.enabled) return;
  resetDailyCounters();

  // Marknadsdata via mainnet (publika endpoints)
  const marketClient = new BinanceClient(liveCreds || { apiKey: "public", apiSecret: "public", testnet: false });

  const STABLES = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDP"]);

  for (const [mode, creds] of [["testnet", testnetCreds], ["live", liveCreds]] as const) {
    if (!creds) continue;
    if (mode === "live" && !state.liveEnabled) continue;
    if (state.autoSellsToday[mode] >= MAX_AUTO_SELLS_PER_DAY) {
      log.info(`[PositionMonitor] ${mode}: daglig sell-cap ${MAX_AUTO_SELLS_PER_DAY} nådd, skippar`);
      continue;
    }

    try {
      const userClient = new BinanceClient(creds);
      const equity = await userClient.getTotalEquity();
      // Bara analysera positioner värda > $0.50 (skippar damm-balanser)
      const positionsToCheck = equity.positions.filter(p => !STABLES.has(p.asset) && p.valueUsdt >= 0.5).slice(0, 15);

      for (const pos of positionsToCheck) {
        if (state.autoSellsToday[mode] >= MAX_AUTO_SELLS_PER_DAY) break;
        const decision = await analyzePosition(pos.asset, pos.qty, marketClient, mode);
        if (!decision || !decision.shouldSell) continue;

        // SELL — hitta rätt symbol via exchangeInfo
        const symbols = await userClient.getTradableSymbols(["USDC", "USDT"]);
        const symInfo = symbols.find(s => s.baseAsset === pos.asset);
        if (!symInfo) {
          log.warn(`[PositionMonitor] Ingen tradable pair för ${pos.asset}, skippar`);
          continue;
        }
        const stepSize = symInfo.stepSize || 0.000001;
        const qtyRounded = Math.floor(pos.qty / stepSize) * stepSize;
        if (qtyRounded <= 0) continue;

        try {
          const fill = await userClient.placeMarketOrder({ symbol: symInfo.symbol, side: "SELL", quantity: qtyRounded });
          state.autoSellsToday[mode]++;
          const fillPrice = parseFloat(fill.cummulativeQuoteQty) / parseFloat(fill.executedQty);
          const sellValue = parseFloat(fill.cummulativeQuoteQty);
          const realizedPnl = decision.entryPrice ? (fillPrice - decision.entryPrice) * parseFloat(fill.executedQty) : 0;

          state.recentSales.push({
            symbol: symInfo.symbol,
            mode,
            pnl: realizedPnl,
            reason: decision.reason,
            time: Date.now(),
            orderId: fill.orderId,
          });

          // Telegram-notis
          const emoji = realizedPnl >= 0 ? "🟢" : "🔴";
          const modeTag = mode === "live" ? "💚 LIVE" : "🧪 TESTNET";
          const pnlStr = decision.pnlPct !== null ? `${decision.pnlPct >= 0 ? "+" : ""}${decision.pnlPct.toFixed(1)}%` : "(okänt entry)";
          const msg = `${emoji} <b>Auto-sell ${modeTag}</b>\n\n` +
            `<b>${symInfo.symbol}</b> qty ${qtyRounded.toFixed(4)}\n` +
            `Sålt @ $${fillPrice.toFixed(6)} = $${sellValue.toFixed(2)}\n` +
            `PnL: ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)} (${pnlStr})\n` +
            `Orsak: ${decision.reason}\n` +
            `OrderID: ${fill.orderId}`;
          await sendTelegramMessage(msg, { parseMode: "HTML" });
          log.ok(`[PositionMonitor] AUTO-SELL ${mode} ${symInfo.symbol} qty=${qtyRounded} pnl=$${realizedPnl.toFixed(2)} reason=${decision.reason}`);
          // Rensa entry-tracking
          state.positionEntries.delete(`${mode}-${pos.asset}`);
        } catch (e) {
          log.warn(`[PositionMonitor] SELL fail ${symInfo.symbol}: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Mellanrum mellan calls för att inte rate-limit:a
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) {
      log.warn(`[PositionMonitor] ${mode} cycle error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

let monitorInterval: NodeJS.Timeout | null = null;

export function startPositionMonitor(testnetCreds: BinanceCredentials | null, liveCreds: BinanceCredentials | null): void {
  if (monitorInterval) return;
  log.ok(`[PositionMonitor] Startar — TESTNET=${!!testnetCreds} LIVE auto-sell=${state.liveEnabled} interval=${CHECK_INTERVAL_MS/1000}s`);
  // Kör första gången efter 60s (ge boot-time)
  setTimeout(() => runCheckCycle(testnetCreds, liveCreds), 60_000);
  monitorInterval = setInterval(() => {
    runCheckCycle(testnetCreds, liveCreds).catch(e => log.warn(`[PositionMonitor] cycle exception: ${e}`));
  }, CHECK_INTERVAL_MS);
}

export function stopPositionMonitor(): void {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  log.info("[PositionMonitor] Stoppad");
}
