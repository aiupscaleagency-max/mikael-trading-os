import Anthropic from "@anthropic-ai/sdk";
import { trackClaudeCall } from "../cost/tracker.js";
import { log } from "../logger.js";
import type { OrderRequest, Position } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════════
//  SECOND OPINION — 2-modell-ensemble.
//
//  Problemet: en enda modell (Head Trader) kan hallucinera en setup, fastna i
//  en narrativ-loop eller överlagra på en enskild rapport. Den har tools och
//  kan lägga order direkt — ingen annan modell tittar på förslaget innan
//  risk managern.
//
//  Lösningen: när MODEL_A (Head Trader) FÖRESLÅR en trade — efter att den
//  valt symbol/side/storlek men INNAN ordern går till risk managern — skickas
//  förslaget + SAMMA marknadskontext till MODEL_B, en oberoende andra modell.
//  MODEL_B ser aldrig att MODEL_A är "chefen"; den ombeds granska förslaget
//  kallt och rösta agree/disagree.
//
//  Grind (evaluateEnsemble): bara om BÅDA säger "agree" går ordern vidare till
//  risk managern. Risk managerns veto ligger kvar oförändrat EFTER grinden —
//  ensemblen kan bara göra det SVÅRARE att handla, aldrig lättare.
//
//  Fail-closed: om MODEL_B kraschar/timeout:ar räknas det som "disagree"
//  (om inte ENSEMBLE_FAIL_OPEN=true). Ingen andra-åsikt ⇒ ingen trade.
//
//  Rör INTE: paper/testnet-defaults, position-sizing-låsen eller nycklar.
//  Denna modul läser bara — den skriver aldrig config eller broker-state.
// ═══════════════════════════════════════════════════════════════════════════

export type Verdict = "agree" | "disagree";

/**
 * Modell-anropet som grinden använder. Sätts bara av demo-/test-körningar
 * (src/scripts/ensembleDemo.ts) för att köra hela kedjan utan API-nycklar.
 * null i produktion = riktiga anrop.
 */
export type SecondOpinionTransport = (
  userMessage: string,
  target: { model: string; provider: ModelProvider },
) => Promise<string>;

let transportOverride: SecondOpinionTransport | null = null;

/**
 * ENDAST för demo/test. Sätt null för att återgå till riktiga modell-anrop.
 * En stub kan kasta ProviderUnavailableError för att öva fallback-vägen.
 */
export function setSecondOpinionTransport(fn: SecondOpinionTransport | null): void {
  transportOverride = fn;
}

export type ModelProvider = "anthropic" | "openrouter" | "openai";

/** Trade-förslaget från MODEL_A, som det ser ut precis innan risk managern. */
export interface TradeProposal {
  symbol: string;
  side: OrderRequest["side"];
  type: OrderRequest["type"];
  /** USD som ska spenderas (BUY MARKET) */
  quoteOrderQty?: number;
  /** Kvantitet i basvaluta (SELL / LIMIT) */
  quantity?: number;
  limitPrice?: number;
  /** MODEL_A:s egen motivering — det som gör detta till dess "agree"-röst. */
  reasoning: string;
}

/** Marknadskontexten MODEL_B får — samma underlag som MODEL_A hade. */
export interface MarketContext {
  lastPrice: number;
  accountValueUsdt: number;
  freeUsdt: number;
  openPositions: Array<Pick<
    Position,
    "symbol" | "quantity" | "avgEntryPrice" | "currentPrice" | "unrealizedPnlUsdt"
  >>;
  dailyRealizedPnlUsdt: number;
  killSwitchActive: boolean;
  mode: string;
  executionMode: string;
  riskFrame: {
    minPositionUsd: number;
    defaultPositionUsd: number;
    maxPositionUsd: number;
    maxTotalExposureUsd: number;
    maxDailyLossUsd: number;
    maxOpenPositions: number;
  };
  /** Specialist-briefingen MODEL_A fattade sitt beslut på (om tillgänglig). */
  briefing?: string;
}

export interface SecondOpinion {
  verdict: Verdict;
  /** 0–1. Hur säker MODEL_B är på sitt eget utlåtande. */
  confidence: number;
  reasoning: string;
  model: string;
  provider: ModelProvider;
  latencyMs: number;
  /** true = verdict kommer från fallback (fel/timeout/parse-miss), inte modellen. */
  degraded: boolean;
  /**
   * Satt när den konfigurerade MODEL_B inte kunde användas och en Claude-modell
   * röstade i dess ställe. Innehåller den modell/provider som föll bort och
   * varför — rösten nedan är alltså fallback-modellens, inte MODEL_B:s.
   */
  fallbackFrom?: { model: string; provider: ModelProvider; reason: string };
}

