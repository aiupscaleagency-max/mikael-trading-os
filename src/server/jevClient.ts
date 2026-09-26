import { execFileSync } from "node:child_process";
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
/**
 * Läser nyckeln ur macOS Keychain.
 *
 * Coachens verktyg (tools/jev/set-typesafe-key.sh) lagrar nyckeln där, inte i
 * en .env. Läser vi samma ställe finns nyckeln på ETT ställe istället för två,
 * och den kan inte hamna i en fil som råkar committas.
 *
 * Returnerar null på allt annat än macOS, och när posten inte finns.
 */
function keyFromKeychain(service: string): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const key = out.trim();
    return key.length > 0 ? key : null;
  } catch {
    return null; // posten finns inte
  }
}

/** Keychain-posten coachens skript skriver till. */
const KEYCHAIN_SERVICE = "aiupscale.typesafe.api-key";

interface JevRoute { url: string; key: string; model: string; mode: JevMode }

const asDirect = (key: string): JevRoute =>
  ({ url: TYPESAFE_DIRECT_URL, key, model: "jev-latest", mode: "direct" });
const asGateway = (key: string): JevRoute =>
  ({ url: GATEWAY_URL, key, model: "typesafe-ai/jev", mode: "gateway" });

/**
 * Alla rutter värda att prova, i tur och ordning.
 *
 * En nyckel bär inte med sig vilken tjänst som utfärdade den: en TypeSafe-nyckel
 * och en Vercel AI Gateway-nyckel ser likadana ut. Gissar vi fel svarar servern
 * 401, vilket är omöjligt att skilja från en ogiltig nyckel. Därför provas båda
 * rutterna med samma nyckel innan vi påstår att nyckeln är fel.
 */
function resolveRoutes(): JevRoute[] {
  const routes: JevRoute[] = [];
  const seen = new Set<string>();
  const add = (route: JevRoute): void => {
    const id = `${route.mode}:${route.key}`;
    if (!seen.has(id)) { seen.add(id); routes.push(route); }
  };

  // .env vinner om den är satt — den är explicit. Namnet på variabeln avgör
  // bara vilken rutt som provas först, inte vilken som är tillåten.
  const direct = process.env.TYPESAFE_API_KEY;
  if (direct) { add(asDirect(direct)); add(asGateway(direct)); }

  const gw = process.env.AI_GATEWAY_API_KEY;
  if (gw) { add(asGateway(gw)); add(asDirect(gw)); }

  // Annars: samma Keychain-post som coachens jev-verktyg använder.
  const fromKeychain = keyFromKeychain(KEYCHAIN_SERVICE);
  if (fromKeychain) { add(asDirect(fromKeychain)); add(asGateway(fromKeychain)); }

  return routes;
}

/** Nyckeln avvisades av en rutt. Säger inget om de andra rutterna. */
class AuthRejected extends Error {
  constructor() { super("JEV: HTTP 401 — nyckeln avvisades av den här rutten"); }
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

      // 401 betyder att nyckeln avvisades av *den här* rutten — inte att
      // tjänsten är nere och inte nödvändigtvis att nyckeln är ogiltig.
      // Anroparen provar nästa rutt innan den drar någon slutsats.
      if (res.status === 401) throw new AuthRejected();
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
  const routes = resolveRoutes();
  if (routes.length === 0) {
    return offlineVerdict(
      "Ingen nyckel hittad — varken i .env eller i Keychain "
      + `(${KEYCHAIN_SERVICE})`,
    );
  }
  if (Date.now() < circuitOpenUntil) {
    return offlineVerdict("Circuit öppen efter upprepade fel — testar igen strax");
  }

  const t0 = Date.now();
  const rejected: JevMode[] = [];
  let lastMsg = "";

  for (const route of routes) {
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
        note: rejected.length > 0 ? `avvisad på ${rejected.join(", ")} först` : "",
      };
    } catch (err) {
      // Bara 401 betyder "fel rutt, prova nästa". Allt annat är ett riktigt
      // fel och ska inte maskeras av ett försök mot en annan tjänst.
      if (err instanceof AuthRejected) {
        rejected.push(route.mode);
        lastMsg = err.message;
        continue;
      }
      lastMsg = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  if (rejected.length === routes.length) {
    lastMsg = `JEV: nyckeln avvisades (401) av både direkt-API och Gateway — nyckeln är inte giltig för någon av tjänsterna`;
  }

  failureCount++;
  if (failureCount >= CIRCUIT_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    failureCount = 0;
    log.warn("[jev] circuit öppnad — pausar anrop i 60s");
  }
  log.warn(`[jev] ${lastMsg} — fortsätter i rules_only`);
  return offlineVerdict(lastMsg);
}

export function getJevStatus(): { route: JevMode; circuitOpen: boolean } {
  return {
    route: resolveRoutes()[0]?.mode ?? "rules_only",
    circuitOpen: Date.now() < circuitOpenUntil,
  };
}
