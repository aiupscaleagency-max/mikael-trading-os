import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const original = process.cwd();
const temp = mkdtempSync(path.join(tmpdir(), "paper-lots-"));
process.chdir(temp);
try {
  const { BybitPaperBroker } = await import("../src/brokers/bybitPaper.js");
  mkdirSync("data");
  writeFileSync("data/bybit-paper.json", JSON.stringify({usdc:8093,holdings:{},open:[],fills:[]}));
  const broker = new BybitPaperBroker();
  assert.equal(broker.snapshot().usdc, 998093);
  assert.equal(new BybitPaperBroker().snapshot().usdc, 998093);

  // Injicera fasta priser: testet får aldrig nå nätverket.
  const mock = broker as unknown as { book: () => Promise<{bid: number; ask: number}> };
  mock.book = async () => ({ bid: 100, ask: 100 });
  const a = await broker.placeOrder({ symbol: "BTCUSDC", side: "BUY", type: "MARKET", quantity: 1 });
  const b = await broker.placeOrder({ symbol: "BTCUSDC", side: "BUY", type: "MARKET", quantity: 2 });
  await broker.cancelOrder("BTCUSDC", a.orderId);
  await broker.placeTimedExitOrder({ symbol: "BTCUSDC", side: "SELL", type: "MARKET", quantity: 2 }, b.orderId);
  assert.equal(await broker.getTimedExitQuantity("BTCUSDC", a.orderId), 1);
  assert.equal(await broker.getTimedExitQuantity("BTCUSDC", b.orderId), 0);
  await broker.placeOrder({ symbol: "BTCUSDC", side: "SELL", type: "MARKET", quantity: .5 });
  assert.equal(await broker.getTimedExitQuantity("BTCUSDC", a.orderId), .5);
  const restored = new BybitPaperBroker();
  assert.equal(await restored.getTimedExitQuantity("BTCUSDC", a.orderId), .5);
  assert.equal(await restored.getTimedExitQuantity("BTCUSDC", b.orderId), 0);
  assert.ok(broker.snapshot().feeRate > 0);
  console.log("PASS: separat lottförsäljning, manuell delstängning, omstart och avgiftssnapshot");
} finally { process.chdir(original); rmSync(temp, { recursive: true }); }
