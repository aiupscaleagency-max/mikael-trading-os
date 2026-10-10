// Demo-simulering (Mike 2026-10-10): Live-instrument som saknas på IG Demo övas med Live-pris och låtsaspengar.
// Bara mockad fetch och injicerade beroenden. Inga nätverksanrop mot IG.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-demo-sim-"));
process.env.TRADING_DATA_DIR = tmp;
process.env.AGENT_TREE_TRADING_EVENTS = "off";
delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO; delete process.env.IG_ORDER_EXECUTION_ENABLED_LIVE;
delete process.env.LIVE_TRADING_CONFIRMED;
for (const k of ["IG_MAX_STAKE_PCT", "IG_MAX_TOTAL_MARGIN_PCT", "IG_MAX_DAILY_LOSS_PCT", "IG_MAX_POSITION_MARGIN", "IG_MAX_TOTAL_MARGIN", "IG_MAX_DAILY_LOSS", "STAKE_PCT_START", "STAKE_PCT_MAX"]) delete process.env[k];
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;

const { createIgDemoSim, createDemoSimRouter, isSimDealId, DEMO_SIM_LABEL, demoSimRow } = await import("../src/integrations/igDemoSim.js");
const { createIgConnection } = await import("../src/integrations/igConnection.js");
const { IgBroker } = await import("../src/brokers/ig.js");
const { closeIgAtExpiry } = await import("../src/server/tradeHorizon.js");
const { getResults } = await import("../src/server/results.js");

const ok = (m: string) => console.log("PASS: " + m);
const SIM = "CS.D.BITCOIN.CEEM.IP", FX = "CS.D.EURUSD.MINI.IP";
let NOW = Date.parse("2026-10-09T10:00:00Z");
const now = () => NOW;
// Live-marknaden för Bitcoin ($0.1): 0,95 SEK/punkt vid förlust, 0,93 vid vinst (FX bid/offer), 50 % marginal
let px = { bid: 60_000, offer: 60_010 };
let rules: Record<string, unknown> = { verified: true, pointValue: 0.95, profitPointValue: 0.93, marginRate: 0.5, pointCurrency: "SEK", executionCurrency: "USD", priceScalingFactor: 1, fx: { path: "USD/SEK", baseCurrency: "USD", accountCurrency: "SEK" } };
let quoteOk = true;
const liveMarket = async (epic: string) => ({
  epic, name: "Bitcoin ($0.1)",
  quote: { ...px, receivedAt: quoteOk ? NOW - 500 : NOW - 600_000, observedAt: quoteOk ? NOW - 500 : NOW - 600_000, delayTime: 0, marketStatus: "TRADEABLE" },
  calculationRules: rules,
  dealingRules: { minDealSize: { value: 0.01 }, minNormalStopOrLimitDistance: { unit: "POINTS", value: 10 } },
  instrument: { unit: "CONTRACTS", contractSize: 1, scalingFactor: 1 },
});
let kill = false;
const mkSim = (file: string) => createIgDemoSim({ market: liveMarket as never, guard: async () => ({ killSwitchActive: kill }), now, file, startBalance: 100_000 });

// ══ 1) Fyllnad på bid/offer, P/L-tecken lång/kort, SEK-omräkning ══
{
  const sim = mkSim(path.join(tmp, "u1.json"));
  const long = await sim.open({ epic: SIM, direction: "BUY", size: 0.1, stopLevel: 59_000, targetLevel: 61_500 });
  assert.equal(long.level, 60_010, "KÖP fylls på Live-offer");
  assert.ok(isSimDealId(long.dealId), "simulerat dealId");
  const short = await sim.open({ epic: SIM, direction: "SELL", size: 0.1, stopLevel: 61_000, targetLevel: 59_000 });
  assert.equal(short.level, 60_000, "SÄLJ fylls på Live-bid");
  assert.ok(Math.abs(long.margin - 60_010 * 0.1 * 0.95 * 0.5) < 1e-9, "marginal i SEK = pris × storlek × punktvärde × marginal");
  px = { bid: 60_500, offer: 60_510 }; // uppgång
  const tl = await sim.close(long.dealId, "manuell");
  assert.equal(tl.closeLevel, 60_500, "lång stängs på bid");
  assert.ok(Math.abs(tl.pnl - (60_500 - 60_010) * 0.1 * 0.93) < 1e-9, "lång vinst med vinstpunktvärdet (FX bid)");
  assert.ok(tl.pnl > 0);
  const ts = await sim.close(short.dealId, "manuell");
  assert.equal(ts.closeLevel, 60_510, "kort stängs på offer");
  assert.ok(Math.abs(ts.pnl - -(60_510 - 60_000) * 0.1 * 0.95) < 1e-9, "kort förlust med förlustpunktvärdet (FX offer)");
  assert.ok(ts.pnl < 0);
  assert.ok(Math.abs(sim.account().balance - (100_000 + tl.pnl + ts.pnl)) < 1e-9, "saldot i SEK = start + realiserat");
  assert.equal(sim.snapshot().closed.length, 2);
  assert.ok(fs.existsSync(path.join(tmp, "u1.json")), "tillståndet sparas i egen fil");
  ok("fyllnad: KÖP på offer, SÄLJ på bid, stängning omvänt; P/L-tecken lång/kort; SEK via verifierat punktvärde; eget saldo");
}

