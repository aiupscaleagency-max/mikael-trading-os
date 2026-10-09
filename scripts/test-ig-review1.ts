// Granskning 1 (B1, M1–M6, mindre fynd): bara fixtures och mockade beroenden. Inga nätverksanrop.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-review1-"));
process.env.TRADING_DATA_DIR = tmp;
process.env.AGENT_TREE_TRADING_EVENTS = "off";
delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO; delete process.env.IG_ORDER_EXECUTION_ENABLED_LIVE;
for (const k of ["IG_MAX_STAKE_PCT", "IG_MAX_TOTAL_MARGIN_PCT", "IG_MAX_DAILY_LOSS_PCT", "IG_MAX_POSITION_MARGIN", "IG_MAX_TOTAL_MARGIN", "IG_MAX_DAILY_LOSS"]) delete process.env[k];
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;

const { IgBroker } = await import("../src/brokers/ig.js");
const { createIgOrders } = await import("../src/integrations/igOrders.js");
const { createIgMarketData, MAX_STREAM_CHARTS, SERIES_TTL_MS } = await import("../src/server/igMarketData.js");
const { addTimedExit, listTimedExits, closeIgAtExpiry } = await import("../src/server/tradeHorizon.js");
const { IG_READ_RATE_ERROR } = await import("../src/integrations/igConnection.js");
const { configureIgTurnGuard, beginIgTurn, endIgTurn, igTurnStale } = await import("../src/server/igTurnGuard.js");
const { TOOLS } = await import("../src/agent/tools.js");
const { createIgPendingOrder } = await import("../src/server/api.js");
const { listPendingOrders } = await import("../src/server/orderGate.js");

const NOW = Date.parse("2026-10-09T10:00:00Z");
const EPIC = "CS.D.EURUSD.MINI.IP";
const sekEnv = (e: string, gen = `${e}-1`) => ({ environment: e, status: "connected", credentialsComplete: true, connectionGeneration: gen, error: null,
  account: { accountType: "CFD", currency: "SEK", balance: 10_000, available: 8_000, profitLoss: 0 } });
let gen = "g1";
const status = () => ({ environments: { demo: sekEnv("demo", `demo-${gen}`), live: sekEnv("live", `live-${gen}`) } }) as never;
// EUR/USD Mini: 1 kontrakt = 10 000 EUR → pointValue 10 000 SEK/enhet (fixture), marginal 3,33 %
const market = async (_e: string, epic: string) => ({
  epic, name: "EUR/USD Mini", category: "forex", expiry: "-",
  quote: { bid: 1.1, offer: 1.1, receivedAt: NOW - 500, observedAt: NOW - 500, delayTime: 0, marketStatus: "TRADEABLE", percentageChange: 0 },
  calculationRules: { verified: true, pointValue: 10, profitPointValue: 10, marginRate: 0.0333, pointCurrency: "SEK", executionCurrency: "SEK", priceScalingFactor: 10_000, note: "fixture" },
  dealingRules: { minDealSize: { value: 0.1 }, minNormalStopOrLimitDistance: { unit: "POINTS", value: 2 } },
  instrument: { unit: "CONTRACTS", contractSize: 10_000, scalingFactor: 10_000, currencies: [{ code: "SEK" }] },
});

