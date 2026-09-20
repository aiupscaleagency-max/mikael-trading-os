import { TOOLS, type ToolContext } from "../agent/tools.js";
import { RiskManager } from "../risk/riskManager.js";
import {
  ProviderUnavailableError,
  setSecondOpinionTransport,
  type EnsembleConfig,
  type ModelProvider,
} from "../orchestrator/secondOpinion.js";
import type { Config } from "../config.js";
import type { AgentState } from "../memory/store.js";
import type { Account, Kline, OrderRequest, OrderResult, Position, Ticker } from "../types.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { log } from "../logger.js";
import { openLearningDb } from "../learning/db.js";

// ═══════════════════════════════════════════════════════════════════════════
//  ENSEMBLE-DEMO — kör 2-modell-grinden i propose/testnet-läge.
//
//  Kör:  npx tsx src/scripts/ensembleDemo.ts
//
//  Läget är hårdkodat till mode=paper + executionMode=approve (propose) och
//  en testnet-broker-stub. Inga riktiga ordrar, inga nycklar krävs, inga
//  broker-anrop utanför stubben.
//
//  MODEL_A = Claude (Head Trader), MODEL_B = GPT-6 Astra via OpenAI.
//
//  MODEL_B:
//    - Som default körs SIMULERADE modell-svar (offline) så att hela kedjan —
//      förslag → grind → risk manager → propose — kan visas utan nycklar.
//      Stubben är provider-medveten: den vet om den anropas som gpt-6-astra
//      (openai) eller som Claude-fallback (anthropic).
//    - Med ENSEMBLE_DEMO_LIVE=true körs riktiga anrop: GPT-6 Astra via
//      OPENAI_API_KEY, Claude-fallback via ANTHROPIC_API_KEY.
// ═══════════════════════════════════════════════════════════════════════════

const LIVE = process.env.ENSEMBLE_DEMO_LIVE === "true";

const ensemble: EnsembleConfig = {
  modelA: process.env.MODEL_A ?? "claude-sonnet-4-6",
  modelB: process.env.MODEL_B ?? "gpt-6-astra",
  modelBProvider: (process.env.MODEL_B_PROVIDER as ModelProvider) ?? "openai",
  requireAgreement: (process.env.ENSEMBLE_REQUIRE_AGREEMENT ?? "true").toLowerCase() !== "false",
  failOpen: (process.env.ENSEMBLE_FAIL_OPEN ?? "false").toLowerCase() === "true",
  gateExits: (process.env.ENSEMBLE_GATE_EXITS ?? "false").toLowerCase() === "true",
  timeoutMs: 45_000,
  fallbackModel: process.env.ENSEMBLE_FALLBACK_MODEL ?? "claude-opus-4-6",
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || undefined,
  },
};

// ── Demo-config: paper + approve. Riskramarna är .env.example-defaults. ──
const demoConfig = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "demo-no-key",
  mode: "paper",
  executionMode: "approve",
  engines: ["crypto_momentum"],
  crypto: { symbols: ["BTCUSDT", "ETHUSDT"], leverage: 5, trailingStopPct: 2, takeProfitSteps: [5, 10, 20] },
  stocks: { symbols: [] },
  wheel: { underlyings: [], putDelta: 0.3, profitTargetPct: 50 },
  risk: {
    defaultPositionUsd: 50,
    minPositionUsd: 20,
    maxPositionUsd: 100,
    maxTotalExposureUsd: 500,
    maxDailyLossUsd: 50,
    maxOpenPositions: 5,
  },
  ensemble,
  // Lärloopen är på i demon så hela kedjan syns: förslag → grind → journal.
  // Skriver till data/learning.db (gitignorerad).
  learning: {
    enabled: true,
    feeBps: { crypto: 10, aktie: 1, forex: 0 },
    slippageBps: 5,
    fundingBpsPer8h: 1,
    mmr: 0.005,
    liqBufferPct: 0.002,
    resolveIntervalSeconds: 900,
    maxResolveAttempts: 10,
    horizonBars: { crypto: 18, aktie: 10, forex: 24 },
  },
  oanda: { symbols: [] },
} as unknown as Config;