// ══ 2) Nekas med klartext: inget Live-pris, ingen FX, fel valuta, kill switch, limit, under minsta storlek ══
{
  px = { bid: 60_000, offer: 60_010 };
  const sim = mkSim(path.join(tmp, "u2.json"));
  quoteOk = false;
  await assert.rejects(sim.open({ epic: SIM, direction: "BUY", size: 0.1 }), /inget färskt Live-pris/);
  quoteOk = true;
  rules = { verified: false, pointValue: null, marginRate: 0.5, pointCurrency: "USD", fxError: "Växelkursen USD/SEK är ogiltig; ingen storlek räknas." };
  await assert.rejects(sim.open({ epic: SIM, direction: "BUY", size: 0.1 }), /Växelkursen USD\/SEK är ogiltig/);
  rules = { verified: false, pointValue: null, marginRate: 0.5, pointCurrency: "USD" };
  await assert.rejects(sim.open({ epic: SIM, direction: "BUY", size: 0.1 }), /kunde inte verifieras/, "ingen gissad valutakurs");
  const sq = await sim.stakeQuote({ epic: SIM, direction: "BUY", stake: 1000 });
  assert.equal(sq.ok, false); assert.match(String(sq.reason), /kunde inte verifieras/);
  rules = { verified: true, pointValue: 0.95, profitPointValue: 0.93, marginRate: 0.5, pointCurrency: "SEK", priceScalingFactor: 1 };
  kill = true;
  await assert.rejects(sim.open({ epic: SIM, direction: "BUY", size: 0.1 }), /kill switch/);
  kill = false;
  await assert.rejects(sim.open({ epic: SIM, direction: "BUY", size: 0.1, orderType: "LIMIT" }), /limitorder stöds inte/);
  await assert.rejects(sim.open({ epic: SIM, direction: "BUY", size: 0.001 }), /under IG:s minsta/);
  await assert.rejects(sim.open({ epic: SIM, direction: "BUY", size: 0.1, stopLevel: 60_005 }), /fel sida|minsta avstånd/);
  await assert.rejects(sim.open({ epic: SIM, direction: "BUY", size: 50 }), /Marginalen/, "samma budget som IG-ordern (≤ 3 % av saldot)");
  assert.equal(sim.snapshot().positions.length, 0, "inget öppnades");
  ok("nekas med klartext: inget färskt Live-pris, FX-fel/ingen verifierad SEK-omräkning, kill switch, limit, minsta storlek, SL-sida, budget");
}

// ══ 3) TP/SL i simuleringen ══
{
  px = { bid: 60_000, offer: 60_010 };
  const sim = mkSim(path.join(tmp, "u3.json"));
  const a = await sim.open({ epic: SIM, direction: "BUY", size: 0.1, stopLevel: 59_500, targetLevel: 60_600 });
  const b = await sim.open({ epic: SIM, direction: "SELL", size: 0.1, stopLevel: 60_400, targetLevel: 59_000 });
  px = { bid: 60_650, offer: 60_660 };
  const done = await sim.tick();
  assert.deepEqual(done.map((t) => [t.dealId, t.reason]).sort(), [[a.dealId, "TP"], [b.dealId, "SL"]].sort(), "lång når TP, kort når SL");
  assert.equal(sim.snapshot().positions.length, 0);
  ok("TP/SL stänger simulerade positioner på Live-bid/offer");
}