// ── M2: gränser i kontovalutan, samma svar i stake-uträkningen och vid godkännandet ──
{
  const dir = fs.mkdtempSync(path.join(tmp, "orders-"));
  const calls: string[] = [];
  const call = async (_m: string, route: string) => { calls.push(route); if (route === "workingorders") return { workingOrders: [] }; if (route === "history/transactions") return { transactions: [], metadata: { pageData: { totalPages: 1 } } }; throw new Error("oväntat " + route); };
  const orders = createIgOrders({ status, accounts: (async () => ({ status: "ready" })) as never, positions: (async () => ({ status: "ready", positions: [] })) as never,
    market: market as never, call: call as never, guard: async () => ({ killSwitchActive: false }), now: () => NOW, directory: dir, enabled: () => false });
  // margin = 1.1 × size × 10 × 0.0333 → size 8 ≈ 2,93 SEK… skala: använd stora storlekar
  const ok = await orders.preview("demo", { epic: EPIC, direction: "BUY", size: 500, orderType: "MARKET", stopLevel: 1.09, targetLevel: 1.12, holdingMinutes: 15, autoClose: false });
  assert.ok(ok.margin > 150 && ok.margin < 300, `marginal ${ok.margin} under 3 % av 10 000`);
  assert.ok(ok.exposure > 1000, "exponering över de gamla 100 USD-gränsen men ändå godkänd (kontovalutagräns)");
  await assert.rejects(orders.preview("demo", { epic: EPIC, direction: "BUY", size: 900, orderType: "MARKET", stopLevel: 1.09, targetLevel: 1.12, holdingMinutes: 15, autoClose: false }), /mer än 3 % av saldot/);
  const b = new IgBroker("demo", { status, connect: (async () => ({})) as never, accounts: (async () => ({ status: "ready" })) as never, market: market as never, enabled: () => false, now: () => NOW, observe: () => {} });
  const q1 = await b.stakeQuote({ epic: EPIC, direction: "BUY", stake: 300, stopLoss: 1.09, takeProfit: 1.12 });
  assert.equal(q1.ok, true, q1.reason);
  const q2 = await b.stakeQuote({ epic: EPIC, direction: "BUY", stake: 300, stopLoss: 1.09, takeProfit: 1.12, size: 900 });
  assert.equal(q2.ok, false); assert.match(q2.reason!, /mer än 3 % av saldot/, "fast antal kan inte gå förbi budgeten (samma text som godkännandet)");
  console.log("PASS: M2 gränser i kontovaluta (3 % marginal) lika i stake-uträkning och godkännande; quantity kringgår inte budgeten");
}

// ── M1: accepterad order från tidigare IG-session blockerar inte nya order efter återanslutning ──
{
  const dir = fs.mkdtempSync(path.join(tmp, "orders-m1-"));
  let n = 0;
  const ps: any[] = [];
  const call = async (_m: string, route: string, method: string) => {
    if (route === "workingorders") return { workingOrders: [] };
    if (route === "history/transactions") return { transactions: [], metadata: { pageData: { totalPages: 1 } } };
    if (method === "POST") { n++; return { dealReference: `ref-${n}` }; }
    if (route.startsWith("confirms/")) return { dealStatus: "ACCEPTED", dealId: `deal-${n}` };
    throw new Error("oväntat " + route);
  };
  gen = "g1";
  const orders = createIgOrders({ status, accounts: (async () => ({ status: "ready" })) as never, positions: (async () => ({ status: "ready", positions: ps })) as never,
    market: market as never, call: call as never, guard: async () => ({ killSwitchActive: false }), now: () => NOW, directory: dir, enabled: () => true });
  const t = { epic: EPIC, direction: "BUY", size: 100, orderType: "MARKET", stopLevel: 1.09, targetLevel: 1.12, holdingMinutes: 15, autoClose: false };
  const d1 = await orders.preview("demo", t); const r1 = await orders.confirm("demo", d1.id); assert.equal(r1.status, "accepted");
  ps.push({ dealId: "deal-1", epic: EPIC, direction: "BUY", size: 100, level: 1.1, currency: "SEK" });
  gen = "g2"; // ny IG-session (omstart / 1 h)
  const d2 = await orders.preview("demo", t);
  assert.ok(d2.id, "ny order efter återanslutning granskas (positionen observerad via färsk positionsläsning)");
  assert.equal(orders.snapshot("demo").pendingOrders.filter((o: any) => o.status === "accepted" && !o.positionObserved).length, 0);
  console.log("PASS: M1 accepterad order observeras efter sessionsbyte; nästa order blockeras inte");
}

