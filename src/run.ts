import { config } from "./config.js";
import type { BrokerAdapter } from "./brokers/adapter.js";
import { IgBroker } from "./brokers/ig.js";
import { igMarketData } from "./server/igMarketData.js";
import { beginIgTurn, configureIgTurnGuard, endIgTurn, igTurnStale } from "./server/igTurnGuard.js";
import { getIgStatus } from "./integrations/igConnection.js";
configureIgTurnGuard({ activeEnv: () => igMarketData.getActiveEnv(), generation: (env) => getIgStatus().environments[env].connectionGeneration ?? null });
import { RiskManager } from "./risk/riskManager.js";
import { runAgentTurn } from "./agent/claudeAgent.js";
import {
  buildMorningBriefingPrompt,
  buildDailyPnlPrompt,
} from "./agent/prompt.js";
import { loadState, saveState, appendDecision } from "./memory/store.js";
import { Scheduler, createDefaultSchedule } from "./scheduler.js";
import { runOrchestratedTurn } from "./orchestrator/orchestrator.js";
import { startServer, broadcastEvent, getActiveBrokerName, setApiKey, setRunAgentCallback } from "./server/api.js";
import { startKlineStream } from "./server/klineStream.js";
import { getSignals, jevReviewSymbols, startSignalEngine, subscribeSignals } from "./server/signalEngine.js";
import { recordAnalysis } from "./memory/tradeMemory.js";
import { listPendingOrders } from "./server/orderGate.js";
import { type PrescreenResult, prescreenPairs, prescreenEnabled, rememberPrescreen } from "./orchestrator/prescreen.js";
import { analysisModeInfo, autoLoopEnabled, scheduleTimes, signalTriggerEnabled, startFixedTimes } from "./server/analysisMode.js";
import { setTeamLast } from "./server/teamLast.js";
import { restoreExecutionMode } from "./server/executionModeStore.js";
import { log } from "./logger.js";
import type { DecisionRecord } from "./types.js";
import type { StrategyEngine } from "./strategies/types.js";
import { PoliticianCopyEngine } from "./strategies/politicianCopy.js";
import { WheelEngine } from "./strategies/wheel.js";
import { CryptoMomentumEngine } from "./strategies/cryptoMomentum.js";

// ═══════════════════════════════════════════════════════════════════════════
//  MIKAEL TRADING OS — Entrypoint
//
//  Körlägen:
//    npm run agent           → full loop med scheduler
//    npm run agent:once      → ett enda pass, exit
//    npm run propose         → ett pass i approve-läge
//    npm run account         → visa konto-status
//    npm run kill -- on|off  → kill-switch
// ═══════════════════════════════════════════════════════════════════════════

// ── Setup: brokers ──
// Plattformen är IG (Mike 2026-10-09): TEST = IG Demo (virtuella pengar på IG:s
// demokonto), LIVE = IG Live. Bybit, Binance, Alpaca, Kraken, Oanda och Blofin
// skapas inte längre (filerna finns kvar i git men används inte).
function createBrokers(): Record<string, BrokerAdapter> {
  return { "ig-demo": new IgBroker("demo"), ig: new IgBroker("live") };
}

/** Agenternas och signalmotorns par = IG-bevakningslistan (EPICs) för aktiv miljö. */
function syncWatchlistToConfig(): void {
  const list = igMarketData.watchlist();
  config.crypto.symbols.splice(0, config.crypto.symbols.length, ...list);
}

// ── Setup: strategi-motorer ──

