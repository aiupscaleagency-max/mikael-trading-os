import { log } from "../../logger.js";
import type { TradeExecutor, ExecutorMode } from "./types.js";
import { PaperExecutor } from "./paperExecutor.js";
import { BinanceExecutor } from "./binanceExecutor.js";

// ═══════════════════════════════════════════════════════════════════════════
// Executor Registry — hanterar nuvarande aktiv executor
//
// Mode-toggle byter executor; tradeState kallar alltid getActiveExecutor()
// så samma kod-väg används oavsett TEST/PROPOSE/LIVE.
// ═══════════════════════════════════════════════════════════════════════════

let activeExecutor: TradeExecutor = new PaperExecutor();

export function getActiveExecutor(): TradeExecutor {
  return activeExecutor;
}

export function getCurrentMode(): ExecutorMode {
  return activeExecutor.mode;
}

export function setActiveExecutor(executor: TradeExecutor): void {
  log.info(`[executor] Bytte till: ${executor.name} (mode: ${executor.mode})`);
  activeExecutor = executor;
}

// Helper för mode-byte från frontend/api
export async function switchMode(mode: ExecutorMode, opts?: { binanceApiKey?: string; binanceApiSecret?: string }): Promise<{ ok: boolean; details: string }> {
  try {
    if (mode === "paper") {
      setActiveExecutor(new PaperExecutor());
      const hc = await activeExecutor.healthCheck();
      return { ok: hc.ok, details: hc.details };
    }
    if (mode === "binance-testnet" || mode === "binance-live") {
      const apiKey = opts?.binanceApiKey || process.env.BINANCE_API_KEY || "";
      const apiSecret = opts?.binanceApiSecret || process.env.BINANCE_API_SECRET || "";
      if (!apiKey || !apiSecret) {
        return { ok: false, details: "Binance API-keys saknas — konfigurera i Settings" };
      }
      const executor = new BinanceExecutor({
        apiKey,
        apiSecret,
        testnet: mode === "binance-testnet",
      });
      const hc = await executor.healthCheck();
      if (!hc.ok) return { ok: false, details: hc.details };
      setActiveExecutor(executor);
      return { ok: true, details: hc.details };
    }
    return { ok: false, details: `Okänt mode: ${mode}` };
  } catch (err) {
    return { ok: false, details: err instanceof Error ? err.message : String(err) };
  }
}
