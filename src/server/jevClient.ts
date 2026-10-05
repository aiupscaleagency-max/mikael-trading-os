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
// OpenRouter säljer JEV utan TypeSafe-konto ($0,042 per 1M input, output gratis).
const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";

const RETRYABLE = new Set([429, 529]);
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 350;
const DEFAULT_TIMEOUT_MS = 2500;

export type JevMode = "direct" | "gateway" | "openrouter" | "rules_only";

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
  httpStatus?: number;
  requestId?: string | null;
}

/**
 * De sju frågorna. Varje är en BEDÖMNING, aldrig en beräkning.
 * Ordningen och id:na följer specen — ändras de matchar svaren inte.
 */
function buildQuestions(): Record<string, unknown> {
  return {
    execution_depth: {type: "choice", instructions: "Recommend analysis depth for a fixed two-agent crypto analysis workflow.", criteria: {fast: null, standard: null, deep: null}},
    needs_independent_review: {type: "noul", instructions: "Does this task category benefit from independent review?"},
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

/** Keychain-posten scripts/set-gateway-key.sh skriver till. */
const GATEWAY_KEYCHAIN_SERVICE = "aiupscale.vercel.gateway-key";

interface JevRoute { url: string; key: string; model: string; mode: JevMode }

const asDirect = (key: string): JevRoute =>
  ({ url: TYPESAFE_DIRECT_URL, key, model: "jev-latest", mode: "direct" });
const asGateway = (key: string): JevRoute =>
  ({ url: GATEWAY_URL, key, model: "typesafe-ai/jev", mode: "gateway" });
const asOpenRouter = (key: string): JevRoute =>
  ({ url: OPENROUTER_URL, key, model: "typesafe/jev-1.13", mode: "openrouter" });

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

  // Delad Gateway-nyckel i Keychain. Den är utfärdad av Vercel, så
  // Gateway-rutten provas först.
  const gwKeychain = keyFromKeychain(GATEWAY_KEYCHAIN_SERVICE);
  if (gwKeychain) { add(asGateway(gwKeychain)); add(asDirect(gwKeychain)); }

  // Annars: samma Keychain-post som coachens jev-verktyg använder.
  const fromKeychain = keyFromKeychain(KEYCHAIN_SERVICE);
  if (fromKeychain) { add(asDirect(fromKeychain)); add(asGateway(fromKeychain)); }

  // Sist: OpenRouter, egen nyckel och egen leverantör. Tar över när
  // TypeSafe svarar 503 eller Vercel spärrar JEV med 429.
  const openRouter = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouter) add(asOpenRouter(openRouter));

  // LÅST ORDNING (Mike 2026-10-04, samma som kursen): JEV går via Vercel
  // först, TypeSafe direkt sedan, OpenRouter ALLTID sist som reserv så att
  // credits aldrig tar slut. Ändra inte utan att Mike bett om det.
  const rank: Record<JevMode, number> = { gateway: 0, direct: 1, openrouter: 2, rules_only: 3 };
  return routes
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank[a.r.mode] - rank[b.r.mode] || a.i - b.i)
    .map((x) => x.r);
}

