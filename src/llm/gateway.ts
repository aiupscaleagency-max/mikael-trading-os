import Anthropic from "@anthropic-ai/sdk";

// ═══════════════════════════════════════════════════════════════════════════
//  LLM-klient — Vercel AI Gateway eller Anthropic direkt.
//
//  Är AI_GATEWAY_API_KEY satt går ALLA modellanrop via Vercel AI Gateway
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

const ENV_OVERRIDE: Record<LlmRole, string> = {
  head: "LLM_MODEL_HEAD",
  advisor: "LLM_MODEL_ADVISOR",
  specialist: "LLM_MODEL_SPECIALIST",
  monitor: "LLM_MODEL_MONITOR",
};

function gatewayKey(): string | undefined {
  const key = process.env.AI_GATEWAY_API_KEY?.trim();
  return key ? key : undefined;
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

/**
 * Ersätter `new Anthropic({ apiKey })`. I gateway-läge pekar klienten på
 * Vercel och varje modell-id översätts automatiskt.
 */
export function createLlmClient(anthropicApiKey?: string | null): Anthropic {
  const key = gatewayKey();
  if (!key) {
    const direct = anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!direct) throw new Error("Varken AI_GATEWAY_API_KEY eller ANTHROPIC_API_KEY är satt");
    return new Anthropic({ apiKey: direct });
  }

  const client = new Anthropic({ apiKey: key, baseURL: GATEWAY_BASE_URL });
  const create = client.messages.create.bind(client.messages) as (
    body: Anthropic.MessageCreateParams,
    options?: Anthropic.RequestOptions,
  ) => unknown;
  client.messages.create = ((body: Anthropic.MessageCreateParams, options?: Anthropic.RequestOptions) =>
    create({ ...body, model: toGatewayModel(body.model) }, options)) as typeof client.messages.create;
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
