// Granskning 2 (B1, M1–M5, FX, rester, H1): granskarens simuleringar som fixturetester.
// Bara mockad fetch och injicerade beroenden. Inga nätverksanrop mot IG, Vercel eller Tiingo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-review2-"));
process.env.TRADING_DATA_DIR = tmp;
process.env.AGENT_TREE_TRADING_EVENTS = "off";
delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO; delete process.env.IG_ORDER_EXECUTION_ENABLED_LIVE;
delete process.env.LIVE_TRADING_CONFIRMED;
for (const k of ["IG_MAX_STAKE_PCT", "IG_MAX_TOTAL_MARGIN_PCT", "IG_MAX_DAILY_LOSS_PCT", "IG_MAX_POSITION_MARGIN", "IG_MAX_TOTAL_MARGIN", "IG_MAX_DAILY_LOSS", "STAKE_PCT_START", "STAKE_PCT_MAX"]) delete process.env[k];
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;

const { createIgConnection, withIgPriority, IG_ORDER_READ_NEED, IG_LIVE_WRITE_LOCKED, igLiveWritesUnlocked, igWritesEnabled } = await import("../src/integrations/igConnection.js");
const { createIgOrders, setIgLateAcceptedHook } = await import("../src/integrations/igOrders.js");
const { createIgMarkets } = await import("../src/integrations/igMarkets.js");
const { FX_SAFETY_MARGIN, igFxIsFresh } = await import("../src/integrations/igRules.js");
const { igAccountLimits } = await import("../src/integrations/igRiskLimits.js");
const { checkOrderGate, isOpeningOrder, needsApproval, setActiveLiveCheck } = await import("../src/server/orderGate.js");
const { createIgSessions } = await import("../src/server/igSessions.js");
const { setStakeHistory, currentStake, setStakeEnvProvider } = await import("../src/risk/stakeLadder.js");
const { accountView, handleIgRoutes, LIVE_LOCKED, LIVE_READ_MISSING, liveReadAllowed } = await import("../src/server/igRoutes.js");
const { IgBroker } = await import("../src/brokers/ig.js");
const { getResults } = await import("../src/server/results.js");
const store = await import("../src/memory/store.js");

const ok = (m: string) => console.log("PASS: " + m);
const NOW0 = Date.parse("2026-10-09T10:00:00Z"); // fredag
const EPIC = "CS.D.EURUSD.MINI.IP";
const fixtureMarket = (now: () => number) => async (_e: string, epic: string) => ({
  epic, name: "EUR/USD Mini", category: "forex", expiry: "-",
  quote: { bid: 1.1, offer: 1.1, receivedAt: now() - 500, observedAt: now() - 500, delayTime: 0, marketStatus: "TRADEABLE", percentageChange: 0 },
  calculationRules: { verified: true, pointValue: 10, profitPointValue: 10, marginRate: 0.0333, pointCurrency: "SEK", executionCurrency: "SEK", priceScalingFactor: 10_000, note: "fixture" },
  dealingRules: { minDealSize: { value: 0.1 }, minNormalStopOrLimitDistance: { unit: "POINTS", value: 2 } },
  instrument: { unit: "CONTRACTS", contractSize: 10_000, scalingFactor: 10_000, currencies: [{ code: "SEK" }] },
});
const TICKET = { epic: EPIC, direction: "BUY", size: 100, orderType: "MARKET", stopLevel: 1.09, targetLevel: 1.12, holdingMinutes: 15, autoClose: false } as const;

// ══ B1: bakgrunden har ätit sin budget → Godkänn går ändå igenom; confirms/ blockeras aldrig ══
{
  const log: string[] = [];
  const fake = (async (url: string, init: any) => {
    const p = new URL(url).pathname.replace("/gateway/deal/", ""); log.push(`${init.method} ${p}`);
    const res = (body: any, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });
    if (p === "session") return res({ currentAccountId: "A1" }, { CST: "c", "X-SECURITY-TOKEN": "x" });
    if (p === "accounts") return res({ accounts: [{ accountId: "A1", accountType: "CFD", currency: "SEK", balance: { balance: 10000, available: 8000, deposit: 0, profitLoss: 0 } }] });
    if (p === "positions" && init.method === "GET") return res({ positions: [] });
    if (p === "workingorders") return res({ workingOrders: [] });
    if (p === "history/transactions") return res({ transactions: [], metadata: { pageData: { totalPages: 1 } } });
    if (p === "positions/otc") return res({ dealReference: "REF1" });
    if (p.startsWith("confirms/")) return res({ dealStatus: "ACCEPTED", dealId: "D1" });
    return res({});
  }) as typeof fetch;
  process.env.IG_ORDER_EXECUTION_ENABLED_DEMO = "true"; // bara i detta block, mot mockad fetch
  const conn = createIgConnection({ loadCredentials: () => ({ demo: { apiKey: "k", identifier: "i", password: "p" } }) as never, fetch: fake });
  await conn.testConnection("demo");
  let bg = 0;
  try { for (let i = 0; i < 100; i++) { await conn.callAuthenticated("demo", "markets/CS.D.X.MINI.IP", "GET", "4"); bg++; } } catch { /* budget slut */ }
  assert.ok(bg <= 24 - IG_ORDER_READ_NEED, `bakgrunden får högst ${24 - IG_ORDER_READ_NEED} läsningar (fick ${bg})`);
  const orders = createIgOrders({ status: conn.getStatus as never, accounts: conn.getAccounts as never, positions: conn.getPositions as never, call: conn.callAuthenticated as never,
    market: fixtureMarket(Date.now) as never, guard: async () => ({ killSwitchActive: false }), directory: path.join(tmp, "b1"), enabled: () => true });
  const before = log.length;
  const r = await withIgPriority(async () => { const d = await orders.preview("demo", TICKET as never); return orders.confirm("demo", d.id); });
  assert.equal(r.status, "accepted", `Godkänn går igenom trots full bakgrund (${r.error ?? ""})`);
  assert.equal(r.dealReference, "REF1"); assert.equal(r.dealId, "D1");
  const prio = log.slice(before);
  assert.ok(prio.includes("GET confirms/REF1"), "utfallskontrollen gjordes");
  assert.ok(prio.filter((x) => x === "GET accounts").length <= 1, "confirm återanvänder förhandsgranskningens kontoläsning");
  // Fyll hela budgeten med prioriterade läsningar: confirms/ släpps ändå (utfallskontroll blockeras aldrig).
  try { await withIgPriority(async () => { for (let i = 0; i < 100; i++) await conn.callAuthenticated("demo", "markets/CS.D.X.MINI.IP", "GET", "4"); }); } catch { /* slut */ }
  await assert.rejects(withIgPriority(() => conn.callAuthenticated("demo", "markets/CS.D.X.MINI.IP", "GET", "4")), /begränsade|budget/i);
  const late = await conn.callAuthenticated("demo", "confirms/REF1", "GET", "1") as any;
  assert.equal(late.dealStatus, "ACCEPTED", "confirms/ räknas men blockeras inte");
  delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO;
  ok(`B1 bakgrunden stoppas vid ${bg} läsningar, Godkänn → accepterad (${prio.length} IG-anrop), confirms/ undantagen budgeten`);
}