// ══ 4) Vägval: sim bara vid positivt belägg ══
{
  let demoCat: any = { markets: [{ epic: FX }], complete: false, searchCompletedAt: null };
  const live = { markets: [{ epic: FX, category: "forex" }, { epic: SIM, name: "Bitcoin ($0.1)", category: "crypto", bid: 60_000, offer: 60_010 }] };
  let probe: "exists" | "missing" | "unknown" = "unknown";
  const r = createDemoSimRouter({ live: () => live as never, demo: () => demoCat, probeDemo: async () => probe, now });
  assert.equal(r.known(SIM), false, "delvis Demo-katalog är inget belägg");
  assert.equal(r.liveOnly(SIM), true, "visas (läsning) som Live-instrument");
  await assert.rejects(r.route(SIM), /går inte att avgöra/, "läsgräns/okänt → nekas, aldrig tyst simulering");
  assert.equal(await r.route(FX), "ig", "Demo-instrument går IG Demo-vägen");
  probe = "missing";
  await assert.rejects(r.route(SIM), /går inte att avgöra/, "okänt svar minns 60 s (ingen ny Demo-läsning per anrop)");
  NOW += 61_000;
  assert.equal(await r.route(SIM), "sim", "IG Demo 404 = belägg");
  assert.equal(r.known(SIM), true);
  const r2 = createDemoSimRouter({ live: () => live as never, demo: () => ({ markets: [{ epic: FX }], searchCompletedAt: NOW }) as never });
  assert.equal(r2.known(SIM), true, "Demo-katalogens sökningar klara utan EPIC:en = belägg");
  const r3 = createDemoSimRouter({ live: () => live as never, demo: () => ({ markets: [{ epic: FX }], searchCompletedAt: NOW }) as never, probeDemo: async () => "exists" });
  assert.equal(await r3.route(FX), "ig");
  // Demo-katalogen saknas (frånkopplad/omloggning): inget läses från Live, Demo-instrument förblir Demo
  const r4 = createDemoSimRouter({ live: () => live as never, demo: () => null, now });
  assert.equal(r4.liveOnly(FX), false, "Demo-instrument läses aldrig från Live när Demo-katalogen saknas");
  assert.equal(r4.liveOnly(SIM), false); assert.equal(r4.known(SIM), false);
  const row = demoSimRow(live.markets[1] as never);
  assert.equal(row.sim, true); assert.equal(row.simLabel, DEMO_SIM_LABEL); assert.match(row.name, /Demo-simulering$/);
  ok("vägval: sim bara vid positivt belägg (sökning klar eller Demo-404); osäkert → nekas med klartext; raden märks");
}

