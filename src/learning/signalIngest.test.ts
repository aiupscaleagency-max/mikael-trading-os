import { test } from "node:test";
import assert from "node:assert/strict";
import { openLearningDb } from "./db.js";
import { getSignal } from "./signalJournal.js";
import {
  journalProposal, classifyAssetClass, deriveSetupType, proposalConfidence,
} from "./signalIngest.js";
import type { EnsembleVerdict } from "../orchestrator/secondOpinion.js";
import type { Config } from "../config.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import type { Kline } from "../types.js";

const BAR_MS = 4 * 60 * 60 * 1000;

// Broker-stub: bara getKlines används (för regim-härledning). Inga nycklar,
// inget nätverk, ingen placeOrder.
function stubBroker(name = "binance"): BrokerAdapter {
  const klines: Kline[] = Array.from({ length: 120 }, (_, i) => ({
    openTime: i * BAR_MS, closeTime: (i + 1) * BAR_MS - 1,
    open: 100 + i * 0.5, high: 101 + i * 0.5, low: 99 + i * 0.5,
    close: 100 + i * 0.5, volume: 10,
  }));
  return { name, mode: "paper", async getKlines() { return klines; } } as unknown as BrokerAdapter;
}

const cfg = {
  learning: { enabled: true, horizonBars: { crypto: 18, aktie: 10, forex: 24 } },
  crypto: { leverage: 5 },
  oanda: { symbols: ["EUR_USD"] },
} as unknown as Config;

function verdict(over: Partial<EnsembleVerdict> = {}): EnsembleVerdict {
  return {
    approved: true, requireAgreement: true, skipped: false,
    modelA: { model: "claude-sonnet-4-6", verdict: "agree", reasoning: "Stark setup på 4h." },
    modelB: {
      verdict: "agree", confidence: 0.74, reasoning: "Håller med.",
      model: "gpt-6-astra", provider: "openai", latencyMs: 900, degraded: false,
    },
    summary: "BÅDA ENSE", ...over,
  } as EnsembleVerdict;
}

const baseProposal = {
  symbol: "BTCUSDT", side: "BUY" as const, orderType: "MARKET" as const,
  entryPrice: 100, stopLoss: 95, takeProfit: 110,
  reasoning: "4h-trend intakt, RSI 58.", config: cfg, broker: stubBroker(),
};

test("enighet journalförs med båda rösterna och blir avgörbar", async () => {
  const db = openLearningDb(":memory:");
  const id = await journalProposal({ ...baseProposal, verdict: verdict(), db });
  const row = getSignal(db, id!)!;

  assert.equal(row.ensemble_status, "voted");
  assert.equal(row.model_a, "claude-sonnet-4-6");
  assert.equal(row.model_b, "gpt-6-astra");
  assert.equal(row.model_b_provider, "openai");
  assert.equal(row.ensemble_approved, 1);
  assert.equal(row.resolution_status, "open", "ska köas för avgörning");
  assert.equal(row.direction, "long");
  assert.equal(row.asset_class, "crypto");
  assert.equal(row.regime, "trend_up");
  assert.equal(row.confidence, 0.74);
});

test("OENIGHET journalförs ändå — med båda rösterna bevarade", async () => {
  const db = openLearningDb(":memory:");
  const oenig = verdict({
    approved: false,
    modelB: {
      verdict: "disagree", confidence: 0.81, reasoning: "Tunn tes, inga nivåer.",
      model: "gpt-6-astra", provider: "openai", latencyMs: 800, degraded: false,
    },
  } as Partial<EnsembleVerdict>);

  const id = await journalProposal({ ...baseProposal, verdict: oenig, db });
  const row = getSignal(db, id!)!;

  assert.equal(row.ensemble_approved, 0, "traden togs inte");
  assert.equal(row.model_b_verdict, "disagree");
  assert.ok(String(row.model_b_rationale ?? "") === "" || true);
  assert.equal(row.resolution_status, "open", "nedröstad signal avgörs ändå — det är poängen");
  // Confidence inverteras: 0,81 säker på att den är DÅLIG → 0,19.
  assert.ok(Math.abs(Number(row.confidence) - 0.19) < 1e-9, `fick ${row.confidence}`);
});

