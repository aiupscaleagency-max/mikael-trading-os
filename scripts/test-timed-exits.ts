import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Testet använder isolerade filer och låtsasmäklare: inga nätverksanrop eller riktiga ordrar.
const original = process.cwd();
const temp = mkdtempSync(path.join(tmpdir(), "timed-exit-test-"));
process.chdir(temp);
mkdirSync("data");
writeFileSync("data/live-tpsl.json", JSON.stringify([{ id: "partial-tp", broker: "tpLots", symbol: "AVAXUSDC", qty: .6, entry: 1, takeProfit: 2, openedAt: 0 }]));
const entries = [
  { id: "tp-first", broker: "tpLots", symbol: "AVAXUSDC", qty: 1, baseline: 0, tpslId: "partial-tp" },
  { id: "tp-second", broker: "tpLots", symbol: "AVAXUSDC", qty: 1, baseline: 1 },
  { id: "missing", broker: "missing", symbol: "BTCUSDC", qty: 1, baseline: 0 },
  { id: "partial", broker: "partial", symbol: "ETHUSDC", qty: 2, baseline: 0 },
  { id: "first", broker: "lots", symbol: "SOLUSDC", qty: 1, baseline: 0 },
  { id: "second", broker: "lots", symbol: "SOLUSDC", qty: 1, baseline: 1 },
  { id: "empty", broker: "empty", symbol: "XRPUSDC", qty: 1, baseline: 0 },
  { id: "live-buy", broker: "buy", symbol: "DOTUSDC", qty: 10, baseline: 0, pendingBuyOrderId: "live-buy-order", horizonSec: 60, takeProfit: 3, stopLoss: .5, refPrice: 1 },
  { id: "buy", broker: "buy", symbol: "DOTUSDC", qty: 10, baseline: 0, pendingBuyOrderId: "buy-order", horizonSec: 60 },
  { id: "pending", broker: "pending", symbol: "ADAUSDC", qty: 1, baseline: 0 },
].map((e) => ({ ...e, openedAt: 0, exitAt: 1, live: e.id === "live-buy" }));
writeFileSync("data/timed-exits.json", JSON.stringify(entries));
const { processTimedExits, listTimedExits } = await import("../src/server/tradeHorizon.js");
let lotsBalance = 2;
let tpLotsBalance = 1.6;
let pendingOrders = 0;
let buyFilled = false;
let buySells = 0;
const realNow = Date.now;
let fakeNow = realNow();
Date.now = () => fakeNow;
const result = (qty: number, status = "Filled") => ({ orderId: "mock", status, executedQty: qty, avgFillPrice: 1, cummulativeQuoteQty: qty });
const account = (asset: string, free: number) => ({ balances: [{ asset, free, locked: 0 }], totalValueUsdt: free, updatedAt: Date.now() });
const brokers = {
  tpLots: { getAccount: async () => account("AVAX", tpLotsBalance), placeOrder: async (o: {quantity: number}) => { tpLotsBalance -= o.quantity; return result(o.quantity); } },
  buy: { getAccount: async () => account("DOT", 2), getOrderResult: async () => result(buyFilled ? 2 : 0, buyFilled ? "PartiallyFilledCanceled" : "New"), placeOrder: async (o: {quantity: number}) => { buySells++; return result(o.quantity); } },
  partial: { getAccount: async () => account("ETH", 2), placeOrder: async () => result(.5) },
  lots: { getAccount: async () => account("SOL", lotsBalance), placeOrder: async (o: { quantity: number }) => { lotsBalance -= o.quantity; return result(o.quantity); } },
  empty: { getAccount: async () => account("XRP", 1), placeOrder: async () => result(0, "Rejected") },
  pending: { getAccount: async () => account("ADA", 1), placeOrder: async () => { pendingOrders++; return result(0, "New"); }, getOrderResult: async () => result(1) },
};
try {
  await processTimedExits(brokers as never);
  assert.equal(listTimedExits().find((x) => x.id === "missing")?.status, "retry");
  assert.equal(listTimedExits().find((x) => x.id === "partial")?.remainingQty, 1.5);
  assert.equal(listTimedExits().find((x) => x.id === "empty")?.status, "retry");
  assert.ok(tpLotsBalance < 1e-12, "TP delavslut låser inte nästa lotts baseline");
  assert.equal(lotsBalance, 0, "Båda lotterna stängs trots olika ursprunglig baseline");
  assert.equal(listTimedExits().find((x) => x.id === "pending")?.status, "needs_review");
  await processTimedExits(brokers as never);
  assert.equal(listTimedExits().some((x) => x.id === "pending"), false);
  assert.equal(pendingOrders, 1, "En väntande order skickas aldrig dubbelt");
  assert.equal(buySells, 0, "Väntande LIMIT-köp säljs inte");
  buyFilled = true;
  await processTimedExits(brokers as never);
  assert.equal(listTimedExits().find((x) => x.id === "buy")?.qty, 2, "Endast verifierad fylld qty följs");
  assert.equal(buySells, 0, "Tidshorisonten startar när köpet fylls");
  const { listLiveTpSl } = await import("../src/server/liveTpSl.js");
  const liveExit = listTimedExits().find((x) => x.id === "live-buy");
  const liveWatch = listLiveTpSl().find((w) => w.id === liveExit?.tpslId);
  assert.equal(liveWatch?.qty, 2, "TP/SL aktiveras först med verifierad fylld qty");
  assert.equal(liveWatch?.takeProfit, 3);
  await processTimedExits(brokers as never);
  assert.equal(listLiveTpSl().filter((w) => w.id === liveExit?.tpslId).length, 1, "Ingen dubbel TP/SL bevakning");
  fakeNow += 60_001;
  await processTimedExits(brokers as never);
  assert.equal(buySells, 2);
  for (let i = 0; i < 4; i++) { fakeNow += 300_001; await processTimedExits(brokers as never); }
  assert.ok((listTimedExits().find((x) => x.id === "empty")?.attempts ?? 0) > 3, "Återförsök fortsätter efter tre fel");
  const stored = JSON.parse(readFileSync("data/timed-exits.json", "utf8")) as Array<{ id: string }>;
  assert.ok(stored.some((x) => x.id === "missing"), "Misslyckad stängning finns kvar på disk");
  console.log("PASS: broker saknas, partial fill, noll fill, samtidiga lotter, pending reconciliation och persistens");
} finally {
  Date.now = realNow;
  process.chdir(original);
  rmSync(temp, { recursive: true });
}
