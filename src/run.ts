import { config } from "./config.js";
import type { BrokerAdapter } from "./brokers/adapter.js";
import { BinanceBroker } from "./brokers/binance.js";
import { AlpacaBroker } from "./brokers/alpaca.js";
import { BlofinBroker } from "./brokers/blofin.js";
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

function createBrokers(): Record<string, BrokerAdapter> {
  const brokers: Record<string, BrokerAdapter> = {};

  if (config.alpaca.enabled) {
    brokers.alpaca = new AlpacaBroker({
      keyId: config.alpaca.keyId,
      secretKey: config.alpaca.secretKey,
      baseUrl: config.alpaca.baseUrl,
      dataUrl: config.alpaca.dataUrl,
      mode: config.mode,
    });
  }

  if (config.blofin.enabled) {
    brokers.blofin = new BlofinBroker({
      apiKey: config.blofin.apiKey,
      apiSecret: config.blofin.apiSecret,
      passphrase: config.blofin.passphrase,
      baseUrl: config.blofin.baseUrl,
      mode: config.mode,
    });
  }

  if (config.binance.enabled) {
    brokers.binance = new BinanceBroker({
      apiKey: config.binance.apiKey,
      apiSecret: config.binance.apiSecret,
      baseUrl: config.binance.baseUrl,
      mode: config.mode,
    });
  }

  return brokers;
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
        if (brokers.alpaca && brokers.alpaca instanceof AlpacaBroker) {
          engines.push(
            new WheelEngine(brokers.alpaca, {
              underlyings: config.wheel.underlyings,
              putDelta: config.wheel.putDelta,
              profitTargetPct: config.wheel.profitTargetPct,
            }),
          );
        } else {
          log.warn("Motor B (Wheel) kräver Alpaca. Skippar.");
        }
        break;

      case "crypto_momentum": {
        const cryptoBroker = brokers.blofin ?? brokers.binance;
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

async function runOnce(
  brokers: Record<string, BrokerAdapter>,
  engines: StrategyEngine[],
  instruction?: string,
  useTeam = true,
): Promise<void> {
  const state = await loadState();

  if (state.killSwitchActive) {
    log.error("🛑 Kill-switch aktiv. Kör `npm run kill off` för att återställa.");
    return;
  }

  // Respektera broker-val från dashboard (runtime), fallback till default-prioritet
  const activeName = getActiveBrokerName();
  const primaryBroker = activeName
    ? brokers[activeName]
    : (brokers.alpaca ?? brokers.blofin ?? brokers.binance);
  if (!primaryBroker) {
    log.error("Ingen broker tillgänglig.");
    return;
  }
  log.info(`Aktiv broker: ${activeName ?? Object.keys(brokers).find((k) => brokers[k] === primaryBroker) ?? "?"} (${primaryBroker.mode})`);

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
    });
    finalText = result.headTrader.decision.briefingSummary;
    toolCalls = result.headTrader.toolCalls;
    placedOrders = result.headTrader.placedOrders;

    broadcastEvent("team-reports", {
      ...result.reports,
      timing: result.timingMs,
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
}

// ── CLI ──

function parseArgs(): { once: boolean; propose: boolean; instruction?: string } {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const propose = args.includes("--propose");
  const instArg = args.find((a) => a.startsWith("--instruction="));
  const instruction = instArg ? instArg.slice("--instruction=".length) : undefined;
  return { once, propose, instruction };
}

async function main(): Promise<void> {
  const args = parseArgs();

  log.info("╔══════════════════════════════════════════════════════════╗");
  log.info("║            MIKAEL TRADING OS                            ║");
  log.info("║  Multi-Asset Trading Agent powered by Claude            ║");
  log.info("╚══════════════════════════════════════════════════════════╝");
  log.info(`  Mode: ${config.mode}  |  Execution: ${config.executionMode}`);
  log.info(`  Engines: ${config.engines.join(", ")}`);
  log.info(`  Brokers: ${[
    config.alpaca.enabled && "Alpaca",
    config.blofin.enabled && "Blofin",
    config.binance.enabled && "Binance",
  ].filter(Boolean).join(", ")}`);
  log.info("──────────────────────────────────────────────────────────");

  const brokers = createBrokers();
  const engines = createEngines(brokers);

  if (engines.length === 0) {
    log.warn("Inga strategi-motorer aktiva. Agenten kör i friform-läge.");
  }

  // Starta dashboard-server (alltid, även i once-mode)
  const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? "3939", 10);
  startServer(DASHBOARD_PORT, brokers);

  // Registrera API-nyckel + run-callback för manuella agent-frågor och dashboard-triggar
  setApiKey(config.anthropicApiKey);
  setRunAgentCallback(() => runOnce(brokers, engines));

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

  scheduler.addTask({
    ...schedule.agentLoop,
    execute: () => runOnce(brokers, engines),
  });

  scheduler.addTask({
    ...schedule.positionScan,
    execute: () =>
      runOnce(
        brokers,
        engines,
        "Position-scan: kolla alla öppna positioner, justera trailing stops uppåt (aldrig ner), stäng om stop/target nåtts.",
        false, // position-scan = single agent (snabbare)
      ),
  });

  scheduler.addTask({
    ...schedule.morningBriefing,
    execute: () => runOnce(brokers, engines, buildMorningBriefingPrompt()),
  });

  scheduler.addTask({
    ...schedule.dailyPnl,
    execute: () => runOnce(brokers, engines, buildDailyPnlPrompt()),
  });

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