export interface EnsembleVerdict {
  /** true = ordern får gå vidare till risk managern. */
  approved: boolean;
  requireAgreement: boolean;
  /** Skippades grinden (t.ex. exit-order)? */
  skipped: boolean;
  modelA: { model: string; verdict: Verdict; reasoning: string };
  modelB: SecondOpinion;
  summary: string;
}

export interface EnsembleConfig {
  modelA: string;
  modelB: string;
  modelBProvider: ModelProvider;
  requireAgreement: boolean;
  failOpen: boolean;
  gateExits: boolean;
  timeoutMs: number;
  /**
   * Claude-modell att falla tillbaka på om MODEL_B-leverantören inte går att
   * använda (saknad nyckel, 401/403, slut kvot, okänd modell). Vi kör ALDRIG
   * blint vidare — antingen röstar fallback-modellen, eller så blir det
   * fail-closed "disagree".
   */
  fallbackModel: string;
  openai: {
    /** EGEN nyckel (OPENAI_API_KEY). Aldrig ANTHROPIC_API_KEY. */
    apiKey: string;
    baseUrl: string;
    /** Valfri. Utelämnas som default — skickas bara om satt. */
    reasoningEffort?: string;
  };
}

const SECOND_OPINION_SYSTEM_PROMPT = `Du är en oberoende RISK-GRANSKARE i ett AI-trading-team. En annan modell har föreslagit en trade. Ditt jobb är INTE att vara artig eller att bekräfta — ditt jobb är att avgöra om förslaget håller.

Du får exakt samma marknadskontext som den föreslående modellen hade, plus dess motivering. Du vet INTE vem som föreslog traden och du har ingen lojalitet till den.

Granska:
1. STÖDER DATAT TESEN? Finns setupen faktiskt i siffrorna, eller är motiveringen en efterhandskonstruktion?
2. RIKTNING: pekar indikatorer/regim/sentiment åt samma håll som föreslagen side (BUY/SELL)?
3. TIMING: är detta entry eller jagar vi ett redan utsträckt drag?
4. PORTFÖLJ: ökar traden en redan korrelerad exponering? Tål dagens PnL detta?
5. STORLEK: är storleken rimlig givet conviction och riskramen?
6. MOTBILDEN: vad är det starkaste argumentet MOT denna trade? Om det argumentet är starkare än förslagets — disagree.

Beslutsregel:
- "agree" = du skulle själv tagit denna trade nu, med denna storlek.
- "disagree" = du tvekar, saknar underlag, ser en tydlig motbild, ELLER om setupen bara är "okej". Tveksam ⇒ disagree. Att avstå en trade kostar noll; en dålig trade kostar kapital.

Svara BARA med JSON, ingen annan text, exakt detta format:
{
  "verdict": "agree" | "disagree",
  "confidence": 0.0-1.0,
  "reasoning": "2-4 meningar på svenska. Nämn den konkreta faktorn som avgjorde."
}`;

function formatProposal(p: TradeProposal): string {
  const size =
    p.quoteOrderQty !== undefined
      ? `${p.quoteOrderQty} USD`
      : p.quantity !== undefined
        ? `${p.quantity} (basvaluta)`
        : "ospecificerad";
  return [
    `Symbol: ${p.symbol}`,
    `Side: ${p.side} (${p.side === "BUY" ? "öppna/öka LONG" : "stäng/minska — SHORT om marginalkonto"})`,
    `Ordertyp: ${p.type}${p.limitPrice !== undefined ? ` @ ${p.limitPrice}` : ""}`,
    `Storlek: ${size}`,
    `Förslagsställarens motivering: ${p.reasoning}`,
  ].join("\n");
}