function createEngines(brokers: Record<string, BrokerAdapter>): StrategyEngine[] {
  const engines: StrategyEngine[] = [];

  for (const name of config.engines) {
    switch (name) {
      case "politician_copy":
        engines.push(
          new PoliticianCopyEngine({
            allowedSymbols: config.stocks.symbols,
          }),
        );
        break;

      case "wheel_strategy":
        if (false) {
          engines.push(
            new WheelEngine(brokers.alpaca as never, {
              underlyings: config.wheel.underlyings,
              putDelta: config.wheel.putDelta,
              profitTargetPct: config.wheel.profitTargetPct,
            }),
          );
        } else {
          log.warn("Motor B (Wheel) kräver Alpaca, som inte används med IG. Skippar.");
        }
        break;

      case "crypto_momentum": {
        const cryptoBroker: BrokerAdapter | undefined = undefined; // Blofin/Binance används inte med IG
        if (cryptoBroker) {
          engines.push(
            new CryptoMomentumEngine(cryptoBroker, {
              symbols: config.crypto.symbols,
              leverage: config.crypto.leverage,
              trailingStopPct: config.crypto.trailingStopPct,
              takeProfitSteps: config.crypto.takeProfitSteps,
            }),
          );
        } else {
          log.warn("Motor C (Crypto Momentum) kräver Blofin eller Binance. Skippar.");
        }
        break;
      }

      default:
        log.warn(`Okänd motor: ${name}. Skippar.`);
    }
  }

  return engines;
}

// ── Huvudfunktion: en turn (stödjer single-agent OCH orchestrator) ──

// Bara en AI-tur åt gången (schemat och tidiga starter delar på den).
let turnRunning = false;
async function runTurnOnce(fn: () => Promise<void>): Promise<void> {
  if (turnRunning) { log.info("[JEV] en tur körs redan, hoppar över"); return; }
  turnRunning = true;
  try { await fn(); } finally { turnRunning = false; }
}

