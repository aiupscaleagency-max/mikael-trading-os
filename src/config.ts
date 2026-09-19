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

  // ── Perplexity (Lars — Research-Analytiker) ──
  PERPLEXITY_API_KEY: z.string().default(""),

  // ── Supabase (multi-tenant, server-side service-role) ──
  SUPABASE_URL: z.string().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),
  // Admin-mode: när satt, backend kör som denna user (läser deras nycklar
  // från Supabase istället för .env). Lämna tom för fallback till .env.
  SUPABASE_USER_ID: z.string().default(""),

  // ── Oanda (Forex-broker) ──
  OANDA_API_KEY: z.string().default(""),
  OANDA_ACCOUNT_ID: z.string().default(""),
  OANDA_BASE_URL: z.string().default("https://api-fxpractice.oanda.com"),

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
  // DEFAULT_POSITION_USD = vad Hanna (Head Trader) använder som standard per trade.
  // MIN/MAX = golv & tak. Hanna får anpassa storlek upp/ner baserat på conviction
  // (Karin's vol-multiplier styr också). Risk Manager blockerar utanför ramen.
  DEFAULT_POSITION_USD: z.coerce.number().positive().default(50),
  MIN_POSITION_USD: z.coerce.number().positive().default(20),
  MAX_POSITION_USD: z.coerce.number().positive().default(100),
  MAX_TOTAL_EXPOSURE_USD: z.coerce.number().positive().default(500),
  MAX_DAILY_LOSS_USD: z.coerce.number().positive().default(50),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),

  // ── AI-Spend cap (circuit breaker — stoppar sessions om överskridet) ──
  MAX_DAILY_SPEND_USD: z.coerce.number().positive().default(2),
  MAX_WEEKLY_SPEND_USD: z.coerce.number().positive().default(10),

  // ── Symbol-listor per motor ──
  CRYPTO_SYMBOLS: csvList.default("BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,DOGEUSDT,DOTUSDT,LINKUSDT,MATICUSDT,UNIUSDT,LTCUSDT,ATOMUSDT,NEARUSDT"),
  STOCK_SYMBOLS: csvList.default("TSLA,NVDA,AAPL,MSFT"),
  WHEEL_UNDERLYINGS: csvList.default("TSLA,NVDA"),
  FOREX_SYMBOLS: csvList.default("EUR_USD,GBP_USD,USD_JPY,USD_CHF,AUD_USD,USD_CAD,EUR_GBP"),

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

  // ── Ensemble (2-modell-omröstning innan risk manager) ──
  // MODEL_A = modellen som FÖRESLÅR traden (Head Trader).
  // MODEL_B = den oberoende andra-åsikten som måste hålla med.
  // Två OLIKA modeller — helst från olika leverantörer — ger genuint skilda
  // perspektiv istället för samma blinda fläckar.
  // MODEL_A: Claude (Head Trader). MODEL_B: granskaren — default GPT-6 Astra
  // via OpenAI, med Claude som fallback om OpenAI-vägen inte går att använda.
  MODEL_A: z.string().default("claude-sonnet-4-6"),
  MODEL_B: z.string().default("gpt-6-astra"),
  // Provider för MODEL_B. "anthropic" och "openai" är implementerade;
  // "openrouter" är förberedd men inte byggd (se secondOpinion.ts).
  MODEL_B_PROVIDER: z.enum(["anthropic", "openrouter", "openai"]).default("openai"),
  // Claude-modell som röstar om MODEL_B-leverantören inte kan användas
  // (saknad nyckel, 401/403, slut kvot, okänd modell).
  ENSEMBLE_FALLBACK_MODEL: z.string().default("claude-opus-4-6"),

  // ── OpenAI (MODEL_B) — EGEN nyckel, aldrig ANTHROPIC_API_KEY ──
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  // Valfritt. Skickas bara om satt (low/medium/high/xhigh på Astra).
  OPENAI_REASONING_EFFORT: z.string().default(""),
  ENSEMBLE_REQUIRE_AGREEMENT: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  // Om MODEL_B kraschar/timeout:ar — ska traden släppas igenom?
  // Default false = fail-closed (ingen andra-åsikt ⇒ ingen trade).
  ENSEMBLE_FAIL_OPEN: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  // Ska grinden även gälla EXITS (SELL)? Default false — vi vill aldrig
  // att en andra modell kan låsa in oss i en förlorande position.
  ENSEMBLE_GATE_EXITS: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  ENSEMBLE_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
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
const hasOanda = !!(env.OANDA_API_KEY && env.OANDA_ACCOUNT_ID);
const hasPerplexity = !!env.PERPLEXITY_API_KEY;