const demoState: AgentState = {
  killSwitchActive: false,
  dailyRealizedPnlUsdt: -4.2,
  dailyPnlResetAt: Date.now(),
  openPositions: {},
};

// ── Testnet-broker-stub. Inga nätverksanrop. ──
const PRICE = 67_450;

const stubBroker: BrokerAdapter = {
  name: "binance-testnet-stub",
  mode: "paper",
  async getAccount(): Promise<Account> {
    return {
      balances: [{ asset: "USDT", free: 1000, locked: 0 }],
      totalValueUsdt: 1000,
      updatedAt: Date.now(),
    };
  },
  async getPositions(): Promise<Position[]> {
    return [];
  },
  async getTicker(symbol: string): Promise<Ticker> {
    return { symbol, price: PRICE, changePct24h: 3.1, volume24h: 12_500 };
  },
  async getKlines(): Promise<Kline[]> {
    // Syntetisk uppåttrend så regim-härledningen har något att arbeta med.
    const BAR = 4 * 60 * 60 * 1000;
    return Array.from({ length: 120 }, (_, i) => ({
      openTime: Date.now() - (120 - i) * BAR,
      closeTime: Date.now() - (119 - i) * BAR - 1,
      open: PRICE * (0.85 + i * 0.0012),
      high: PRICE * (0.86 + i * 0.0012),
      low: PRICE * (0.84 + i * 0.0012),
      close: PRICE * (0.85 + i * 0.0012),
      volume: 100,
    }));
  },
  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    throw new Error(`Demo-brokern lägger aldrig ordrar (försökte: ${order.side} ${order.symbol})`);
  },
} as unknown as BrokerAdapter;

const BRIEFING = `── [2/9] TEKNISK ANALYTIKER ──
BTCUSDT: bullish (score 3) — 1h/4h/1d över EMA20, RSI14 58, MACD-kors uppåt | Entry: 67450, SL: 65900 | TP: 69000/70500/72000
ETHUSDT: neutral (score 1) — konsoliderar under 4h-motstånd

── [4/9] RISK-ANALYTIKER ──
Risknivå: LOW | Portföljhetta: 0% | Korrelation: låg (inga öppna positioner)
Positionsstorlek: max 100 USD

── [9/9] CLAUDE ADVISOR ──
Outlook: BULLISH | Marknadscykel: markup
Contrarian: Drivet är 3 dagar gammalt — risk att vi köper sista benet.`;

// ── Simulerade modell-svar (offline), provider-medvetna. ──
//
// Stubben används bara i demon. Den efterliknar två saker:
//   1. gpt-6-astra (openai) som granskare — röstar på förslagets innehåll.
//   2. Ett trasigt OpenAI-konto: kastar ProviderUnavailableError precis som
//      askOpenAI gör vid 401/insufficient_quota, så att den RIKTIGA
//      fallback-logiken i secondOpinion.ts körs på riktigt i demon.
let simulateOpenAiFailure: string | null = null;

