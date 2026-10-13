import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
  // Krävs av agent-lagret, men inte för att starta och titta på marknadsdata.
  // Saknas den loggas det när en agent faktiskt anropas.
  ANTHROPIC_API_KEY: z.string().default(""),
  // Vercel AI Gateway: när den är satt går alla modellanrop dit (src/llm/gateway.ts).
  AI_GATEWAY_API_KEY: z.string().default(""),

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
  // Separata nycklar för Alpacas RIKTIGA konto. Alpaca ger olika nycklar för
  // paper och live, så båda kan ligga inne samtidigt. Order mot live-kontot
  // släpps ändå bara igenom när MODE=live och LIVE_TRADING_CONFIRMED=true.
  ALPACA_LIVE_KEY_ID: z.string().default(""),
  ALPACA_LIVE_SECRET_KEY: z.string().default(""),
  ALPACA_LIVE_BASE_URL: z.string().default("https://api.alpaca.markets"),

  // ── Kraken (krypto, tillåter API-handel från Sverige/EU). Alltid LIVE. ──
  KRAKEN_API_KEY: z.string().default(""),
  KRAKEN_API_SECRET: z.string().default(""),
  // Valutan du har på Kraken-kontot (EUR för svenska konton, eller USD)
  KRAKEN_QUOTE: z.string().default("EUR"),

  // ── Bybit EU (krypto, EU-licens, API-handel tillåten från Sverige). Alltid LIVE. ──
  BYBIT_API_KEY: z.string().default(""),
  BYBIT_API_SECRET: z.string().default(""),
  // USDC som standard: USDT är begränsat i EU
  BYBIT_QUOTE: z.string().default("USDC"),
  BYBIT_BASE_URL: z.string().default("https://api.bybit.eu"),
  // Bybit Demo Trading (TEST på samma börs som LIVE). Nyckeln skapas i Bybit under Demo Trading → API.
  BYBIT_DEMO_API_KEY: z.string().default(""),
  BYBIT_DEMO_API_SECRET: z.string().default(""),
  BYBIT_DEMO_BASE_URL: z.string().default("https://api-demo.bybit.com"),

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
  CRYPTO_SYMBOLS: csvList.default("BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,DOGEUSDT,DOTUSDT,LINKUSDT,POLUSDT,UNIUSDT,LTCUSDT,ATOMUSDT,NEARUSDT"),
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
const hasAlpacaLive = !!(env.ALPACA_LIVE_KEY_ID && env.ALPACA_LIVE_SECRET_KEY);
const hasKraken = !!(env.KRAKEN_API_KEY && env.KRAKEN_API_SECRET);
const hasBybit = !!(env.BYBIT_API_KEY && env.BYBIT_API_SECRET);
const hasBybitDemo = !!(env.BYBIT_DEMO_API_KEY && env.BYBIT_DEMO_API_SECRET);
const hasBlofin = !!(env.BLOFIN_API_KEY && env.BLOFIN_API_SECRET && env.BLOFIN_PASSPHRASE);
const hasBinance = !!(env.BINANCE_API_KEY && env.BINANCE_API_SECRET) ||
  !!(env.BINANCE_LIVE_API_KEY && env.BINANCE_LIVE_API_SECRET);
const hasOanda = !!(env.OANDA_API_KEY && env.OANDA_ACCOUNT_ID);
const hasPerplexity = !!env.PERPLEXITY_API_KEY;

// ── Vy-läge ─────────────────────────────────────────────────────────────
// Utan mäklarnycklar startar systemet ändå, i vy-läge: publik marknadsdata,
// diagram och signaler fungerar, men ingen order kan läggas eftersom ingen
// broker finns att lägga den mot.
//
// Tidigare avbröts starten här. Det gjorde att man inte kunde titta på
// systemet utan att först koppla ett riktigt konto — och att koppla ett
// konto bara för att se ett diagram är fel ordning.
// IG är plattformen (Demo + Live). Inloggning ligger i ~/.config/aiupscale/trading-ig.json
// (IG_CREDENTIALS_FILE), inte i .env. Utan den visas IG som ej anslutet i dashboarden.
const viewOnly = false;
void hasAlpaca; void hasAlpacaLive; void hasKraken; void hasBybit; void hasBybitDemo; void hasBlofin; void hasBinance; void hasOanda;

export const config = {
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  /** Ingen broker konfigurerad — ordrar är omöjliga, inte bara avstängda. */
  viewOnly,
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

  bybit: {
    enabled: hasBybit,
    apiKey: env.BYBIT_API_KEY,
    apiSecret: env.BYBIT_API_SECRET,
    quote: env.BYBIT_QUOTE,
    baseUrl: env.BYBIT_BASE_URL,
  },

  bybitDemo: {
    enabled: hasBybitDemo,
    apiKey: env.BYBIT_DEMO_API_KEY,
    apiSecret: env.BYBIT_DEMO_API_SECRET,
    quote: env.BYBIT_QUOTE,
    baseUrl: env.BYBIT_DEMO_BASE_URL,
  },

  kraken: {
    enabled: hasKraken,
    apiKey: env.KRAKEN_API_KEY,
    apiSecret: env.KRAKEN_API_SECRET,
    quote: env.KRAKEN_QUOTE,
  },

  alpacaLive: {
    enabled: hasAlpacaLive,
    keyId: env.ALPACA_LIVE_KEY_ID,
    secretKey: env.ALPACA_LIVE_SECRET_KEY,
    baseUrl: env.ALPACA_LIVE_BASE_URL,
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
    // MATIC heter POL sedan 2024 (Bybit har inget MATIC-par), så en gammal .env byts ut här
    // IG: fylls från IG-bevakningslistan (EPICs) vid start, se run.ts. CRYPTO_SYMBOLS används inte.
    symbols: [] as string[],
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

// Egna mynt/par: med IG ligger de i IG-bevakningslistan (data/ig-watchlist-<miljö>.json, src/server/igMarketData.ts).