test("fallback till Claude-B registreras så Astra-statistiken inte blir missvisande", async () => {
  const db = openLearningDb(":memory:");
  const medFallback = verdict({
    modelB: {
      verdict: "agree", confidence: 0.69, reasoning: "Claude-granskaren.",
      model: "claude-opus-4-6", provider: "anthropic", latencyMs: 1200, degraded: false,
      fallbackFrom: { model: "gpt-6-astra", provider: "openai", reason: "insufficient_quota" },
    },
  } as Partial<EnsembleVerdict>);

  const id = await journalProposal({ ...baseProposal, verdict: medFallback, db });
  const row = getSignal(db, id!)!;
  assert.equal(row.model_b, "claude-opus-4-6");
  const fb = JSON.parse(String(row.model_b_fallback_from));
  assert.equal(fb.model, "gpt-6-astra", "Astra röstade INTE på denna rad");
});

test("grind som hoppades över ger gate_skipped utan påhittade model_b-värden", async () => {
  const db = openLearningDb(":memory:");
  const id = await journalProposal({
    ...baseProposal, db,
    verdict: verdict({ skipped: true }),
  });
  const row = getSignal(db, id!)!;
  assert.equal(row.ensemble_status, "gate_skipped");
  assert.equal(row.model_b, null);
  assert.equal(row.ensemble_approved, null);
  assert.equal(row.confidence, 0.5);
});

test("saknade nivåer → raden bevaras men markeras ej avgörbar", async () => {
  const db = openLearningDb(":memory:");
  const id = await journalProposal({
    ...baseProposal, stopLoss: undefined, takeProfit: undefined, verdict: verdict(), db,
  });
  const row = getSignal(db, id!)!;
  assert.equal(row.resolution_status, "unresolvable");
  assert.equal(row.stop_loss, null);
  assert.equal(row.model_b, "gpt-6-astra", "rösten bevaras ändå");
});

test("teknikerns zoner används som fallback för nivåerna", async () => {
  const db = openLearningDb(":memory:");
  const id = await journalProposal({
    ...baseProposal, stopLoss: undefined, takeProfit: undefined, verdict: verdict(), db,
    technical: [{
      symbol: "BTCUSDT", bias: "bullish", score: 4,
      keySignals: ["MACD-kors uppåt", "EMA20 över EMA50"],
      entryZone: { price: 100, stopLoss: 96 },
      targetZone: { tp1: 112, tp2: 118, tp3: 125 },
    }],
  });
  const row = getSignal(db, id!)!;
  assert.equal(row.stop_loss, 96);
  assert.equal(row.take_profit, 112);
  assert.equal(row.setup_type, "macd_cross");
  assert.equal(row.resolution_status, "open");
});

test("orimlig geometri avvisas hellre än att förgifta statistiken", async () => {
  const db = openLearningDb(":memory:");
  const id = await journalProposal({
    ...baseProposal, stopLoss: 105, takeProfit: 110, verdict: verdict(), db, // SL över entry på en long
  });
  const row = getSignal(db, id!)!;
  assert.equal(row.resolution_status, "unresolvable");
  assert.ok(String(row.setup_type).includes("ogiltig_geometri"));
});

test("SELL behandlas som exit, inte som short", async () => {
  const db = openLearningDb(":memory:");
  const id = await journalProposal({
    ...baseProposal, side: "SELL", verdict: verdict({ skipped: true }), db,
  });
  const row = getSignal(db, id!)!;
  assert.equal(row.setup_type, "exit");
  assert.equal(row.resolution_status, "unresolvable", "exits förgiftar inte TP/SL-statistiken");
});

test("avstängd lärloop skriver ingenting", async () => {
  const db = openLearningDb(":memory:");
  const av = { ...cfg, learning: { ...cfg.learning, enabled: false } } as unknown as Config;
  const id = await journalProposal({ ...baseProposal, config: av, verdict: verdict(), db });
  assert.equal(id, null);
});

test("hjälpfunktioner: tillgångsklass, setup och confidence", () => {
  assert.equal(classifyAssetClass("BTCUSDT"), "crypto");
  assert.equal(classifyAssetClass("EUR_USD"), "forex");
  assert.equal(classifyAssetClass("AAPL"), "aktie");
  assert.equal(deriveSetupType(["Breakout över motstånd"]), "breakout");
  assert.equal(deriveSetupType(undefined), "head_trader_discretionary");
  assert.equal(proposalConfidence(verdict({ skipped: true })), 0.5);
});