function simulatedTransport(
  userMessage: string,
  target: { model: string; provider: ModelProvider },
): Promise<string> {
  if (target.provider === "openai" && simulateOpenAiFailure) {
    return Promise.reject(new ProviderUnavailableError(simulateOpenAiFailure));
  }

  // Enkel heuristik enbart för demon: en motivering med konkreta nivåer och
  // flera samstämmiga tidsramar godkänns; en tunn tes avslås.
  const hasLevels = /\b\d{4,}\b/.test(userMessage) && /SL|stop|TP/i.test(userMessage);
  const multiTimeframe = (userMessage.match(/\b(1h|4h|1d|15m)\b/g) ?? []).length >= 3;
  const thin = /känsla|momentum ser bra ut|alla pratar om|FOMO/i.test(userMessage);
  const agree = hasLevels && multiTimeframe && !thin;

  const who = target.provider === "openai" ? "GPT-granskaren" : "Claude-granskaren";
  return Promise.resolve(
    JSON.stringify(
      agree
        ? {
            verdict: "agree",
            confidence: target.provider === "openai" ? 0.74 : 0.69,
            reasoning:
              `${who}: tesen är förankrad i data — 1h/4h/1d pekar åt samma håll, entry ligger nära EMA20 ` +
              "och stoppen är definierad på 65900 (~2,3% risk). Storleken ryms i riskramen och portföljen " +
              "är tom, så ingen korrelationsrisk tillkommer.",
          }
        : {
            verdict: "disagree",
            confidence: target.provider === "openai" ? 0.83 : 0.78,
            reasoning:
              `${who}: motiveringen saknar konkreta nivåer och samstämmiga tidsramar — den beskriver ett ` +
              "narrativ, inte en setup. Utan definierad stop går risken inte att kvantifiera. Att avstå " +
              "kostar noll; tveksam ⇒ disagree.",
          },
    ),
  );
}

function makeCtx(): ToolContext {
  return {
    broker: stubBroker,
    brokers: { binance: stubBroker },
    risk: new RiskManager(demoConfig),
    config: demoConfig,
    state: demoState,
    engines: [],
    marketContext: BRIEFING,
    proposedByModel: ensemble.modelA,
    sideEffects: { placedOrders: [], killSwitchToggled: false, ensembleVotes: [] },
  };
}

async function scenario(title: string, input: Record<string, unknown>): Promise<void> {
  log.info("─".repeat(72));
  log.info(`SCENARIO: ${title}`);
  log.info("─".repeat(72));

  const ctx = makeCtx();
  const output = await TOOLS.place_order!.handler(input, ctx);

  const vote = ctx.sideEffects.ensembleVotes?.[0];
  if (vote) {
    const { modelA, modelB, approved } = vote.verdict;
    log.agent(`  MODEL_A  ${modelA.model.padEnd(22)} röst=agree`);
    log.agent(`           motivering: ${modelA.reasoning}`);
    const role = modelB.fallbackFrom ? "FALLBACK" : "MODEL_B ";
    log.agent(`  ${role} ${modelB.model.padEnd(22)} (${modelB.provider}) röst=${modelB.verdict} (confidence ${modelB.confidence.toFixed(2)}, ${modelB.latencyMs}ms${modelB.degraded ? ", DEGRADERAD" : ""})`);
    if (modelB.fallbackFrom) {
      log.agent(`           ⚠ ${modelB.fallbackFrom.model} (${modelB.fallbackFrom.provider}) föll bort: ${modelB.fallbackFrom.reason}`);
    }
    log.agent(`           motivering: ${modelB.reasoning}`);
    log.agent(`  GRIND    → ${approved ? "GODKÄND — går vidare till risk manager" : "SKIPPAD — når aldrig risk managern"}`);
  }

  log.info(`  Tool-svar: ${JSON.stringify(output, null, 2).split("\n").join("\n  ")}`);
  log.info("");
}

