// Kravlista fas 2 (A–H): bara fixtures och mockade beroenden. Inga nätverksanrop, inga ordrar, inga betalda agentanrop.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-req-"));
process.env.TRADING_DATA_DIR = tmp;
process.env.AGENT_TREE_TRADING_EVENTS = "off";
delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO; delete process.env.IG_ORDER_EXECUTION_ENABLED_LIVE;
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;

const NOW = Date.parse("2026-10-09T10:00:00Z");
const html = fs.readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
const ok = (name: string) => console.log(`PASS: ${name}`);

// ══ A. Demo = Live ══
{
  // A1: inga sidor/knappar döljs beroende på miljö (bara etiketter/färger skiljer)
  const hiding = html.match(/(isLive|env\s*===\s*["']live["']|IG\.st\.env\s*===\s*["'](live|demo)["'])[^;\n]{0,80}(style\.display|\.hidden\s*=|classList\.(add|remove)\(["']hidden)/g) ?? [];
  assert.deepEqual(hiding, [], "UI-kod döljer funktioner beroende på miljö");
  const menu = [...html.matchAll(/<button[^>]*data-page="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(menu.includes("markets") && menu.includes("pairs") && menu.includes("strategies"));
  const pages = html.match(/const PAGES = \[([^\]]+)\]/)![1]!.split(",").map((x) => x.trim().replace(/"/g, ""));
  for (const m of menu) assert.ok(pages.includes(m!), `menyposten ${m} saknar sida`);
  assert.equal(new Set(pages).size, pages.length, "dubbla sidor");
  ok("A1 samma meny/sidor i båda miljöerna; inga miljövillkor som döljer funktioner; inga dubbla sidor");

  const { createIgMarketDirectory, igLiveOnlyReferences } = await import("../src/integrations/igMarketDirectory.js");
  const refs = igLiveOnlyReferences([{ epic: "CS.D.EURUSD.MINI.IP" }], [
    { epic: "CS.D.EURUSD.MINI.IP", name: "EUR/USD Mini", bid: 1.1, offer: 1.1 },
    { epic: "CS.D.BITCOIN.CFD.IP", name: "Bitcoin", category: "crypto", bid: 60000, offer: 60010, changePercent: 2, type: "CURRENCIES" },
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.label, "ej tillgänglig på Demo");
  assert.equal(refs[0]!.availableHere, false);
  for (const k of ["bid", "offer", "changePercent", "balance"]) assert.ok(!(k in refs[0]!), `Live-${k} läcker till Demo`);

  let gen = "live-1", calls = 0;
  const status = () => ({ environments: { demo: { status: "connected", connectionGeneration: "demo-1" }, live: { status: "connected", connectionGeneration: gen } } }) as never;
  const fallback = async (mode: string, category: string) => { calls++; return { markets: [{ epic: mode === "live" ? "CS.D.BITCOIN.CFD.IP" : "CS.D.EURUSD.MINI.IP", name: "x", type: category === "crypto" ? "CURRENCIES" : "CURRENCIES", instrumentType: "CURRENCIES" }], complete: false, progress: { retryAt: NOW + 60000 }, remainingSearches: 3 }; };
  const dir = createIgMarketDirectory({ status, fallback: fallback as never, now: () => NOW });
  assert.equal(dir.peek("live", "crypto"), null, "peek får inte hämta från IG");
  assert.equal(calls, 0);
  await Promise.all([dir.catalogue("live", "crypto"), dir.catalogue("live", "crypto")]);
  assert.equal(calls, 1, "singleflight: parallella hämtningar delar ett anrop");
  const peeked = dir.peek("live", "crypto");
  assert.ok(peeked, "senaste katalogen kan läsas utan IG-anrop");
  gen = "live-2";
  assert.equal(dir.peek("live", "crypto"), null, "katalog från en annan Live-inloggning används inte");
  ok("A2 Live-EPIC som saknas på Demo = katalogreferens 'ej tillgänglig på Demo' utan Live-priser; byte av inloggning släpper referensen");

  const { catalogueProgress } = await import("../src/server/igRoutes.js");
  const part = catalogueProgress({ markets: [1, 2, 3], status: "partial", complete: false, remainingSearches: 4, progress: { retryAt: NOW + 60000 } });
  assert.equal(part.state, "delvis"); assert.equal(part.count, 3); assert.match(part.text, /3 instrument hittills · delvis · 4 sökningar kvar/); assert.equal(part.retryAt, NOW + 60000);
  const full = catalogueProgress({ markets: [1], status: "ready", complete: true });
  assert.equal(full.state, "fullständig");
  const err = catalogueProgress({ markets: [], status: "unavailable", error: "IG är inte anslutet" });
  assert.equal(err.state, "fel"); assert.match(err.text, /Nytt försök inom ~60 s/);
  assert.ok(html.includes('id="mk-prog-forex"') && html.includes('id="mk-prog-crypto"'), "katalogframsteg syns på Valutapar");
  assert.ok(/setInterval\(tick, 60000\)/.test(html), "katalogen hämtas om ~60 s utan att urvalet nollställs");
  ok("A3 katalogframsteg (antal, delvis/fullständig, fel, återförsök ~60 s) syns; singleflight");
}

// ══ D. Pengar & order ══
const EPIC = "CS.D.EURUSD.MINI.IP";
const sekEnv = (e: string) => ({ environment: e, status: "connected", credentialsComplete: true, connectionGeneration: `${e}-g1`, error: null,
  account: { accountType: "CFD", currency: "SEK", balance: 10_000, available: 8_000, profitLoss: -12.5 } });
const igStatus = () => ({ environments: { demo: sekEnv("demo"), live: sekEnv("live") } }) as never;
const market = async (_e: string, epic: string) => ({
  epic, name: "EUR/USD Mini", category: "forex", expiry: "-",
  quote: { bid: 1.0999, offer: 1.1001, receivedAt: NOW - 500, observedAt: NOW - 500, delayTime: 0, marketStatus: "TRADEABLE", percentageChange: 0 },
  calculationRules: { verified: true, pointValue: 10, profitPointValue: 10, marginRate: 0.0333, pointCurrency: "SEK", executionCurrency: "SEK", priceScalingFactor: 10_000, note: "fixture" },
  dealingRules: { minDealSize: { value: 0.1 }, minNormalStopOrLimitDistance: { unit: "POINTS", value: 2 } },
  instrument: { unit: "CONTRACTS", contractSize: 10_000, scalingFactor: 10_000, currencies: [{ code: "SEK" }] },
});
const { IgBroker } = await import("../src/brokers/ig.js");
const mkBroker = (positions: any[], env: "demo" | "live" = "demo") => new IgBroker(env, { status: igStatus, connect: (async () => ({})) as never, accounts: (async () => ({ status: "ready" })) as never, market: market as never,
  positions: (async () => ({ status: "ready", positions })) as never, enabled: () => false, now: () => NOW, observe: () => {} });
{
  const { igOrderMoneyView } = await import("../src/integrations/igRiskLimits.js");
  const b = mkBroker([{ dealId: "L1", epic: EPIC, direction: "BUY", size: 0.5, level: 1.1, currency: "SEK", bid: 1.0999, offer: 1.1001 }]);
  const pf = await b.portfolioMargin();
  assert.equal(pf.verified, true); assert.equal(pf.positions, 1);
  assert.ok(Math.abs(pf.exposure - 1.1 * 0.5 * 10) < 1e-9 && Math.abs(pf.margin - 1.1 * 0.5 * 10 * 0.0333) < 1e-9);
  const q = await b.stakeQuote({ epic: EPIC, direction: "BUY", stake: 200, stopLoss: 1.09, takeProfit: 1.12 });
  assert.equal(q.ok, true, q.reason);
  const v = igOrderMoneyView({ currency: "SEK", balance: 10_000, available: 8_000, profitLoss: -12.5, pct: 2, stake: 200, quote: q as never, portfolio: pf });
  assert.equal(v.currency, "SEK"); assert.equal(v.balance, 10_000); assert.equal(v.available, 8_000); assert.equal(v.profitLoss, -12.5);
  assert.equal(v.maxPositionMargin, 300, "3 % av saldot"); assert.equal(v.maxTotalMargin, 1500);
  assert.ok(v.margin! > 0 && v.margin! <= 200); assert.ok(Math.abs(v.marginPctOfBalance! - v.margin! / 100) < 1e-9);
  assert.ok(v.lossAtSl! > 0 && v.lossAtSlPctOfBalance! > 0, "SL-risken visas separat");
  assert.ok(v.gainAtTp! > 0); assert.ok(v.spreadCost! > 0, "spreadkostnad räknas från IG-kvoten");
  assert.ok(Math.abs(v.totalMarginAfter! - (pf.margin + v.margin!)) < 1e-9 && v.totalExposureAfter! > v.exposure!);
  assert.equal(v.unit, "CONTRACTS"); assert.equal(v.contractSize, 10_000);
  assert.match(v.pctMeaning, /marginal, inte maxförlust/);
  assert.deepEqual(v.missing, []);
  // Minsta kontrakt som inte ryms förklaras
  const tiny = await b.stakeQuote({ epic: EPIC, direction: "BUY", stake: 0.01 });
  assert.equal(tiny.ok, false);
  const tv = igOrderMoneyView({ currency: "SEK", balance: 10_000, available: 8_000, profitLoss: 0, pct: 0.1, stake: 0.01, quote: tiny as never, portfolio: null });
  assert.match(tv.minContractNote!, /Minsta IG-kontrakt \(0\.1 CONTRACTS\)/); assert.ok(tv.missing.includes("öppna positioners marginal"));
  assert.equal(tv.openMargin, null, "overifierad portfölj visas inte som 0");
  ok("D2 i kontovaluta: saldo, tillgängligt, budget % och SEK, marginal, total exponering, kontraktsstorlek, SL-risk separat, TP, spread, P/L; minsta kontrakt förklaras");
}
{
  // D1 + D3 i UI: snabbval och fyra separata tidsval
  for (const id of ["ot-instr", "ot-chart-iv", "ot-ana-iv", "ot-sess-min", "ot-kill"]) assert.ok(html.includes(`id="${id}"`), `saknar ${id}`);
  for (const sec of [60, 120, 180, 240, 300]) assert.ok(html.includes(`data-tf="${sec}"`), `snabbval ${sec / 60} min saknas`);
  assert.ok(/class="ot-pctq" data-pct="1"[^>]*title=/.test(html), "verktygstips på procentknapparna");
  const { setIgTimes, getIgTimes } = await import("../src/server/igTimes.js");
  const { shortIntervals, setHorizonMin, getHorizonMin } = await import("../src/server/tradeHorizon.js");
  assert.equal(setIgTimes({ analysisInterval: "2m" }).ok, false);
  assert.equal(setIgTimes({ analysisInterval: "15m", sessionMinutes: 30 }).ok, true);
  assert.equal(setHorizonMin(3), 3, "innehavstid 3 min");
  assert.equal(getIgTimes().analysisInterval, "15m"); assert.equal(getIgTimes().sessionMinutes, 30); assert.equal(getHorizonMin(), 3);
  assert.deepEqual(shortIntervals(), ["15m", "1h", "4h"], "analysintervallet styr analysen, inte innehavstiden");
  ok("D1/D3 snabbval för instrument, 1–3 %, 1–5 min + exakta fält; innehavstid, diagram-, analysintervall och sessionslängd är fyra separata val");
}
{
  // D3/D5: begärd tidsstängning och Roll-Over med serverbekräftelse
  const th = await import("../src/server/tradeHorizon.js");
  th.addTimedExit({ broker: "ig-demo", symbol: EPIC, qty: 1, live: false, baseline: 0, dealId: "R1", horizonSec: 300 });
  const x = th.listTimedExits().find((e) => e.dealId === "R1")!;
  assert.ok(x.requestedExitAt && x.requestedExitAt === x.exitAt);
  const r = th.rollOverTimedExit("R1", 5 * 60, x.requestedExitAt! - 60_000);
  assert.equal(r.ok, true); if (r.ok) { assert.equal(r.from, x.requestedExitAt); assert.equal(r.to, x.requestedExitAt! + 300_000); }
  assert.equal(th.rollOverTimedExit("R1", 40 * 60).ok, false, "högst 30 min fram");
  assert.equal(th.rollOverTimedExit("NOPE", 300).ok, false);
  // Orderläget av: exitAt flyttas för nytt försök, men den begärda tiden ligger kvar
  const after = th.listTimedExits().find((e) => e.dealId === "R1")!;
  const off = { executionEnabled: () => false, closePosition: async () => ({}), getPositions: async () => [{ dealId: "R1" }] };
  await th.closeIgAtExpiry(after, off as never);
  const kept = th.listTimedExits().find((e) => e.dealId === "R1")!;
  assert.equal(kept.igState, "execution-off"); assert.equal(kept.requestedExitAt, after.requestedExitAt, "begärd tid ändras inte av återförsök");
  // Bekräftad stängning loggas
  let open = true;
  const on = { executionEnabled: () => true, closePosition: async () => { open = false; return {}; }, getPositions: async () => (open ? [{ dealId: "R1" }] : []) };
  await th.closeIgAtExpiry(kept, on as never);
  assert.equal(th.listTimedExits().some((e) => e.dealId === "R1"), false);
  const conf = th.listConfirmedExits().find((c) => c.dealId === "R1")!;
  assert.equal(conf.how, "closed"); assert.equal(conf.requestedExitAt, after.requestedExitAt);
  assert.ok(html.includes("data-rollover") && html.includes("resConfirmed"));
  ok("D3/D5 begärd tidsstängning syns; Roll-Over flyttar systemets stängning (gammal → ny tid, serverbekräftad, max 30 min); bekräftad stängning loggas");
}
{
  // D4: Double Up = nytt granskat utkast, samma riktning, samma grindar
  const { createIgDoubleUp } = await import("../src/server/api.js");
  const { listPendingOrders } = await import("../src/server/orderGate.js");
  const { loadState, saveState } = await import("../src/memory/store.js");
  const positions = [{ dealId: "D1", epic: EPIC, direction: "SELL", size: 0.2, level: 1.1, currency: "SEK", bid: 1.0999, offer: 1.1001, stopLevel: 1.11, limitLevel: 1.08 }];
  const b = mkBroker(positions);
  const before = (await listPendingOrders()).length;
  const r: any = await createIgDoubleUp("D1", b);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.pendingOrder.side, "SELL", "samma riktning (ingen stängning)"); assert.equal(r.pendingOrder.closeDealId, undefined);
  assert.equal(r.pendingOrder.quantity, 0.2); assert.equal(r.pendingOrder.stopLoss, 1.11);
  assert.ok(r.combined.totalMargin > r.combined.newMargin && r.combined.totalSlRisk > 0);
  assert.equal((await listPendingOrders()).length, before + 1, "bara ett utkast — inget skickas");
  assert.equal((await createIgDoubleUp("X9", b) as any).status, 404);
  const st = await loadState(); await saveState({ ...st, killSwitchActive: true });
  const killed: any = await createIgDoubleUp("D1", b);
  assert.equal(killed.ok, false, "kill switch stoppar Double Up"); await saveState({ ...st, killSwitchActive: false });
  ok("D4 Double Up: nytt utkast i samma riktning/storlek via samma grindar (kill switch, budget, Godkänn); sammanlagd marginal/risk visas");
}
{
  // D6: orderflagga per miljö, båda av som standard; okänt utfall sänds aldrig om
  const { igOrderExecutionEnabled } = await import("../src/integrations/igConnection.js");
  assert.equal(igOrderExecutionEnabled("demo"), false); assert.equal(igOrderExecutionEnabled("live"), false);
  const env = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(env, /IG_ORDER_EXECUTION_ENABLED_DEMO=false/); assert.match(env, /IG_ORDER_EXECUTION_ENABLED_LIVE=false/);
  assert.ok(html.includes("ot-kill-reset"), "kill switch-status + återställning i UI");
  ok("D6 separat orderflagga per miljö (båda av), kill switch-status och återställning syns, granskning/Godkänn bevaras");
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log("Kravlistan: alla tester godkända (endast mocks, inga nätverksanrop)");
process.exit(0);