// ══ 5) HELA flödet: Godkänn → Demo-mäklaren → simulering → tidsstängning. NOLL skrivande IG-anrop (Demo och Live) ══
{
  const log: string[] = [];
  const fake = (async (url: string, init: any) => {
    const u = new URL(url), env = u.hostname.startsWith("demo-") ? "demo" : "live", p = u.pathname.replace("/gateway/deal/", "");
    const hdr = init?.headers ?? {}; log.push(`${env} ${init?.method ?? "GET"}${hdr._method ? "(" + hdr._method + ")" : ""} ${p}`);
    const res = (body: any, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });
    if (p === "session") return res({ currentAccountId: "A1" }, { CST: "c", "X-SECURITY-TOKEN": "x" });
    if (p === "accounts") return res({ accounts: [{ accountId: "A1", accountType: "CFD", currency: "SEK", balance: { balance: 100_000, available: 100_000, deposit: 0, profitLoss: 0 } }] });
    if (p === "positions" && (init?.method ?? "GET") === "GET") return res({ positions: [] });
    if (p === "workingorders") return res({ workingOrders: [] });
    if (p === "positions/otc" || p === "workingorders/otc") return res({ dealReference: "REF-X" });
    if (p.startsWith("confirms/")) return res({ dealStatus: "ACCEPTED", dealId: "D-X" });
    return res({});
  }) as typeof fetch;
  const writes = () => log.filter((x) => !/^(demo|live) GET /.test(x) && !/^(demo|live) POST session$/.test(x));
  const conn = createIgConnection({ loadCredentials: () => ({ demo: { apiKey: "k", identifier: "i", password: "p" }, live: { apiKey: "k", identifier: "i", password: "p" } }) as never, fetch: fake });
  await conn.testConnection("demo"); await conn.testConnection("live");
  px = { bid: 60_000, offer: 60_010 }; quoteOk = true;
  rules = { verified: true, pointValue: 0.95, profitPointValue: 0.93, marginRate: 0.5, pointCurrency: "SEK", priceScalingFactor: 1 };
  const sim = mkSim(path.join(tmp, "flow.json"));
  const router = { known: (e: string) => e === SIM, route: async (e: string) => (e === SIM ? "sim" as const : "ig" as const) };
  const igPath = () => { throw new Error("IG-ordervägen får inte användas för en simulerad order"); };
  const demo = new IgBroker("demo", { status: conn.getStatus as never, connect: conn.testConnection as never, accounts: conn.getAccounts as never, positions: conn.getPositions as never,
    market: (async () => { throw new Error("Demo-marknaden ska inte läsas för simulerade EPICs"); }) as never,
    preview: igPath as never, confirm: igPath as never, close: igPath as never, enabled: () => true, now, observe: () => {}, sim, simRouter: router });
  const { createIgPendingOrder, executeApprovedOrder } = await import("../src/server/api.js");
  const made = await createIgPendingOrder({ symbol: SIM, side: "BUY", stakePct: 1, source: "dashboard", stopLoss: 59_000, takeProfit: 61_500, horizonSec: 300 }, demo);
  assert.equal(made.ok, true, (made as { error?: string }).error);
  const po = (made as { pendingOrder: any }).pendingOrder;
  assert.equal(po.stakeAmount, 1000, "insatsen räknas på simuleringens saldo (1 % av 100 000 SEK)");
  const r = await executeApprovedOrder(po, { "ig-demo": demo } as never);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  const order = (r as { result: any }).result;
  assert.ok(isSimDealId(order.dealId), "fylld i simuleringen"); assert.equal(order.fillLevel, 60_010);
  const ps = await demo.getPositions({ fresh: true });
  const mine = ps.find((p) => p.dealId === order.dealId)!;
  assert.ok(mine?.sim && /Demo-simulering/.test(String(mine.name)), "positionen syns i Demo, märkt");
  // Motsatt riktning stänger (M3) via Godkänn, samma flöde
  const closeReq = await createIgPendingOrder({ symbol: SIM, side: "SELL", source: "dashboard" }, demo);
  assert.equal(closeReq.ok, true, (closeReq as { error?: string }).error);
  assert.equal((closeReq as { pendingOrder: any }).pendingOrder.closeDealId, order.dealId);
  // Ny position som stängs av tidsgränsen (closeIgAtExpiry)
  const p2 = await sim.open({ epic: SIM, direction: "SELL", size: 0.02, stopLevel: 61_000, targetLevel: 59_000 });
  px = { bid: 59_900, offer: 59_910 };
  await closeIgAtExpiry({ id: "x1", broker: "ig-demo", symbol: SIM, qty: 0.02, live: false, openedAt: NOW, exitAt: NOW, baseline: 0, dealId: p2.dealId } as never, demo);
  assert.ok(!sim.hasPosition(p2.dealId), "tidsstängningen stänger den simulerade positionen");
  const rc = await executeApprovedOrder((closeReq as { pendingOrder: any }).pendingOrder, { "ig-demo": demo } as never);
  assert.equal(rc.ok, true, (rc as { error?: string }).error);
  assert.ok(!sim.hasPosition(order.dealId), "Godkänd stängning stänger den simulerade positionen");
  assert.deepEqual(writes(), [], "NOLL skrivande IG-anrop (varken Demo eller Live) för öppning + stängning");
  // Resultatfönstret i Demo tar med simulerade affärer, märkta "sim"; Live påverkas inte
  const res = await getResults({ "ig-demo": demo, ig: demo } as never, "TEST", [], { history: (async () => ({ status: "ready", transactions: [] })) as never, sim });
  assert.equal(res.trades.filter((t) => t.kind === "sim").length, 2, "båda simulerade affärerna i Demo-resultatet");
  assert.ok(res.trades.every((t) => t.kind !== "sim" || /Demo-simulering/.test(t.coin)));
  const live = new IgBroker("live", { status: conn.getStatus as never, connect: conn.testConnection as never, accounts: conn.getAccounts as never, positions: conn.getPositions as never,
    market: liveMarket as never, preview: (async () => { throw new Error("IG-vägen"); }) as never, enabled: () => true, now, observe: () => {}, sim, simRouter: router });
  assert.equal(live.isSimEpic(SIM), false, "Live har aldrig simulering");
  await assert.rejects(live.placeOrder({ symbol: SIM, side: "BUY", type: "MARKET", quantity: 0.1, stopLoss: 59_000, takeProfit: 61_500 }), /IG-vägen/, "Live går alltid IG-vägen");
  const liveRes = await getResults({ ig: live } as never, "LIVE", [], { history: (async () => ({ status: "ready", transactions: [] })) as never, sim });
  assert.equal(liveRes.trades.length, 0, "Live-resultatet utan simulering");
  ok("hela flödet (förslag → Godkänn → sim → Sälj/motsatt → tidsstängning) gör 0 skrivande IG-anrop; Demo-resultat märkta sim; Live orörd");
}

