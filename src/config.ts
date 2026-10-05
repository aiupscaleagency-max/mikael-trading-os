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

/** Äldre USDT-listor migreras till samma USDC-par som TEST och LIVE använder. */
function normalizeSymbol(value: string): string {
  return value.toUpperCase().replace(/^MATIC/, "POL").replace(/USDT$/, "USDC");
}

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

  // ── Bybit EU (krypto, EU-licens, API-handel tillåten från Sverige). Alltid LIVE. ──
  BYBIT_API_KEY: z.string().default(""),
  BYBIT_API_SECRET: z.string().default(""),
  // TEST och LIVE delar alltid Bybit EU:s USDC-marknad.
  BYBIT_QUOTE: z.literal("USDC").default("USDC"),
  BYBIT_BASE_URL: z.literal("https://api.bybit.eu").default("https://api.bybit.eu"),
  // ── Perplexity (Lars — Research-Analytiker) ──
  PERPLEXITY_API_KEY: z.string().default(""),

  // ── Supabase (multi-tenant, server-side service-role) ──
  SUPABASE_URL: z.string().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),
  // Admin-mode: när satt, backend kör som denna user (läser deras nycklar
  // från Supabase istället för .env). Lämna tom för fallback till .env.
  SUPABASE_USER_ID: z.string().default(""),

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
  CRYPTO_SYMBOLS: csvList.default("BTCUSDC,ETHUSDC,SOLUSDC,BNBUSDC,XRPUSDC,ADAUSDC,AVAXUSDC,DOGEUSDC,DOTUSDC,LINKUSDC,POLUSDC,UNIUSDC,LTCUSDC,ATOMUSDC,NEARUSDC"),
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
const hasBybit = !!(env.BYBIT_API_KEY && env.BYBIT_API_SECRET);
const hasPerplexity = !!env.PERPLEXITY_API_KEY;

// ── Vy-läge ─────────────────────────────────────────────────────────────
// Utan mäklarnycklar startar systemet ändå, i vy-läge: publik marknadsdata,
// diagram och signaler fungerar, men ingen order kan läggas eftersom ingen
// broker finns att lägga den mot.
//
// Tidigare avbröts starten här. Det gjorde att man inte kunde titta på
// systemet utan att först koppla ett riktigt konto — och att koppla ett
// konto bara för att se ett diagram är fel ordning.
const viewOnly = process.env.BYBIT_PAPER === "false" && !hasBybit;
if (viewOnly) {
  console.warn(
    "⚠️  Ingen broker konfigurerad — startar i VY-LÄGE.\n" +
    "   Marknadsdata, diagram och signaler fungerar. Inga ordrar kan läggas.\n" +
    "   Aktivera Bybit TEST eller koppla Bybit EU för att förbereda LIVE.",
  );
}

const cryptoSymbols: string[] = [...new Set(env.CRYPTO_SYMBOLS.map(normalizeSymbol).filter((x) => /^[A-Z0-9]{2,20}USDC$/.test(x)))];

export const config = {
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  /** Ingen broker konfigurerad — ordrar är omöjliga, inte bara avstängda. */
  viewOnly,
  mode: env.MODE as Mode,
  executionMode: env.EXECUTION_MODE as ExecutionMode,

  engines: [] as string[],

  bybit: {
    enabled: hasBybit,
    apiKey: env.BYBIT_API_KEY,
    apiSecret: env.BYBIT_API_SECRET,
    quote: env.BYBIT_QUOTE,
    baseUrl: env.BYBIT_BASE_URL,
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
    symbols: cryptoSymbols,
  },

  loopIntervalSeconds: env.LOOP_INTERVAL_SECONDS,
  scanIntervalSeconds: env.SCAN_INTERVAL_SECONDS,
  briefingHourUtc: env.BRIEFING_HOUR_UTC,
} as const;

export type Config = typeof config;

// Egna mynt (Mike 2026-10-04): tips från grupper läggs till i dashboarden och
// sparas i data/custom-symbols.json. De läses in här, innan strömmarna startar,
// så att signalmotorn, JEV och agenterna följer dem precis som de 15 vanliga.
try {
  const extra = JSON.parse(readFileSync(resolvePath("data/custom-symbols.json"), "utf8")) as { symbols?: Array<{ symbol: string }> };
  for (const c of extra.symbols ?? []) {
    const sym = normalizeSymbol(String(c.symbol || ""));
    if (/^[A-Z0-9]{2,20}USDC$/.test(sym) && !config.crypto.symbols.includes(sym)) config.crypto.symbols.push(sym);
  }
} catch { /* inga egna mynt ännu */ }
