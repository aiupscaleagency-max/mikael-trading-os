// Port-tester (Bybit → IG): bara fixtures och mockade beroenden. Inga nätverksanrop till IG/Vercel/Tiingo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-port-"));
process.env.TRADING_DATA_DIR = tmp;
delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO; delete process.env.IG_ORDER_EXECUTION_ENABLED_LIVE;
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;

const { IgBroker, IgExecutionOffError, IG_EXECUTION_OFF } = await import("../src/brokers/ig.js");
const { igOrderExecutionEnabled } = await import("../src/integrations/igConnection.js");
const { createIgMarketData } = await import("../src/server/igMarketData.js");
const { getResults, parseIgMoney } = await import("../src/server/results.js");
const { closeIgAtExpiry } = await import("../src/server/tradeHorizon.js");
const { getCategory } = await import("../src/server/movers.js");
const { pairOf } = await import("../src/server/strategyRunner.js");

const NOW = 1_760_000_000_000;
const env = (e: "demo" | "live", currency = "SEK") => ({ status: "connected", credentialsComplete: true, connectionGeneration: `${e}-1`, error: null,
  account: { currency, balance: 10_000, available: 8_000, profitLoss: 12.5 } });
const status = () => ({ environments: { demo: env("demo"), live: env("live") } }) as never;
const EPIC = "CS.D.EURUSD.MINI.IP";
const market = async (_e: string, epic: string) => ({
  epic, name: "EUR/USD Mini", category: "forex",
  quote: { bid: 1.1, offer: 1.1002, percentageChange: 0.25, observedAt: NOW - 1000 },
  calculationRules: { verified: true, pointValue: 10, profitPointValue: 10, marginRate: 0.0333, pointCurrency: "SEK", executionCurrency: "SEK", note: "fixture" },
  dealingRules: { minDealSize: { value: 0.1 }, minNormalStopOrLimitDistance: { unit: "POINTS", value: 2 } },
  instrument: { unit: "CONTRACTS", contractSize: 10_000, scalingFactor: 10_000 },
});
function broker(e: "demo" | "live", over: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const b = new IgBroker(e, {
    status, connect: (async () => ({})) as never, accounts: (async () => ({ status: "ready" })) as never,
    positions: (async () => ({ status: "ready", positions: [
      { dealId: "D1", epic: EPIC, direction: "BUY", size: 2, level: 1.0990, currency: "SEK", bid: 1.1, offer: 1.1002, stopLevel: 1.09, limitLevel: 1.11 },
      { dealId: "D2", epic: EPIC, direction: "SELL", size: 1, level: 1.1010, currency: "SEK", bid: 1.1, offer: 1.1002 },
    ] })) as never,
    market: market as never,
    candles: (async (_e: string, _epic: string, tf: string, limit: number) => { calls.push(["candles", { tf, limit }]); return { candles: [{ openTime: 0, closeTime: 60_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7 }] }; }) as never,
    preview: (async (en: string, input: unknown) => { calls.push(["preview", { en, input }]); return { id: "draft-1", entry: 1.1, margin: 36 }; }) as never,
    confirm: (async (en: string, id: string) => { calls.push(["confirm", { en, id }]); return { status: "accepted", dealId: "NEW1", dealReference: "REF1" }; }) as never,
    close: (async (en: string, dealId: string) => { calls.push(["close", { en, dealId }]); return { status: "closed", dealReference: "CREF" }; }) as never,
    enabled: () => false, now: () => NOW, ...over,
  });
  return { b, calls };
}

