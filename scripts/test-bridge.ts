// Bron till Grok-boxen (src/server/bridgeRoutes.ts).
// Låtsade IG-mäklare och egen datamapp. Inga nätverksanrop mot IG, ingen bot, inga order.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
process.env.TRADING_DATA_DIR = path.join(tmp, "data");
process.env.TRADING_MEMORY_OFF = "true";
const READ = "r".repeat(40), WRITE = "w".repeat(40);
process.env.BRIDGE_READ_TOKEN = READ;
process.env.BRIDGE_WRITE_TOKEN = WRITE;
delete process.env.BRIDGE_TICKET_TTL_MIN;

const { IgBroker } = await import("../src/brokers/ig.js");
const { createBridgeHandler, _resetBridgeForTests } = await import("../src/server/bridgeRoutes.js");
const { addPendingOrder, listPendingOrders } = await import("../src/server/orderGate.js");

const ok = (m: string) => console.log(`  ✓ ${m}`);

// ── Låtsade IG-mäklare (instanceof IgBroker, utan riktiga anrop) ────────────
const calls = { account: 0, positions: 0, connectTries: 0 };
function fakeIg(env: "demo" | "live", connected: boolean) {
  const b = Object.create(IgBroker.prototype) as InstanceType<typeof IgBroker>;
  Object.assign(b, {
    env, name: env === "live" ? "ig" : "ig-demo", mode: env === "live" ? "live" : "paper",
    status: () => ({ status: connected ? "connected" : "disconnected", account: { currency: "SEK", accountType: "CFD" } }),
    executionEnabled: () => false,
    ensureConnected: async () => { calls.connectTries++; throw new Error("ska inte anropas"); },
    getAccount: async () => { calls.account++; return { balances: [], totalValueUsdt: 1000, updatedAt: 1, currency: "SEK", balance: 1000, available: 900, profitLoss: 5 }; },
    getPositions: async () => { calls.positions++; return [{ symbol: "IX.D.DAX.IFD.IP", baseAsset: "DAX", quoteAsset: "SEK", quantity: 1, avgEntryPrice: 100, currentPrice: 101, unrealizedPnlUsdt: 10, openedAt: 0, dealId: "D1", direction: "BUY", name: "DAX", pnlCurrency: "SEK", pnlVerified: true, stopLevel: 90, limitLevel: 120 }]; },
    lastKnownPositions: () => null,
  });
  return b;
}
const brokers = { "ig-demo": fakeIg("demo", true), ig: fakeIg("live", false) };

// createPending: lägger bara i kön (samma som createIgPendingOrder gör när grinden släpper igenom)
const seen: Record<string, unknown>[] = [];
const createPending = async (b: Record<string, unknown>, broker: InstanceType<typeof IgBroker>) => {
  seen.push(b);
  if (b.symbol === "NEKAS.X") return { ok: false as const, error: "Ordergrinden stoppade", status: 409 };
  const common = { source: String(b.source), venue: `broker:${broker.name}`, live: broker.mode === "live", symbol: String(b.symbol), side: (b.side === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL" };
  // Som M3 i createIgPendingOrder: motsatt riktning stänger, en köpost per position, orsaken efter "·"
  if (b.symbol === "STANG.X") {
    const first = await addPendingOrder({ ...common, closeDealId: "D7", reason: `Stänger lång position 1 (D7) · ${String(b.reason).slice(0, 120)}` });
    await addPendingOrder({ ...common, closeDealId: "D8", reason: `Stänger lång position 2 (D8) · ${String(b.reason).slice(0, 120)}` });
    return { ok: true as const, pendingOrder: first, quote: null };
  }
  const p = await addPendingOrder({ ...common, reason: String(b.reason ?? ""), ...(b.horizonSec ? { horizonSec: Number(b.horizonSec) } : {}) });
  return { ok: true as const, pendingOrder: p, quote: null };
};
const journalRows: Record<string, unknown>[] = [];
const journal = {
  read: async () => journalRows as never,
  write: async (r: Record<string, unknown>) => { journalRows.push(r); },
};
const broadcasts: string[] = [];

_resetBridgeForTests();
const server = http.createServer(createBridgeHandler({ brokers, createPending: createPending as never, broadcast: (e) => broadcasts.push(e), journal: journal as never }));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, p: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() as any };
}