async function runOnce(
  brokers: Record<string, BrokerAdapter>,
  engines: StrategyEngine[],
  instruction?: string,
  useTeam = true,
  scheduled = false,
): Promise<void> {
  // Försållning: signalmotorn + JEV väljer par innan AI-teamet startas.
  // En schemalagd tur utan någon signal hoppas över helt (inga AI-anrop).
  const screen: PrescreenResult = prescreenPairs({
    cryptoSymbols: config.crypto.symbols,
    otherSymbols: config.stocks.symbols,
    instruction,
    scheduled,
  });
  const turnStartedAt = Date.now();
  let jevStopped: { symbol: string; why: string }[] = [];
  // JEV granskar bara paren den här analysen valt (signalerna i sig är gratis matte).
  if (screen.enabled && screen.flagged.length && !screen.skip) {
    const maxPairs = Math.max(1, Number(process.env.PRESCREEN_MAX_PAIRS ?? 3) || 3);
    const candidates = screen.flagged.slice(0, maxPairs * 2).map((f) => f.symbol);
    const picked = new Set(screen.symbols);
    if (candidates.some((c) => picked.has(c))) {
      const { kept, stopped } = await jevReviewSymbols(candidates, maxPairs);
      jevStopped = stopped;
      if (stopped.length) {
        const top = kept.slice(0, maxPairs);
        const stopNote = `JEV stoppade ${stopped.map((x) => x.symbol).join(", ")}`;
        if (top.length) {
          screen.symbols = top;
          screen.note = `${stopNote}; AI-teamet tar ${top.join(", ")}`;
        } else if (scheduled && !instruction) {
          screen.symbols = []; screen.skip = true;
          screen.note = `${stopNote}; inget par kvar, AI-teamet vilar`;
        } else {
          screen.symbols = [...config.crypto.symbols, ...config.stocks.symbols];
          screen.note = `${stopNote}; du bad om analys: alla par`;
        }
      }
    }
  }
  rememberPrescreen(screen);
  log.info(`[JEV] försållning: ${screen.note}`);
  if (useTeam && screen.skip) return;

  const state = await loadState();

  if (state.killSwitchActive) {
    log.error("🛑 Kill-switch aktiv. Kör `npm run kill off` för att återställa.");
    return;
  }

  // Respektera broker-val från dashboard (runtime), fallback till default-prioritet
  const activeName = getActiveBrokerName();
  const primaryBroker = activeName
    ? brokers[activeName]
    : brokers["ig-demo"];
  if (!primaryBroker) {
    log.error("Ingen broker tillgänglig.");
    return;
  }
  log.info(`Aktiv broker: ${activeName ?? Object.keys(brokers).find((k) => brokers[k] === primaryBroker) ?? "?"} (${primaryBroker.mode})`);
  // B3: turen binds till miljön + IG-sessionen den startar i
  const igTurn = primaryBroker instanceof IgBroker ? beginIgTurn(primaryBroker.env) : null;
  try {

  const risk = new RiskManager(config);

  log.info(
    `Agent-turn startar — mode=${useTeam ? "TEAM" : "SINGLE"} ` +
    `engines=[${engines.map((e) => e.name).join(",")}] ` +
    `brokers=[${Object.keys(brokers).join(",")}]`,
  );

  let finalText: string;
  let toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  let placedOrders: Array<{ request: import("./types.js").OrderRequest; result: import("./types.js").OrderResult }>;

  if (useTeam) {
    // ── Orchestrator-mode: specialist-team ──
    const result = await runOrchestratedTurn({
      config,
      state,
      broker: primaryBroker,
      brokers,
      risk,
      engines,
      userInstruction: instruction,
      symbols: screen.symbols,
    });
    finalText = result.headTrader.decision.briefingSummary;
    toolCalls = result.headTrader.toolCalls;
    placedOrders = result.headTrader.placedOrders;

    // Hanna (Head Trader) med på korten: vilket beslut och hur många ordrar
    const headOrders = result.headTrader.placedOrders;
    const headReport = {
      decision: headOrders.length ? (headOrders[0]!.request.side === "BUY" ? "BUY" : "SELL") : "HOLD",
      actions: headOrders.map((o) => ({ symbol: o.request.symbol, side: o.request.side })),
      summary: result.headTrader.decision.briefingSummary,
    };
    const teamPayload = { ...result.reports, head: headReport };
    const staleWhy = igTurnStale(igTurn);
    if (staleWhy) {
      // Sen analys efter kontobyte: släng resultatet (inget kvitto, inget minne, ingen popup)
      log.warn(`[analys] ${staleWhy}`);
      broadcastEvent("analysis-stale", { reason: staleWhy, at: Date.now() });
      return;
    }
    setTeamLast(teamPayload, screen.symbols);

    // Tradingminnet: spara vad teamet såg och beslöt (resultatet kopplas
    // senare från TEST-kontots stängda affärer).
    void (async () => {
      const wanted = new Set(screen.symbols.map((x) => x.toUpperCase()));
      const pending = (await listPendingOrders().catch(() => []))
        .filter((o) => Date.parse(o.createdAt) >= turnStartedAt && wanted.has(o.symbol.toUpperCase()));
      const proposals = [
        ...pending.map((o) => ({ symbol: o.symbol, side: o.side, usd: o.quoteUsd, takeProfit: o.takeProfit, stopLoss: o.stopLoss, refPrice: o.refPrice })),
        ...headOrders.map((o) => ({ symbol: o.request.symbol, side: o.request.side, usd: o.request.quoteOrderQty })),
      ];
      await recordAnalysis({
        at: turnStartedAt,
        trigger: scheduled ? "scheduled" : "manual",
        instruction,
        symbols: screen.symbols,
        note: screen.note,
        signals: getSignals()
          .filter((x) => wanted.has(x.symbol.toUpperCase()))
          .map((x) => ({ symbol: x.symbol, direction: x.direction, score: x.score, reasons: x.reasons })),
        jevStopped,
        decision: proposals.length ? proposals.map((p) => `${p.side} ${p.symbol}`).join(", ") : "HOLD",
        summary: result.headTrader.decision.briefingSummary ?? "",
        proposals,
      });
    })().catch((err) => log.warn(`[minne] ${err instanceof Error ? err.message : String(err)}`));
    broadcastEvent("team-reports", {
      ...teamPayload,
      timing: result.timingMs,
      at: Date.now(),
      symbols: screen.symbols,
    });
  } else {
    // ── Single-agent fallback ──
    const turn = await runAgentTurn({
      config,
      broker: primaryBroker,
      brokers,
      risk,
      state,
      engines,
      userInstruction: instruction,
    });
    finalText = turn.finalText;
    toolCalls = turn.toolCalls;
    placedOrders = turn.placedOrders;
  }

  // Persistera state + beslut
  let action: DecisionRecord["action"] = "hold";
  let orderResult: DecisionRecord["orderResult"];
  let symbol: string | undefined;

  if (placedOrders.length > 0) {
    const first = placedOrders[0]!;
    action = first.request.side === "BUY" ? "buy" : "sell";
    orderResult = first.result;
    symbol = first.request.symbol;

    for (const { request, result } of placedOrders) {
      if (request.side === "BUY") {
        const existing = state.openPositions[request.symbol];
        if (existing) {
          const totalQty = existing.quantity + result.executedQty;
          const totalCost =
            existing.quantity * existing.avgEntryPrice +
            result.executedQty * result.avgFillPrice;
          state.openPositions[request.symbol] = {
            quantity: totalQty,
            avgEntryPrice: totalQty > 0 ? totalCost / totalQty : 0,
            openedAt: existing.openedAt,
          };
        } else {
          state.openPositions[request.symbol] = {
            quantity: result.executedQty,
            avgEntryPrice: result.avgFillPrice,
            openedAt: result.timestamp,
          };
        }
      } else {
        const existing = state.openPositions[request.symbol];
        if (existing && existing.quantity > 0) {
          const soldQty = Math.min(result.executedQty, existing.quantity);
          const realized = (result.avgFillPrice - existing.avgEntryPrice) * soldQty;
          state.dailyRealizedPnlUsdt += realized;
          log.trade(`Realiserad PnL: ${realized.toFixed(2)} USDT (${request.symbol})`);
          const remaining = existing.quantity - soldQty;
          if (remaining <= 0.0000001) {
            delete state.openPositions[request.symbol];
          } else {
            state.openPositions[request.symbol] = { ...existing, quantity: remaining };
          }
        }
      }
    }

    broadcastEvent("trade", { action, symbol, orderResult });
  }

  await saveState(state);

  const record = await appendDecision({
    timestamp: Date.now(),
    mode: config.mode,
    action,
    symbol,
    reasoning: finalText,
    toolCalls,
    orderResult,
  });

  broadcastEvent("turn-complete", { id: record.id, action, symbol });

  log.agent("─".repeat(60));
  log.agent(finalText);
  log.agent("─".repeat(60));
  log.info(
    `Turn klart. beslut=${action} tools=${toolCalls.length} orders=${placedOrders.length} id=${record.id}`,
  );
  } finally { if (igTurn) endIgTurn(igTurn); }
}

