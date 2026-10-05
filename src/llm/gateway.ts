import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  LLM-klient — Vercel AI Gateway eller Anthropic direkt.
//
//  Finns AI_GATEWAY_API_KEY (i .env eller i Keychain via
//  scripts/set-gateway-key.sh) går ALLA modellanrop via Vercel AI Gateway
//  (Anthropic Messages-kompatibel endpoint). Då kan varje roll köra valfri
//  modell i gatewayen — t.ex. Head Trader på Opus 5.5 och Advisor på
//  GPT-6 Astra — med en och samma nyckel och en samlad kostnadsvy i Vercel.
//
//  Saknas gateway-nyckeln används ANTHROPIC_API_KEY som tidigare, med
//  samma modeller som innan. Inget beteende ändras förrän nyckeln finns.
//
//  Modell per roll kan alltid överstyras i .env:
//    LLM_MODEL_HEAD, LLM_MODEL_ADVISOR, LLM_MODEL_SPECIALIST, LLM_MODEL_MONITOR
// ═══════════════════════════════════════════════════════════════════════════

export const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

export type LlmRole = "head" | "advisor" | "specialist" | "monitor";

// Trädet i gateway-läge: Sonnet 5.5 fattar besluten, GPT-6 Astra granskar
// helheten (dyrast per token, körs bara när JEV ber om det), Haiku kör
// de snabba specialisterna.
// Head kör Sonnet 5.5: tecknen räknas ut av koden, Head väger bara ihop
// rapporterna, och Sonnet släpps igenom av Vercel där Opus 5/5.5 spärras.
const GATEWAY_MODELS: Record<LlmRole, string> = {
  head: "anthropic/claude-sonnet-5.5",
  advisor: "openai/gpt-6-astra",
  specialist: "anthropic/claude-haiku-4.5",
  monitor: "anthropic/claude-opus-5.5",
};

// Reservmodell kräver ett uttryckligt godkänt LLM_MODEL_FALLBACK-val.
export function fallbackModels(model: string): string[] {
  const override = process.env.LLM_MODEL_FALLBACK?.trim();
  if (override === "off") return [];
  const chain = override ? override.split(",").map((m) => m.trim()).filter(Boolean) : []; // Modellbyte kräver ett uttryckligt konfigurerat och godkänt reservval.
  return chain.filter((m) => m !== model);
}
/** Första reserven (bakåtkompatibelt). */
export function fallbackModel(model: string): string | undefined {
  return fallbackModels(model)[0];
}

const ENV_OVERRIDE: Record<LlmRole, string> = {
  head: "LLM_MODEL_HEAD",
  advisor: "LLM_MODEL_ADVISOR",
  specialist: "LLM_MODEL_SPECIALIST",
  monitor: "LLM_MODEL_MONITOR",
};

// Samma Keychain-post som scripts/set-gateway-key.sh och jevClient.ts använder.
const GATEWAY_KEYCHAIN_SERVICE = "aiupscale.vercel.gateway-key";
let keychainKey: string | null | undefined;

function gatewayKeyFromKeychain(): string | null {
  if (keychainKey !== undefined) return keychainKey;
  keychainKey = null;
  if (process.platform !== "darwin") return keychainKey;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", GATEWAY_KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    keychainKey = out.length > 0 ? out : null;
  } catch {
    keychainKey = null;
  }
  return keychainKey;
}

function gatewayKey(): string | undefined {
  const key = process.env.AI_GATEWAY_API_KEY?.trim();
  if (key) return key;
  return gatewayKeyFromKeychain() ?? undefined;
}

function openRouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || undefined;
}

/** True när modellanropen går via en gateway (Vercel eller OpenRouter) med "provider/modell"-id:n. */
export function usingGateway(): boolean {
  return gatewayKey() !== undefined || openRouterKey() !== undefined;
}

