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

// ══ E. Urval, analys, sessioner ══
{
  const { createIgSessions, stockholmSlot, capacityError } = await import("../src/server/igSessions.js");
  const { directAnalysisSymbols } = await import("../src/server/api.js");
  const { checkOrderGate, setOrderGateSessionHook, needsApproval } = await import("../src/server/orderGate.js");
  let t = Date.parse("2026-10-09T06:00:00Z"); // 08:00 i Stockholm (CEST)
  let binding: string | null = "demo-g1", active: "demo" | "live" = "demo";
  const batches: string[][] = [];
  const ctxs: any[] = [];
  const gates: Array<{ ok: boolean }> = [];
  let approvalDuringBatch: boolean[] = [];
  const mk = (n: number) => `CS.D.T${String(n).padStart(3, "0")}.MINI.IP`;
  const dir = path.join(tmp, "sess");
  const S = createIgSessions({
    binding: (e) => (e === "demo" ? binding : null), activeEnv: () => active, guard: async () => null, now: () => t, directory: dir,
    runBatch: async (_e, epics, ctx) => {
      batches.push(epics); ctxs.push(ctx);
      approvalDuringBatch.push(needsApproval());
      // Agenterna försöker lägga ordrar under omgången: högst 5 nya försök per session
      for (let i = 0; i < 3; i++) gates.push(await checkOrderGate({ live: false, side: "BUY", unitsOrder: true, opening: true, source: "agent" }));
      return { picks: [{ symbol: epics[0]!, action: "buy", reasoning: "test" }], stopped: epics[1] ? [{ symbol: epics[1], why: "svag signal" }] : [] };
    },
  });
  setOrderGateSessionHook((i) => S.orderGateHook(i), () => S.forcesApproval());

  // E2: direktanalys högst 10, bara EPICs
  assert.equal(directAnalysisSymbols(Array.from({ length: 11 }, (_, i) => mk(i))).ok, false);
  assert.equal(directAnalysisSymbols(["BTCUSDT"]).ok, false, "inga påhittade symboler");
  const dd = directAnalysisSymbols([mk(1), mk(1)]); assert.ok(dd.ok && dd.symbols!.length === 1);

  // E2: urvalet sparas på servern (överlever omstart), max 500
  const sel = Array.from({ length: 12 }, (_, i) => mk(i));
  S.setSelection("demo", sel);
  const reloaded = createIgSessions({ binding: () => binding, activeEnv: () => active, guard: async () => null, now: () => t, directory: dir, runBatch: async () => ({ picks: [] }) });
  assert.deepEqual(reloaded.state("demo").selection.epics, sel, "urvalet ligger på servern");
  assert.throws(() => S.setSelection("demo", Array.from({ length: 501 }, (_, i) => mk(i))), /Högst 500/);
  assert.throws(() => S.setSelection("demo", ["BTCUSDT"]), /IG-EPICs/);

  // E5: kapacitet 60 min × 5/min = 300; större urval kräver nytt tidsval
  assert.equal(capacityError(300, 60), null); assert.match(capacityError(301, 60)!, /Välj ny tid/);
  assert.throws(() => S.start("demo", { epics: Array.from({ length: 80 }, (_, i) => mk(i)), durationMinutes: 15 }), /ryms inte/);

  // E2/E4: manuell session, fryst lista/miljö/strategi/intervall, omgångar om högst 5 per minut
  const x = S.start("demo", { durationMinutes: 15, analysisInterval: "5m", strategy: "ema-cross-5m" });
  assert.equal(x.epics.length, 12); assert.equal(x.binding, "demo-g1"); assert.equal(x.analysisInterval, "5m"); assert.equal(x.strategy, "ema-cross-5m");
  S.setSelection("demo", [mk(99)]);
  assert.equal(S.state("demo").session!.epics.length, 12, "listan frystes vid start");
  assert.throws(() => S.start("demo", {}), /pågår redan/);
  await S.runNext("demo");
  assert.deepEqual(batches[0], sel.slice(0, 5)); assert.equal(ctxs[0].analysisInterval, "5m"); assert.equal(ctxs[0].scheduled, false);
  await S.runNext("demo"); assert.equal(batches.length, 1, "nästa omgång först efter en minut");
  t += 60_000; await S.runNext("demo");
  assert.deepEqual(batches[1], sel.slice(5, 10));
  let st = S.state("demo").session!;
  assert.equal(st.items.find((i) => i.epic === sel[0])!.action, "buy");
  assert.match(st.items.find((i) => i.epic === sel[1])!.result!, /JEV stoppade/);
  assert.equal(st.items.find((i) => i.epic === sel[2])!.action, "avstå", "sessionen får avstå");
  assert.equal(st.items.filter((i) => i.status === "väntar").length, 2);
  // Högst 5 nya orderförsök: 3 + 2 tillåts, resten spärras
  assert.equal(gates.filter((g) => g.ok).length, 5); assert.equal(gates.filter((g) => !g.ok).length, 1);
  assert.equal(st.orderAttempts, 5);
  assert.equal((await checkOrderGate({ live: false, side: "BUY", unitsOrder: true, opening: true, source: "orderpanel" })).ok, true, "räknar bara agenternas försök under omgångar");
  // Stoppa
  const stopped = S.stop("demo");
  assert.equal(stopped!.status, "stopped"); assert.ok(stopped!.items.filter((i) => i.status === "hoppad").length === 2);

  // Kontobyte avbryter (kör aldrig vidare på annat konto)
  S.setSelection("demo", sel.slice(0, 3));
  S.start("demo", { durationMinutes: 15 });
  binding = "demo-g2";
  t += 60_000; await S.runNext("demo");
  assert.equal(S.state("demo").session!.status, "interrupted"); assert.match(S.state("demo").session!.reason!, /inloggningen ändrades/);
  binding = "demo-g1";

  // E5: schema 08:00/12:00/15:00/19:00 Stockholm, 1 h, redigerbart; tvingar Godkänn; aktiverar aldrig orderläget
  const sch = S.state("demo").schedule;
  assert.deepEqual(sch.map((s) => s.time), ["08:00", "12:00", "15:00", "19:00"]);
  assert.deepEqual(sch.map((s) => s.label), ["Morgon", "Lunch", "Eftermiddag", "Kväll"]);
  assert.equal(stockholmSlot(Date.parse("2026-10-09T06:00:00Z")).time, "08:00");
  assert.equal(stockholmSlot(Date.parse("2026-12-09T07:00:00Z")).time, "08:00", "vintertid");
  S.setSelection("demo", Array.from({ length: 301 }, (_, i) => mk(i)));
  assert.throws(() => S.setSchedule("demo", [{ id: "morning", enabled: true }]), /ryms inte/);
  S.setSelection("demo", sel);
  S.setSchedule("demo", [{ id: "lunch", time: "12:30", enabled: true }]);
  assert.throws(() => S.setSchedule("demo", [{ id: "lunch", time: "25:00" }]), /HH:MM/);
  t = Date.parse("2026-10-09T10:30:00Z"); // 12:30 Stockholm
  approvalDuringBatch = [];
  await S.tick();
  const sx = S.state("demo").session!;
  assert.equal(sx.trigger, "schema"); assert.equal(sx.durationMinutes, 60); assert.equal(sx.slot, "lunch");
  assert.ok(approvalDuringBatch.length >= 1 && approvalDuringBatch.every(Boolean), "schemalagd omgång tvingar Godkänn");
  await S.tick();
  assert.equal(S.state("demo").schedule.find((x) => x.id === "lunch")!.lastOccurrence, "2026-10-09 12:30", "ingen dubbelstart samma tid");
  const { config } = await import("../src/config.js");
  assert.equal(needsApproval(), config.executionMode === "approve", "efter omgången gäller vanligt läge igen");
  const { igOrderExecutionEnabled } = await import("../src/integrations/igConnection.js");
  assert.equal(igOrderExecutionEnabled("demo"), false, "schemat slår aldrig på orderläget");
  setOrderGateSessionHook(null);

  // E1/E3 i UI
  for (const id of ["mk-sel-all", "mk-sel-vis", "mk-sel-none", "mk-analyze", "mk-session"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes("data-igs-start-saved") && html.includes("data-igs-session") && html.includes("data-igs-schedule"));
  assert.ok(!/IG analyserar|Analysera med IG/.test(html), "knapptexten antyder inte att IG analyserar");
  assert.ok(html.includes("MK.all().forEach(m=>MK.sel.add(m.epic))"), "Markera alla tar hela katalogen, även utanför filter/Visa mer");
  ok("E1–E5 urval på servern, direktanalys ≤10, session ≤500 i omgångar om 5/min med fryst lista/konto/strategi/intervall, köstatus, JEV-stopp, avstå, max 5 orderförsök, stopp, schema med kapacitet 300 som tvingar Godkänn");
}

// ══ C. UI / marknadssida ══
{
  // C3: sidomenyn — varje post leder till en sida, inga dubbletter
  const side = html.slice(html.indexOf('<aside class="sidebar">'), html.indexOf("</aside>"));
  const items = [...side.matchAll(/data-page="([a-z]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => [m[1]!, m[2]!.trim()] as const);
  const labels = items.map((x) => x[1]);
  for (const want of ["Trade", "Trades", "Cost", "Valutapar", "Alla par", "Strategier", "Signaler", "Sessioner", "Agentchatt", "Marknader", "Verktyg", "Inställningar"]) assert.ok(labels.includes(want), `menyn saknar ${want}`);
  for (const [page] of items) assert.ok(html.includes(`id="page-${page}"`), `sidan page-${page} saknas`);
  assert.equal(new Set(items.map((x) => x[0])).size, items.length, "dubbla sidor i menyn");
  // C1: svart bakgrund, grön upp/köp, röd ned/sälj
  assert.match(html, /--bg:#000000/); assert.ok(/\.up\{color:#3fb950\}/.test(html) && /\.down\{color:#f85149\}/.test(html));
  // C2: 1–4 diagram, valbar länkning, märkning
  for (const l of ['data-mc="1"', 'data-mc="2"', 'data-mc="3"', 'data-mc="4"', 'id="mcLink"', 'id="mcSyncIv"']) assert.ok(html.includes(l), l);
  assert.ok(html.includes('IG.st.env === "live" ? "LIVE" : "DEMO"'), "varje diagram märkt DEMO/LIVE");
  // C4/C5: kort och filter
  for (const id of ["mkf-cat", "mkf-fav", "mkf-q", "mkf-region", "mkf-status", "mkf-dir", "mkf-trend", "mkf-sort"]) assert.ok(html.includes(`id="${id}"`), id);
  for (const k of ["data-mk-fav", "data-mk-enrich", 'data-act="chart"', 'data-act="analyze"', "data-more", "kvot saknas", "förändring saknas"]) assert.ok(html.includes(k), k);
  assert.ok(!/mest vinster"|Mest vinster</.test(html.replace(/&quot;mest vinster&quot;-prognos/g, "")), "ingen 'mest vinster' som prognos");
  assert.ok(html.includes("inte IG:s handelsplats") && html.includes("sentiment ≠ volym/vinst"));
  // C7: Trades åtskilda, Cost utan påhittade siffror
  assert.ok(html.includes('id="trades-pending-card"') && html.includes("Öppna positioner") && html.includes("Avslutade affärer"));
  assert.ok(!html.includes("// Demo-data") && !html.includes('textContent = "$0.32"'), "Cost visar inga påhittade siffror");
  assert.ok(html.includes("Detta är inte trading-resultat"));
  ok("C1–C5, C7: svart/grönt/rött, 1–4 diagram med länkning och DEMO/LIVE-märkning, sidomenyn utan dubbletter, Valutapar-kort och filter, Trades/Cost åtskilda utan påhittade data");
}
{
  // C6: inklistrad IG-signal → agentteamet granskar (inga ordrar) → Kopiera till Trade (utkast)
  const { createIgImportedSignals } = await import("../src/integrations/igImportedSignals.js");
  const { createIgPreferences } = await import("../src/integrations/igPreferences.js");
  let gen = "demo-g1";
  const st = () => ({ environments: { demo: { status: "connected", connectionGeneration: gen }, live: { status: "disconnected" } } }) as never;
  const sig = createIgImportedSignals({ status: st, now: () => NOW, directory: path.join(tmp, "sig") });
  const input = { epic: EPIC, sourceText: "IG: köp EUR/USD", direction: "BUY" as const, entryLevel: 1.1, stopLevel: 1.09, targetLevel: 1.12, validUntil: NOW + 3600_000 };
  assert.throws(() => sig.save("demo", { ...input, stopLevel: 1.2 }), /fel sida/);
  assert.throws(() => sig.save("live", input), /anslutet/);
  const saved = sig.save("demo", input);
  assert.equal(saved.executable, false); assert.equal(saved.status, "unverified_draft");
  sig.review("demo", saved.id, { at: NOW, status: "done", verdict: "hold", summary: "svag" });
  assert.equal(sig.list("demo")[0]!.review!.verdict, "hold");
  gen = "demo-g2"; assert.equal(sig.list("demo")[0]!.stale, true, "annan inloggning → inaktuell");
  const prefs = createIgPreferences(path.join(tmp, "prefs"));
  const p1 = prefs.set("demo", { favorites: [EPIC], revision: 0 });
  assert.throws(() => prefs.set("demo", { favorites: [], revision: 0 }), /annan vy/);
  assert.deepEqual(prefs.get("live").favorites, [], "favoriter per miljö");
  assert.equal(p1.revision, 1);

  // Granskningen via den riktiga vägen (api.startImportedSignalReview) med mockad agentkörning
  const { startImportedSignalReview } = await import("../src/server/api.js");
  const { checkOrderGate, listPendingOrders } = await import("../src/server/orderGate.js");
  const { analysisEnd } = await import("../src/server/agentActivity.js");
  gen = "demo-g1";
  const fresh = sig.save("demo", { ...input, direction: "SELL", stopLevel: 1.11, targetLevel: 1.08 });
  const before = (await listPendingOrders()).length;
  let duringReview: { ok: boolean } | null = null, seen: { ins: string; symbols: string[] } | null = null;
  assert.equal((await startImportedSignalReview("demo", "nope", { run: async () => {}, store: sig }) as any).status, 404);
  const rv: any = await startImportedSignalReview("demo", fresh.id, { store: sig, run: async (ins, symbols) => {
    seen = { ins, symbols };
    duringReview = await checkOrderGate({ live: false, side: "SELL", unitsOrder: true, opening: true, source: "agent" });
    analysisEnd({ status: "done", picks: [{ symbol: EPIC, action: "hold", sizeUsd: 0, confidence: "low", reasoning: "Ingen bekräftelse i stängda ljus" }] });
  } });
  assert.equal(rv.ok, true); assert.equal(sig.list("demo").find((x) => x.id === fresh.id)!.review!.status, "running");
  await rv.done;
  assert.deepEqual(seen!.symbols, [EPIC], "rätt instrument"); assert.match(seen!.ins, /OVERIFIERAD/); assert.match(seen!.ins, /INGA ordrar/);
  assert.equal(duringReview!.ok, false, "nya ordrar spärras under granskningen");
  const reviewed = sig.list("demo").find((x) => x.id === fresh.id)!.review!;
  assert.equal(reviewed.status, "done"); assert.equal(reviewed.verdict, "hold"); assert.match(reviewed.summary!, /bekräftelse/);
  assert.equal((await checkOrderGate({ live: false, side: "BUY", unitsOrder: true, opening: true, source: "agent" })).ok, true, "spärren släpps efter granskningen");
  assert.equal((await listPendingOrders()).length, before, "granskning skapar inga ordrar");
  gen = "demo-g2";
  assert.match((await startImportedSignalReview("demo", fresh.id, { run: async () => {}, store: sig }) as any).error, /annan IG-inloggning/);
  for (const k of ["sg-save", "data-sg-review", "data-sg-copy", "Kopiera till Trade", "Inget är skickat"]) assert.ok(html.includes(k), k);
  ok("C6 inklistrad IG-signal sparas som overifierat utkast per konto, agentteamet granskar utan ordrar, Kopiera till Trade fyller bara orderpanelen");
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log("Kravlistan: alla tester godkända (endast mocks, inga nätverksanrop)");
process.exit(0);