// ── Mindre 7: okänt utfall utan IG-referens stäms av manuellt (läser positioner + aktivitet, skickar inget) ──
{
  const dir = fs.mkdtempSync(path.join(tmp, "orders-unk-"));
  let timeout = true; const posts: string[] = [];
  const ps: any[] = [];
  const call = async (_m: string, route: string, method: string) => {
    if (route === "workingorders") return { workingOrders: [] };
    if (route === "history/transactions") return { transactions: [], metadata: { pageData: { totalPages: 1 } } };
    if (route === "history/activity") return { activities: [{ epic: EPIC, date: "2026-10-09T10:00:00", details: { direction: "BUY" } }] };
    if (method === "POST") { posts.push(route); if (timeout) throw new Error("timeout"); return { dealReference: "x" }; }
    throw new Error("oväntat " + route);
  };
  gen = "g1";
  const orders = createIgOrders({ status, accounts: (async () => ({ status: "ready" })) as never, positions: (async () => ({ status: "ready", positions: ps })) as never,
    market: market as never, call: call as never, guard: async () => ({ killSwitchActive: false }), now: () => NOW, directory: dir, enabled: () => true });
  const t = { epic: EPIC, direction: "BUY", size: 100, orderType: "MARKET", stopLevel: 1.09, targetLevel: 1.12, holdingMinutes: 15, autoClose: false };
  const d = await orders.preview("demo", t); const r = await orders.confirm("demo", d.id);
  assert.equal(r.status, "unknown"); assert.equal(r.dealReference, undefined);
  await assert.rejects(orders.preview("demo", t), /avstämmas/, "blockerar tills avstämt");
  ps.push({ dealId: "found-1", epic: EPIC, direction: "BUY", size: 100, level: 1.1, currency: "SEK" });
  const res = await orders.resolveUnknown("demo", d.id);
  assert.equal(res.status, "accepted"); assert.equal(res.dealId, "found-1");
  assert.equal(posts.length, 1, "avstämningen skickar ingen order");
  timeout = false;
  assert.ok((await orders.preview("demo", t)).id, "nya order tillåts efter avstämning");
  console.log("PASS: okänt utfall utan referens: manuell avstämning mot positioner + aktivitet, inget skickas om");
}

// ── B1: positioner cachas (singleflight), färsk läsning för order/stängning ──
{
  let reads = 0;
  const b = new IgBroker("demo", { status, connect: (async () => ({})) as never, market: market as never, enabled: () => false, now: () => NOW, observe: () => {},
    positions: (async () => { reads++; await new Promise((r) => setTimeout(r, 5)); return { status: "ready", positions: [{ dealId: "D1", epic: EPIC, direction: "BUY", size: 1, level: 1.1, currency: "SEK", bid: 1.1, offer: 1.1 }] }; }) as never });
  await Promise.all([b.getPositions(), b.getPositions(), b.getPositions()]);
  await b.getPositions();
  assert.equal(reads, 1, "tre samtidiga + en till inom 15 s = en IG-läsning");
  await b.getPositions({ fresh: true });
  assert.equal(reads, 2, "fresh läser alltid");
  console.log("PASS: B1 positioner cachas 15 s med singleflight; order/stängning läser färskt");
}

// ── B1 + mindre 6: tidsstängning tas aldrig bort tyst ──
{
  const posList = [{ dealId: "T1" }];
  let enabled = false, closeErr: Error | null = null, closes = 0;
  const fake: any = {
    name: "ig-demo", mode: "paper", executionEnabled: () => enabled,
    getPositions: async () => posList.map((p) => ({ ...p })),
    closePosition: async (id: string) => { closes++; if (closeErr) throw closeErr; const i = posList.findIndex((p) => p.dealId === id); if (i >= 0) posList.splice(i, 1); return {}; },
  };
  addTimedExit({ broker: "ig-demo", symbol: EPIC, qty: 1, live: false, horizonSec: 60, baseline: 0, dealId: "T1" });
  const x = () => listTimedExits().find((e) => e.dealId === "T1")!;
  await closeIgAtExpiry(x(), fake);
  assert.equal(x().igState, "execution-off", "orderläget av: ligger kvar som 'väntar – orderläget av'"); assert.equal(closes, 0);
  enabled = true; closeErr = new Error(IG_READ_RATE_ERROR);
  await closeIgAtExpiry(x(), fake);
  assert.equal(x().igState, "retrying"); assert.equal(x().attempts ?? 0, 0, "läsgräns räknas inte som försök");
  closeErr = new Error("IG svarade HTTP 500");
  for (let i = 0; i < 3; i++) await closeIgAtExpiry(x(), fake);
  assert.equal(x().igState, "needs-attention", "efter 3 fel: kräver åtgärd, men finns kvar och försöker igen");
  assert.ok(x().exitAt > Date.now(), "nästa försök schemalagt");
  closeErr = null;
  await closeIgAtExpiry(x(), fake);
  assert.equal(listTimedExits().some((e) => e.dealId === "T1"), false, "bort först när IG bekräftat stängningen");
  console.log("PASS: tidsstängning: orderläge av syns, läsgräns räknas inte, fel flaggas 'kräver åtgärd', tas bort först efter bekräftad stängning");
}

