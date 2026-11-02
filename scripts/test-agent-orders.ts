// Agenternas ordrar: Manuell/Automatisk (src/server/agentOrders.ts).
// Egen datamapp, låtsat godkännande. Inga nätverksanrop mot IG, ingen bot, inga order.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orders-test-"));
process.env.TRADING_DATA_DIR = path.join(tmp, "data");
process.env.TRADING_MEMORY_OFF = "true";

const ao = await import("../src/server/agentOrders.js");
const { addPendingOrder } = await import("../src/server/orderGate.js");
const ok = (m: string) => console.log(`  ✓ ${m}`);

// Standard = Manuell, även utan fil
await ao.restoreAgentOrdersMode();
assert.equal(ao.getAgentOrdersMode(), "manual");
ok("utan sparat val: Manuell");

// Live kan aldrig sättas till Automatisk
const live = await ao.setAgentOrdersMode("auto", "live");
assert.equal(live.ok, false);
assert.equal(ao.getAgentOrdersMode(), "manual");
ok("Automatisk nekas i IG Live, läget oförändrat");

// Demo kan, och valet sparas till nästa start
assert.equal((await ao.setAgentOrdersMode("auto", "demo")).ok, true);
await ao.restoreAgentOrdersMode();
assert.equal(ao.getAgentOrdersMode(), "auto");
ok("Automatisk i Demo sparas och läses tillbaka");

// Bara agentförslag i IG Demo godkänns automatiskt
const base = { status: "pending" as const, live: false, venue: "broker:ig-demo" };
assert.equal(ao.shouldAutoApprove({ ...base, source: "agent:hanna" }), true);
assert.equal(ao.shouldAutoApprove({ ...base, source: "agent:oppningsvakt" }), true);
assert.equal(ao.shouldAutoApprove({ ...base, source: "dashboard" }), false);
assert.equal(ao.shouldAutoApprove({ ...base, source: "chat" }), false);
assert.equal(ao.shouldAutoApprove({ ...base, source: "double-up" }), false);
assert.equal(ao.shouldAutoApprove({ ...base, source: "strategi:ORB" }), false);
assert.equal(ao.shouldAutoApprove({ ...base, source: "agent:hanna", live: true, venue: "broker:ig" }), false);
assert.equal(ao.shouldAutoApprove({ ...base, source: "agent:hanna", venue: "broker:ig" }), false);
ok("bara agentförslag i IG Demo; dina egna knappar, chatten, strategier och Live kräver Godkänn");

// Tips → kö: bara KÖP/SÄLJ med verifierade nivåer, bäst rankade först, dubbletter hoppas över
const approved: string[] = [];
ao.setAgentOrderApprover(async (id) => { approved.push(id); return { ok: true }; });
const created: Array<Record<string, unknown>> = [];
const create = async (b: Record<string, unknown>) => {
  created.push(b);
  const p = await addPendingOrder({ source: String(b.source), venue: "broker:ig-demo", live: false, symbol: String(b.symbol), side: b.side as "BUY" | "SELL", reason: String(b.reason) });
  return { ok: true as const, pendingOrder: p };
};
const tip = (epic: string, rank: number, action: "buy" | "sell" | "hold", extra: Record<string, unknown> = {}) => ({
  epic, rank, action, why: "test", entry: 100, takeProfit: action === "sell" ? 95 : 105, stopLoss: action === "sell" ? 102 : 98,
  sizePct: 1, sizeText: null, horizonMin: 15, confidence: "medium" as const, note: null, ...extra,
});
const q = await ao.queueTipsAsOrders([
  tip("IX.D.SPTRD.IFE.IP", 2, "sell"),
  tip("CS.D.EURUSD.CEE.IP", 1, "buy"),
  tip("CS.D.GBPUSD.CEE.IP", 3, "hold"),
  tip("CS.D.USDJPY.CEE.IP", 4, "buy", { unverifiedLevels: true }),
], "broker:ig-demo", create);
assert.equal(q.queued, 2);
assert.equal(q.auto, 2);
assert.deepEqual(created.map((c) => c.symbol), ["CS.D.EURUSD.CEE.IP", "IX.D.SPTRD.IFE.IP"]);
assert.equal(created[1]!.side, "SELL");
assert.equal(created[0]!.source, "agent:hanna");
assert.equal(created[0]!.horizonSec, 900);
assert.ok(q.skipped.some((s) => s.includes("USDJPY")));
ok("tips → kö: rätt ordning, AVVAKTA och overifierade nivåer hoppas över, Automatisk godkänner");

const again = await ao.queueTipsAsOrders([tip("CS.D.EURUSD.CEE.IP", 1, "buy")], "broker:ig-demo", create);
assert.equal(again.queued, 0);
ok("samma förslag läggs inte två gånger");

// Manuell: inget godkänns automatiskt
await ao.setAgentOrdersMode("manual", "demo");
approved.length = 0;
const m = await ao.queueTipsAsOrders([tip("CS.D.AUDUSD.CEE.IP", 1, "buy")], "broker:ig-demo", create);
assert.equal(m.queued, 1);
assert.equal(m.auto, 0);
assert.equal(approved.length, 0);
ok("Manuell: förslaget väntar på ditt Godkänn");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("agentOrders: alla tester gröna");