// 1. Adapter: namn, konto i kontovaluta, positioner (lång + kort), ticker, ljus
{
  const { b, calls } = broker("demo");
  assert.equal(b.name, "ig-demo"); assert.equal(b.mode, "paper");
  assert.equal(new IgBroker("live").name, "ig");
  const a = await b.getAccount();
  assert.equal(a.currency, "SEK"); assert.equal(a.balance, 10_000); assert.equal(a.available, 8_000);
  const ps = await b.getPositions();
  assert.equal(ps.length, 2);
  const [long, short] = ps as any[];
  assert.equal(long.dealId, "D1"); assert.equal(long.direction, "BUY"); assert.equal(long.name, "EUR/USD Mini");
  assert.ok(Math.abs(long.unrealizedPnlUsdt - (1.1 - 1.099) * 2 * 10) < 1e-9, "lång P/L = (bid − level) × size × punktvärde");
  assert.equal(long.stopLevel, 1.09); assert.equal(long.limitLevel, 1.11); assert.equal(long.pnlVerified, true);
  assert.equal(short.direction, "SELL");
  assert.ok(Math.abs(short.unrealizedPnlUsdt - (1.101 - 1.1002) * 1 * 10) < 1e-9, "kort P/L = (level − offer) × size × punktvärde");
  const t = await b.getTicker(EPIC);
  assert.ok(Math.abs(t.price - 1.1001) < 1e-12); assert.equal(t.changePct24h, 0.25);
  const k = await b.getKlines(EPIC, "5m", 5000);
  assert.equal(k[0]!.close, 1.5); assert.deepEqual(calls.find((c) => c[0] === "candles")![1], { tf: "5m", limit: 200 });
  await assert.rejects(b.getTicker("BTCUSDT"), /ingen IG-EPIC/, "påhittade/Bybit-symboler avvisas");
  console.log("PASS: IG-adapter: ig/ig-demo, SEK-konto, långa/korta positioner med P/L, ticker, ljus (≤200), fel EPIC avvisas");
}

// 2. Orderläget AV: inget skickas (placeOrder, closePosition, horisont)
{
  assert.equal(igOrderExecutionEnabled("demo"), false); assert.equal(igOrderExecutionEnabled("live"), false);
  const { b, calls } = broker("demo");
  await assert.rejects(b.placeOrder({ symbol: EPIC, side: "SELL", type: "MARKET", stakeAmount: 100 }), (e: unknown) => e instanceof IgExecutionOffError && String((e as Error).message).startsWith(IG_EXECUTION_OFF));
  await assert.rejects(b.closePosition("D1"), IgExecutionOffError);
  const before = calls.length;
  await closeIgAtExpiry({ id: "x1", broker: "ig-demo", symbol: EPIC, qty: 1, live: false, exitAt: NOW, dealId: "D1" } as never, b);
  assert.equal(calls.filter((c) => ["preview", "confirm", "close"].includes(c[0])).length, 0, "Orderläget av: inget preview/confirm/close");
  assert.equal(calls.length, before);
  console.log("PASS: orderläget av (standard i båda miljöerna): placeOrder/stängning/horisont skickar ingenting");
}

// 3. KORT (SÄLJ) öppnas och stängs via dealId; horisonten stänger IG-positionen
{
  const { b, calls } = broker("demo", { enabled: () => true });
  const r = await b.placeOrder({ symbol: EPIC, side: "SELL", type: "MARKET", stakeAmount: 100 });
  const pv = calls.find((c) => c[0] === "preview")![1] as any;
  assert.equal(pv.en, "demo"); assert.equal(pv.input.direction, "SELL"); assert.equal(pv.input.epic, EPIC);
  assert.ok(pv.input.stopLevel > 1.1 && pv.input.targetLevel < 1.1, "kort: SL över, TP under priset");
  assert.ok(pv.input.size >= 0.1, "storlek från IG-regler (minst minDealSize)");
  assert.equal(r.dealId, "NEW1"); assert.equal(calls.filter((c) => c[0] === "confirm").length, 1);
  await b.placeOrder({ symbol: EPIC, side: "BUY", type: "MARKET", closeDealId: "NEW1" });
  assert.deepEqual(calls.filter((c) => c[0] === "close").map((c) => c[1]), [{ en: "demo", dealId: "NEW1" }]);
  await closeIgAtExpiry({ id: "x2", broker: "ig-demo", symbol: EPIC, qty: 1, live: false, exitAt: NOW, dealId: "D2" } as never, b);
  assert.deepEqual(calls.filter((c) => c[0] === "close").map((c) => (c[1] as any).dealId), ["NEW1", "D2"], "horisont stänger med IG close");
  await closeIgAtExpiry({ id: "x3", broker: "ig-demo", symbol: EPIC, qty: 1, live: false, exitAt: NOW, dealId: "GONE" } as never, b);
  assert.equal(calls.filter((c) => c[0] === "close").length, 2, "redan stängd position stängs inte igen");
  const { b: u } = broker("demo", { enabled: () => true, confirm: (async () => ({ status: "unknown", error: "timeout" })) as never });
  await assert.rejects(u.placeOrder({ symbol: EPIC, side: "BUY", type: "MARKET", stakeAmount: 100 }), /INTE om/);
  console.log("PASS: KORT öppnas (SÄLJ) och stängs med dealId, horisonten stänger IG-positionen, okänt utfall skickas inte om");
}