async function main(): Promise<void> {
  log.info("╔══════════════════════════════════════════════════════════════════╗");
  log.info("║  ENSEMBLE-DEMO — 2-modell-grind (propose / testnet)             ║");
  log.info("╚══════════════════════════════════════════════════════════════════╝");
  log.info(`  MODE=${demoConfig.mode}  EXECUTION_MODE=${demoConfig.executionMode}  broker=${stubBroker.name} (${stubBroker.mode})`);
  log.info(`  MODEL_A=${ensemble.modelA}`);
  log.info(`  MODEL_B=${ensemble.modelB} (provider=${ensemble.modelBProvider})`);
  log.info(`  ENSEMBLE_REQUIRE_AGREEMENT=${ensemble.requireAgreement}  FAIL_OPEN=${ensemble.failOpen}  GATE_EXITS=${ensemble.gateExits}`);
  log.info(`  MODEL_B-läge: ${LIVE ? "LIVE (riktiga API-anrop)" : "SIMULERAD (offline, inga nycklar används)"}`);
  log.info(`  Riskramar oförändrade: MIN ${demoConfig.risk.minPositionUsd} / DEFAULT ${demoConfig.risk.defaultPositionUsd} / MAX ${demoConfig.risk.maxPositionUsd} USD`);
  log.info("");

  if (!LIVE) {
    // Injicera de simulerade modell-svaren. Produktionsvägen är orörd —
    // utan detta anrop görs riktiga anrop mot OpenAI respektive Anthropic.
    setSecondOpinionTransport(simulatedTransport);
  }

  await scenario("Claude föreslår, GPT-6 Astra röstar AGREE — grinden öppnar", {
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quote_qty: 50,
    stop_loss: 65900,
    take_profit: 69000,
    reasoning:
      "BTCUSDT bullish på 1h/4h/1d: pris 67450 över EMA20 på samtliga, RSI14 58 (ej överköpt), MACD-kors uppåt på 4h. Entry 67450, SL 65900 (-2,3%), TP1 69000. Karin vol=medium, Rasmus risk=low, portföljen tom. Storlek 50 USD = DEFAULT.",
  });

  await scenario("Tunn tes — GPT-6 Astra röstar DISAGREE, traden skippas", {
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quote_qty: 50,
    reasoning:
      "Momentum ser bra ut och alla pratar om BTC just nu. Känslan är att vi ska upp — jag vill inte missa draget.",
  });

  // ── Fallback-vägen: OpenAI-kontot svarar 401/insufficient_quota ──
  // Här körs den riktiga fallback-logiken i secondOpinion.ts; bara HTTP-svaret
  // är simulerat. Poängen: vi kör aldrig blint vidare utan andra-åsikt.
  if (!LIVE) {
    simulateOpenAiFailure =
      'OpenAI-kontot är utan kvot — HTTP 429 (insufficient_quota): You exceeded your current quota.';
  }
  await scenario("OpenAI svarar insufficient_quota — tydligt fel + fallback till Claude-B", {
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quote_qty: 50,
    stop_loss: 65900,
    take_profit: 69000,
    reasoning:
      "BTCUSDT bullish på 1h/4h/1d: pris 67450 över EMA20 på samtliga, RSI14 58, MACD-kors uppåt på 4h. Entry 67450, SL 65900 (-2,3%), TP1 69000. Storlek 50 USD = DEFAULT.",
  });
  simulateOpenAiFailure = null;

  // ── Lärloopens journal ──
  // Varje förslag ovan skrevs till data/learning.db med BÅDA rösterna, även
  // det nedröstade. Det är så vi senare kan mäta om grinden lönar sig.
  log.info("─".repeat(72));
  log.info("LÄRLOOPENS JOURNAL (data/learning.db)");
  log.info("─".repeat(72));
  const rader = openLearningDb()
    .prepare(
      `SELECT symbol, direction, entry, stop_loss, take_profit, regime, confidence,
              model_a, model_b, model_b_verdict, ensemble_approved, resolution_status
         FROM signal_journal ORDER BY rowid`,
    )
    .all();
  for (const r of rader) {
    log.info(
      `  ${r.direction} ${r.symbol} @ ${r.entry} | SL ${r.stop_loss ?? "–"} TP ${r.take_profit ?? "–"} ` +
      `| regim=${r.regime} conf=${Number(r.confidence).toFixed(2)}`,
    );
    log.info(
      `      A=${r.model_a} vs B=${r.model_b} (${r.model_b_verdict}) ` +
      `→ approved=${r.ensemble_approved} | ${r.resolution_status}`,
    );
  }
  log.info("");

  log.ok("Demo klar. Inga ordrar lades, inga riktiga nycklar användes, inga config-lås rördes.");
  log.info("Oenigheten ovan är loggad till data/decisions.jsonl som action=hold.");
  log.info("Signalerna är journalförda i data/learning.db — kör `npm run journal:resolve` för att avgöra dem.");
}

main().catch((err) => {
  log.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