export function hasLlmCredentials(): boolean {
  return usingGateway() || Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** Modell för en roll. directDefault gäller när gatewayen inte används. */
export function modelFor(role: LlmRole, directDefault: string): string {
  const override = process.env[ENV_OVERRIDE[role]]?.trim();
  if (override) return override;
  return usingGateway() ? GATEWAY_MODELS[role] : directDefault;
}

/**
 * Gatewayen vill ha "provider/modell". Anthropic-id:n som redan finns i
 * koden ("claude-haiku-4-5-20251001") översätts så att gamla anrop fungerar.
 */
export function toGatewayModel(model: string): string {
  if (model.includes("/")) return model;
  const m = model.match(/^(claude-[a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/);
  if (m) return `anthropic/${m[1]}-${m[2]}.${m[3]}`;
  const single = model.match(/^(claude-[a-z]+-\d+)(?:-\d{8})?$/);
  if (single) return `anthropic/${single[1]}`;
  return model;
}

/** "anthropic/claude-opus-5.5" → "claude-opus-5-5" för Anthropics eget API. */
export function toDirectModel(model: string): string {
  return model.replace(/^anthropic\//, "").replace(/(\d+)\.(\d+)$/, "$1-$2");
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

type Create = (body: Anthropic.MessageCreateParams, options?: Anthropic.RequestOptions) => Promise<unknown>;

interface Route {
  name: string;
  /** Tar rutten den här modellen? (Anthropic direkt tar bara Claude.) */
  accepts: (model: string) => boolean;
  toModel: (model: string) => string;
  create: Create;
}

// En rutt som svarat 401/402/403/429 (eller 400 "credit balance too low") på en modell hoppas över en stund, så
// att varje iteration i Head-loopen inte slår i samma spärr igen.
const ROUTE_COOLDOWN_MS = 10 * 60_000;
const routeBlockedUntil = new Map<string, number>();
interface RouteAttempt { route: string; model: string; status: number | null; outcome: "success" | "error"; at: number; requestId: string | null; actualModel?: string | null }
const routeAttempts: RouteAttempt[] = [];
function recordRoute(attempt: RouteAttempt): void {
  routeAttempts.push(attempt);
  if (routeAttempts.length > 50) routeAttempts.shift();
}
/** Endast metadata: nycklar, modellprompter och råa felsvar lämnar aldrig klienten. */
export function getLlmDiagnostics() {
  return { configured: { vercel: Boolean(gatewayKey()), openrouter: Boolean(openRouterKey()), anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()) },
    models: Object.fromEntries((Object.keys(ENV_OVERRIDE) as LlmRole[]).map((role) => [role, modelFor(role, "ej gatewaymodell")])),
    fallbackOverride: process.env.LLM_MODEL_FALLBACK?.trim() || "off",
    attempts: routeAttempts.map((a) => ({ ...a })), runtime: "Trading-OS specialist- och Hanna-agenter; Hermes Desktop är separat" };
}


function statusOf(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}

function bind(client: Anthropic): Create {
  return client.messages.create.bind(client.messages) as Create;
}

function buildRoutes(directKey: string): Route[] {
  const routes: Route[] = [];
  if (directKey && process.env.LLM_CLAUDE_DIRECT !== "false") {
    routes.push({
      name: "anthropic",
      accepts: (m) => m.startsWith("anthropic/"),
      toModel: toDirectModel,
      create: bind(new Anthropic({ apiKey: directKey })),
    });
  }
  const vercel = gatewayKey();
  if (vercel) {
    routes.push({
      name: "vercel",
      accepts: () => true,
      toModel: (m) => m,
      create: bind(new Anthropic({ apiKey: vercel, baseURL: GATEWAY_BASE_URL })),
    });
  }
  const openRouter = openRouterKey();
  if (openRouter) {
    routes.push({
      name: "openrouter",
      accepts: () => true,
      toModel: (m) => m,
      create: bind(new Anthropic({ apiKey: null, authToken: openRouter, baseURL: OPENROUTER_BASE_URL })),
    });
  }
  return routes;
}

/**
 * Ersätter `new Anthropic({ apiKey })`.
 *
 * Varje anrop provar rutterna i ordning tills en svarar:
 *   1. Anthropic direkt (bara Claude-modeller, kräver ANTHROPIC_API_KEY med krediter)
 *   2. Vercel AI Gateway (AI_GATEWAY_API_KEY)
 *   3. OpenRouter (OPENROUTER_API_KEY)
 * Stoppar alla rutter en Opus 5.5-förfrågan körs samma kedja med reserven
 * (Opus 4.8). Saknas både gateway- och OpenRouter-nyckel används Anthropic
 * direkt precis som förut.
 */
export function createLlmClient(anthropicApiKey?: string | null): Anthropic {
  const directKey = (anthropicApiKey || process.env.ANTHROPIC_API_KEY || "").trim();
  if (!usingGateway()) {
    if (!directKey) throw new Error("Varken AI_GATEWAY_API_KEY, OPENROUTER_API_KEY eller ANTHROPIC_API_KEY är satt");
    // Direktrutten använder samma verifiering och diagnostik som gateway-rutterna.
  }

  const routes = buildRoutes(directKey);
  const client = new Anthropic({ apiKey: "unused", baseURL: GATEWAY_BASE_URL });

  const tryRoutes = async (
    body: Anthropic.MessageCreateParams,
    model: string,
    options?: Anthropic.RequestOptions,
    ignoreCooldown = false,
  ) => {
    let lastErr: unknown;
    for (const route of routes) {
      if (!route.accepts(model)) continue;
      const key = `${route.name}:${model}`;
      if (!ignoreCooldown && (routeBlockedUntil.get(key) ?? 0) > Date.now()) continue;
      try {
        const call = route.create({ ...body, model: route.toModel(model) }, options) as Promise<unknown> & { withResponse?: () => Promise<{data: unknown; response: Response; request_id?: string}> };
        const envelope = call.withResponse ? await call.withResponse() : null;
        const response = envelope ? envelope.data : await call;
        const message = response as {type?: string; content?: unknown[]; model?: string; _request_id?: string};
        if (message.type !== "message" || !Array.isArray(message.content) || typeof message.model !== "string") throw new Error("Ogiltigt LLM-svarsschema");
        recordRoute({route: route.name, model, actualModel: message.model, status: envelope?.response.status ?? null, outcome: "success", at: Date.now(), requestId: envelope?.request_id ?? message._request_id ?? null});
        return response;
      } catch (err) {
        const status = statusOf(err);
        recordRoute({route: route.name, model, status: status ?? null, outcome: "error", at: Date.now(), requestId: null});
        // Nätverksfel provas på nästa befintliga rutt, med exakt samma modell.
        if (status === undefined) { lastErr = new Error("Nätverksfel i LLM-rutten"); continue; }
        lastErr = err;
        const noCredits = status === 400 && /credit/i.test(String((err as Error).message));
        if (noCredits || [401, 402, 403, 429].includes(status)) routeBlockedUntil.set(key, Date.now() + ROUTE_COOLDOWN_MS);
        log.warn(`[LLM] ${route.name} svarade ${status} för ${model} — provar nästa väg`);
      }
    }
    throw new Error(`Ingen LLM-väg tar modellen ${model}${lastErr ? " efter ruttfel" : ""}`);
  };

  client.messages.create = (async (body: Anthropic.MessageCreateParams, options?: Anthropic.RequestOptions) => {
    const model = toGatewayModel(body.model);
    const chain = [model, ...fallbackModels(model)];
    const tried: string[] = [];
    let firstErr: unknown;
    for (const m of chain) {
      try {
        if (m !== model) log.warn(`[LLM] Alla vägar stoppade ${tried.join(", ")} — kör reserv ${m}`);
        return await tryRoutes(body, m, options);
      } catch (err) {
        if (statusOf(err) === undefined && !/Ingen LLM-väg/.test(String((err as Error)?.message))) throw err;
        firstErr ??= err;
        tried.push(m);
      }
    }
    const reason = firstErr instanceof Error ? firstErr.message : String(firstErr);
    throw new Error(`Ingen AI-modell svarade (provade ${tried.join(", ")}). Första felet: ${reason}`);
  }) as typeof client.messages.create;
  return client;
}

/** Plockar ut JSON även om modellen (t.ex. GPT) lindar svaret i ```json-block. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  // Avklippt svar: öppnande ```json utan stängning — ta bort staketet och läs resten
  text = text.replace(/^[^{]*?```(?:json)?\s*/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
}