// ══ B1 + M2: okänt utfall med dealReference stäms av efter omloggning (samma konto); sen accept lägger till tidsgräns ══
{
  let clock = NOW0, gen = "g1", accountId = "ACC-1", confirmMode: "timeout" | "accepted" | "gone" = "timeout";
  const posts: string[] = [], hooked: any[] = [];
  const status = () => ({ environments: { demo: { environment: "demo", status: "connected", connectionGeneration: `demo-${gen}`, account: { accountId, accountType: "CFD", currency: "SEK", balance: 10_000, available: 8_000, profitLoss: 0 } }, live: { environment: "live", status: "disconnected", account: null } } }) as never;
  let activity: any[] = [];
  const call = async (_m: string, route: string, method: string) => {
    if (route === "workingorders") return { workingOrders: [] };
    if (route === "history/transactions") return { transactions: [], metadata: { pageData: { totalPages: 1 } } };
    if (route === "history/activity") return { activities: activity };
    if (route.startsWith("confirms/")) { if (confirmMode === "accepted") return { dealStatus: "ACCEPTED", dealId: "LATE-1" }; throw new Error(confirmMode === "gone" ? "404" : "timeout"); }
    if (method === "POST") { posts.push(route); return { dealReference: `REF-${posts.length}` }; }
    throw new Error("oväntat " + route);
  };
  setIgLateAcceptedHook((mode, d) => { hooked.push({ mode, ...d }); });
  const mk = (dir: string) => createIgOrders({ status, accounts: (async () => ({ status: "ready" })) as never, positions: (async () => ({ status: "ready", positions: [] })) as never,
    market: fixtureMarket(() => clock) as never, call: call as never, guard: async () => ({ killSwitchActive: false }), now: () => clock, directory: path.join(tmp, dir), enabled: () => true });
  const orders = mk("m2a");
  const d = await orders.preview("demo", { ...TICKET, timedExitSec: 900 } as never);
  const r = await orders.confirm("demo", d.id);
  assert.equal(r.status, "unknown"); assert.equal(r.dealReference, "REF-1");
  // IG loggar om (ny generation, samma konto). Annat konto först: avstämningen väntar.
  gen = "g2"; accountId = "ACC-OTHER"; confirmMode = "accepted"; clock += 61_000;
  await orders.tick();
  assert.equal(orders.snapshot("demo").pendingOrders.find((o: any) => o.id === d.id)?.status, "unknown", "annat konto: ingen avstämning");
  accountId = "ACC-1"; clock += 61_000;
  await orders.tick();
  const after = orders.snapshot("demo").pendingOrders.find((o: any) => o.id === d.id) as any;
  assert.equal(after.status, "accepted"); assert.equal(after.dealId, "LATE-1");
  assert.equal(posts.length, 1, "ingen omsändning");
  assert.equal(hooked.length, 1, "sen accept lägger till tidsgränsen"); assert.equal(hooked[0].timedExitSec, 900); assert.equal(hooked[0].dealId, "LATE-1");
  await orders.tick(); assert.equal(hooked.length, 1, "tidsgränsen läggs bara till en gång");
  ok("M2 + B1 okänd order med dealReference stäms av via confirms/ efter omloggning (bara samma konto); sen accept → tidsgräns en gång");

  // confirms/ svarar inte längre → IG-aktiviteten med samma dealReference avgör (manuell knapp med referens)
  const o2 = mk("m2b"); confirmMode = "timeout";
  const d2 = await o2.preview("demo", TICKET as never); const r2 = await o2.confirm("demo", d2.id);
  assert.equal(r2.status, "unknown");
  confirmMode = "gone"; gen = "g3";
  activity = [{ epic: EPIC, date: new Date(clock).toISOString().slice(0, 19), status: "ACCEPTED", dealId: "ACT-1", details: { dealReference: r2.dealReference, direction: "BUY" } }];
  const res = await o2.resolveUnknown("demo", d2.id);
  assert.equal(res.status, "accepted"); assert.equal(res.dealId, "ACT-1");
  assert.equal(posts.length, 2, "avstämning skickar inget");
  // Utan referens: matchas bara mot en position skapad efter att ordern skickades (en kandidat), annars väntar den.
  const ps: any[] = [];
  const callNoRef = async (m: string, route: string, method: string) => { if (method === "POST") { posts.push(route); throw new Error("timeout"); } return call(m, route, method); };
  const o3 = createIgOrders({ status, accounts: (async () => ({ status: "ready" })) as never, positions: (async () => ({ status: "ready", positions: ps })) as never,
    market: fixtureMarket(() => clock) as never, call: callNoRef as never, guard: async () => ({ killSwitchActive: false }), now: () => clock, directory: path.join(tmp, "m2c"), enabled: () => true });
  activity = [];
  const d3 = await o3.preview("demo", TICKET as never); const r3 = await o3.confirm("demo", d3.id);
  assert.equal(r3.status, "unknown"); assert.equal(r3.dealReference, undefined);
  ps.push({ dealId: "OLD", epic: EPIC, direction: "BUY", size: 100, createdDateUTC: new Date(clock - 3_600_000).toISOString().slice(0, 19) });
  await assert.rejects(o3.resolveUnknown("demo", d3.id), /För tidigt/, "gammal position räknas inte som ordern");
  ps.push({ dealId: "NEW", epic: EPIC, direction: "BUY", size: 100, createdDateUTC: new Date(clock).toISOString().slice(0, 19) });
  // Granskning 3 (N1): positionen i fönstret räcker inte; en ACCEPTED IG-aktivitet med samma dealId krävs.
  await assert.rejects(o3.resolveUnknown("demo", d3.id), /saknar en accepterad IG-aktivitet/, "position utan bekräftande aktivitet adopteras inte");
  activity = [{ epic: EPIC, date: new Date(clock).toISOString().slice(0, 19), status: "ACCEPTED", dealId: "NEW", details: { direction: "BUY" } }];
  const res3 = await o3.resolveUnknown("demo", d3.id);
  assert.equal(res3.status, "accepted"); assert.equal(res3.dealId, "NEW");
  ok("M2 manuell avstämning: med referens (IG-aktivitet) och utan referens (bara nya positioner), ingenting skickas om");
  setIgLateAcceptedHook(null);
}

