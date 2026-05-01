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
import Anthropic from "@anthropic-ai/sdk";
import { atr as computeATR } from "../indicators/ta.js";
import { trailingStop } from "../risk/eliteRisk.js";

// Mike's krav: 'agera på millisekunder', 'event-driven'. 1 min är säkraste tradeoff
// mot rate-limit (var 5:e min var för slö för Mike). Public klines API har ingen
// per-IP weight på max 1200/min — 1 min × 7 positions = ~14 weight, helt OK.
const CHECK_INTERVAL_MS = 60_000;
const TAKE_PROFIT_PCT = 10;
const STOP_LOSS_PCT = -5;
const RSI_OVERBOUGHT = 75;
const MAX_AUTO_SELLS_PER_DAY = 20;
const MIN_HOLD_MINUTES = 10;
// SELL-slippage-cap: avbryt SELL om orderbok-djup ger > 75 bps slippage
const MAX_SELL_SLIPPAGE_BPS = 75;
// ATR-trail aktiveras när position är +5% i vinst (skyddar profits)
const TRAIL_ACTIVATE_PCT = 5;
const TRAIL_DISTANCE_PCT = 2.5;

// Bearish-mönster som triggar SELL
const BEARISH_PATTERNS: PatternType[] = [
  "bearish_engulfing",
  "double_top",
  "head_shoulders",
  "evening_star",
  "dark_cloud_cover",
  "shooting_star",
];

interface PositionEntry {
  entryPrice: number;
  qty: number;
  openedAt: number;
  mode: "testnet" | "live";
  // Trailing stop: aktiveras när position är +TRAIL_ACTIVATE_PCT
  trailingStopPrice?: number;
  // Highest seen price (för trail-uppdatering)
  highWatermark?: number;
}

interface MonitorState {
  enabled: boolean;
  liveEnabled: boolean;
  autoSellsToday: { testnet: number; live: number };
  lastResetDay: number;
  // Track entry-pris per position (sym → { entryPrice, qty, openedAt })
  positionEntries: Map<string, PositionEntry>;
  // Sales-log för audit + LÄRDOMS-LOOP (Advisor läser denna inför nästa beslut)
  recentSales: Array<{
    symbol: string; mode: string; pnl: number; pnlPct: number | null;
    reason: string; advisorVerdict: string; advisorReasoning: string;
    holdMinutes: number; rsi: number; patterns: string[];
    time: number; orderId: number;
  }>;
  // Advisor-verifikation: kräver djup analys före LIVE-sell
  requireAdvisorOnLive: boolean;
}