// ── B1 + M6: högst 4 diagram, bevakningslistan först, gamla serier släpps (ingen ström, ingen pollning) ──
{
  let t = NOW;
  const ensured: Array<{ charts: Array<{ epic: string; scale: string }> }> = [];
  const stream = { events: new EventEmitter(), ensure: (_e: string, _ep: string[], charts: any[]) => { ensured.push({ charts }); }, summary: () => ({ status: "CONNECTED:WS-STREAMING" }) };
  const histCalls: string[] = [];
  const wl = ["CS.D.A.MINI.IP", "CS.D.B.MINI.IP", "CS.D.C.MINI.IP"];
  fs.writeFileSync(path.join(tmp, "wl-chart-demo.json"), JSON.stringify({ epics: wl.map((epic) => ({ epic, name: epic })) }));
  const md = createIgMarketData({ status, now: () => t, stream: stream as never, file: (e) => path.join(tmp, `wl-chart-${e}.json`),
    candles: (async (_e: string, epic: string, tf: string) => { histCalls.push(`${epic}|${tf}`); return { candles: [{ openTime: t - 120_000, closeTime: t - 60_000, open: 1, high: 1, low: 1, close: 1 }] }; }) as never,
    market: market as never });
  for (const e of wl) await md.ensureSeries("demo", e, "1m");
  for (const e of ["CS.D.X.MINI.IP", "CS.D.Y.MINI.IP", "CS.D.Z.MINI.IP"]) await md.ensureSeries("demo", e, "5m");
  md.requestStream([], "demo");
  const last = ensured[ensured.length - 1]!.charts;
  assert.equal(last.length, MAX_STREAM_CHARTS, "högst 4 diagramplatser");
  assert.deepEqual(last.slice(0, 3).map((c) => c.epic).sort(), [...wl].sort(), "bevakningslistans signalserier först");
  await assert.rejects(md.ensureSeries("demo", "CS.D.A.MINI.IP", "7m"), /stöder inte/, "ogiltigt intervall läggs aldrig till");
  md.pinSeries("strategies", "demo", [{ epic: "CS.D.P.MINI.IP", iv: "1d" }]);
  t += SERIES_TTL_MS + 1000;
  const active = md.watchedSeries("demo");
  assert.equal(active.some((k) => k.startsWith("CS.D.X.MINI.IP")), false, "diagram ingen frågat efter på 150 s släpps");
  assert.ok(active.includes("CS.D.P.MINI.IP|1d"), "strategins fästa serie följs");
  assert.ok(active.includes("CS.D.A.MINI.IP|1m"), "bevakningslistan följs alltid");
  console.log("PASS: B1/M6 högst 4 strömmade diagram (bevakning först), oanvända serier släpps, strategier fästs, ogiltiga intervall avvisas");
}

// ── M3: SÄLJ mot en öppen lång position stänger den (ingen hedge); Sälj allt utan position avvisas ──
{
  const positions: any[] = [{ dealId: "L1", epic: EPIC, direction: "BUY", size: 2, level: 1.1, currency: "SEK", bid: 1.1, offer: 1.1 }];
  const b = new IgBroker("demo", { status, connect: (async () => ({})) as never, accounts: (async () => ({ status: "ready" })) as never, market: market as never,
    positions: (async () => ({ status: "ready", positions })) as never, enabled: () => false, now: () => NOW, observe: () => {} });
  const r: any = await createIgPendingOrder({ symbol: EPIC, side: "SELL", stakePct: 1, source: "test" }, b);
  assert.equal(r.ok, true, r.error); assert.equal(r.pendingOrder.closeDealId, "L1", "SÄLJ stänger den långa positionen"); assert.equal(r.pendingOrder.quantity, 2);
  positions.length = 0;
  const none: any = await createIgPendingOrder({ symbol: EPIC, side: "SELL", sellAll: true, source: "test" }, b);
  assert.equal(none.ok, false); assert.match(none.error, /Ingen lång position/);
  const short: any = await createIgPendingOrder({ symbol: EPIC, side: "SELL", stakePct: 1, source: "test", stopLoss: 1.11, takeProfit: 1.08 }, b);
  assert.equal(short.ok, true, short.error); assert.equal(short.pendingOrder.closeDealId, undefined, "SÄLJ utan position öppnar kort");
  const big: any = await createIgPendingOrder({ symbol: EPIC, side: "BUY", quantity: 900, source: "test", stopLoss: 1.09, takeProfit: 1.12 }, b);
  assert.equal(big.ok, false); assert.match(big.error, /3 % av saldot/, "quantity kringgår inte 1–3 %");
  assert.ok((await listPendingOrders()).length >= 2);
  console.log("PASS: M3 SÄLJ stänger öppen lång (closeDealId), Sälj allt utan position avvisas, SÄLJ utan position = kort; quantity spärras av budgeten");
}

