import "dotenv/config";
import { z } from "zod";
import type { ExecutionMode, Mode } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
//  MIKAEL TRADING OS — KONFIGURATION
//  Laddar och validerar .env. Kraschar tidigt om något kritiskt saknas.
// ═══════════════════════════════════════════════════════════════════════════

const csvList = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );

const schema = z.object({
  ANTHROPIC_API_KEY: z.string().min(10, "ANTHROPIC_API_KEY saknas"),

  MODE: z.enum(["paper", "live"]).default("paper"),
  LIVE_TRADING_CONFIRMED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),

  // ── Alpaca (Aktier + Optioner) ──
  ALPACA_KEY_ID: z.string().default(""),
  ALPACA_SECRET_KEY: z.string().default(""),
  ALPACA_BASE_URL: z
    .string()
    .default("https://paper-api.alpaca.markets"),

  // ── Blofin (Krypto-derivat) ──
  BLOFIN_API_KEY: z.string().default(""),
  BLOFIN_API_SECRET: z.string().default(""),
  BLOFIN_PASSPHRASE: z.string().default(""),
  BLOFIN_BASE_URL: z
    .string()
    .default("https://openapi.blofin.com"),

  // ── Binance (Krypto spot, valfritt fallback) ──
  BINANCE_API_KEY: z.string().default(""),
  BINANCE_API_SECRET: z.string().default(""),
  BINANCE_LIVE_API_KEY: z.string().default(""),
  BINANCE_LIVE_API_SECRET: z.string().default(""),

  // ── Vilka motorer ska vara aktiva? ──
  ENGINES: z
    .string()
    .default("crypto_momentum")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),

  // ── Risk-ramar ──
  MAX_POSITION_USD: z.coerce.number().positive().default(100),
  MAX_TOTAL_EXPOSURE_USD: z.coerce.number().positive().default(500),
  MAX_DAILY_LOSS_USD: z.coerce.number().positive().default(50),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),

  // ── Symbol-listor per motor ──
  CRYPTO_SYMBOLS: csvList.default("BTCUSDT,ETHUSDT,SOLUSDT"),
  STOCK_SYMBOLS: csvList.default("TSLA,NVDA,AAPL,MSFT"),
  WHEEL_UNDERLYINGS: csvList.default("TSLA,NVDA"),

  // ── Crypto Momentum specifikt ──
  CRYPTO_LEVERAGE: z.coerce.number().int().min(1).max(20).default(5),
  CRYPTO_TRAILING_STOP_PCT: z.coerce.number().positive().default(2),
  CRYPTO_TP_STEPS: z
    .string()
    .default("5,10,20")
    .transform((v) => v.split(",").map(Number)),

  // ── Wheel specifikt ──
  WHEEL_PUT_DELTA: z.coerce.number().default(0.3),
  WHEEL_PROFIT_TARGET_PCT: z.coerce.number().default(50),

  // ── Timing ──
  LOOP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  SCAN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(900),
  EXECUTION_MODE: z.enum(["auto", "approve"]).default("auto"),

  // ── Morning briefing (UTC-timme) ──
  BRIEFING_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(7),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Ogiltig konfiguration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// Live-spärr
if (env.MODE === "live" && !env.LIVE_TRADING_CONFIRMED) {
  console.error(
    "❌ MODE=live men LIVE_TRADING_CONFIRMED=false. " +
      "Sätt LIVE_TRADING_CONFIRMED=true i .env för att bekräfta att du förstår riskerna.",
  );
  process.exit(1);
}

// Minst en broker måste vara konfigurerad.
const hasAlpaca = !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY);
const hasBlofin = !!(env.BLOFIN_API_KEY && env.BLOFIN_API_SECRET && env.BLOFIN_PASSPHRASE);
const hasBinance = !!(env.BINANCE_API_KEY && env.BINANCE_API_SECRET) ||
  !!(env.BINANCE_LIVE_API_KEY && env.BINANCE_LIVE_API_SECRET);

if (!hasAlpaca && !hasBlofin && !hasBinance) {
  console.error(
    "❌ Ingen broker konfigurerad. Fyll i minst Alpaca ELLER Blofin ELLER Binance-nycklar i .env.",
  );
  process.exit(1);
}

export const config = {
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  mode: env.MODE as Mode,
  executionMode: env.EXECUTION_MODE as ExecutionMode,

  engines: env.ENGINES as string[],

  alpaca: {
    enabled: hasAlpaca,
    keyId: env.ALPACA_KEY_ID,
    secretKey: env.ALPACA_SECRET_KEY,
    baseUrl: env.ALPACA_BASE_URL,
    dataUrl: "https://data.alpaca.markets",
  },

  blofin: {
    enabled: hasBlofin,
    apiKey: env.BLOFIN_API_KEY,
    apiSecret: env.BLOFIN_API_SECRET,
    passphrase: env.BLOFIN_PASSPHRASE,
    baseUrl: env.BLOFIN_BASE_URL,
  },

  binance: {
    enabled: hasBinance,
    apiKey: env.MODE === "live" ? env.BINANCE_LIVE_API_KEY : env.BINANCE_API_KEY,
    apiSecret: env.MODE === "live" ? env.BINANCE_LIVE_API_SECRET : env.BINANCE_API_SECRET,
    baseUrl:
      env.MODE === "live" ? "https://api.binance.com" : "https://testnet.binance.vision",
  },

  risk: {
    maxPositionUsd: env.MAX_POSITION_USD,
    maxTotalExposureUsd: env.MAX_TOTAL_EXPOSURE_USD,
    maxDailyLossUsd: env.MAX_DAILY_LOSS_USD,
    maxOpenPositions: env.MAX_OPEN_POSITIONS,
  },

  crypto: {
    symbols: env.CRYPTO_SYMBOLS,
    leverage: env.CRYPTO_LEVERAGE,
    trailingStopPct: env.CRYPTO_TRAILING_STOP_PCT,
    takeProfitSteps: env.CRYPTO_TP_STEPS,
  },

  stocks: {
    symbols: env.STOCK_SYMBOLS,
  },

  wheel: {
    underlyings: env.WHEEL_UNDERLYINGS,
    putDelta: env.WHEEL_PUT_DELTA,
    profitTargetPct: env.WHEEL_PROFIT_TARGET_PCT,
  },

  loopIntervalSeconds: env.LOOP_INTERVAL_SECONDS,
  scanIntervalSeconds: env.SCAN_INTERVAL_SECONDS,
  briefingHourUtc: env.BRIEFING_HOUR_UTC,
} as const;

export type Config = typeof config;