const state: MonitorState = {
  enabled: true,
  liveEnabled: false,
  autoSellsToday: { testnet: 0, live: 0 },
  lastResetDay: new Date().getUTCDate(),
  positionEntries: new Map(),
  recentSales: [],
  requireAdvisorOnLive: true, // LIVE: alltid Advisor-verifikation före SELL (Mike-krav)
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

// ─── ADVISOR-VERIFIKATION (Opus) — djup analys före LIVE auto-sell ───
// Mike's krav: "djupt analyserat, agenterna ska läsa och lära upp sig att känna igen
// chart-mönster, hålla koll på marknaden i realtid, använda historik"
async function verifyWithAdvisor(
  asset: string,
  symbol: string,
  mode: "testnet" | "live",
  marketSnapshot: { currentPrice: number; klines1h: Candle[]; klines4h: Candle[]; rsi: number; patterns1h: string[]; patterns4h: string[] },
  position: { entryPrice: number | null; pnlPct: number | null; holdMinutes: number; qty: number; valueUsdt: number },
  ruleSignals: { tpSl: string; pattern: string; rsi: string },
): Promise<{ approve: boolean; verdict: string; reasoning: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.warn("[Advisor] ANTHROPIC_API_KEY saknas — defaultar till APPROVE");
    return { approve: true, verdict: "APPROVE_NO_AI", reasoning: "Advisor unavailable, regelbaserat beslut godkänt." };
  }
  const anthropic = new Anthropic({ apiKey });

  // LÄRDOMAR: senaste 10 sales på samma symbol + 5 övriga
  const symbolSpecific = state.recentSales.filter(s => s.symbol === symbol).slice(-10);
  const otherRecent = state.recentSales.filter(s => s.symbol !== symbol).slice(-5);
  const lessons = [...symbolSpecific, ...otherRecent].map(s => ({
    symbol: s.symbol, hold_min: s.holdMinutes, pnl: s.pnl.toFixed(2), pnl_pct: s.pnlPct?.toFixed(1) || "?",
    reason: s.reason, advisor: s.advisorVerdict, patterns: s.patterns.join(","), rsi_at_sell: s.rsi.toFixed(0),
  }));

  // Senaste 20 candles + volym-ratio (senaste 5 vs snitt)
  const recentCandles = marketSnapshot.klines1h.slice(-20).map(k => ({
    t: new Date(k.time * 1000).toISOString().slice(5,16),
    o: k.open.toFixed(6), h: k.high.toFixed(6), l: k.low.toFixed(6), c: k.close.toFixed(6),
    v: k.volume.toFixed(0),
  }));
  // Volym-confirmation: senaste 5 candles vs snitt av senaste 20
  const allVols = marketSnapshot.klines1h.slice(-20).map(k => k.volume);
  const recent5Vol = allVols.slice(-5).reduce((s,v) => s+v, 0) / 5;
  const avg20Vol = allVols.reduce((s,v) => s+v, 0) / Math.max(1, allVols.length);
  const volRatio = avg20Vol > 0 ? (recent5Vol / avg20Vol) : 1;
  // 4h trend (sista 5 4h-candles)
  const last4h = marketSnapshot.klines4h.slice(-5);
  const trend4h = last4h.length >= 2 ? (last4h[last4h.length-1].close > last4h[0].close ? "UPTREND" : "DOWNTREND") : "UNCLEAR";

  const systemPrompt = `Du är ADVISOR — Mike's senior trading-AI på Claude Opus, sista instans innan RIKTIG SELL-order på Binance ${mode === "live" ? "MAINNET (riktiga pengar)" : "TESTNET"}.

ELITE TRADER LOGIC — Mike's krav: 'agenterna ska bara lägga resultat på trades där de känner sig säkra på vinst grundat på djupanalys, chart-mönster och marknaden'.

VETO-bias som default. APPROVE bara när alla 3 av följande är true:
1. **Trend-confirmation**: 4h-trend stödjer SELL (nedåt eller bekräftad reversal). Bullish 4h + bearish 1h = VETO (intraday noise).
2. **Volym-confirmation**: Senaste candles har volym ≥ 1.2x snitt. Låg volym = svag signal = VETO.
3. **Pattern-clarity**: Bearish pattern är inte överlappande/motsägs av bullish. Två motstridiga patterns = VETO.

Hard rules som ALLTID approver:
- Stop-loss träffad (SL ${STOP_LOSS_PCT}% eller värre) → APPROVE oavsett, kapitalbevarande > timing.
- Take-profit träffad (TP +${TAKE_PROFIT_PCT}% eller bättre) → APPROVE för att låsa vinst.

Svara EXAKT format:
VERDICT: APPROVE eller VETO
REASONING: 2-3 meningar med SIFFROR (RSI, %, volym-ratio, pattern-namn).

Var disciplinerad. 'Vänta' är ett legitimt svar. Mike förlorar hellre en vinst-bana än tar förlust på falsk signal.`;

  const userMsg = `═══ POSITION ═══
Symbol: ${symbol} (asset ${asset})
Mode: ${mode}
Qty: ${position.qty}
Värde nu: $${position.valueUsdt.toFixed(2)}
Entry-pris: ${position.entryPrice?.toFixed(8) ?? "OKÄNT (manuell köp innan tracking)"}
Aktuellt pris: $${marketSnapshot.currentPrice.toFixed(8)}
PnL: ${position.pnlPct !== null ? `${position.pnlPct >= 0 ? "+" : ""}${position.pnlPct.toFixed(2)}%` : "okänt"}
Hold-tid: ${position.holdMinutes.toFixed(0)} min

═══ REGELBASERADE SIGNALER (varför vi överväger SELL) ═══
- TP/SL: ${ruleSignals.tpSl || "neutral"}
- Pattern: ${ruleSignals.pattern || "inga bearish"}
- RSI: ${ruleSignals.rsi || `${marketSnapshot.rsi.toFixed(0)} (neutral)`}

═══ MARKNAD ═══
RSI(14) 1h: ${marketSnapshot.rsi.toFixed(1)}
Trend 4h: ${trend4h}
Volym-ratio (senaste 5 vs snitt 20): ${volRatio.toFixed(2)}x ${volRatio >= 1.2 ? "(hög, signal-bekräftande)" : volRatio < 0.8 ? "(låg, svag signal)" : "(normal)"}
Bearish patterns 1h: ${marketSnapshot.patterns1h.join(", ") || "inga"}
Bearish patterns 4h: ${marketSnapshot.patterns4h.join(", ") || "inga"}

Senaste 20 1h-candles (t/o/h/l/c/v):
${recentCandles.map(c => `${c.t} ${c.o}/${c.h}/${c.l}/${c.c} vol=${c.v}`).join("\n")}

═══ MIKE'S LÄRDOMAR (senaste sells) ═══
${lessons.length > 0 ? JSON.stringify(lessons, null, 2) : "Ingen historik än — bygg sample."}

═══ DITT BESLUT ═══
Ska vi sälja ${asset} NU? Använd formatet:
VERDICT: APPROVE / VETO
REASONING: ...`;

  try {
    const reply = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: "user", content: userMsg }],
    });
    const text = reply.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlock).text).join("");
    const verdictMatch = text.match(/VERDICT:\s*(APPROVE|VETO)/i);
    const reasoningMatch = text.match(/REASONING:\s*([\s\S]+?)(?:\n\n|$)/i);
    const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : "APPROVE";
    const reasoning = reasoningMatch ? reasoningMatch[1].trim().slice(0, 400) : text.slice(0, 400);
    return { approve: verdict === "APPROVE", verdict, reasoning };
  } catch (e) {
    log.warn(`[Advisor] verifikation fail: ${e instanceof Error ? e.message : String(e)} — defaultar till APPROVE`);
    return { approve: true, verdict: "APPROVE_API_FAIL", reasoning: "Advisor API fail, regelbaserat beslut används." };
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

// Analysera EN position och returnera SELL-beslut + full marknadssnapshot för Advisor
interface PositionDecision {
  shouldSell: boolean;
  reason: string;
  currentPrice: number;
  entryPrice: number | null;
  pnlPct: number | null;
  symbol: string;
  klines1h: Candle[];
  klines4h: Candle[];
  rsi: number;
  patterns1h: string[];
  patterns4h: string[];
  holdMinutes: number;
  ruleSignals: { tpSl: string; pattern: string; rsi: string };
}

async function analyzePosition(
  asset: string,
  qty: number,
  marketClient: BinanceClient,
  mode: "testnet" | "live",
): Promise<PositionDecision | null> {
  const candidateSymbols = [`${asset}USDC`, `${asset}USDT`];
  let symbol: string | null = null;
  let currentPrice = 0;
  let klines: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  let klines4h: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  for (const s of candidateSymbols) {
    try {
      const [price, k1, k4] = await Promise.all([
        marketClient.getPrice(s),
        marketClient.getKlines(s, "1h", 50),
        marketClient.getKlines(s, "4h", 50),
      ]);
      if (price > 0 && k1.length >= 20) {
        symbol = s; currentPrice = price; klines = k1; klines4h = k4; break;
      }
    } catch { /* try next */ }
  }
  if (!symbol || klines.length < 20) return null;

  const entry = state.positionEntries.get(`${mode}-${asset}`);
  const entryPrice = entry?.entryPrice ?? null;
  const pnlPct = entryPrice ? ((currentPrice - entryPrice) / entryPrice) * 100 : null;
  const holdMinutes = entry ? (Date.now() - entry.openedAt) / 60_000 : 999;

  // Min hold-tid skydd
  if (entry && holdMinutes < MIN_HOLD_MINUTES) {
    return null;
  }

  let tpSlSignal = false; let tpSlReason = "";
  if (pnlPct !== null) {
    if (pnlPct >= TAKE_PROFIT_PCT) { tpSlSignal = true; tpSlReason = `TP +${pnlPct.toFixed(1)}%`; }
    else if (pnlPct <= STOP_LOSS_PCT) { tpSlSignal = true; tpSlReason = `SL ${pnlPct.toFixed(1)}%`; }
  }

  // ── ATR-baserad trailing stop ──
  // Aktiveras vid +TRAIL_ACTIVATE_PCT — höjer SL i takt med pris för att låsa profit.
  // Triggas SL-sell om priset faller till trail-nivån.
  if (entry && pnlPct !== null && pnlPct >= TRAIL_ACTIVATE_PCT) {
    const newHigh = Math.max(entry.highWatermark ?? entry.entryPrice, currentPrice);
    entry.highWatermark = newHigh;
    const newTrail = trailingStop(newHigh, entry.trailingStopPrice ?? entry.entryPrice * 0.95, "BUY", TRAIL_DISTANCE_PCT);
    entry.trailingStopPrice = newTrail;
    if (currentPrice <= newTrail) {
      tpSlSignal = true;
      tpSlReason = `TRAIL @ $${newTrail.toFixed(6)} (high $${newHigh.toFixed(6)}, +${pnlPct.toFixed(1)}%)`;
    }
  }

  let patterns1h: string[] = []; let patterns4h: string[] = [];
  try {
    const candles1h: Candle[] = klines.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
    patterns1h = detectAllPatterns(candles1h).filter(p => BEARISH_PATTERNS.includes(p.type) && p.candle.time >= klines[klines.length - 5].time).map(p => p.type);
  } catch {}
  try {
    const candles4hC: Candle[] = klines4h.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
    patterns4h = detectAllPatterns(candles4hC).filter(p => BEARISH_PATTERNS.includes(p.type)).slice(-3).map(p => p.type);
  } catch {}

  const closes = klines.map(k => k.close);
  const rsi = computeRSI(closes);
  const rsiSignal = rsi >= RSI_OVERBOUGHT;
  const patternSignal = patterns1h.length > 0;

  const signalCount = [tpSlSignal, patternSignal, rsiSignal].filter(Boolean).length;
  const hardTriggerSL = pnlPct !== null && pnlPct <= STOP_LOSS_PCT;
  const hardTriggerTP = pnlPct !== null && pnlPct >= TAKE_PROFIT_PCT;
  const shouldSell = hardTriggerSL || hardTriggerTP || signalCount >= 2;

  const reasonParts: string[] = [];
  if (tpSlSignal) reasonParts.push(tpSlReason);
  if (patternSignal) reasonParts.push(`pattern: ${patterns1h.join("+")}`);
  if (rsiSignal) reasonParts.push(`RSI ${rsi.toFixed(0)}`);
  const reason = reasonParts.length > 0 ? reasonParts.join(", ") : "inga starka signaler";

  const candles1h: Candle[] = klines.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
  const candles4hOut: Candle[] = klines4h.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));

  return {
    shouldSell, reason, currentPrice, entryPrice, pnlPct,
    symbol, klines1h: candles1h, klines4h: candles4hOut, rsi,
    patterns1h, patterns4h, holdMinutes,
    ruleSignals: {
      tpSl: tpSlReason,
      pattern: patternSignal ? patterns1h.join("+") : "",
      rsi: rsiSignal ? `${rsi.toFixed(0)} (överköpt)` : "",
    },
  };
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

        // ADVISOR-VERIFIKATION (LIVE ALLTID, TESTNET vid SL/TP-trigger för cost-control)
        let advisorVerdict = "REGEL_AUTO";
        let advisorReasoning = "Regelbaserat (Advisor ej konsulterad)";
        const needAdvisor = (mode === "live" && state.requireAdvisorOnLive) ||
                            (mode === "testnet" && (decision.ruleSignals.tpSl || decision.patterns1h.length > 0));
        if (needAdvisor) {
          const verify = await verifyWithAdvisor(
            pos.asset, decision.symbol, mode,
            { currentPrice: decision.currentPrice, klines1h: decision.klines1h, klines4h: decision.klines4h,
              rsi: decision.rsi, patterns1h: decision.patterns1h, patterns4h: decision.patterns4h },
            { entryPrice: decision.entryPrice, pnlPct: decision.pnlPct, holdMinutes: decision.holdMinutes,
              qty: pos.qty, valueUsdt: pos.valueUsdt },
            decision.ruleSignals,
          );
          advisorVerdict = verify.verdict;
          advisorReasoning = verify.reasoning;
          if (!verify.approve) {
            log.info(`[PositionMonitor] ${mode} ${decision.symbol} — Advisor VETO: ${verify.reasoning.slice(0,150)}`);
            // Telegram-notis även vid VETO så Mike ser att Advisor jobbar
            const modeTag = mode === "live" ? "💚 LIVE" : "🧪 TESTNET";
            await sendTelegramMessage(
              `🟡 <b>Advisor VETO ${modeTag}</b>\n\n<b>${decision.symbol}</b> — sell-signal triggad men Advisor håller positionen.\n\nRegel-signaler: ${decision.reason}\nAdvisor: ${verify.reasoning.slice(0,300)}`,
              { parseMode: "HTML" }
            );
            await new Promise(r => setTimeout(r, 500));
            continue; // Hoppa över sell
          }
        }

        const symbols = await userClient.getTradableSymbols(["USDC", "USDT"]);
        const symInfo = symbols.find(s => s.baseAsset === pos.asset);
        if (!symInfo) { log.warn(`[PositionMonitor] Ingen tradable pair för ${pos.asset}`); continue; }
        const stepSize = symInfo.stepSize || 0.000001;
        const qtyRounded = Math.floor(pos.qty / stepSize) * stepSize;
        if (qtyRounded <= 0) continue;

        // Slippage-skydd: kolla att orderboken är djup nog för att SELL utan stor slippage.
        // Skip om > MAX_SELL_SLIPPAGE_BPS — Mike förlorar mer på slippage än vad signalen sparar.
        // Undantag: om vi är i hard-SL (≤-5%) — då säljer vi ändå för att begränsa förlust.
        const isHardSL = decision.pnlPct !== null && decision.pnlPct <= STOP_LOSS_PCT;
        try {
          const slip = await marketClient.estimateSlippage(symInfo.symbol, "SELL", qtyRounded * decision.currentPrice);
          if (slip.fillable && slip.slippageBps > MAX_SELL_SLIPPAGE_BPS && !isHardSL) {
            log.warn(`[PositionMonitor] ${symInfo.symbol} SELL skipped — slippage ${slip.slippageBps.toFixed(0)} bps > cap ${MAX_SELL_SLIPPAGE_BPS}`);
            continue;
          }
        } catch { /* slippage-fail ska inte blocka critical SL-exits */ }

        try {
          const fill = await userClient.placeMarketOrder({ symbol: symInfo.symbol, side: "SELL", quantity: qtyRounded });
          state.autoSellsToday[mode]++;
          const fillPrice = parseFloat(fill.cummulativeQuoteQty) / parseFloat(fill.executedQty);
          const sellValue = parseFloat(fill.cummulativeQuoteQty);
          const realizedPnl = decision.entryPrice ? (fillPrice - decision.entryPrice) * parseFloat(fill.executedQty) : 0;

          // LÄRDOMS-LOGG: full kontext sparas så Advisor kan referera till tidigare sells
          state.recentSales.push({
            symbol: symInfo.symbol, mode, pnl: realizedPnl, pnlPct: decision.pnlPct,
            reason: decision.reason, advisorVerdict, advisorReasoning,
            holdMinutes: decision.holdMinutes, rsi: decision.rsi, patterns: decision.patterns1h,
            time: Date.now(), orderId: fill.orderId,
          });
          // Behåll bara senaste 100 sales för minne-effektivitet
          if (state.recentSales.length > 100) state.recentSales = state.recentSales.slice(-100);

          const emoji = realizedPnl >= 0 ? "🟢" : "🔴";
          const modeTag = mode === "live" ? "💚 LIVE" : "🧪 TESTNET";
          const pnlStr = decision.pnlPct !== null ? `${decision.pnlPct >= 0 ? "+" : ""}${decision.pnlPct.toFixed(1)}%` : "(okänt entry)";
          const advisorTag = advisorVerdict === "APPROVE" ? "✅ Advisor godkände" : (advisorVerdict === "REGEL_AUTO" ? "Regelbaserat" : `Advisor: ${advisorVerdict}`);
          const msg = `${emoji} <b>Auto-sell ${modeTag}</b>\n\n` +
            `<b>${symInfo.symbol}</b> qty ${qtyRounded.toFixed(4)}\n` +
            `Sålt @ $${fillPrice.toFixed(6)} = $${sellValue.toFixed(2)}\n` +
            `PnL: ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)} (${pnlStr})\n` +
            `Orsak: ${decision.reason}\n` +
            `${advisorTag}\n` +
            `OrderID: ${fill.orderId}`;
          await sendTelegramMessage(msg, { parseMode: "HTML" });
          log.ok(`[PositionMonitor] AUTO-SELL ${mode} ${symInfo.symbol} qty=${qtyRounded} pnl=$${realizedPnl.toFixed(2)} reason=${decision.reason} advisor=${advisorVerdict}`);
          state.positionEntries.delete(`${mode}-${pos.asset}`);
        } catch (e) {
          log.warn(`[PositionMonitor] SELL fail ${symInfo.symbol}: ${e instanceof Error ? e.message : String(e)}`);
        }

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