/** Nyckeln avvisades av en rutt. Säger inget om de andra rutterna. */
class AuthRejected extends Error {
  constructor() { super("JEV: HTTP 401 — nyckeln avvisades av den här rutten"); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Typade svar måste täcka alla frågor innan JEV räknas som tillgänglig. */
export function validateJevAnswers(questions: Record<string, unknown>, answers: unknown): answers is Record<string, JevAnswer> {
  if (!answers || typeof answers !== "object") return false;
  return Object.entries(questions).every(([id, raw]) => {
    const question = raw as {type?: string; criteria?: unknown};
    const answer = (answers as Record<string, JevAnswer>)[id];
    if (!answer || answer.type !== question.type) return false;
    if (answer.type === "noul") return typeof answer.noul === "number" && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1;
    if (answer.type === "score") return typeof answer.score === "number" && Number.isFinite(answer.score) && answer.score >= 0;
    if (answer.type === "choice") return typeof answer.choice === "string" && Boolean(question.criteria && typeof question.criteria === "object" && !Array.isArray(question.criteria) && Object.hasOwn(question.criteria, answer.choice));
    return false;
  });
}
let lastVerdict: {route:JevMode;available:boolean;at:number;httpStatus:number|null;requestId:string|null;note:string} | null = null;

async function postWithRetry(
  url: string, key: string, body: unknown, timeoutMs: number,
): Promise<{ answers: Record<string, JevAnswer>; model?: string; httpStatus: number; requestId: string | null }> {
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

      if (res.ok) {
        const data = await res.json() as {answers?: unknown;model?: string};
        if (!validateJevAnswers((body as {questions:Record<string,unknown>}).questions,data.answers)) throw new Error("JEV: ogiltigt eller ofullständigt svarsschema");
        return {answers:data.answers,model:data.model,httpStatus:res.status,requestId:res.headers.get("x-request-id") ?? res.headers.get("request-id")};
      }

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

/** En rutt som svarat 401/402/403 hoppas över i 10 min (prövas sedan igen). */
const ROUTE_PAUSE_MS = 10 * 60_000;
const routePausedUntil = new Map<string, number>();

/** Circuit breaker — slutar anropa efter upprepade fel, testar igen efter en minut. */
let failureCount = 0;
let circuitOpenUntil = 0;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;

function offlineVerdict(note: string): JevVerdict {
  lastVerdict = {route:"rules_only",available:false,at:Date.now(),httpStatus:null,requestId:null,note};
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
  // Andra anropare (t.ex. src/llm/jev.ts) ställer egna frågor men delar rutter,
  // nyckelupplösning och circuit breaker.
  questions: Record<string, unknown> = buildQuestions(),
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
    const rid = `${route.mode}:${route.key.slice(-6)}`;
    if ((routePausedUntil.get(rid) ?? 0) > Date.now()) continue;
    try {
      const data = await postWithRetry(
        route.url, route.key,
        { state: {task_category: "crypto_analysis", summary: "Recommend depth and review for an existing fixed technical-agent and head-trader workflow. Market analysis and risk calculations happen outside JEV.", constraints: ["advisory only", "exactly two agent roles", "no market data or credentials"]}, model: route.model, questions },
        timeoutMs,
      );
      failureCount = 0;
      lastVerdict = {route:route.mode,available:true,at:Date.now(),httpStatus:data.httpStatus,requestId:data.requestId,note:"Validerat svarsschema"};
      return {
        mode: route.mode,
        available: true,
        httpStatus: data.httpStatus, requestId: data.requestId,
        answers: Object.fromEntries(Object.keys(questions).map((id) => [id, data.answers[id]!])),
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
        routePausedUntil.set(rid, Date.now() + ROUTE_PAUSE_MS);
        continue;
      }
      // Övriga fel (429, 5xx, timeout): prova nästa rutt om det finns en,
      // annars rapporteras felet nedan.
      lastMsg = err instanceof Error ? err.message : String(err);
      // 402 (krediter slut) och 403 ändras inte på sekunder: pausa rutten.
      if (/HTTP (402|403)|verifiering/.test(lastMsg)) routePausedUntil.set(rid, Date.now() + ROUTE_PAUSE_MS);
      log.warn(`[jev] ${route.mode}: ${lastMsg} — provar nästa rutt`);
      continue;
    }
  }

  if (!lastMsg) lastMsg = "alla JEV-vägar är pausade efter 401/402/403";
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

export function getJevStatus() {
  return {
    route: lastVerdict?.route ?? "rules_only",
    configuredRoute: resolveRoutes()[0]?.mode ?? "rules_only",
    circuitOpen: Date.now() < circuitOpenUntil,
    lastVerdict,
  };
}
