// Forexprisets representation för Tiingo-historik i Demo (lånas från Live) + agenternas Tiingo-forex.
// Bara mockar: inga nätverksanrop mot IG eller Tiingo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-fx-mult-"));
process.env.TRADING_DATA_DIR = tmp;
process.env.AGENT_TREE_TRADING_EVENTS = "off";
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;

const { createIgForexMultiplier, FX_MULTIPLIER_MISS_TTL_MS } = await import("../src/server/igForexMultiplier.js");
const AD = await import("../src/server/igAgentData.js");

const EPIC = "CS.D.EURUSD.CEE.IP";
const inst = (scalingFactor: number) => ({ epic: EPIC, scalingFactor, onePipMeans: "0.0001 USD/EUR" });

// ── 1. Demo saknar bevis: Live:s verifierade värde lånas, bara när kontraktet beskrivs likadant ──
{
  let clock = 1_000_000, liveReads = 0;
  const live = { epic: EPIC, type: "CURRENCIES", instrument: inst(10000), calculationRules: { nativePriceMultiplier: 10000 } };
  const demo = { epic: EPIC, type: "CURRENCIES", instrument: inst(10000), calculationRules: { nativePriceMultiplier: null } };
  const fx = createIgForexMultiplier({ now: () => clock, market: async (env) => { if (env === "live") { liveReads++; return live; } return demo; } });
  assert.deepEqual(await fx.get("demo", EPIC, demo), { multiplier: 10000, borrowedFromLive: true });
  assert.deepEqual(await fx.get("demo", EPIC, demo), { multiplier: 10000, borrowedFromLive: true }); assert.equal(liveReads, 1, "cachad: ingen ny Live-läsning");
  assert.deepEqual(await fx.get("live", EPIC, live), { multiplier: 10000, borrowedFromLive: false }, "eget bevis används direkt");

  // Olika scalingFactor i Demo och Live: inget lån
  const other = createIgForexMultiplier({ now: () => clock, market: async (env) => env === "live" ? live : { ...demo, instrument: inst(1) } });
  assert.equal(await other.get("demo", EPIC), null);
  // Live saknar också beviset: inget lån, och ny läsning först efter väntetiden
  let reads = 0;
  const none = createIgForexMultiplier({ now: () => clock, market: async () => { reads++; return demo; } });
  assert.equal(await none.get("demo", EPIC), null); const r0 = reads;
  assert.equal(await none.get("demo", EPIC), null); assert.equal(reads, r0, "saknat bevis cachas");
  clock += FX_MULTIPLIER_MISS_TTL_MS + 1; await none.get("demo", EPIC); assert.ok(reads > r0, "försöker igen efter väntetiden");
  // IG-fel: null, aldrig undantag
  let fail = true;
  const err = createIgForexMultiplier({ market: async (env) => { if (fail) throw new Error("IG begränsade antal läsanrop"); return env === "live" ? live : demo; } });
  assert.equal(await err.get("demo", EPIC), null); assert.equal(err.peek("demo", EPIC), null);
  fail = false; assert.equal((await err.get("demo", EPIC))?.multiplier, 10000, "IG-fel cachas inte");
  fail = true; assert.equal(err.peek("demo", EPIC)?.multiplier, 10000, "peek: senast verifierade värde utan IG-läsning");
  console.log("PASS: Demo lånar Live:s verifierade forexrepresentation (samma scalingFactor/onePipMeans), cachas, inget lån vid olikheter eller fel");
}

// ── 2. Agenternas Tiingo-forex räknas om till IG-punkter med verifierad representation ──
{
  const now = Date.UTC(2026, 10, 2, 10, 0, 0);
  const minute = Array.from({ length: 900 }, (_, i) => { const t = now - (900 - i) * 60_000; return { openTime: t, closeTime: t + 60_000, open: 1.1174, high: 1.1175, low: 1.1173, close: 1.1174, volume: 1 }; });
  const tiingo = { bars: async (_e: string, _n: unknown, f: any) => ({ ticker: "eurusd", freq: f, bars: minute, at: now, note: null }), hint: () => {} };
  const quote = { epic: EPIC, bid: 11173.5, offer: 11174.5, mid: 11174, observedAt: now - 2_000, receivedAt: now - 2_000, delayTime: 0, marketStatus: "TRADEABLE", changePct: 0, high: null, low: null, source: "stream" };
  const make = (m: number | null) => AD.createIgAgentData({
    memory: () => [], dataEnv: (e) => e, quote: () => quote as any, name: () => "EUR/USD", budget: () => ({ backgroundRemaining: 0 }) as any,
    historyBlockedUntil: () => now + 3_600_000, tiingo: tiingo as any, streamWaitMs: 0, now: () => now, fxMultiplier: async () => m,
  });
  const ok = await make(10000).klines("demo", EPIC, "15m", 50, null);
  assert.equal(ok.sourceKey, "tiingo"); assert.ok(ok.klines.length >= 20, "Tiingo-ljus används");
  assert.equal(ok.klines.at(-1)!.close, 11174, "omräknat till IG-punkter"); assert.equal(ok.deviationPct, 0);
  const no = await make(null).klines("demo", EPIC, "15m", 50, null);
  assert.equal(no.klines.length, 0, "utan verifierad representation avvisas Tiingo som förut"); assert.match(no.note ?? "", /avviker/);
  console.log("PASS: Agenternas Tiingo-forex räknas om med verifierad representation; utan bevis avvisas den (±3 %)");
}
console.log("Forexrepresentation: alla tester godkända (endast mocks, inga nätverksanrop)");