function formatContext(ctx: MarketContext): string {
  const positions =
    ctx.openPositions.length === 0
      ? "  (inga öppna positioner)"
      : ctx.openPositions
          .map(
            (p) =>
              `  ${p.symbol}: qty=${p.quantity} entry=${p.avgEntryPrice} nu=${p.currentPrice} pnl=${p.unrealizedPnlUsdt.toFixed(2)} USDT`,
          )
          .join("\n");

  const exposure = ctx.openPositions.reduce(
    (sum, p) => sum + p.quantity * p.currentPrice,
    0,
  );

  let out = [
    `Senaste pris: ${ctx.lastPrice}`,
    `Kontovärde: ${ctx.accountValueUsdt.toFixed(2)} USDT | Fritt USDT: ${ctx.freeUsdt.toFixed(2)}`,
    `Dagens realiserade PnL: ${ctx.dailyRealizedPnlUsdt.toFixed(2)} USDT (dagsgräns -${ctx.riskFrame.maxDailyLossUsd})`,
    `Kill-switch: ${ctx.killSwitchActive ? "AKTIV" : "OK"} | Mode: ${ctx.mode} | Execution: ${ctx.executionMode}`,
    `Öppna positioner (${ctx.openPositions.length}/${ctx.riskFrame.maxOpenPositions}), exponering ${exposure.toFixed(2)}/${ctx.riskFrame.maxTotalExposureUsd} USD:`,
    positions,
    `Riskram per position: MIN ${ctx.riskFrame.minPositionUsd} / DEFAULT ${ctx.riskFrame.defaultPositionUsd} / MAX ${ctx.riskFrame.maxPositionUsd} USD`,
  ].join("\n");

  if (ctx.briefing) {
    out += `\n\n──── SPECIALIST-BRIEFING (samma underlag som förslagsställaren hade) ────\n${ctx.briefing}`;
  }
  return out;
}

function parseOpinion(text: string): { verdict: Verdict; confidence: number; reasoning: string } | null {
  // Modeller lägger ibland JSON i ```-block eller med text runt. Plocka ut objektet.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const raw = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
    const verdict = String(raw.verdict ?? "").toLowerCase();
    if (verdict !== "agree" && verdict !== "disagree") return null;
    const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
    return {
      verdict,
      // Klipp till [0,1] — en modell som svarar 85 istället för 0.85 ska inte
      // smitta loggen med skräp.
      confidence: Math.min(1, Math.max(0, confidence > 1 ? confidence / 100 : confidence)),
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "(ingen motivering angiven)",
    };
  } catch {
    return null;
  }
}

