import { log } from "../../logger.js";
import type { TradeExecutor, ExecutorMode } from "./types.js";
import { PaperExecutor } from "./paperExecutor.js";
import { BinanceExecutor } from "./binanceExecutor.js";
import { OandaExecutor } from "./oandaExecutor.js";
import { BlofinExecutor } from "./blofinExecutor.js";

// ═══════════════════════════════════════════════════════════════════════════
// Executor Registry — hanterar nuvarande aktiv executor + symbol-routing
//
// Mode-toggle byter executor; tradeState kallar getExecutorForSymbol(sym)
// så att forex routas till Oanda och crypto till Binance automatiskt.
// ═══════════════════════════════════════════════════════════════════════════

let cryptoExecutor: TradeExecutor = new PaperExecutor();   // Binance public för pris
let forexExecutor: TradeExecutor | null = null;             // Oanda om configured

export function getActiveExecutor(): TradeExecutor {
  return cryptoExecutor; // backward-compatibility
}

// SYMBOL-BASERAD ROUTING — crypto → Binance, forex → Oanda
export function getExecutorForSymbol(symbol: string): TradeExecutor {
  const isForex = symbol.includes("/") || /^(EUR|GBP|USD|JPY|CHF|AUD|NZD|CAD)_/.test(symbol);
  if (isForex) {
    if (!forexExecutor) {
      throw new Error(`Forex (${symbol}) kräver Oanda-executor — konfigurera Oanda i Settings först`);
    }
    return forexExecutor;
  }
  return cryptoExecutor;
}

export function getCurrentMode(): ExecutorMode {
  return cryptoExecutor.mode;
}

export function setActiveExecutor(executor: TradeExecutor): void {
  log.info(`[executor] Bytte crypto-executor till: ${executor.name}`);
  cryptoExecutor = executor;
}

export function setForexExecutor(executor: TradeExecutor | null): void {
  if (executor) log.info(`[executor] Forex-executor: ${executor.name}`);
  else log.info(`[executor] Forex-executor avaktiverad`);
  forexExecutor = executor;
}

export function hasForexExecutor(): boolean {
  return forexExecutor !== null;
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

// Konfigurera Blofin-executor (alternativ till Binance för crypto/futures)
export async function setupBlofin(opts: { apiKey: string; apiSecret: string; passphrase: string; testnet?: boolean }): Promise<{ ok: boolean; details: string }> {
  try {
    if (!opts.apiKey || !opts.apiSecret || !opts.passphrase) {
      return { ok: false, details: "Blofin kräver apiKey + apiSecret + passphrase" };
    }
    const executor = new BlofinExecutor({
      apiKey: opts.apiKey,
      apiSecret: opts.apiSecret,
      passphrase: opts.passphrase,
      testnet: !!opts.testnet,
    });
    const hc = await executor.healthCheck();
    if (!hc.ok) return { ok: false, details: hc.details };
    setActiveExecutor(executor);
    return { ok: true, details: hc.details };
  } catch (err) {
    return { ok: false, details: err instanceof Error ? err.message : String(err) };
  }
}

// Konfigurera Oanda-executor för forex (separat från crypto-mode)
export async function setupOanda(opts: { apiToken: string; accountId: string; practice?: boolean }): Promise<{ ok: boolean; details: string }> {
  try {
    if (!opts.apiToken || !opts.accountId) {
      setForexExecutor(null);
      return { ok: false, details: "Oanda apiToken + accountId krävs" };
    }
    const executor = new OandaExecutor({
      apiToken: opts.apiToken,
      accountId: opts.accountId,
      practice: opts.practice !== false, // default true (demo)
    });
    const hc = await executor.healthCheck();
    if (!hc.ok) {
      setForexExecutor(null);
      return { ok: false, details: hc.details };
    }
    setForexExecutor(executor);
    return { ok: true, details: hc.details };
  } catch (err) {
    setForexExecutor(null);
    return { ok: false, details: err instanceof Error ? err.message : String(err) };
  }
}