// 4. Pengar: storlek/marginal/SL/TP i kontovalutan, och för liten insats förklaras
{
  const { b } = broker("demo");
  const q = await b.stakeQuote({ epic: EPIC, direction: "BUY", stake: 100, stopLoss: 1.0970, takeProfit: 1.1060 });
  assert.equal(q.ok, true); assert.equal(q.currency, "SEK"); assert.equal(q.unit, "CONTRACTS"); assert.equal(q.contractSize, 10_000);
  assert.ok(q.margin! <= 100 && q.margin! > 0); assert.ok(q.moneyAtSl! > 0 && q.moneyAtTp! > 0);
  const small = await b.stakeQuote({ epic: EPIC, direction: "BUY", stake: 0.01 });
  assert.equal(small.ok, false); assert.match(small.reason!, /Minsta IG-kontrakt/);
  console.log("PASS: insats → storlek, marginal, exponering, pengar vid SL/TP i SEK; minsta kontrakt över budget förklaras");
}

// 5. Marknadsdata: historikfel behåller namn/kvot, inga ljus hittas på, inga nya tidsstämplar; Demo/Live separat
{
  const stream = { events: new EventEmitter(), summary: () => ({ status: "DISCONNECTED" }), ensure: () => {} };
  let marketCalls = 0;
  const md = createIgMarketData({
    status, now: () => NOW, stream: stream as never, file: (e) => path.join(tmp, `wl-${e}.json`),
    candles: (async () => { throw new Error("400 error.public-api.exceeded-account-historical-data-allowance"); }) as never,
    market: (async (_e: string, epic: string) => { marketCalls++; return { epic, name: "Bitcoin", category: "crypto", quote: { bid: 100, offer: 101, observedAt: NOW - 5_000, delayTime: 0, marketStatus: "TRADEABLE" } }; }) as never,
  });
  await md.refreshHistory("demo", "CS.D.BITCOIN.CFD.IP", "5m");
  assert.equal(md.closed("CS.D.BITCOIN.CFD.IP", "5m", "demo").length, 0, "inga påhittade ljus");
  assert.match(md.historyError("CS.D.BITCOIN.CFD.IP", "5m", "demo")!, /historik saknas/);
  assert.equal(md.nameOf("CS.D.BITCOIN.CFD.IP", "demo"), "Bitcoin");
  const q = md.quote("CS.D.BITCOIN.CFD.IP", "demo")!;
  assert.equal(q.mid, 100.5); assert.equal(q.observedAt, NOW - 5_000, "tidsstämpeln är IG:s, inte uppfräschad");
  md.setRestQuote("demo", "CS.D.BITCOIN.CFD.IP", { bid: 1, offer: 2, observedAt: NOW - 60_000 });
  assert.equal(md.quote("CS.D.BITCOIN.CFD.IP", "demo")!.mid, 100.5, "äldre kvot ersätter aldrig nyare");
  assert.equal(md.quote("CS.D.BITCOIN.CFD.IP", "live"), null, "Demo-kvot syns aldrig i Live");
  assert.equal(md.nameOf("CS.D.BITCOIN.CFD.IP", "live"), null);
  await assert.rejects(md.addWatch("BTCUSDT; DROP"), /Ogiltig IG-EPIC/);
  assert.ok(marketCalls >= 1);
  const wrong = createIgMarketData({ status, now: () => NOW, stream: stream as never, file: (e) => path.join(tmp, `wl2-${e}.json`),
    market: (async () => ({ epic: "CS.D.OTHER.CFD.IP", name: "Annat", quote: {} })) as never });
  await assert.rejects(wrong.addWatch("CS.D.BITCOIN.CFD.IP", "demo"), /fel instrument/, "IG-svar för fel EPIC avvisas");
  console.log("PASS: historikfel (400) behåller namn/kvot med varning, inga ljus/tidsstämplar hittas på, Demo/Live blandas aldrig, fel EPIC avvisas");
}

