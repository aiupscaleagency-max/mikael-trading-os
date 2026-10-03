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

// Reserv när Vercel stoppar en modell med 429 ("No access to this model at
// this time"). Vercel har låga gränser på de nyaste modellerna för vissa
// konton: första anropet går igenom, nästa stoppas. Då kör turen vidare på
// reservmodellen i stället för att Head kraschar. Överstyr med
// LLM_MODEL_FALLBACK, eller stäng av med LLM_MODEL_FALLBACK=off.
const GATEWAY_FALLBACKS: Record<string, string> = {
  "anthropic/claude-opus-5.5": "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-5.5": "anthropic/claude-opus-4.8",
};
export function fallbackModel(model: string): string | undefined {
  const override = process.env.LLM_MODEL_FALLBACK?.trim();
  if (override === "off") return undefined;
  const fallback = GATEWAY_FALLBACKS[model];
  if (!fallback) return undefined;
  return override || fallback;
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
    return new Anthropic({ apiKey: directKey });
  }

  const routes = buildRoutes(directKey);
  const client = new Anthropic({ apiKey: "unused", baseURL: GATEWAY_BASE_URL });

  const tryRoutes = async (body: Anthropic.MessageCreateParams, model: string, options?: Anthropic.RequestOptions) => {
    let lastErr: unknown;
    for (const route of routes) {
      if (!route.accepts(model)) continue;
      const key = `${route.name}:${model}`;
      if ((routeBlockedUntil.get(key) ?? 0) > Date.now()) continue;
      try {
        return await route.create({ ...body, model: route.toModel(model) }, options);
      } catch (err) {
        const status = statusOf(err);
        if (status === undefined) throw err; // nätverksfel i koden, inte ett svar
        lastErr = err;
        const noCredits = status === 400 && /credit/i.test(String((err as Error).message));
        if (noCredits || [401, 402, 403, 429].includes(status)) routeBlockedUntil.set(key, Date.now() + ROUTE_COOLDOWN_MS);
        log.warn(`[LLM] ${route.name} svarade ${status} för ${model} — provar nästa väg`);
      }
    }
    throw lastErr ?? new Error(`Ingen LLM-väg tar modellen ${model}`);
  };

  client.messages.create = (async (body: Anthropic.MessageCreateParams, options?: Anthropic.RequestOptions) => {
    const model = toGatewayModel(body.model);
    try {
      return await tryRoutes(body, model, options);
    } catch (err) {
      const fallback = fallbackModel(model);
      if (!fallback) throw err;
      log.warn(`[LLM] Alla vägar stoppade ${model} — kör reserv ${fallback}`);
      return tryRoutes(body, fallback, options);
    }
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