async function askAnthropic(params: {
  apiKey: string;
  model: string;
  userMessage: string;
  timeoutMs: number;
}): Promise<string> {
  const client = new Anthropic({ apiKey: params.apiKey, timeout: params.timeoutMs });
  const response = await client.messages.create({
    model: params.model,
    max_tokens: 1024,
    system: [
      { type: "text", text: SECOND_OPINION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: params.userMessage }],
  });
  trackClaudeCall("second_opinion", params.model, response.usage).catch(() => {});
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Fel som betyder "OpenAI-vägen är inte användbar just nu av konfig-/konto-skäl"
 * — saknad nyckel, 401/403, eller slut på kvot. Dessa (och BARA dessa) triggar
 * fallback till Claude-B. Timeouts, 5xx och vanlig rate limit gör det INTE —
 * de är transienta och ska fail-closed:a som vanligt.
 */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

interface OpenAiErrorBody {
  error?: { message?: string; type?: string; code?: string };
}

/**
 * OpenAI-vägen (MODEL_B_PROVIDER=openai). Används för GPT-6 Astra m.fl.
 *
 * Nyckel: OPENAI_API_KEY — en EGEN variabel. ANTHROPIC_API_KEY skickas
 * ALDRIG hit; funktionen tar bara emot openaiApiKey och kan inte nå den andra.
 *
 * Endpoint: Chat Completions räcker (vi gör text in / JSON ut, inga tools).
 * Parametrar anpassade efter Astra: `max_completion_tokens` (inte `max_tokens`)
 * och INGEN `temperature`/`top_p` — de ger 400 på reasoning-modellerna.
 */
async function askOpenAI(params: {
  openaiApiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort?: string;
  userMessage: string;
  timeoutMs: number;
}): Promise<string> {
  if (!params.openaiApiKey) {
    throw new ProviderUnavailableError(
      "OPENAI_API_KEY saknas. Sätt den i .env (egen nyckel — återanvänd ALDRIG ANTHROPIC_API_KEY).",
    );
  }

  const body: Record<string, unknown> = {
    model: params.model,
    messages: [
      { role: "system", content: SECOND_OPINION_SYSTEM_PROMPT },
      { role: "user", content: params.userMessage },
    ],
    // Astra ignorerar max_tokens; max_completion_tokens är rätt parameter.
    max_completion_tokens: 1024,
    // Structured output — vi vill ha ren JSON tillbaka, inte prosa.
    response_format: { type: "json_object" },
  };
  // temperature/top_p skickas medvetet INTE — 400 på reasoning-modeller.
  if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;

  let res: Response;
  try {
    res = await fetch(`${params.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch (err) {
    // Nätverksfel/timeout = transient → fail-closed, inte fallback.
    throw new Error(
      `OpenAI-anrop misslyckades (nätverk/timeout): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let parsed: OpenAiErrorBody = {};
    try {
      parsed = JSON.parse(raw) as OpenAiErrorBody;
    } catch {
      /* icke-JSON felsvar — raw duger */
    }
    const code = parsed.error?.code ?? parsed.error?.type ?? "";
    const message = parsed.error?.message ?? raw.slice(0, 300) ?? "(inget felmeddelande)";
    const detail = `HTTP ${res.status}${code ? ` (${code})` : ""}: ${message}`;

    // Konfig-/kontofel → fallback till Claude-B.
    if (res.status === 401 || res.status === 403 || code === "invalid_api_key") {
      throw new ProviderUnavailableError(`OpenAI avvisade nyckeln — ${detail}`);
    }
    if (code === "insufficient_quota" || /insufficient[_ ]quota/i.test(message)) {
      throw new ProviderUnavailableError(`OpenAI-kontot är utan kvot — ${detail}`);
    }
    if (res.status === 404 || code === "model_not_found") {
      throw new ProviderUnavailableError(
        `OpenAI känner inte igen MODEL_B="${params.model}" — ${detail}. Kontrollera modellsträngen.`,
      );
    }
    // Rate limit (429 utan quota-kod), 5xx m.m. = transient → fail-closed.
    throw new Error(`OpenAI-anrop misslyckades — ${detail}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  // Kostnadsspårning: samma logg som Claude-anropen (agent="second_opinion").
  // OBS: cost/tracker.ts saknar PRICING-rad för GPT-modeller, så kostnaden
  // beräknas med den konservativa default-taxan tills en riktig rad läggs in.
  if (json.usage) {
    trackClaudeCall("second_opinion", params.model, {
      input_tokens: json.usage.prompt_tokens ?? 0,
      output_tokens: json.usage.completion_tokens ?? 0,
    }).catch(() => {});
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI svarade utan innehåll i choices[0].message.content.");
  return content;
}

// TODO(model-b-provider): OpenRouter är kvar som framtida väg.
// Kontraktet är neutralt — en funktion som tar (system, user) och returnerar
// text. Implementera askOpenRouter() analogt med askOpenAI ovan (samma
// Chat-Completions-form, base URL https://openrouter.ai/api/v1), läs nyckeln
// från en EGEN env-variabel (OPENROUTER_API_KEY) och registrera den i
// askModelB. ANTHROPIC_API_KEY ska ALDRIG skickas till en annan leverantör.
// Resten av kedjan (grind, loggning, risk manager) är oförändrad.

async function askModelB(params: {
  model: string;
  provider: ModelProvider;
  userMessage: string;
  timeoutMs: number;
  /** Anthropic-nyckel — används BARA av anthropic-vägen. */
  anthropicApiKey: string;
  /** OpenAI-nyckel — används BARA av openai-vägen. */
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiReasoningEffort?: string;
}): Promise<string> {
  switch (params.provider) {
    case "anthropic":
      return askAnthropic({
        apiKey: params.anthropicApiKey,
        model: params.model,
        userMessage: params.userMessage,
        timeoutMs: params.timeoutMs,
      });
    case "openai":
      return askOpenAI({
        openaiApiKey: params.openaiApiKey,
        baseUrl: params.openaiBaseUrl,
        model: params.model,
        reasoningEffort: params.openaiReasoningEffort,
        userMessage: params.userMessage,
        timeoutMs: params.timeoutMs,
      });
    case "openrouter":
      throw new ProviderUnavailableError(
        `MODEL_B_PROVIDER=openrouter är inte implementerad ännu (se TODO(model-b-provider) i secondOpinion.ts).`,
      );
  }
}

/**
 * Fråga MODEL_B om en andra åsikt på ett trade-förslag.
 *
 * Kastar aldrig — vid fel returneras ett degraderat "disagree" så att
 * anroparen kan fail-closed:a utan try/catch.
 */
export async function getSecondOpinion(params: {
  apiKey: string;
  proposal: TradeProposal;
  context: MarketContext;
  ensemble: EnsembleConfig;
  /**
   * Byt ut modell-anropet mot en egen funktion. Används av demo-/test-körningar
   * för att köra hela grinden utan API-nycklar. Produktion lämnar den tom.
   */
  transport?: SecondOpinionTransport;
}): Promise<SecondOpinion> {
  const { apiKey, proposal, context, ensemble } = params;
  const started = Date.now();

  const userMessage = [
    "──── FÖRESLAGEN TRADE (granska denna) ────",
    formatProposal(proposal),
    "",
    "──── MARKNADSKONTEXT ────",
    formatContext(context),
    "",
    "Rösta agree eller disagree på förslaget ovan. Svara bara med JSON.",
  ].join("\n");

  const transport = params.transport ?? transportOverride;

  // Ett försök med en given modell/provider. Returnerar rösten, eller kastar.
  const attempt = async (
    model: string,
    provider: ModelProvider,
    fallbackFrom?: SecondOpinion["fallbackFrom"],
  ): Promise<SecondOpinion> => {
    const text = transport
      ? await transport(userMessage, { model, provider })
      : await askModelB({
          model,
          provider,
          userMessage,
          timeoutMs: ensemble.timeoutMs,
          // Varje väg får BARA sin egen nyckel.
          anthropicApiKey: apiKey,
          openaiApiKey: ensemble.openai.apiKey,
          openaiBaseUrl: ensemble.openai.baseUrl,
          openaiReasoningEffort: ensemble.openai.reasoningEffort,
        });

    const parsed = parseOpinion(text);
    if (!parsed) {
      log.warn(`[Ensemble] MODEL_B (${model}) gav oparsbart svar — räknas som disagree.`);
      return {
        verdict: "disagree",
        confidence: 0,
        reasoning: `Kunde inte tolka svaret från MODEL_B (${model}). Rå-svar: ${text.slice(0, 200)}`,
        model,
        provider,
        latencyMs: Date.now() - started,
        degraded: true,
        fallbackFrom,
      };
    }

    return {
      ...parsed,
      model,
      provider,
      latencyMs: Date.now() - started,
      degraded: false,
      fallbackFrom,
    };
  };

  try {
    return await attempt(ensemble.modelB, ensemble.modelBProvider);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Transient fel (timeout, 5xx, rate limit) → fail-closed direkt.
    // Vi kör aldrig blint vidare, och vi byter inte modell i onödan.
    if (!(err instanceof ProviderUnavailableError)) {
      log.error(`[Ensemble] MODEL_B (${ensemble.modelB}) misslyckades: ${msg}`);
      return {
        verdict: "disagree",
        confidence: 0,
        reasoning: `MODEL_B ej tillgänglig: ${msg}`,
        model: ensemble.modelB,
        provider: ensemble.modelBProvider,
        latencyMs: Date.now() - started,
        degraded: true,
      };
    }

    // Konfig-/kontofel hos MODEL_B-leverantören → tydligt fel + fallback till
    // Claude-B. Vi vill ALDRIG tyst köra vidare utan andra-åsikt.
    log.error(
      `╔══ MODEL_B (${ensemble.modelB} via ${ensemble.modelBProvider}) KAN INTE ANVÄNDAS ══╗\n` +
      `  ${msg}\n` +
      `  → Faller tillbaka till Claude-B (${ensemble.fallbackModel}) för denna granskning.\n` +
      `  Åtgärda OPENAI_API_KEY/kvot/MODEL_B i .env för att få tillbaka ${ensemble.modelB}.`,
    );

    const fallbackFrom = {
      model: ensemble.modelB,
      provider: ensemble.modelBProvider,
      reason: msg,
    };

    if (!apiKey) {
      log.error("[Ensemble] Ingen ANTHROPIC_API_KEY för fallback heller → fail-closed disagree.");
      return {
        verdict: "disagree",
        confidence: 0,
        reasoning: `MODEL_B ej tillgänglig (${msg}) och ingen fallback-modell kunde köras. Ingen andra-åsikt ⇒ ingen trade.`,
        model: ensemble.modelB,
        provider: ensemble.modelBProvider,
        latencyMs: Date.now() - started,
        degraded: true,
        fallbackFrom,
      };
    }

    try {
      const opinion = await attempt(ensemble.fallbackModel, "anthropic", fallbackFrom);
      log.warn(
        `[Ensemble] Fallback-röst från ${ensemble.fallbackModel}: ${opinion.verdict} ` +
        `(confidence ${opinion.confidence.toFixed(2)})`,
      );
      return opinion;
    } catch (fallbackErr) {
      const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      log.error(`[Ensemble] Fallback-modellen (${ensemble.fallbackModel}) misslyckades också: ${fbMsg}`);
      return {
        verdict: "disagree",
        confidence: 0,
        reasoning: `MODEL_B ej tillgänglig (${msg}). Fallback (${ensemble.fallbackModel}) misslyckades också: ${fbMsg}. Ingen andra-åsikt ⇒ ingen trade.`,
        model: ensemble.fallbackModel,
        provider: "anthropic",
        latencyMs: Date.now() - started,
        degraded: true,
        fallbackFrom,
      };
    }
  }
}

/**
 * Agreement-grinden. Kör MODEL_B och avgör om ordern får gå vidare till
 * risk managern.
 *
 * MODEL_A:s röst är implicit "agree" — det är den som lade fram förslaget,
 * och dess motivering är dess röst. Grinden kräver att MODEL_B håller med.
 */
export async function evaluateEnsemble(params: {
  apiKey: string;
  proposal: TradeProposal;
  context: MarketContext;
  ensemble: EnsembleConfig;
  /** Se getSecondOpinion — bara för demo/test. */
  transport?: SecondOpinionTransport;
}): Promise<EnsembleVerdict> {
  const { proposal, ensemble } = params;

  const modelA = {
    model: ensemble.modelA,
    verdict: "agree" as const,
    reasoning: proposal.reasoning,
  };

  const isExit = proposal.side === "SELL";

  // Grinden AV, eller exit-order och vi gatar inte exits: släpp igenom direkt
  // till risk managern (som behåller sitt veto). Vi vill aldrig att en andra
  // modell kan låsa in oss i en position vi försöker ta oss ur.
  if (!ensemble.requireAgreement || (isExit && !ensemble.gateExits)) {
    const why = !ensemble.requireAgreement
      ? "ENSEMBLE_REQUIRE_AGREEMENT=false"
      : "exit-order (ENSEMBLE_GATE_EXITS=false)";
    return {
      approved: true,
      requireAgreement: ensemble.requireAgreement,
      skipped: true,
      modelA,
      modelB: {
        verdict: "agree",
        confidence: 0,
        reasoning: `Grind hoppades över: ${why}.`,
        model: ensemble.modelB,
        provider: ensemble.modelBProvider,
        latencyMs: 0,
        degraded: false,
      },
      summary: `Ensemble-grind hoppades över (${why}) — ordern går till risk managern.`,
    };
  }

  log.agent(
    `[Ensemble] ${proposal.side} ${proposal.symbol}: MODEL_A (${ensemble.modelA}) föreslår — ` +
    `frågar MODEL_B (${ensemble.modelB} via ${ensemble.modelBProvider})…`,
  );

  const modelB = await getSecondOpinion(params);

  // Röstade en fallback-modell i MODEL_B:s ställe? Det ska synas i loggen,
  // i decisions-loggen och i svaret till Head Trader.
  const fallbackNote = modelB.fallbackFrom
    ? ` [FALLBACK: ${modelB.fallbackFrom.model} (${modelB.fallbackFrom.provider}) kunde inte användas — ${modelB.fallbackFrom.reason}. ${modelB.model} röstade istället.]`
    : "";

  // Fail-open-undantaget gäller BARA degraderade svar (fel/timeout/parse-miss),
  // aldrig ett riktigt "disagree" från modellen.
  const failedOpen = modelB.degraded && ensemble.failOpen;
  const approved = modelB.verdict === "agree" || failedOpen;

  const summary = (failedOpen
    ? `MODEL_B (${modelB.model}) svarade inte — ENSEMBLE_FAIL_OPEN=true släpper igenom. ${modelB.reasoning}`
    : approved
      ? `BÅDA ENSE: MODEL_A (${modelA.model}) föreslog, MODEL_B (${modelB.model}) höll med (confidence ${modelB.confidence.toFixed(2)}). ${modelB.reasoning}`
      : `OENIGHET: MODEL_A (${modelA.model}) föreslog ${proposal.side} ${proposal.symbol}, MODEL_B (${modelB.model}) sa disagree (confidence ${modelB.confidence.toFixed(2)}). ${modelB.reasoning}`) + fallbackNote;

  if (approved) {
    log.ok(`[Ensemble] ✓ ${proposal.side} ${proposal.symbol}: båda överens → vidare till risk manager.`);
  } else {
    log.warn(`[Ensemble] ✗ ${proposal.side} ${proposal.symbol}: oenighet → traden skippas.`);
  }

  return { approved, requireAgreement: true, skipped: false, modelA, modelB, summary };
}