// ══ M1: kill switch stoppar aldrig stängning/minskning; sessionen räknar bara agenternas nya ordrar ══
{
  const s = await store.loadState(); (s as any).killSwitchActive = true; await store.saveState(s);
  assert.equal((await checkOrderGate({ live: false, side: "SELL", unitsOrder: true, opening: false, source: "Sälj nu" })).ok, true, "stäng lång");
  assert.equal((await checkOrderGate({ live: false, side: "BUY", unitsOrder: true, opening: false, source: "Sälj nu" })).ok, true, "stäng kort (KÖP)");
  assert.equal((await checkOrderGate({ live: false, side: "BUY", unitsOrder: true, opening: false, source: "godkänd:Sälj nu" })).ok, true, "godkänn stängning av kort");
  assert.equal((await checkOrderGate({ live: false, side: "SELL", unitsOrder: true, opening: true, source: "agent" })).ok, false, "ny kort position stoppas");
  assert.equal((await checkOrderGate({ live: false, side: "BUY", unitsOrder: true, source: "agent" })).ok, false, "IG utan flagga behandlas som ny");
  assert.equal(isOpeningOrder({ side: "BUY", opening: false, unitsOrder: true }), false);
  (s as any).killSwitchActive = false; await store.saveState(s);

  const seen: Array<unknown> = [];
  let sess: ReturnType<typeof createIgSessions>;
  sess = createIgSessions({ binding: (e) => `${e}-g1`, activeEnv: () => "demo", guard: async () => null, now: () => NOW0, directory: path.join(tmp, "m1-sess"),
    runBatch: async () => {
      for (const input of [
        { live: false, opening: false, side: "BUY", source: "Sälj allt" },
        { live: false, opening: false, side: "SELL", source: "agent" },
        { live: false, opening: true, side: "BUY", source: "dashboard" },
        ...Array.from({ length: 6 }, () => ({ live: false, opening: true, side: "BUY", source: "agent" })),
      ]) seen.push(sess.orderGateHook(input));
      return { picks: [] };
    } });
  sess.start("demo", { epics: [EPIC], durationMinutes: 15 });
  await sess.runNext("demo");
  assert.deepEqual(seen.slice(0, 3), [null, null, null], "stängningar och Mikes egna ordrar räknas inte");
  assert.equal(seen.slice(3).filter((x) => x !== null && typeof x === "object").length, 5, "5 nya agentordrar släpps (och räknas)");
  assert.match(String(seen.at(-1)), /5 orderförsök/, "den sjätte nya agentordern stoppas");
  sess.stop("demo");
  ok("M1 kill switch släpper alla stängningar (båda riktningar); sessionen räknar bara agenternas nya positioner");
}

// ══ FX: JPY/GBP/NOK → SEK (direkt, omvänd, kors via USD) och helgkurs med 2 % marginal ══
{
  let clock = NOW0;
  const pairs: Record<string, { epic: string; bid: number; offer: number }> = {
    "GBP/SEK": { epic: "CS.D.GBPSEK.CFD.IP", bid: 13.0, offer: 13.02 },
    "SEK/NOK": { epic: "CS.D.SEKNOK.CFD.IP", bid: 1.0, offer: 1.0 + 1e-3 },
    "USD/JPY": { epic: "CS.D.USDJPY.CFD.IP", bid: 150.0, offer: 150.02 },
    "USD/SEK": { epic: "CS.D.USDSEK.CFD.IP", bid: 10.0, offer: 10.01 },
    "EUR/SEK": { epic: "CS.D.EURSEK.CFD.IP", bid: 11.0, offer: 11.01 },
  };
  let closed = false;
  const call = async (_m: string, route: string, _method: string, _v: string, _b?: unknown, opts?: { query?: string }) => {
    if (route === "markets") {
      const term = new URLSearchParams(opts?.query ?? "").get("searchTerm") ?? "";
      const hit = pairs[term];
      return { markets: hit ? [{ epic: hit.epic, instrumentName: term, instrumentType: "CURRENCIES" }] : [] };
    }
    const name = Object.keys(pairs).find((k) => route === `markets/${pairs[k]!.epic}`);
    if (!name) throw new Error("oväntat " + route);
    const x = pairs[name]!;
    return { instrument: { epic: x.epic, name, type: "CURRENCIES", streamingPricesAvailable: true, currencies: [{ code: name.slice(4), isDefault: true }] },
      snapshot: { marketStatus: closed ? "EDITS_ONLY" : "TRADEABLE", delayTime: 0, bid: x.bid, offer: x.offer, updateTimestampUTC: clock - 200, scalingFactor: 1 }, dealingRules: {} };
  };
  const status = () => ({ environments: { demo: { status: "connected", connectionGeneration: "fx-1", account: { accountId: "A", accountType: "CFD", currency: "SEK" } }, live: { status: "disconnected" } } }) as never;
  const m = createIgMarkets({ call: call as never, status, now: () => clock });
  const gbp = await m.accountFx("demo", "GBP");
  assert.ok(gbp && gbp.bid === 13.0 && gbp.path === "GBP/SEK", "GBP direkt");
  const nok = await m.accountFx("demo", "NOK");
  assert.ok(nok && Math.abs(nok.bid - 1 / 1.001) < 1e-9 && nok.path === "1/(SEK/NOK)", "NOK via omvänt par");
  const jpy = await m.accountFx("demo", "JPY");
  assert.ok(jpy && jpy.path?.includes("USD/JPY") && jpy.path.includes("USD/SEK"), `JPY kors via USD (${jpy?.path})`);
  assert.ok(Math.abs(jpy!.bid - (1 / 150.02) * 10.0) < 1e-12, "korskursens bid = 1/(USD/JPY offer) × USD/SEK bid");
  const eur = await m.accountFx("demo", "EUR");
  assert.ok(eur && igFxIsFresh(eur, "SEK", clock, "EUR"));
  // Helg: FX-marknaden stängd. Senaste verifierade kurs (fredag) används med 2 % marginal, aldrig äldre än 4 dygn.
  closed = true; clock = NOW0 + 86_400_000; // lördag
  const wk = await m.accountFx("demo", "EUR");
  assert.ok(wk?.stale, "helgkurs markerad");
  assert.equal(wk!.label, "senaste växelkurs (fredag)");
  assert.equal(wk!.safetyMargin, FX_SAFETY_MARGIN);
  assert.ok(Math.abs(wk!.bid - 11.0 * 0.98) < 1e-9 && Math.abs(wk!.offer - 11.01 * 1.02) < 1e-9, "bid sänks och offer höjs med 2 %");
  clock = NOW0 + 5 * 86_400_000;
  assert.equal(await m.accountFx("demo", "EUR"), null, "för gammal kurs används inte");
  ok("FX GBP direkt, NOK omvänt, JPY kors via USD; helg: senaste växelkurs (fredag) med 2 % marginal, högst 4 dygn");
}

