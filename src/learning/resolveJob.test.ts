import { test } from "node:test";
import assert from "node:assert/strict";
import { openLearningDb } from "./db.js";
import { insertSignal, getSignal } from "./signalJournal.js";
import { runResolveJob } from "./resolveJob.js";
import type { NewSignalRow } from "./schema.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import type { Config } from "../config.js";
import type { Kline } from "../types.js";

const BAR_MS = 4 * 60 * 60 * 1000;

const cfg = {
  learning: {
    enabled: true,
    feeBps: { crypto: 10, aktie: 1, forex: 0 },
    slippageBps: 5, fundingBpsPer8h: 1, mmr: 0.005, liqBufferPct: 0.002,
    resolveIntervalSeconds: 900, maxResolveAttempts: 10,
    horizonBars: { crypto: 18, aktie: 10, forex: 24 },
  },
} as unknown as Config;

function rad(ts: number, over: Partial<NewSignalRow> = {}): NewSignalRow {
  return {
    id: `sig-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    ts, source: "head_trader_proposal", signal_version: "test",
    asset_class: "crypto", symbol: "BTCUSDT", venue: "binance", timeframe: "4h",
    leverage: 1, is_perp: 0,
    direction: "long", setup_type: "ta_score",
    entry: 100, stop_loss: 95, take_profit: 110,
    horizon_bars: 5, confidence: 0.7, regime: "trend_up",
    features_snapshot: "{}", rationale: "test",
    resolution_status: "open",
    ensemble_status: "voted",
    model_a: "claude-sonnet-4-6", model_a_verdict: "agree", model_a_rationale: "x",
    model_b: "gpt-6-astra", model_b_provider: "openai", model_b_verdict: "agree",
    model_b_confidence: 0.7, model_b_fallback_from: null, ensemble_approved: 1,
    ensemble_ts: ts,
    ...over,
  } as NewSignalRow;
}

/** Broker som levererar candles där priset går till TP i bar 3. */
function tpBroker(signalTs: number): BrokerAdapter {
  return {
    name: "binance", mode: "paper",
    async getKlinesRange(): Promise<Kline[]> {
      const priser: Array<[number, number, number, number]> = [
        [100, 102, 99, 101], [101, 104, 100, 103], [103, 112, 102, 111],
        [111, 112, 110, 111], [111, 112, 110, 111],
      ];
      return priser.map(([o, h, l, c], i) => ({
        openTime: signalTs + (i + 1) * BAR_MS,
        closeTime: signalTs + (i + 2) * BAR_MS - 1,
        open: o, high: h, low: l, close: c, volume: 1,
      }));
    },
  } as unknown as BrokerAdapter;
}

test("jobbet avgör en öppen signal och skriver tillbaka utfallet", async () => {
  const db = openLearningDb(":memory:");
  const ts = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const r = rad(ts);
  insertSignal(db, r);

  const res = await runResolveJob({ config: cfg, brokers: { binance: tpBroker(ts) }, db });
  assert.equal(res.resolved, 1, "signalen ska ha avgjorts");

  const efter = getSignal(db, r.id)!;
  assert.equal(efter.resolution_status, "resolved");
  assert.equal(efter.outcome, "TP");
  assert.equal(efter.exit_price, 110);
  assert.equal(efter.bars_to_resolution, 3);
  assert.ok(Number(efter.r_multiple) > 0);
  assert.ok(Number(efter.r_multiple) < Number(efter.r_multiple_gross), "kostnader ska dras av");
  assert.equal(efter.resolver_version, "resolve-v1");
});

test("avlistad symbol ger upp direkt istället för att köa om i evighet", async () => {
  const db = openLearningDb(":memory:");
  const ts = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const r = rad(ts, { symbol: "MATICUSDT" });
  insertSignal(db, r);

  const trasig = {
    name: "binance", mode: "paper",
    async getKlinesRange(): Promise<Kline[]> {
      throw new Error('Binance GET /api/v3/klines 400: {"code":-1121,"msg":"Invalid symbol."}');
    },
  } as unknown as BrokerAdapter;

  const res = await runResolveJob({ config: cfg, brokers: { binance: trasig }, db });
  assert.equal(res.unresolvable, 1);
  const efter = getSignal(db, r.id)!;
  assert.equal(efter.resolution_status, "unresolvable");
  assert.ok(String(efter.resolve_error).includes("delisted_or_invalid_symbol"));
});

test("nätverksfel lämnar raden öppen och räknar upp försöken", async () => {
  const db = openLearningDb(":memory:");
  const ts = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const r = rad(ts);
  insertSignal(db, r);

  const nere = {
    name: "binance", mode: "paper",
    async getKlinesRange(): Promise<Kline[]> { throw new Error("fetch failed: ECONNREFUSED"); },
  } as unknown as BrokerAdapter;

  const res = await runResolveJob({ config: cfg, brokers: { binance: nere }, db });
  assert.equal(res.failed, 1);
  const efter = getSignal(db, r.id)!;
  assert.equal(efter.resolution_status, "open", "transient fel får inte ge upp raden");
  assert.equal(efter.resolve_attempts, 1);
});

test("FAS 1: bara krypto plockas upp — aktie/forex lämnas helt orörda", async () => {
  const db = openLearningDb(":memory:");
  const ts = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const aktie = rad(ts, { asset_class: "aktie", symbol: "AAPL", venue: "alpaca" });
  const forex = rad(ts, { asset_class: "forex", symbol: "EUR_USD", venue: "oanda" });
  const krypto = rad(ts);
  insertSignal(db, aktie);
  insertSignal(db, forex);
  insertSignal(db, krypto);

  const res = await runResolveJob({ config: cfg, brokers: { binance: tpBroker(ts) }, db });

  assert.equal(res.examined, 1, "bara krypto-raden ska granskas");
  assert.equal(res.resolved, 1);

  for (const r of [aktie, forex]) {
    const efter = getSignal(db, r.id)!;
    assert.equal(efter.resolution_status, "open", "raden ska ligga kvar till sin fas byggs");
    assert.equal(efter.resolve_attempts, 0, "inga försök ska brännas på den");
    assert.equal(efter.resolve_error, null);
    assert.equal(efter.model_b, "gpt-6-astra", "ensemble-rösten är bevarad");
  }
});

test("krypto-broker utan getKlinesRange ger inte upp raden", async () => {
  const db = openLearningDb(":memory:");
  const ts = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const r = rad(ts);
  insertSignal(db, r);

  const utanStöd = { name: "binance", mode: "paper" } as unknown as BrokerAdapter;
  const res = await runResolveJob({ config: cfg, brokers: { binance: utanStöd }, db });

  assert.equal(res.unresolvable, 0, "saknat brokerstöd är inte samma sak som omöjlig");
  const efter = getSignal(db, r.id)!;
  assert.equal(efter.resolution_status, "open");
});

test("ej avgörbara rader plockas aldrig upp av jobbet", async () => {
  const db = openLearningDb(":memory:");
  const ts = Date.now() - 10 * 24 * 60 * 60 * 1000;
  insertSignal(db, rad(ts, { resolution_status: "unresolvable", stop_loss: null, take_profit: null }));
  const res = await runResolveJob({ config: cfg, brokers: { binance: tpBroker(ts) }, db });
  assert.equal(res.examined, 0);
});

test("avstängd lärloop gör ingenting", async () => {
  const db = openLearningDb(":memory:");
  const ts = Date.now() - 10 * 24 * 60 * 60 * 1000;
  insertSignal(db, rad(ts));
  const av = { ...cfg, learning: { ...cfg.learning, enabled: false } } as unknown as Config;
  const res = await runResolveJob({ config: av, brokers: { binance: tpBroker(ts) }, db });
  assert.equal(res.examined, 0);
});