if (!hasAlpaca && !hasBlofin && !hasBinance && !hasOanda) {
  console.error(
    "❌ Ingen broker konfigurerad. Fyll i minst Alpaca ELLER Blofin ELLER Binance-nycklar i .env.",
  );
  process.exit(1);
}

// Ensemble: varna tydligt vid start om MODEL_B-vägen inte är körbar.
// Vi stoppar inte igång — grinden faller tillbaka på Claude-B per granskning —
// men Mike ska se det direkt i loggen, inte först vid första trade-förslaget.
if (env.MODEL_B_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
  console.warn(
    `⚠ MODEL_B_PROVIDER=openai men OPENAI_API_KEY saknas. Granskaren (${env.MODEL_B}) ` +
      `kan inte anropas — ensemblen faller tillbaka på ${env.ENSEMBLE_FALLBACK_MODEL} (Claude). ` +
      `Lägg OPENAI_API_KEY i .env (egen nyckel — återanvänd ALDRIG ANTHROPIC_API_KEY).`,
  );
}
if (env.MODEL_B_PROVIDER === "openrouter") {
  console.warn(
    `⚠ MODEL_B_PROVIDER=openrouter är inte implementerad — ensemblen faller tillbaka på ${env.ENSEMBLE_FALLBACK_MODEL}.`,
  );
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

  oanda: {
    enabled: hasOanda,
    apiKey: env.OANDA_API_KEY,
    accountId: env.OANDA_ACCOUNT_ID,
    baseUrl: env.OANDA_BASE_URL,
    symbols: env.FOREX_SYMBOLS,
  },

  perplexity: {
    enabled: hasPerplexity,
    apiKey: env.PERPLEXITY_API_KEY,
  },

  supabase: {
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    userId: env.SUPABASE_USER_ID,
    enabled: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
  },

  risk: {
    defaultPositionUsd: env.DEFAULT_POSITION_USD,
    minPositionUsd: env.MIN_POSITION_USD,
    maxPositionUsd: env.MAX_POSITION_USD,
    maxTotalExposureUsd: env.MAX_TOTAL_EXPOSURE_USD,
    maxDailyLossUsd: env.MAX_DAILY_LOSS_USD,
    maxOpenPositions: env.MAX_OPEN_POSITIONS,
  },

  costCap: {
    dailyUsd: env.MAX_DAILY_SPEND_USD,
    weeklyUsd: env.MAX_WEEKLY_SPEND_USD,
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

  ensemble: {
    modelA: env.MODEL_A,
    modelB: env.MODEL_B,
    modelBProvider: env.MODEL_B_PROVIDER,
    requireAgreement: env.ENSEMBLE_REQUIRE_AGREEMENT,
    failOpen: env.ENSEMBLE_FAIL_OPEN,
    gateExits: env.ENSEMBLE_GATE_EXITS,
    timeoutMs: env.ENSEMBLE_TIMEOUT_MS,
    fallbackModel: env.ENSEMBLE_FALLBACK_MODEL,
    openai: {
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
      reasoningEffort: env.OPENAI_REASONING_EFFORT || undefined,
    },
  },

  loopIntervalSeconds: env.LOOP_INTERVAL_SECONDS,
  scanIntervalSeconds: env.SCAN_INTERVAL_SECONDS,
  briefingHourUtc: env.BRIEFING_HOUR_UTC,
} as const;

export type Config = typeof config;