// 6. Resultat: IG-historik + positioner per miljö, P/L i kontovalutan
{
  assert.equal(parseIgMoney("SEK12.50"), 12.5); assert.equal(parseIgMoney("SEK-3,20"), -3.2); assert.equal(parseIgMoney("-kr3.20"), -3.2); assert.equal(parseIgMoney("x"), null);
  const { b: demo } = broker("demo"); const { b: live } = broker("live");
  const seen: string[] = [];
  const history = (async (e: string) => { seen.push(e); return { status: "ready", transactions: e === "demo"
    ? [{ type: "DEAL", date: "2026-10-08T10:00:00", instrumentName: "EUR/USD Mini", size: "-1", openLevel: "1.1010", closeLevel: "1.1000", profitAndLoss: "SEK10.00", reference: "R1" },
       { type: "DEAL", date: "2026-10-08T11:00:00", instrumentName: "EUR/USD Mini", size: "+1", openLevel: "1.1000", closeLevel: "1.0990", profitAndLoss: "SEK-10.00", reference: "R2" },
       { type: "DEPO", cashTransaction: true, profitAndLoss: "SEK1000" }]
    : [] }; }) as never;
  const rd = await getResults({ "ig-demo": demo, ig: live }, "TEST", [], { history });
  assert.equal(rd.env, "demo"); assert.equal(rd.currency, "SEK"); assert.equal(rd.totals.trades, 2); assert.equal(rd.totals.wins, 1);
  assert.equal(rd.trades.find((t) => t.reference === "R1")!.side, "SELL", "kort affär visas som SÄLJ");
  assert.equal(rd.open.length, 2); assert.equal(rd.open[0]!.dealId, "D1");
  const rl = await getResults({ "ig-demo": demo, ig: live }, "LIVE", [], { history });
  assert.equal(rl.env, "live"); assert.equal(rl.totals.trades, 0, "Demo-affärer syns aldrig i Live");
  assert.deepEqual(seen, ["demo", "live"]);
  assert.ok(fs.existsSync(path.join(tmp, "ig-closed-demo.json")), "Demo-affärer sparas för tradingminnet i TRADING_DATA_DIR");
  console.log("PASS: resultat från IG-historik/positioner, Demo och Live separata, P/L i SEK");
}

// 7. Rörelse/kategorier: saknade värden visas som saknade, volym finns inte hos IG
{
  const dir = (async (_e: string, cat: string) => ({ status: "ready", markets: cat === "forex"
    ? [{ epic: "A.B.C", name: "EUR/USD", bid: 1, offer: 1.01, changePercent: 0.5, high: 1.02, low: 0.99 }, { epic: "A.B.D", name: "GBP/USD", bid: null, offer: null, changePercent: null }]
    : [{ epic: "C.D.E", name: "Bitcoin", bid: 100, offer: 101, changePercent: -2, high: 110, low: 90 }] })) as never;
  const g = await getCategory("gainers", 5, 10, { dir, env: "demo" });
  assert.deepEqual(g.map((m) => m.epic), ["A.B.C", "C.D.E"], "utan IG-förändring tas instrumentet inte med i upp/ner");
  const v = await getCategory("volume", 5, 10, { dir, env: "demo" });
  assert.equal(v.length, 0); assert.match(v.note!, /ingen handelsvolym/);
  const cheap = await getCategory("cheapest", 5, 10, { dir, env: "demo" });
  assert.equal(cheap[cheap.length - 1]!.price, null, "saknat pris sist och som null");
  console.log("PASS: Marknaden just nu från IG-katalogen; saknade värden = null, ingen påhittad volym");
}

// 8. Strategier: kortnamn blir aldrig en påhittad EPIC
{
  assert.equal(pairOf("BTC"), null, "BTC utan verifierad EPIC i bevakningslistan → ingen EPIC");
  assert.equal(pairOf("CS.D.BITCOIN.CFD.IP"), "CS.D.BITCOIN.CFD.IP");
  console.log("PASS: strategins kortnamn översätts bara till verifierade EPICs");
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log("IG-port: alla tester godkända (endast mocks, inga nätverksanrop)");
process.exit(0);