// ── M4: get_all_positions läser bara turens miljö ──
{
  let liveTouched = 0;
  const demo = new IgBroker("demo", { status, connect: (async () => ({})) as never, accounts: (async () => ({ status: "ready" })) as never, market: market as never,
    positions: (async () => ({ status: "ready", positions: [] })) as never, enabled: () => false, now: () => NOW, observe: () => {} });
  const live = new IgBroker("live", { status, connect: (async () => { liveTouched++; return {}; }) as never, accounts: (async () => { liveTouched++; return { status: "ready" }; }) as never,
    positions: (async () => { liveTouched++; return { status: "ready", positions: [] }; }) as never, market: market as never, enabled: () => false, now: () => NOW, observe: () => {} });
  const out: any = await TOOLS.get_all_positions!.handler({}, { broker: demo, brokers: { "ig-demo": demo, ig: live } } as never);
  assert.equal(liveTouched, 0, "IG Live rörs aldrig under en Demo-tur"); assert.equal(out.brokers.length, 1);
  const acc: any = await TOOLS.get_account!.handler({}, { broker: demo } as never);
  assert.equal(acc.currency, "SEK"); assert.equal("totalValueUsdt" in acc, false, "SEK märks aldrig som USDT");
  console.log("PASS: M4 verktygen läser bara turens IG-miljö; konto i SEK, inte USDT");
}

// ── B3/M5: sen analys efter kontobyte stoppas ──
{
  let env: "demo" | "live" = "demo"; let g = "a";
  configureIgTurnGuard({ activeEnv: () => env, generation: () => g });
  const turn = beginIgTurn("demo");
  assert.equal(igTurnStale(turn), null);
  env = "live";
  assert.match(igTurnStale(turn)!, /byttes från IG Demo till IG Live/);
  const demo = new IgBroker("demo", { status, connect: (async () => ({})) as never, market: market as never, enabled: () => false, now: () => NOW, observe: () => {} });
  const res: any = await TOOLS.place_order!.handler({ symbol: EPIC, side: "BUY", type: "MARKET", reasoning: "test" }, { broker: demo, config: { executionMode: "approve" } } as never);
  assert.equal(res.accepted, false); assert.match(res.reason, /stoppades/, "inget förslag köas på det nya kontot");
  env = "demo"; g = "b";
  assert.match(igTurnStale(turn)!, /byggdes om/);
  endIgTurn(turn);
  console.log("PASS: B3 sen analys efter konto-/sessionsbyte stoppas (inga förslag köas)");
}

// ── M5: movers binder miljön (explicit env läser bara den miljöns ljus) ──
{
  const { getCategory } = await import("../src/server/movers.js");
  const dir = (async (e: string, cat: string) => ({ markets: cat === "forex" ? [{ epic: EPIC, name: `EUR/USD ${e}`, bid: 1, offer: 1.1 }] : [] })) as never;
  const live = await getCategory("move", 5, 5, { dir, env: "live" });
  assert.equal(live[0]!.base, "EUR/USD live");
  console.log("PASS: M5 Marknaden just nu läser den miljö begäran startade i");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("Granskning 1: alla tester godkända (endast mocks, inga nätverksanrop)");
process.exit(0);