// ══ M4: belopp bara för aktiv miljö. Live får LÄSAS när Live-uppgifterna finns; Live-ORDER låsta tills .env låser upp ══
{
  const a = { accountId: "X", currency: "SEK", accountType: "CFD", balance: 123_456, available: 1 };
  assert.deepEqual(accountView(a, false), { currency: "SEK", accountType: "CFD", hidden: true });
  assert.equal((accountView(a, true) as any).balance, 123_456);
  const call = async (pathname: string, method = "GET", body = "") => {
    let code = 0, out = "";
    const res = { writeHead: (c: number) => { code = c; }, end: (s: string) => { out = s; }, setHeader: () => {} } as never;
    await handleIgRoutes(new URL("http://x" + pathname), method, {} as never, res, async () => body, {}, () => undefined, () => {}, async () => ({ id: "x" }));
    return { code, body: JSON.parse(out || "{}") };
  };
  // Påhittade uppgifter i en privat tmp-fil (600). Den riktiga IG-filen läses aldrig i testet.
  const prevFile = process.env.IG_CREDENTIALS_FILE;
  const credFile = (name: string, data: unknown) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(data), { mode: 0o600 }); fs.chmodSync(f, 0o600); return f; };
  const fakeRow = { apiKey: "test-k", identifier: "test-i", password: "test-p" };
  // (a1) Live-uppgifter kompletta → läsning tillåten (inte 403), order fortsatt låsta
  process.env.IG_CREDENTIALS_FILE = credFile("creds-live.json", { demo: fakeRow, live: fakeRow });
  assert.equal(liveReadAllowed(), true);
  const h = await call("/api/ig/history?env=live");
  assert.notEqual(h.code, 403, "Live-historik får läsas"); assert.equal(h.body.env, "live");
  const c = await call("/api/ig/connect", "POST", JSON.stringify({ environment: "live" }));
  assert.notEqual(c.code, 403, "Live-inloggning (bara läsning) tillåten"); assert.notEqual(c.body.status, "locked");
  const st = await call("/api/ig/status");
  assert.equal(st.code, 200);
  assert.equal(st.body.liveRead, true); assert.equal(st.body.orderAllowed, false);
  assert.equal(st.body.liveLocked, true, "liveLocked betyder fortfarande: Live-ORDER låsta");
  assert.equal(st.body.environments.live.liveRead, true); assert.equal(st.body.environments.live.orderAllowed, false);
  assert.equal(st.body.environments.live.executionEnabled, false, "Live visas aldrig som orderläge PÅ");
  assert.match(LIVE_LOCKED, /order är låsta/); assert.match(LIVE_LOCKED, /Läsning .* tillåten/);
  // (a2) Live-uppgifter saknas → 403, ingen inloggning eller läsning mot Live
  process.env.IG_CREDENTIALS_FILE = credFile("creds-demo.json", { demo: fakeRow });
  assert.equal(liveReadAllowed(), false);
  const h2 = await call("/api/ig/history?env=live");
  assert.equal(h2.code, 403); assert.equal(h2.body.error, LIVE_READ_MISSING);
  const c2 = await call("/api/ig/connect", "POST", JSON.stringify({ environment: "live" }));
  assert.equal(c2.code, 403, "ingen Live-inloggning utan Live-uppgifter");
  const st2 = await call("/api/ig/status");
  assert.equal(st2.body.liveRead, false); assert.equal(st2.body.orderAllowed, false); assert.equal(st2.body.environments.live.locked, true);
  if (prevFile === undefined) delete process.env.IG_CREDENTIALS_FILE; else process.env.IG_CREDENTIALS_FILE = prevFile;
  // Dashboard: mäklarväljaren byter utan CFG.mode-villkor och visar fel; LIVE-knappen öppnar handelsbekräftelsen bara när Live-order är tillåtna
  const dash = fs.readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
  assert.ok(/getElementById\("broker-select"\)\.addEventListener\("change", async e=>\{\s*await switchBroker\(e\.target\.value\);/.test(dash), "mäklarväljaren byter alltid via switchBroker");
  assert.ok(dash.includes("if(m && m.liveOrdersAllowed){ openLiveConfirm(); return; }"), "handelsbekräftelsen bara när Live-order är tillåtna");
  assert.ok(dash.includes("LIVE · bara läsning, order låsta"), "Live-vy med låsta order märks tydligt");
  assert.ok(dash.includes('else if(ev.type === "broker-changed"){ if(ev.payload?.broker) applyBrokerView(ev.payload.broker); }'), "broker-changed uppdaterar allt");
  ok("M4 andra miljöns saldo döljs; Live läses (status/connect/history) när uppgifterna finns, 403 när de saknas; status: liveRead ja, orderAllowed nej");
}

// ══ M4b: HÅRT SKRIVSTOPP för IG Live. Live aktiv + order låsta → NOLL POST/PUT/DELETE mot IG (utom sessionsinloggning) ══
{
  const log: string[] = [];
  const fake = (async (url: string, init: any) => {
    const u = new URL(url), env = u.hostname.startsWith("demo-") ? "demo" : "live", p = u.pathname.replace("/gateway/deal/", "");
    const hdr = init?.headers ?? {}; log.push(`${env} ${init?.method ?? "GET"}${hdr._method ? "(" + hdr._method + ")" : ""} ${p}`);
    const res = (body: any, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });
    if (p === "session") return res({ currentAccountId: "A1" }, { CST: "c", "X-SECURITY-TOKEN": "x" });
    if (p === "accounts") return res({ accounts: [{ accountId: "A1", accountType: "CFD", currency: "SEK", balance: { balance: 10000, available: 8000, deposit: 0, profitLoss: 0 } }] });
    if (p === "positions" && (init?.method ?? "GET") === "GET") return res({ positions: [{ position: { dealId: "OWN1", direction: "BUY", size: 1, level: 1.1, currency: "SEK", createdDateUTC: "2026-10-09T09:00:00" }, market: { epic: EPIC, instrumentName: "EUR/USD Mini", bid: 1.1, offer: 1.1, marketStatus: "TRADEABLE" } }] });
    if (p === "workingorders") return res({ workingOrders: [] });
    if (p === "history/transactions") return res({ transactions: [], metadata: { pageData: { totalPages: 1 } } });
    if (p === "positions/otc" || p === "workingorders/otc") return res({ dealReference: "REF-LIVE" });
    if (p.startsWith("confirms/")) return res({ dealStatus: "ACCEPTED", dealId: "D-LIVE", affectedDeals: [{ dealId: "OWN1", status: "DELETED" }] });
    return res({});
  }) as typeof fetch;
  const liveWrites = () => log.filter((x) => x.startsWith("live ") && !/^live GET /.test(x) && x !== "live POST session");
  const saved = { MODE: process.env.MODE, LTC: process.env.LIVE_TRADING_CONFIRMED, FL: process.env.IG_ORDER_EXECUTION_ENABLED_LIVE, FD: process.env.IG_ORDER_EXECUTION_ENABLED_DEMO };
  const restore = () => { for (const [k, v] of [["MODE", saved.MODE], ["LIVE_TRADING_CONFIRMED", saved.LTC], ["IG_ORDER_EXECUTION_ENABLED_LIVE", saved.FL], ["IG_ORDER_EXECUTION_ENABLED_DEMO", saved.FD]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  // Värsta fallet: Live-orderflaggan PÅ men servern INTE startad i live (MODE/LIVE_TRADING_CONFIRMED saknas) → fortfarande låst.
  delete process.env.MODE; delete process.env.LIVE_TRADING_CONFIRMED;
  process.env.IG_ORDER_EXECUTION_ENABLED_LIVE = "true"; process.env.IG_ORDER_EXECUTION_ENABLED_DEMO = "true";
  try {
    assert.equal(igLiveWritesUnlocked(), false); assert.equal(igWritesEnabled("live"), false); assert.equal(igWritesEnabled("demo"), true);
    const conn = createIgConnection({ loadCredentials: () => ({ demo: { apiKey: "k", identifier: "i", password: "p" }, live: { apiKey: "k", identifier: "i", password: "p" } }) as never, fetch: fake });
    assert.equal((await conn.testConnection("live")).status, "connected", "Live-inloggning (POST session) släpps igenom");
    await conn.testConnection("demo");
    // 1) Direkt i igConnection: öppna, stäng (_method DELETE), arbetsorder → alla stoppas före fetch
    await assert.rejects(conn.callAuthenticated("live", "positions/otc", "POST", "2", { epic: EPIC, direction: "BUY", size: 1 }), (e: Error) => e.message === IG_LIVE_WRITE_LOCKED);
    await assert.rejects(conn.callAuthenticated("live", "positions/otc", "POST", "1", { dealId: "OWN1", direction: "SELL", size: 1, orderType: "MARKET" }, { _method: "DELETE" }), (e: Error) => e.message === IG_LIVE_WRITE_LOCKED);
    await assert.rejects(conn.callAuthenticated("live", "workingorders/otc", "POST", "2", { epic: EPIC }), (e: Error) => e.message === IG_LIVE_WRITE_LOCKED);
    // Läsning fungerar som vanligt
    assert.ok(Array.isArray((await conn.callAuthenticated("live", "positions", "GET", "2")).positions), "Live-positioner läses");
    assert.equal((await conn.getAccounts("live")).status, "ready", "Live-saldo läses");
    // 2) Orderflödet (Godkänn/orderpanel → preview+confirm) och stängning (Sälj nu / Sälj allt / tidsstängning / TP/SL → close)
    const orders = createIgOrders({ status: conn.getStatus as never, accounts: conn.getAccounts as never, positions: conn.getPositions as never, call: conn.callAuthenticated as never,
      market: fixtureMarket(Date.now) as never, guard: async () => ({ killSwitchActive: false }), directory: path.join(tmp, "m4b"), enabled: () => true });
    const draft = await withIgPriority(() => orders.preview("live", TICKET as never));
    assert.equal(draft.status, "draft", "granskning (läsning) fungerar i Live");
    await assert.rejects(withIgPriority(() => orders.confirm("live", draft.id)), /order låsta/);
    await assert.rejects(withIgPriority(() => orders.close("live", "OWN1")), /order låsta/, "egen position i IG:s app stängs aldrig");
    assert.equal(orders.snapshot("live").exitPlans.length, 0, "ingen stängningsplan/adoption skapas för Live");
    // 3) Mäklaren (placeOrder/closePosition: Godkänn, Sälj nu, Sälj allt, liveTpSl, strategier, chattens stängning)
    const live = new IgBroker("live", { status: conn.getStatus as never, connect: conn.testConnection as never, accounts: conn.getAccounts as never, positions: conn.getPositions as never,
      market: fixtureMarket(Date.now) as never, preview: orders.preview as never, confirm: orders.confirm as never, close: orders.close as never });
    assert.equal(live.executionEnabled(), false, "standard: Live-orderläget AV när .env inte låst upp Live");
    await assert.rejects(live.placeOrder({ symbol: EPIC, side: "BUY", type: "MARKET", stakeAmount: 100 } as never));
    await assert.rejects(live.closePosition("OWN1", EPIC));
    // Även om någon injicerar "på" stoppar orderflödet/skrivstoppet
    const forced = new IgBroker("live", { status: conn.getStatus as never, connect: conn.testConnection as never, accounts: conn.getAccounts as never, positions: conn.getPositions as never,
      market: fixtureMarket(Date.now) as never, preview: orders.preview as never, confirm: orders.confirm as never, close: orders.close as never, enabled: () => true });
    await assert.rejects(forced.closePosition("OWN1", EPIC));
    // 4) Tidsstängning (tradeHorizon) mot Live: standardmäklaren → "orderläget av", inget skickas
    const { closeIgAtExpiry } = await import("../src/server/tradeHorizon.js");
    await closeIgAtExpiry({ id: "m4b-x", broker: "ig", symbol: EPIC, qty: 1, live: true, exitAt: Date.now(), dealId: "OWN1" } as never, live);
    await closeIgAtExpiry({ id: "m4b-y", broker: "ig", symbol: EPIC, qty: 1, live: true, exitAt: Date.now(), dealId: "OWN1" } as never, forced);
    // 5) Bakgrundens orderslinga (tidsplaner/avstämning) läser bara
    await orders.tick();
    // 6) AUTO: medan Live visas kräver varje order Godkänn (agentens AUTO-gren nås aldrig)
    setActiveLiveCheck(() => true); assert.equal(needsApproval(), true); setActiveLiveCheck(null);
    const toolsSrc = fs.readFileSync(new URL("../src/agent/tools.ts", import.meta.url), "utf8");
    assert.ok(toolsSrc.includes('ctx.config.executionMode === "approve" || liveBroker'), "AUTO-grenen hoppas över för Live-mäklare");
    assert.deepEqual(liveWrites(), [], `inga skrivande Live-anrop nådde IG (${liveWrites().join(", ")})`);
    // Demo påverkas inte: samma skrivanrop når (den mockade) IG
    await conn.callAuthenticated("demo", "positions/otc", "POST", "2", { epic: EPIC, direction: "BUY", size: 1 });
    assert.ok(log.includes("demo POST positions/otc"), "Demo-order släpps igenom");
    // Positiv kontroll: först när .env låst upp Live (MODE=live + LIVE_TRADING_CONFIRMED + Live-flaggan) når anropet IG
    process.env.MODE = "live"; process.env.LIVE_TRADING_CONFIRMED = "true";
    assert.equal(igLiveWritesUnlocked(), true);
    await conn.callAuthenticated("live", "positions/otc", "POST", "2", { epic: EPIC, direction: "BUY", size: 1 });
    assert.deepEqual(liveWrites(), ["live POST positions/otc"], "upplåst: exakt ett anrop släpptes");
    // Flaggan av igen → låst trots MODE=live
    process.env.IG_ORDER_EXECUTION_ENABLED_LIVE = "false";
    await assert.rejects(conn.callAuthenticated("live", "positions/otc", "POST", "1", { dealId: "OWN1" }, { _method: "DELETE" }), (e: Error) => e.message === IG_LIVE_WRITE_LOCKED);
    assert.equal(liveWrites().length, 1);
    // Lager B (runt själva fetch): även om lager A skulle släppa igenom stoppar backstoppet, med oförvanskat fel
    process.env.IG_ORDER_EXECUTION_ENABLED_LIVE = "true";
    const onlyFirst = (() => { let n = 0; return () => n++ === 0; })(); // lager A får "ja", lager B får "nej"
    const connB = createIgConnection({ loadCredentials: () => ({ live: { apiKey: "k", identifier: "i", password: "p" } }) as never, fetch: fake, liveWritesUnlocked: onlyFirst });
    assert.equal((await connB.testConnection("live")).status, "connected");
    await assert.rejects(connB.callAuthenticated("live", "positions/otc", "POST", "2", { epic: EPIC, direction: "BUY", size: 1 }), (e: Error) => e.message === IG_LIVE_WRITE_LOCKED, "backstoppet stoppar, felet blir inte 'okänt utfall'");
    assert.equal(liveWrites().length, 1, "backstoppet: inget nytt skrivande Live-anrop");
    // Bakgrundsslingan (tidsplan i igOrders.tick): en Live-plan skapad medan Live var upplåst stängs INTE när Live låsts igen
    let clock = Date.now();
    const ordersT = createIgOrders({ status: conn.getStatus as never, accounts: conn.getAccounts as never, positions: conn.getPositions as never, call: conn.callAuthenticated as never,
      market: fixtureMarket(() => clock) as never, guard: async () => ({ killSwitchActive: false }), now: () => clock, directory: path.join(tmp, "m4b-tick"), enabled: () => true });
    const dT = await withIgPriority(() => ordersT.preview("live", { ...TICKET, autoClose: true } as never));
    const rT = await withIgPriority(() => ordersT.confirm("live", dT.id));
    assert.equal(rT.status, "accepted", `upplåst: Live-order accepterad (${rT.error ?? ""})`);
    assert.ok(ordersT.snapshot("live").exitPlans.some((p: any) => p.status === "scheduled"), "tidsplan skapad");
    const writesBefore = liveWrites().length;
    delete process.env.MODE; delete process.env.LIVE_TRADING_CONFIRMED; // Live låst igen
    clock += 16 * 60_000; // tidsplanens stängningstid har passerat
    await ordersT.tick();
    assert.equal(liveWrites().length, writesBefore, "låst: bakgrundsslingan skickade ingen stängning till IG Live");
    assert.ok(!ordersT.snapshot("live").exitPlans.some((p: any) => ["submitted", "confirmed"].includes(p.status)), "ingen stängning begärd");
  } finally { restore(); }
  ok("M4b skrivstopp: Live aktiv + order låsta → 0 skrivande Live-anrop från igConnection, Godkänn/confirm, stängning (Sälj nu/Sälj allt/TP/SL), mäklaren, tidsstängning, bakgrundsslingan och AUTO; Demo opåverkad; upplåst .env släpper igenom");
}

// ══ M5 + mindre 11: separat insatstrappa per miljö; IG_MAX_STAKE_PCT kan inte höjas över 3 % ══
{
  setStakeHistory(Array.from({ length: 12 }, () => 50), 10_000, "SEK", "demo");
  setStakeHistory([-10], 2_000, "SEK", "live");
  const d = currentStake("demo")!, l = currentStake("live")!;
  assert.equal(d.pct, 2); assert.equal(d.amount, 200); assert.equal(d.env, "demo");
  assert.equal(l.pct, 1); assert.equal(l.amount, 20); assert.equal(l.closed, 1);
  setStakeEnvProvider(() => "live"); assert.equal(currentStake()!.env, "live"); setStakeEnvProvider(() => "demo");
  process.env.IG_MAX_STAKE_PCT = "10"; assert.equal(igAccountLimits(10_000).maxStakePct, 3); process.env.IG_MAX_STAKE_PCT = "2"; assert.equal(igAccountLimits(10_000).maxStakePct, 2); delete process.env.IG_MAX_STAKE_PCT;
  ok("M5 Demo-trappa 2 % (12 vinster), Live-trappa 1 % (egna resultat); taket 3 % kan bara sänkas");
}

// ══ M3 + rester: inga påhittade data i UI:t som går att nå ══
{
  // Kommentarer som förklarar vad som togs bort räknas inte; bara kod och text som kan visas.
  const html = fs.readFileSync(new URL("../dashboard.html", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/AUTO-EXECUTED/.test(html), "inga falska Telegram-meddelanden");
  assert.ok(!/Träningssession/.test(html), "ingen falsk träningssession");
  assert.ok(!/Bybit LIVE/.test(html), "ingen Bybit LIVE-text");
  assert.ok(!/id="(?:set-)?binance-(?:key|secret|api)/i.test(html), "inga Binance-nyckelfält");
  assert.ok(!/function simulateTeamResponse/.test(html), "simulateTeamResponse borttagen");
  assert.ok(!/new WebSocket\([^)]*binance/i.test(html), "ingen Binance-websocket");
  const randoms = [...html.matchAll(/^.*Math\.random.*$/gm)].map((m) => m[0]);
  assert.ok(randoms.every((l) => /\bid:/.test(l)), `Math.random bara i id-strängar: ${randoms.join(" | ")}`);
  for (const fn of ["genSimAgents", "generateConfluenceAnalysis", "scanWatches", "resolveScalpTrade", "generateSetupType", "simulateExecuteTrade"]) {
    const i = html.indexOf(`function ${fn}(`);
    if (i < 0) continue;
    const body = html.slice(i, html.indexOf("\n}", i));
    assert.ok(!/Math\.random/.test(body), `${fn} slumpar inga poäng/priser`);
  }
  ok("M3 inga påhittade sessioner, poäng eller AUTO-EXECUTED; inga Binance-nycklar, ingen Bybit LIVE-text");
}

// ══ H1: order, pengar och resultat i BÅDA miljöerna (Live med orderläget av) ══
{
  const status = () => ({ environments: {
    demo: { environment: "demo", status: "connected", credentialsComplete: true, connectionGeneration: "demo-h", account: { accountId: "D", accountType: "CFD", currency: "SEK", balance: 10_000, available: 8_000, profitLoss: 0 } },
    live: { environment: "live", status: "connected", credentialsComplete: true, connectionGeneration: "live-h", account: { accountId: "L", accountType: "CFD", currency: "SEK", balance: 50_000, available: 40_000, profitLoss: 0 } } } }) as never;
  const posts: string[] = [];
  const call = async (m: string, route: string, method: string) => {
    if (route === "workingorders") return { workingOrders: [] };
    if (route === "history/transactions") return { transactions: [], metadata: { pageData: { totalPages: 1 } } };
    if (method === "POST") { posts.push(`${m} ${route}`); return { dealReference: `R-${m}` }; }
    if (route.startsWith("confirms/")) return { dealStatus: "ACCEPTED", dealId: `DEAL-${m}` };
    throw new Error("oväntat " + route);
  };
  const enabled = (e: string) => e === "demo";
  const orders = createIgOrders({ status, accounts: (async () => ({ status: "ready" })) as never, positions: (async () => ({ status: "ready", positions: [] })) as never,
    market: fixtureMarket(() => NOW0) as never, call: call as never, guard: async () => ({ killSwitchActive: false }), now: () => NOW0, directory: path.join(tmp, "h1"), enabled: enabled as never });
  const row: Record<string, Record<string, string>> = { demo: {}, live: {} };
  for (const e of ["demo", "live"] as const) {
    const d = await orders.preview(e, TICKET as never);
    row[e]!.order = d.status === "draft" ? "granskning ✓" : "✗";
    const r = await orders.confirm(e, d.id).catch((err: Error) => ({ status: "blocked", error: err.message }) as any);
    row[e]!.confirm = r.status === "accepted" ? "skickad, accepterad ✓" : /avstängt|order låsta/.test(r.error ?? "") ? "orderläget av/order låsta, inget skickat ✓" : `✗ ${r.status}`;
    const b = new IgBroker(e, { status, connect: (async () => ({})) as never, accounts: (async () => ({ status: "ready" })) as never, market: fixtureMarket(() => NOW0) as never, enabled: () => enabled(e), now: () => NOW0, observe: () => {} } as never);
    const q = await b.stakeQuote({ epic: EPIC, direction: "BUY", stake: e === "demo" ? 100 : 500, stopLoss: 1.09, takeProfit: 1.12 });
    row[e]!.money = q.ok && q.currency === "SEK" ? `insats i SEK ✓ (${q.currency})` : `✗ ${q.error}`;
    const res = await getResults({ [e === "live" ? "ig" : "ig-demo"]: { getAccount: async () => ({ currency: "SEK", balance: e === "demo" ? 10_000 : 50_000 }), getPositions: async () => [] } as never }, e === "live" ? "LIVE" : "TEST",
      [], { history: (async (env: string) => ({ status: "ready", transactions: [{ type: "DEAL", date: "2026-10-09T09:00:00", instrumentName: `${env}-affär`, size: "+1", profitAndLoss: "SEK10.00", openLevel: "1", closeLevel: "1.1" }] })) as never });
    row[e]!.results = res.env === e && res.trades.length === 1 && res.trades[0]!.coin === `${e}-affär` ? "egna resultat ✓" : "✗ blandat";
  }
  assert.deepEqual(posts, ["demo positions/otc"], "bara Demo skickade; Live med orderläget av skickade inget");
  console.log("H1-matris (fixtures):\n| | IG Demo | IG Live |\n|---|---|---|\n" + Object.keys(row.demo!).map((k) => `| ${k} | ${row.demo![k]} | ${row.live![k]} |`).join("\n"));
  for (const e of ["demo", "live"]) for (const [k, v] of Object.entries(row[e]!)) assert.ok(v.includes("✓"), `${e} ${k}: ${v}`);
  ok("H1 order (granskning, skick/stopp), pengar (SEK) och resultat körs i båda miljöerna; Live skickar inget med orderläget av");
}

// ══ Krav E5: varje orderförsök som öppnar en ny position räknas mot taket 5, oavsett utfall ══
{
  const { createIgPendingOrder, executeApprovedOrder } = await import("../src/server/api.js");
  const { setOrderGateSessionHook, updatePendingOrder } = await import("../src/server/orderGate.js");
  const EPIC2 = "CS.D.GBPUSD.MINI.IP";
  const status = () => ({ environments: { demo: { environment: "demo", status: "connected", credentialsComplete: true, connectionGeneration: "demo-e5", account: { accountId: "D", accountType: "CFD", currency: "SEK", balance: 10_000, available: 8_000, profitLoss: 0 } }, live: { environment: "live", status: "disconnected", account: null } } }) as never;
  const confirms = ["accepted", "rejected", "unknown"]; let previews = 0;
  const b = new IgBroker("demo", { status, connect: (async () => ({})) as never, accounts: (async () => ({ status: "ready" })) as never, market: fixtureMarket(() => NOW0) as never,
    positions: (async () => ({ status: "ready", positions: [{ dealId: "L1", epic: EPIC2, direction: "BUY", size: 1, level: 1.1, currency: "SEK", bid: 1.1, offer: 1.1 }] })) as never,
    preview: (async () => { previews++; if (previews === 4) throw new Error("IG begränsade antal läsningar; försök igen om en minut"); return { id: `dr-${previews}` }; }) as never,
    confirm: (async (_e: string, id: string) => { const st = confirms.shift() ?? "accepted"; return { id, status: st, dealId: st === "accepted" ? `DEAL-${id}` : undefined, error: st === "rejected" ? "IG avvisade ordern (MARKET_CLOSED)" : st === "unknown" ? "ingen bekräftelse" : undefined }; }) as never,
    enabled: () => true, now: () => NOW0, observe: () => {} } as never);
  const results: any[] = [];
  const sess = createIgSessions({ binding: (e) => `${e}-e5`, activeEnv: () => "demo", guard: async () => null, now: () => NOW0, directory: path.join(tmp, "e5-sess"),
    runBatch: async () => {
      const prop = (extra: Record<string, unknown> = {}) => createIgPendingOrder({ symbol: EPIC, side: "BUY", stakePct: 1, source: "agent", stopLoss: 1.09, takeProfit: 1.12, ...extra }, b);
      results.push(await prop()); // 1 → accepterad
      results.push(await prop()); // 2 → avvisad av IG
      results.push(await prop()); // 3 → okänt utfall
      results.push(await prop({ quantity: 1_000_000 })); // 4 → stoppad redan av insats/budget
      results.push(await prop()); // 5 → stoppad efter Godkänn (IG-läsgräns)
      results.push(await createIgPendingOrder({ symbol: EPIC2, side: "SELL", stakePct: 1, source: "agent" }, b)); // stängning: räknas inte
      results.push(await prop()); // 6 → taket nått
      return { picks: [] };
    } });
  setOrderGateSessionHook((i) => sess.orderGateHook(i), null, (tag, o, note) => sess.recordAttemptOutcome(tag as never, o, note ?? null));
  sess.start("demo", { epics: [EPIC], durationMinutes: 15 });
  await sess.runNext("demo");
  assert.equal(results[3].ok, false, "försök 4 stoppas av insats/budget");
  assert.equal(results[5].ok, true, results[5].error); assert.equal(results[5].pendingOrder.closeDealId, "L1", "stängningen släpps");
  assert.equal(results[6].ok, false); assert.match(results[6].error, /5\/5 orderförsök/, "sjätte försöket stoppas av taket");
  for (const i of [0, 1, 2, 4]) { assert.equal(results[i].ok, true, results[i].error); assert.ok(results[i].pendingOrder.sessionAttempt, "väntande order bär sitt försök"); }
  // Godkänn: accepterad, avvisad, okänd, stoppad. Inget av dem lämnar tillbaka ett försök.
  for (const i of [0, 1, 2, 4]) await executeApprovedOrder(results[i].pendingOrder, { "ig-demo": b } as never);
  const x = sess.state("demo").session!;
  assert.equal(x.orderAttempts, 5, "5 försök räknade");
  assert.deepEqual(x.attempts!.map((a) => a.outcome), ["accepterad", "avvisad", "okänd", "stoppad", "stoppad"]);
  assert.ok(x.attempts!.every((a) => a.epic === EPIC), "stängningen finns inte i listan");
  assert.match(String(x.attempts![4]!.note), /begränsade/);
  sess.stop("demo");
  // Nekad i Väntande ordrar räknas också (egen session).
  let pend: any = null;
  const sess2Batch = createIgSessions({ binding: (e) => `${e}-e5b`, activeEnv: () => "demo", guard: async () => null, now: () => NOW0, directory: path.join(tmp, "e5-sess2"),
    runBatch: async () => { pend = await createIgPendingOrder({ symbol: EPIC, side: "BUY", stakePct: 1, source: "agent", stopLoss: 1.09, takeProfit: 1.12 }, b); return { picks: [] }; } });
  setOrderGateSessionHook((i) => sess2Batch.orderGateHook(i), null, (tag, o, note) => sess2Batch.recordAttemptOutcome(tag as never, o, note ?? null));
  sess2Batch.start("demo", { epics: [EPIC], durationMinutes: 15 }); await sess2Batch.runNext("demo");
  assert.equal(pend.ok, true, pend.error);
  await updatePendingOrder(pend.pendingOrder.id, { status: "rejected" });
  const y = sess2Batch.state("demo").session!;
  assert.equal(y.orderAttempts, 1); assert.equal(y.attempts![0]!.outcome, "nekad");
  sess2Batch.stop("demo"); setOrderGateSessionHook(null);
  const html = fs.readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
  assert.ok(html.includes("${x.orderAttempts}/${x.maxOrderAttempts} orderförsök"), "sessionen visar x/5 orderförsök");
  ok("E5 accepterad, avvisad, okänd, stoppad (före och efter Godkänn) och nekad räknas; stängningar räknas inte; sjätte försöket stoppas; UI visar x/5 orderförsök");
}

// ══ TradingView-analysdiagram: säker symbolmappning, intervall, etikett; ingen orderkoppling ══
{
  const vm = await import("node:vm");
  const html = fs.readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).find((x) => x.includes("window.TVW ="));
  assert.ok(src, "TradingView-modulen finns");
  const sandbox: any = { window: {}, document: { getElementById: () => null }, URLSearchParams, JSON, setInterval: () => 0, setTimeout: () => 0 };
  vm.createContext(sandbox); vm.runInContext(src!, sandbox);
  const TVW = sandbox.window.TVW;
  assert.equal(TVW.LABEL, "TradingView · analysdiagram · inte IG:s priser");
  assert.equal(TVW.map("CS.D.EURUSD.MINI.IP", "EUR/USD Mini"), "FX:EURUSD");
  assert.equal(TVW.map("CS.D.USDSEK.CFD.IP", "USD/SEK"), "OANDA:USDSEK");
  assert.equal(TVW.map("CS.D.BITCOIN.CFD.IP", "Bitcoin"), "BITSTAMP:BTCUSD");
  assert.equal(TVW.map("CS.D.ETHUSD.CFD.IP", "Ether"), "COINBASE:ETHUSD");
  assert.equal(TVW.map("CS.D.GBPUSD.MINI.IP", "EUR/USD Mini"), null, "namn och EPIC stämmer inte: ingen gissning");
  assert.equal(TVW.map("IX.D.OMX.IFM.IP", "OMX Stockholm 30"), null, "okänt: symbolsökning");
  assert.equal(TVW.map("CS.D.DOGEUSD.CFD.IP", "Dogecoin"), null, "krypto utan säker mappning: symbolsökning");
  assert.equal(TVW.interval("1h"), "60"); assert.equal(TVW.interval("4h"), "240"); assert.equal(TVW.interval("1d"), "D"); assert.equal(TVW.interval("1m"), "1");
  const u = new URL(TVW.url("FX:EURUSD", "15m"));
  assert.equal(u.host, "s.tradingview.com"); assert.equal(u.searchParams.get("interval"), "15"); assert.equal(u.searchParams.get("theme"), "dark");
  assert.equal(u.searchParams.get("hide_side_toolbar"), "0", "ritverktyg på");
  assert.match(u.searchParams.get("overrides") ?? "", /#10b981/); assert.match(u.searchParams.get("overrides") ?? "", /#ef4444/);
  assert.ok(!/\b(?:order\w*|deal\w*|fetch)\b|positions\/otc|api\/ig/i.test(src!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/orderpanelen|inga order/gi, "")), "widgeten anropar inga order- eller IG-funktioner");
  ok("TradingView: säker mappning (FX/OANDA, BITSTAMP/COINBASE), annars symbolsökning; intervall, mörkt tema, grönt/rött, etikett, inga orderfunktioner");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("Granskning 2: alla tester godkända (endast mocks, inga nätverksanrop)");
process.exit(0); // api.ts startar timers vid import
