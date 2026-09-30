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

// Trädet i gateway-läge: Opus 5.5 fattar besluten, GPT-6 Astra granskar
// helheten (billigare än Fable-credits), Haiku kör de snabba specialisterna.
const GATEWAY_MODELS: Record<LlmRole, string> = {
  head: "anthropic/claude-opus-5.5",
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
};
// Efter en 429 går modellen direkt till reserven en stund, så att varje
// iteration i Head-loopen inte först slår i spärren igen.
const FALLBACK_COOLDOWN_MS = 10 * 60_000;
const blockedUntil = new Map<string, number>();

export function fallbackModel(model: string): string | undefined {
  const override = process.env.LLM_MODEL_FALLBACK?.trim();
  if (override === "off") return undefined;
  const fallback = GATEWAY_FALLBACKS[model];
  if (!fallback) return undefined;
  return override || fallback;
}

function isRateLimited(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 429;
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

export function usingGateway(): boolean {
  return gatewayKey() !== undefined;
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

function isRetryableElsewhere(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status === 429 || status === 529 || (typeof status === "number" && status >= 500);
}

/**
 * Ersätter `new Anthropic({ apiKey })`.
 *
 * Med både gateway-nyckel och ANTHROPIC_API_KEY går Claude-modellerna direkt
 * till Anthropic (inga Vercel-gränser på Opus 5.5), och bara övriga modeller
 * som GPT-6 Astra går via Vercel. Svarar Anthropic 429/5xx provas samma modell
 * via Vercel, och stoppar Vercel också tar reserven vid. Sätt
 * LLM_CLAUDE_DIRECT=false för att skicka allt via Vercel.
 */
export function createLlmClient(anthropicApiKey?: string | null): Anthropic {
  const key = gatewayKey();
  const directKey = (anthropicApiKey || process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) {
    if (!directKey) throw new Error("Varken AI_GATEWAY_API_KEY eller ANTHROPIC_API_KEY är satt");
    return new Anthropic({ apiKey: directKey });
  }

  const client = new Anthropic({ apiKey: key, baseURL: GATEWAY_BASE_URL });
  const create = client.messages.create.bind(client.messages) as (
    body: Anthropic.MessageCreateParams,
    options?: Anthropic.RequestOptions,
  ) => unknown;
  const directClient =
    directKey && process.env.LLM_CLAUDE_DIRECT !== "false" ? new Anthropic({ apiKey: directKey }) : null;
  const createDirect = directClient
    ? (directClient.messages.create.bind(directClient.messages) as typeof create)
    : null;

  const viaGateway = async (body: Anthropic.MessageCreateParams, model: string, options?: Anthropic.RequestOptions) => {
    const fallback = fallbackModel(model);
    if (fallback && (blockedUntil.get(model) ?? 0) > Date.now()) {
      return create({ ...body, model: fallback }, options);
    }
    try {
      return await create({ ...body, model }, options);
    } catch (err) {
      if (!fallback || !isRateLimited(err)) throw err;
      blockedUntil.set(model, Date.now() + FALLBACK_COOLDOWN_MS);
      log.warn(`[LLM] ${model} stoppades av Vercel (429) — kör reserv ${fallback} i ${FALLBACK_COOLDOWN_MS / 60_000} min`);
      return create({ ...body, model: fallback }, options);
    }
  };

  client.messages.create = (async (body: Anthropic.MessageCreateParams, options?: Anthropic.RequestOptions) => {
    const model = toGatewayModel(body.model);
    if (createDirect && model.startsWith("anthropic/")) {
      try {
        return await createDirect({ ...body, model: toDirectModel(model) }, options);
      } catch (err) {
        if (!isRetryableElsewhere(err)) throw err;
        log.warn(`[LLM] Anthropic direkt svarade ${(err as { status?: number }).status} för ${model} — provar via Vercel`);
      }
    }
    return viaGateway(body, model, options);
  }) as typeof client.messages.create;
  return client;
}

/** Plockar ut JSON även om modellen (t.ex. GPT) lindar svaret i ```json-block. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
}