try {
  // 1. Hälsa utan token
  assert.equal((await call("GET", "/bridge/v1/health")).status, 200);
  ok("health svarar utan token");

  // 2. Läsning kräver läs-token, skriv-token räcker inte
  assert.equal((await call("GET", "/bridge/v1/positions?env=demo")).status, 401);
  assert.equal((await call("GET", "/bridge/v1/positions?env=demo", WRITE)).status, 401);
  assert.equal((await call("GET", "/bridge/v1/positions?env=demo", "fel")).status, 401);
  const pos = await call("GET", "/bridge/v1/positions?env=demo", READ);
  assert.equal(pos.status, 200);
  assert.equal(pos.json.positions[0].dealId, "D1");
  assert.equal(pos.json.positions[0].upnl, 10);
  ok("positioner: bara läs-token släpps in");

  // 3. Cache: två läsningar = ett anrop mot mäklaren
  await call("GET", "/bridge/v1/positions?env=demo", READ);
  assert.equal(calls.positions, 1);
  const acc = await call("GET", "/bridge/v1/account?env=demo", READ);
  assert.equal(acc.json.account.balance, 1000);
  await call("GET", "/bridge/v1/account?env=demo", READ);
  assert.equal(calls.account, 1);
  ok("läsningar cachas (IG:s läsbudget skyddas)");

  // 4. Live inte ansluten → 503 utan att bron försöker logga in
  const live = await call("GET", "/bridge/v1/account?env=live", READ);
  assert.equal(live.status, 503);
  assert.equal(live.json.connected, false);
  assert.equal(calls.connectTries, 0);
  const lst = await call("GET", "/bridge/v1/status?env=live", READ);
  assert.equal(lst.json.connected, false);
  assert.equal((await call("GET", "/bridge/v1/account", READ)).status, 400);
  ok("Live: läses bara när Trading-OS redan är anslutet, ingen egen inloggning");

  // 5. Biljett kräver skriv-token
  const t = { ticketId: "alessio-0001", env: "demo", agent: "alessio", symbol: "IX.D.DAX.IFD.IP", side: "BUY", takeProfit: 120, stopLoss: 90, reason: "Test", forceOpen: true, sellAll: true, quantity: 99, strategyId: "x", source: "dashboard", live: true };
  assert.equal((await call("POST", "/bridge/v1/tickets", READ, t)).status, 401);
  assert.equal((await call("POST", "/bridge/v1/tickets", undefined, t)).status, 401);
  const r1 = await call("POST", "/bridge/v1/tickets", WRITE, t);
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  assert.equal(r1.json.pendingOrder.status, "pending");
  assert.equal(r1.json.pendingOrder.env, "demo");
  ok("biljett med skriv-token → status pending i Godkänn-kön");

  // 6. Vitlistan: farliga fält följer aldrig med, källan sätts av bron
  const sent = seen[0]!;
  for (const k of ["forceOpen", "sellAll", "quantity", "strategyId", "live"]) assert.equal(k in sent, false, `${k} fick följa med`);
  assert.equal(sent.source, "grok:alessio");
  assert.match(String(sent.reason), /^\[Biljett alessio-0001 från alessio\] Test$/);
  ok("forceOpen/sellAll/quantity/strategyId tas bort, källa = grok:<agent>");

  // 7. Bäst-före sätts
  const queued = (await listPendingOrders()).find((o) => o.id === r1.json.pendingOrder.id)!;
  const ttl = Date.parse(queued.expiresAt!) - Date.now();
  assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000, `ttl ${ttl}`);
  assert.ok(broadcasts.includes("pending-orders"));
  ok("biljetten går ut efter 15 min om den inte godkänts");

  // 8. Idempotens: samma ticketId en gång till ger ingen ny order
  const r2 = await call("POST", "/bridge/v1/tickets", WRITE, t);
  assert.equal(r2.json.duplicate, true);
  assert.equal((await listPendingOrders()).length, 1);
  ok("samma ticketId två gånger = en order i kön");

  // 9. Nekad av grinden registreras som rejected
  const r3 = await call("POST", "/bridge/v1/tickets", WRITE, { ...t, ticketId: "alessio-0002", symbol: "NEKAS.X" });
  assert.equal(r3.status, 409);
  assert.equal(r3.json.ticket.status, "rejected");
  const tl = await call("GET", "/bridge/v1/tickets", READ);
  assert.equal(tl.json.tickets.length, 2);
  assert.equal(tl.json.tickets.find((x: any) => x.ticketId === "alessio-0001").orderStatus, "pending");
  ok("grindens nej följer med till boxen");

  // 10. Felaktiga biljetter
  assert.equal((await call("POST", "/bridge/v1/tickets", WRITE, { ...t, ticketId: "x" })).status, 400);
  assert.equal((await call("POST", "/bridge/v1/tickets", WRITE, { ...t, ticketId: "alessio-0003", env: "ig" })).status, 400);
  assert.equal((await call("POST", "/bridge/v1/tickets", WRITE, { ...t, ticketId: "alessio-0004", agent: "a b" })).status, 400);
  ok("ogiltig ticketId/env/agent nekas");

  // 11. Ingen väg till Godkänn eller resten av API:t
  const id = r1.json.pendingOrder.id;
  for (const tok of [READ, WRITE]) {
    for (const [m, p] of [["POST", `/api/pending-orders/${id}/approve`], ["POST", `/bridge/v1/pending/${id}/approve`], ["POST", "/api/active-broker"], ["GET", "/api/pending-orders"], ["GET", "/"], ["POST", "/bridge/v1/pending"], ["GET", "/bridge/v1/../../api/pending-orders"]] as const) {
      const r = await call(m, p, tok, m === "POST" ? {} : undefined);
      assert.equal(r.status, 404, `${m} ${p} gav ${r.status}`);
    }
  }
  assert.equal((await listPendingOrders()).find((o) => o.id === id)!.status, "pending");
  ok("ingen token når Godkänn, aktiv mäklare eller dashboardens API");

  // 12. Webbläsare nekas
  assert.equal((await call("GET", "/bridge/v1/pending", READ, undefined, { Origin: "https://evil.example" })).status, 403);
  ok("anrop med Origin (webbläsare) nekas");

  // 13. Journalen: skriv med skriv-token, märkt Grok
  assert.equal((await call("POST", "/bridge/v1/journal", READ, { typ: "lardom", agent: "alessio", titel: "x" })).status, 401);
  const j = await call("POST", "/bridge/v1/journal", WRITE, { typ: "lardom", agent: "alessio", titel: "DAX: vänta på 15-min-stängning", text: "rad1\nrad2 {json}", konto: "ig-live" });
  assert.equal(j.status, 201);
  assert.equal(journalRows[0]!.agent, "grok-alessio");
  assert.equal(journalRows[0]!.titel, "[Grok] DAX: vänta på 15-min-stängning");
  assert.equal(journalRows[0]!.text, "rad1 rad2 json");
  assert.equal(journalRows[0]!.konto, "ig-live");
  assert.equal((await call("POST", "/bridge/v1/journal", WRITE, { typ: "avvisad", agent: "alessio", titel: "x" })).status, 400);
  const jr = await call("GET", "/bridge/v1/journal?typ=lardom", READ);
  assert.equal(jr.json.rows.length, 1);
  ok("journalen: Grok-rader märks [Grok], radbrytningar/klamrar tas bort");

  // 14. Samma token för läsa och skriva = allt nekas
  process.env.BRIDGE_WRITE_TOKEN = READ;
  assert.equal((await call("GET", "/bridge/v1/pending", READ)).status, 401);
  assert.equal((await call("POST", "/bridge/v1/tickets", READ, { ...t, ticketId: "alessio-0009" })).status, 401);
  process.env.BRIDGE_WRITE_TOKEN = "kort";
  assert.equal((await call("POST", "/bridge/v1/tickets", "kort", { ...t, ticketId: "alessio-0010" })).status, 401);
  process.env.BRIDGE_WRITE_TOKEN = WRITE;
  ok("samma eller för kort token = nekas (fail-closed)");

  // 15. Godkänn-kön syns för boxen
  const pend = await call("GET", "/bridge/v1/pending", READ);
  assert.equal(pend.json.pending.length, 1);
  assert.equal(pend.json.pending[0].source, "grok:alessio");
  ok("väntande godkännanden kan läsas");

  // 16. Lång tidshorisont får inte förlänga bäst-före (addPendingOrder sätter annars upp till 30 dagar)
  const hz = await call("POST", "/bridge/v1/tickets", WRITE, { ...t, ticketId: "alessio-0020", horizonSec: 30 * 86400 });
  assert.equal(hz.status, 201);
  const hzOrder = (await listPendingOrders()).find((o) => o.id === hz.json.pendingOrder.id)!;
  assert.ok(Date.parse(hzOrder.expiresAt!) - Date.now() <= 15 * 60_000, "bäst-före längre än 15 min");
  ok("lång tidshorisont: biljetten går ändå ut efter 15 min");

  // 17. Stängning av flera positioner: alla köposter får bäst-före och sparas på biljetten
  const cl = await call("POST", "/bridge/v1/tickets", WRITE, { ...t, ticketId: "alessio-0021", symbol: "STANG.X", side: "SELL" });
  assert.equal(cl.status, 201);
  const clIds: string[] = cl.json.ticket.pendingOrderIds;
  assert.equal(clIds.length, 2);
  for (const o of (await listPendingOrders()).filter((x) => clIds.includes(x.id))) {
    assert.ok(o.expiresAt && Date.parse(o.expiresAt) - Date.now() <= 15 * 60_000, `${o.id} saknar bäst-före`);
  }
  ok("stängning som blir flera köposter: alla går ut efter 15 min");

  // 18. Biljett mot Live som inte är anslutet: ingen inloggning, ingen köpost
  const before = (await listPendingOrders()).length, seenBefore = seen.length;
  const lt = await call("POST", "/bridge/v1/tickets", WRITE, { ...t, ticketId: "alessio-0022", env: "live" });
  assert.equal(lt.status, 503);
  assert.equal(calls.connectTries, 0);
  assert.equal(seen.length, seenBefore);
  assert.equal((await listPendingOrders()).length, before);
  ok("biljett mot ej anslutet Live: nekas utan att Trading-OS loggar in");

  console.log("Bron: alla tester gick igenom");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