// ══ 4b) IG Demo-strömmen avvisade prisposten: prislös Demo-sökträff ersätts av märkt Live-rad ══
{
  let rejectedNow = new Set<string>([SIM]);
  const demoCat = { markets: [{ epic: FX }, { epic: SIM, name: "Bitcoin ($0.1)", bid: null, offer: null }], complete: false, searchCompletedAt: null };
  const live = { markets: [{ epic: FX, category: "forex", bid: 1.1, offer: 1.1 }, { epic: SIM, name: "Bitcoin ($0.1)", category: "crypto", bid: 60_000, offer: 60_010 }] };
  const r = createDemoSimRouter({ live: (c) => ({ markets: live.markets.filter((m) => m.category === c) }) as never, demo: () => demoCat as never, demoRejected: (e) => rejectedNow.has(e), now });
  assert.equal(r.known(SIM), true, "IG:s avvisade Demo-prisström = positivt belägg");
  assert.equal(r.liveOnly(SIM), true);
  assert.equal(await r.route(SIM), "sim");
  rejectedNow = new Set(); // Demo-prenumerationen avslutad: felet raderas hos strömmen
  assert.equal(r.known(SIM), true, "belägget minns (ingen växling fram och tillbaka)");
  assert.equal(r.known(FX), false); assert.equal(await r.route(FX), "ig", "Demo-instrument påverkas inte");
  const sp = r.split("crypto", demoCat.markets);
  assert.deepEqual([...sp.sim, ...sp.unproven].map((m) => m.epic), [SIM], "den avvisade Demo-raden ersätts av Live-raden");
  ok("IG Demo-strömmens avvisning av prisposten är belägg; minns; Demo-instrument orörda; raden ersätts (inga dubbletter)");
}

// ══ 4c) Alla par: en kvot från strömmen uppdaterar kortets pris, idag % och minidiagrammets sista punkt ══
{
  const vm = await import("node:vm");
  const html = fs.readFileSync(path.resolve("dashboard.html"), "utf8");
  const src = ["ppApplyQuote", "ppSparkSeries"].map((n) => { const m = new RegExp(`function ${n}\\([\\s\\S]*?\\n}\\n`).exec(html); assert.ok(m, `${n} finns i dashboard.html`); return m![0]; }).join("\n");
  const ctx: any = { Date, isFinite };
  vm.createContext(ctx); vm.runInContext(src + "\nthis.ppApplyQuote = ppApplyQuote; this.ppSparkSeries = ppSparkSeries;", ctx);
  const card: any = { price: 60_000, chg: 1.0, bars: [59_900, 60_000], to: 1000 };
  assert.equal(ctx.ppApplyQuote(card, { epic: SIM, mid: 60_123, changePct: 1.4, observedAt: 2000 }), true);
  assert.equal(card.price, 60_123, "priset följer kvoten"); assert.equal(card.chg, 1.4, "idag % följer kvoten"); assert.equal(card.dirty, true, "kortet ritas om");
  assert.deepEqual(ctx.ppSparkSeries(card.bars, card.livePx, card.liveAt, card.to), [59_900, 60_000, 60_123], "minidiagrammets sista punkt = livepriset");
  assert.deepEqual(ctx.ppSparkSeries([], 1, 2, 0), [], "inget diagram hittas på från ett enda pris");
  assert.ok(/IG\.on\("quote", q=>\{ ppApplyQuote\(P\[q\.epic\], q\); \}\)/.test(html), "Alla par lyssnar på strömmens kvoter");
  assert.ok(/IG\.want\("allpairs", active\(\) \? \[\.\.\.onScreen\]\.slice\(0, 20\)/.test(html), "högst 20 kort på skärmen prenumererar");
  ok("Alla par livesynk: kvot uppdaterar pris, idag % och sista punkten; högst 20 kort i strömmen");
}

// ══ 6) Statisk: simuleringen har inga IG-skrivvägar ══
{
  const src = fs.readFileSync(path.resolve("src/integrations/igDemoSim.ts"), "utf8");
  assert.ok(!/from\s+["'][^"']*(igConnection|igOrders)/.test(src), "importerar inte igConnection/igOrders");
  assert.ok(!/positions\/otc|workingorders|callIgAuthenticated|fetch\(/.test(src), "inga IG-anrop i simuleringen");
  ok("statisk: igDemoSim importerar inget från igConnection/igOrders och har inga IG-anrop");
}
console.log("Demo-simulering: alla tester godkända (endast mocks, inga nätverksanrop)");
process.exit(0);
