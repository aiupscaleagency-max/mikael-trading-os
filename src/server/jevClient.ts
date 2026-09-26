import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// JEV — probabilistiskt bedömningslager
//
// UPPDELNINGEN, som är hela poängen:
//   Vår kod   räknar aritmetik, hårda mått och regler (signalEngine, riskManager)
//   JEV       bedömer luddiga tillstånd — trendar marknaden, är flödet
//             informerat, håller exekveringen?
//
// JEV får ALDRIG räkna och ALDRIG handla. Sju typade frågor i ETT anrop,
// svar under ~500 ms.
//
// ── SÄKERHETSREGELN ──────────────────────────────────────────────────────
// JEV kan bara SÄNKA en signal, aldrig höja den. En LONG kan bli AVVAKTA;
// en AVVAKTA kan aldrig bli LONG.
//
// Skälet: siffrorna kommer från kod som går att testa och upprepa. Ett
// probabilistiskt lager som kunde skapa signaler skulle kunna hallucinera
// fram en trade. Som veto är det däremot bara skyddande.
//
// ── NÄR JEV ÄR NERE ──────────────────────────────────────────────────────
// Systemet fortsätter i RULES_ONLY: signalerna räknas som vanligt, men utan
// bedömningslagret. Det syns i varje signal (jev.mode). Inget tystnar.
//
// Protokoll enligt reference/jev/jev-hft-system.md.
// ═══════════════════════════════════════════════════════════════════════════

const TYPESAFE_DIRECT_URL = "https://api.typesafe.ai/v1/systemone";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";

const RETRYABLE = new Set([429, 529]);
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 350;
const DEFAULT_TIMEOUT_MS = 2500;

export type JevMode = "direct" | "gateway" | "rules_only";

export interface JevAnswer {
  type: "choice" | "noul" | "score";
  choice?: string;
  noul?: number;
  score?: number;
  confidence?: number;
}

export interface JevVerdict {
  mode: JevMode;
  /** false när JEV inte gick att nå — signalen gäller ändå, utan bedömning. */
  available: boolean;
  answers: Record<string, JevAnswer>;
  latencyMs: number | null;
  model: string | null;
  note: string;
}

/**
 * De sju frågorna. Varje är en BEDÖMNING, aldrig en beräkning.
 * Ordningen och id:na följer specen — ändras de matchar svaren inte.
 */
function buildQuestions(): Record<string, unknown> {
  return {
    regime: {
      type: "choice",
      instructions: "What market regime does this state describe?",
      criteria: { trending: null, mean_reverting: null, high_vol: null, crisis: null },
    },
    direction: {
      type: "choice",
      instructions: "What is the price bias over the next 10 ticks?",
      criteria: { up: null, down: null, neutral: null },
    },
    toxic_flow: {
      type: "noul",
      instructions: "Is the aggressive flow in this state likely informed rather than noise?",
    },
    liquidity_stressed: {
      type: "noul",
      instructions: "Is the order book thinner than its recent norm?",
    },
    quote_environment: {
      type: "score",
      instructions: "How favourable is this state for providing liquidity?",
      criteria: ["Do not quote", "Marginal", "Standard", "Excellent"],
    },
    inventory_pressure: {
      type: "score",
      instructions: "Given the current inventory, how urgent is it to cut the position?",
      criteria: ["None", "Mild", "Skew hard", "Reduce now"],
    },
    execution_health: {
      type: "score",
      instructions: "Is execution quality optimal or degrading in this state?",
      criteria: ["Degrading", "Acceptable", "Good", "Optimal"],
    },
  };
}

/**
 * Nyckelupplösning enligt specen:
 *   1. TYPESAFE_API_KEY  → direkt-API (ett nätverkshopp färre)
 *   2. AI_GATEWAY_API_KEY → Vercel AI Gateway
 *   3. Ingen nyckel       → rules_only
 */
function resolveRoute(): { url: string; key: string; model: string; mode: JevMode } | null {
  const direct = process.env.TYPESAFE_API_KEY;
  if (direct) return { url: TYPESAFE_DIRECT_URL, key: direct, model: "jev-latest", mode: "direct" };
  const gw = process.env.AI_GATEWAY_API_KEY;
  if (gw) return { url: GATEWAY_URL, key: gw, model: "typesafe-ai/jev", mode: "gateway" };
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function postWithRetry(
  url: string, key: string, body: unknown, timeoutMs: number,
): Promise<{ answers: Record<string, JevAnswer>; model?: string }> {
  let lastErr = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.ok) return await res.json() as { answers: Record<string, JevAnswer>; model?: string };

      // 401 betyder att nyckeln avvisades — inte att tjänsten är nere.
      // Vanligaste orsaken: en Gateway-nyckel satt som TYPESAFE_API_KEY
      // (eller tvärtom). De två rutterna tar olika nycklar.
      if (res.status === 401) {
        throw new Error(
          "JEV: HTTP 401 — nyckeln avvisades. Är det en Vercel AI Gateway-nyckel? " +
          "Flytta den i så fall till AI_GATEWAY_API_KEY.",
        );
      }
      if (res.status === 403) {
        const txt = await res.text().catch(() => "");
        if (txt.includes("customer_verification_required")) {
          throw new Error("JEV: kontot kräver verifiering hos leverantören");
        }
        throw new Error(`JEV: HTTP 403`);
      }
      if (!RETRYABLE.has(res.status)) throw new Error(`JEV: HTTP ${res.status}`);
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("JEV:")) throw err; // inte återförsöksbart
      lastErr = msg;
    }
    if (attempt < MAX_RETRIES) await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
  }
  throw new Error(`JEV: gav upp efter ${MAX_RETRIES} försök (${lastErr})`);
}

/** Circuit breaker — slutar anropa efter upprepade fel, testar igen efter en minut. */
let failureCount = 0;
let circuitOpenUntil = 0;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;

function offlineVerdict(note: string): JevVerdict {
  return { mode: "rules_only", available: false, answers: {}, latencyMs: null, model: null, note };
}

/**
 * Ställer de sju frågorna om ett marknadstillstånd.
 *
 * Kastar aldrig. Går JEV inte att nå returneras rules_only, och anroparen
 * fortsätter med sina egna regler. Ett bedömningslager som kan stoppa hela
 * systemet när det är nere är farligare än inget bedömningslager alls.
 */
export async function askJev(
  state: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<JevVerdict> {
  const route = resolveRoute();
  if (!route) {
    return offlineVerdict("Ingen TYPESAFE_API_KEY eller AI_GATEWAY_API_KEY satt");
  }
  if (Date.now() < circuitOpenUntil) {
    return offlineVerdict("Circuit öppen efter upprepade fel — testar igen strax");
  }

  const t0 = Date.now();
  try {
    const data = await postWithRetry(
      route.url, route.key,
      { state, model: route.model, questions: buildQuestions() },
      timeoutMs,
    );
    failureCount = 0;
    return {
      mode: route.mode,
      available: true,
      answers: data.answers ?? {},
      latencyMs: Date.now() - t0,
      model: data.model ?? route.model,
      note: "",
    };
  } catch (err) {
    failureCount++;
    if (failureCount >= CIRCUIT_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      failureCount = 0;
      log.warn("[jev] circuit öppnad — pausar anrop i 60s");
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[jev] ${msg} — fortsätter i rules_only`);
    return offlineVerdict(msg);
  }
}

export function getJevStatus(): { route: JevMode; circuitOpen: boolean } {
  return {
    route: resolveRoute()?.mode ?? "rules_only",
    circuitOpen: Date.now() < circuitOpenUntil,
  };
}