// ── CLI ──

function parseArgs(): { once: boolean; serve: boolean; propose: boolean; instruction?: string } {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  // --serve: håll dashboard och marknadsströmmar igång utan att köra
  // agent-loopen. Det är läget för en alltid-på-tjänst: systemet ska gå att
  // nå när som helst utan att varje omstart kostar LLM-anrop.
  const serve = args.includes("--serve");
  const propose = args.includes("--propose");
  const instArg = args.find((a) => a.startsWith("--instruction="));
  const instruction = instArg ? instArg.slice("--instruction=".length) : undefined;
  return { once, serve, propose, instruction };
}

async function main(): Promise<void> {
  const args = parseArgs();

  log.info("╔══════════════════════════════════════════════════════════╗");
  log.info("║            MIKAEL TRADING OS                            ║");
  log.info("║  Multi-Asset Trading Agent powered by Claude            ║");
  log.info("╚══════════════════════════════════════════════════════════╝");
  await restoreExecutionMode();
  log.info(`  Mode: ${config.mode}  |  Execution: ${config.executionMode}`);
  log.info(`  Engines: ${config.engines.join(", ")}`);
  log.info("──────────────────────────────────────────────────────────");

  const brokers = createBrokers();
  // Visa de mäklare som faktiskt är registrerade (Bybit överallt döljer t.ex. Binance)
  log.info(`  Brokers: ${Object.keys(brokers).join(", ") || "inga"}`);
  const engines = createEngines(brokers);

  if (engines.length === 0) {
    log.warn("Inga strategi-motorer aktiva. Agenten kör i friform-läge.");
  }

  // Starta dashboard-server (alltid, även i once-mode)
  const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? "3939", 10);
  startServer(DASHBOARD_PORT, brokers);

  // ── Kline-ström + signal-motor ──────────────────────────────────────────
  // Krävs för signalpanelen och diagrammet. Publik marknadsdata — inga
  // nycklar behövs, så den startar även i vy-läge.
  //
  // Startas här och inte i startServer(): servern ska kunna svara på
  // /api/signals även innan strömmen hunnit fylla på, och panelen visar då
  // att den väntar istället för att endpointen saknas.
  // Alla par agenterna följer (Bybit klarar alla på en anslutning)
  // IG: bevakningslistan (EPICs) är både agenternas och signalmotorns par.
  config.stocks.symbols.splice(0, config.stocks.symbols.length); // inga Alpaca-aktier
  syncWatchlistToConfig();
  igMarketData.events.on("watchlist", () => syncWatchlistToConfig());
  igMarketData.events.on("env", () => syncWatchlistToConfig());
  const streamSymbols = config.crypto.symbols;
  const streamInterval = process.env.SIGNAL_INTERVAL ?? "1m";
  startSignalEngine();
  void startKlineStream(streamSymbols, streamInterval)
    .then(() => log.ok(
      `[signal] ${streamSymbols.length} par @ ${streamInterval} — `
      + `panelen fylls när första ljuset stängt`,
    ))
    .catch((err) => log.warn(
      `[signal] kline-strömmen startade inte: ${err instanceof Error ? err.message : String(err)}`,
    ));

  // Registrera API-nyckel + run-callback för manuella agent-frågor och dashboard-triggar
  setApiKey(config.anthropicApiKey);
  setRunAgentCallback((instruction?: string) => runOnce(brokers, engines, instruction));

  // Serve-läge: bara dashboard och strömmar. Ingen agent-körning, inga
  // LLM-anrop vid start.
  if (args.serve) {
    log.ok(`Serve-läge — dashboard på http://localhost:${DASHBOARD_PORT}`);
    log.info("Agent-loopen körs inte. Använd dashboarden eller --once för en körning.");
    await new Promise(() => {});
    return;
  }

  // Engångs-körning
  if (args.once || args.propose) {
    if (args.propose) {
      (config as { executionMode: "auto" | "approve" }).executionMode = "approve";
    }
    await runOnce(brokers, engines, args.instruction);
    log.info(`Dashboard fortfarande aktiv på http://localhost:${DASHBOARD_PORT} — Ctrl+C för att stänga.`);
    // Håll processen igång så dashboarden inte dör
    await new Promise(() => {});
    return;
  }

  // Full loop med scheduler + orchestrator team
  const scheduler = new Scheduler();
  const schedule = createDefaultSchedule(config);

  // AI kostar pengar, så standard är MANUELL: bara "Kör analys". Fasta tider
  // med ANALYSIS_SCHEDULE, det gamla intervall-läget med AI_AUTO_LOOP=true.
  if (autoLoopEnabled()) {
    scheduler.addTask({
      ...schedule.agentLoop,
      execute: () => runTurnOnce(() => runOnce(brokers, engines, undefined, true, true)),
    });
  }
  if (scheduleTimes().length) {
    startFixedTimes((time) => {
      log.info(`[analys] fast tid ${time}: AI-teamet startar`);
      void runTurnOnce(() => runOnce(brokers, engines, undefined, true, true)).catch((err) =>
        log.warn(`[analys] tur kl ${time} misslyckades: ${err instanceof Error ? err.message : String(err)}`));
    });
  }
  log.ok(`[analys] ${analysisModeInfo().text}`);

  // Tidig start (bara med PRESCREEN_TRIGGER=true): när ett par får en ny
  // signal startar AI-teamet direkt i stället för att vänta på nästa tur.
  // Högst en sådan start per PRESCREEN_TRIGGER_COOLDOWN_SEC (standard 300 s,
  // samma takt som schemat) och samma par väcker teamet högst var 15:e minut.
  if (prescreenEnabled() && signalTriggerEnabled()) {
    const cooldownMs = (Number(process.env.PRESCREEN_TRIGGER_COOLDOWN_SEC ?? 300) || 300) * 1000;
    const lastDir = new Map<string, string>();
    const lastWake = new Map<string, number>();
    let lastTrigger = 0;
    subscribeSignals((sig) => {
      const prev = lastDir.get(sig.symbol);
      lastDir.set(sig.symbol, sig.direction);
      if (sig.direction === "NEUTRAL" || prev === sig.direction) return;
      const now = Date.now();
      if (now - lastTrigger < cooldownMs || now - (lastWake.get(sig.symbol) ?? 0) < 15 * 60_000) return;
      if (turnRunning) return;
      lastTrigger = now;
      lastWake.set(sig.symbol, now);
      log.info(`[JEV] ny signal ${sig.symbol} ${sig.direction} (${sig.score}): AI-teamet startar tidigt`);
      void runTurnOnce(() => runOnce(brokers, engines, undefined, true, true)).catch((err) =>
        log.warn(`[JEV] tidig tur misslyckades: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  // LEGACY position-scan (trailing stops) DISABLED — ersatt av positionMonitor.ts
  // Den spammade 437 testnet-positioner med trailing-stop-notiser till Telegram.
  // Auto-sell + advisor-verifikation hanteras nu av src/server/positionMonitor.ts
  //
  // scheduler.addTask({
  //   ...schedule.positionScan,
  //   execute: () => runOnce(brokers, engines, "Position-scan: ...", false),
  // });

  // LEGACY morning briefing + daily P&L också disabled (skickade Telegram-spam för 437 positioner)
  // Återaktiveras när vi har riktig daily-summary som inte iterar varje position
  //
  // scheduler.addTask({
  //   ...schedule.morningBriefing,
  //   execute: () => runOnce(brokers, engines, buildMorningBriefingPrompt()),
  // });
  // scheduler.addTask({
  //   ...schedule.dailyPnl,
  //   execute: () => runOnce(brokers, engines, buildDailyPnlPrompt()),
  // });

  // INGEN initial agent-turn vid boot — väntar på schemalagd tid.
  // Anledning: tidigare orsakade en exit-loop (boot → fel → restart → boot → fel)
  // hundratals oavsiktliga Claude-anrop. Schemalagd loop hanterar all körning.
  // Manuell trigger finns via "Kör analys"-knappen i dashboarden (POST /api/run-agent).
  log.info("Boot klart. Väntar på schemalagd körning eller manuell trigger.");

  await scheduler.start();
}

// Fångar oväntade fel som annars skulle krascha processen — loggar utan att exit.
// Detta tillsammans med restart: on-failure:3 i compose säkerställer att containern
// INTE restartar i loop och bränner credits vid oväntat fel.
process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.message}`);
});

main().catch((err) => {
  log.error(`Fatalt fel: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
