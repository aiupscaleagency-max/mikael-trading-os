// Granskning 3 (N1–N4 + FX-rimlighet): granskarens simulering r3sim/late.mts som fixturetest.
// Bara mockad fetch och injicerade beroenden. Inga nätverksanrop mot IG, Vercel eller Tiingo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-review3-"));
process.env.TRADING_DATA_DIR = tmp;
process.env.AGENT_TREE_TRADING_EVENTS = "off";
delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO; delete process.env.IG_ORDER_EXECUTION_ENABLED_LIVE;
delete process.env.LIVE_TRADING_CONFIRMED;
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;

const { createIgConnection, withIgPriority } = await import("../src/integrations/igConnection.js");
const { createIgOrders, setIgLateAcceptedHook } = await import("../src/integrations/igOrders.js");
const { createIgMarkets } = await import("../src/integrations/igMarkets.js");
const { igFxPlausibility, igPairQuote, FX_MAX_DEVIATION } = await import("../src/integrations/igRules.js");

const ok = (m: string) => console.log("PASS: " + m);
const iso = (t: number) => new Date(t).toISOString().slice(0, 19);
const EPIC = "CS.D.EURUSD.MINI.IP";

// ══ Granskarens simulering (r3sim/late.mts), med falsk fetch mot en riktig createIgConnection ══
{
  // Bara i den här testprocessen och bara mot den falska fetch:en; standard i koden är fortfarande AV.
  process.env.IG_ORDER_EXECUTION_ENABLED_DEMO = "true";
  let clock = Date.parse("2026-10-09T10:00:00Z"); const NOW = () => clock;
  const log: string[] = []; let confirmsFail = false, postFail = false;
  let openPositions: any[] = [], activities: any[] = [];
  const fake = (async (url: string, init: any) => {
    const u = new URL(url); const p = u.pathname.replace("/gateway/deal/", ""); log.push(`${init.method} ${p}`);
    const okr = (body: any, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });
    if (p === "session") return okr({ currentAccountId: "ACC1234" }, { CST: "c", "X-SECURITY-TOKEN": "x" });
    if (p === "accounts") return okr({ accounts: [{ accountId: "ACC1234", accountType: "CFD", currency: "SEK", balance: { balance: 100000, available: 80000, deposit: 0, profitLoss: 0 } }] });
    if (p === "positions" && init.method === "GET") return okr({ positions: openPositions });
    if (p === "workingorders") return okr({ workingOrders: [] });
    if (p === "history/transactions") return okr({ transactions: [], metadata: { pageData: { totalPages: 1 } } });
    if (p === "history/activity") return okr({ activities });
    if (p.startsWith("markets/")) return okr({});
    if (p === "positions/otc") { if (postFail) throw new Error("timeout"); return okr({ dealReference: "REF1" }); }
    if (p.startsWith("confirms/")) { if (confirmsFail) return new Response("{}", { status: 500 }); return okr({ dealStatus: "ACCEPTED", dealId: "D1" }); }
    return okr({});
  }) as any;
  const conn = createIgConnection({ loadCredentials: () => ({ demo: { apiKey: "k", identifier: "i", password: "p" } }), fetch: fake, now: NOW } as any);
  await conn.testConnection("demo");
  const market = async (_e: string, epic: string) => {
    await conn.callAuthenticated("demo", `markets/${epic}`, "GET", "4");
    return { epic, name: "EUR/USD Mini", expiry: "-",
      quote: { bid: 1.1, offer: 1.1, receivedAt: NOW() - 500, observedAt: NOW() - 500, delayTime: 0, marketStatus: "TRADEABLE" },
      calculationRules: { verified: true, pointValue: 10, profitPointValue: 10, marginRate: 0.0333, pointCurrency: "SEK", executionCurrency: "SEK", priceScalingFactor: 10000 },
      dealingRules: { minDealSize: { value: 0.1 }, minNormalStopOrLimitDistance: { unit: "POINTS", value: 2 } },
      instrument: { unit: "CONTRACTS", contractSize: 10000, scalingFactor: 10000, currencies: [{ code: "SEK" }] } };
  };
  const hooks: any[] = []; setIgLateAcceptedHook((m, d) => hooks.push({ m, ...d }));
  const mk = (dir: string) => createIgOrders({ status: conn.getStatus as any, accounts: conn.getAccounts as any, positions: conn.getPositions as any, call: conn.callAuthenticated as any,
    market: market as any, guard: async () => ({ killSwitchActive: false }), directory: path.join(tmp, dir), enabled: () => true, now: NOW, identity: conn.getAccountIdentity as any });
  const input = { epic: EPIC, direction: "BUY", size: 1, orderType: "MARKET", stopLevel: 1.09, targetLevel: 1.12, holdingMinutes: 15, autoClose: false, timedExitSec: 900 };

  // 1. Värsta fallet: bakgrunden mättad, N öppna positioner med kalla marknadsläsningar.
  //    Antingen accepteras ordern, eller så stoppar läsgränsen den FÖRE POST (aldrig "okänd").
  const orders = mk("o1"); const results: string[] = [];
  for (const N of [0, 2, 3, 4, 6]) {
    clock += 61000;
    openPositions = Array.from({ length: N }, (_, i) => ({ position: { dealId: "P" + i, direction: "BUY", size: 1, level: 1.1, currency: "SEK", createdDateUTC: iso(clock - 3600e3) }, market: { epic: "CS.D.X" + i + ".MINI.IP" } }));
    try { for (;;) await conn.callAuthenticated("demo", "markets/CS.D.BG.MINI.IP", "GET", "4"); } catch { /* bakgrunden mättad */ }
    const before = log.length;
    try {
      const r = await withIgPriority(async () => { const d = await orders.preview("demo", input); return orders.confirm("demo", d.id); });
      results.push(`${N}:${r.status}`);
      assert.equal(r.status, "accepted", `N=${N}`);
      assert.equal((r as any).accountRef, undefined, "kontoreferensen lämnar aldrig servern");
      openPositions.push({ position: { dealId: "D1", direction: "BUY", size: 1, level: 1.1, currency: "SEK" }, market: { epic: input.epic } });
      await conn.getPositions("demo"); orders.snapshot("demo", [{ dealId: "D1" }]);
    } catch (e) {
      results.push(`${N}:stopp`);
      assert.ok(!log.slice(before).includes("POST positions/otc"), `N=${N}: inget skickas när läsgränsen stoppar`);
    }
  }
  assert.deepEqual(results.slice(0, 3), ["0:accepted", "2:accepted", "3:accepted"], results.join(","));
  ok(`sim 1: värsta läsbudget ${results.join(" ")} (stopp sker före POST, aldrig okänt)`);

  // 2. Okänd med dealReference, IG loggar om, tick stämmer av AUTOMATISKT → tidsstängning exakt en gång.
  clock += 61000; openPositions = []; confirmsFail = true;
  const o2 = mk("o2");
  const r2 = await withIgPriority(async () => { const d = await o2.preview("demo", input); return o2.confirm("demo", d.id); });
  assert.equal(r2.status, "unknown"); assert.equal(r2.dealReference, "REF1");
  await conn.testConnection("demo"); confirmsFail = false; clock += 61000;
  await o2.tick();
  assert.deepEqual(o2.snapshot("demo").pendingOrders.map((d: any) => `${d.status}/${d.dealId}`), ["accepted/D1"]);
  assert.equal(hooks.length, 1, "automatisk avstämning via dealReference lägger till tidsstängningen");
  await o2.tick(); assert.equal(hooks.length, 1, "bara en gång");
  ok("sim 2: dealReference + omloggning → tick stämmer av och lägger till tidsstängningen en gång");

  // 3. N1: POST timeout (ingen referens). Ordern nådde aldrig IG. Mike öppnar själv samma EPIC/riktning/storlek.
  hooks.length = 0; postFail = true;
  const scenario = async (dir: string, openedAfterMs: number, act: "same" | "other" | "none", dated = true) => {
    clock += 61000; openPositions = []; activities = [];
    const o = mk(dir);
    const r = await withIgPriority(async () => { const d = await o.preview("demo", input); return o.confirm("demo", d.id); });
    assert.equal(r.status, "unknown"); assert.equal(r.dealReference, undefined);
    const sent = clock; clock += openedAfterMs;
    openPositions = [{ position: { dealId: "MANUAL9", direction: "BUY", size: 1, level: 1.1, currency: "SEK", ...(dated ? { createdDateUTC: iso(clock) } : {}) }, market: { epic: input.epic } }];
    if (act !== "none") activities = [{ epic: input.epic, direction: "BUY", date: iso(clock), status: "ACCEPTED", dealId: act === "same" ? "MANUAL9" : "OTHER", details: { direction: "BUY", dealReference: "MANUALREF" } }];
    clock = sent + 200000;
    return { o, id: r.id };
  };
  // a) Manuell position 90 s efter sändningen (utanför fönstret): adopteras INTE, ingen tidsstängning.
  {
    const { o, id } = await scenario("o3a", 90_000, "same");
    const res = await o.resolveUnknown("demo", id) as any;
    assert.equal(res.status, "rejected"); assert.equal(res.dealId, null);
    assert.match(res.note, /MANUAL9.*utanför tidsfönstret.*rörs inte/);
    assert.equal(hooks.length, 0, "Mikes egen position får ingen tidsstängning");
  }
  // b) Granskarens exakta fall (+30 s, ACCEPTED-aktivitet med samma dealId): adopteras, men INGEN tidsstängning
  //    förrän Mike uttryckligen svarar ja. Nej → aldrig.
  {
    const { o, id } = await scenario("o3b", 30_000, "same");
    const res = await o.resolveUnknown("demo", id) as any;
    assert.equal(res.status, "accepted"); assert.equal(res.dealId, "MANUAL9");
    assert.equal(hooks.length, 0, "manuell avstämning lägger aldrig själv till tidsstängning");
    assert.equal(res.timedExitOffer?.dealId, "MANUAL9", "frågan 'tidsstängning saknas – lägg till?' ställs");
    assert.equal((o.snapshot("demo") as any).exitOffers.length, 1);
    await o.tick(); assert.equal(hooks.length, 0, "tick lägger inte heller till den");
    const no = await o.answerLateExit("demo", id, false);
    assert.equal(no.added, false); assert.equal(hooks.length, 0);
    assert.equal((o.snapshot("demo") as any).exitOffers.length, 0);
    await assert.rejects(o.answerLateExit("demo", id, true), /Ingen tidsstängning att ta ställning till/, "ett nej står sig");
  }
  // c) Samma fall, Mike svarar uttryckligen ja → tidsstängningen läggs till exakt en gång.
  {
    const { o, id } = await scenario("o3c", 10_000, "same");
    const res = await o.resolveUnknown("demo", id) as any;
    assert.equal(res.status, "accepted"); assert.equal(hooks.length, 0);
    const yes = await o.answerLateExit("demo", id, true);
    assert.equal(yes.added, true); assert.equal(hooks.length, 1); assert.equal(hooks[0].dealId, "MANUAL9");
    await assert.rejects(o.answerLateExit("demo", id, true), /Ingen tidsstängning/); assert.equal(hooks.length, 1);
    hooks.length = 0;
  }
  // d) Position i fönstret men aktiviteten har ett annat dealId, eller saknas: ingen adoption, inget ändras.
  for (const act of ["other", "none"] as const) {
    const { o, id } = await scenario("o3d-" + act, 10_000, act);
    await assert.rejects(o.resolveUnknown("demo", id), /saknar en accepterad IG-aktivitet med samma dealId/);
    assert.equal(o.snapshot("demo").pendingOrders.find((d: any) => d.id === id)?.status, "unknown", "ordern ligger kvar som okänd");
  }
  // e) Positionen saknar öppningstid: fråga i stället för att markera som avvisad.
  {
    const { o, id } = await scenario("o3e", 10_000, "none", false);
    await assert.rejects(o.resolveUnknown("demo", id), /saknar öppningstid/);
    assert.equal(o.snapshot("demo").pendingOrders.find((d: any) => d.id === id)?.status, "unknown");
  }
  // f) Med dealReference och manuell knapp: accepterad, men tidsstängningen kräver också Mikes ja.
  {
    postFail = false; confirmsFail = true; clock += 61000; openPositions = []; activities = [];
    const o = mk("o3f");
    const r = await withIgPriority(async () => { const d = await o.preview("demo", input); return o.confirm("demo", d.id); });
    assert.equal(r.status, "unknown"); confirmsFail = false; clock += 61000;
    const res = await o.resolveUnknown("demo", r.id) as any;
    assert.equal(res.status, "accepted"); assert.equal(res.dealId, "D1");
    assert.equal(hooks.length, 0); assert.ok(res.timedExitOffer);
    await o.tick(); assert.equal(hooks.length, 0);
  }
  setIgLateAcceptedHook(null);
  delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO;
  ok("sim 3 / N1: utan referens adopteras bara en position inom −60/+30 s med ACCEPTED-aktivitet med samma dealId; manuell avstämning lägger aldrig till tidsstängning utan uttryckligt ja");
}

// ══ N2 + N4: stängningens sändtid skrivs aldrig om; kontomatchning på fullt konto-id ══
{
  let clock = Date.parse("2026-10-09T12:00:00Z"); let fullId = "ACC1234", gen = "g1";
  const status = () => ({ environments: { demo: { environment: "demo", status: "connected", connectionGeneration: `demo-${gen}`, account: { accountId: `••••${fullId.slice(-4)}`, accountType: "CFD", currency: "SEK", balance: 10_000, available: 8_000, profitLoss: 0 } }, live: { environment: "live", status: "disconnected", account: null } } }) as never;
  const ps: any[] = [{ dealId: "POS1", epic: EPIC, direction: "BUY", size: 1, level: 1.1, currency: "SEK" }];
  const posts: string[] = [];
  const call = async (_m: string, route: string, method: string) => {
    if (method === "POST") { posts.push(route); throw new Error("timeout"); }
    if (route === "history/activity") return { activities: [] };
    throw new Error("oväntat " + route);
  };
  const market = async (_e: string, epic: string) => ({ epic, expiry: "-", quote: { bid: 1.1, offer: 1.1, receivedAt: clock - 500, observedAt: clock - 500, delayTime: 0, marketStatus: "TRADEABLE" } });
  const o = createIgOrders({ status, positions: (async () => ({ status: "ready", positions: ps })) as never, market: market as never, call: call as never,
    guard: async () => ({ killSwitchActive: false }), now: () => clock, directory: path.join(tmp, "n2"), enabled: () => true, identity: () => ({ accountId: fullId }) });
  const plan = await o.close("demo", "POS1") as any;
  assert.equal(plan.status, "unknown"); assert.equal(plan.accountRef, undefined, "kontoreferensen lämnar aldrig servern");
  const submittedAt = plan.submittedAt;
  // N4: annat konto med samma fyra sista siffror är inloggat → ingen avstämning.
  fullId = "ZZZ1234"; gen = "g2";
  await assert.rejects(o.resolveUnknown("demo", "POS1"), /annat IG-konto/, "samma fyra sista siffror räcker inte");
  fullId = "ACC1234";
  // N2: positionen syns fortfarande inom 2 min → fråga igen, ändra varken status eller sändtid.
  clock += 30_000;
  await assert.rejects(o.resolveUnknown("demo", "POS1"), /För tidigt/);
  let snap = o.snapshot("demo").exitPlans.find((p: any) => p.dealId === "POS1") as any;
  assert.equal(snap.status, "unknown"); assert.equal(snap.submittedAt, submittedAt, "sändtiden är orörd");
  assert.equal(snap.accountRef, undefined);
  // Efter 2 min med positionen kvar: misslyckad (sändtiden fortfarande orörd).
  clock += 120_000;
  const res = await o.resolveUnknown("demo", "POS1") as any;
  assert.equal(res.status, "failed");
  snap = JSON.parse(fs.readFileSync(path.join(tmp, "n2", "demo.json"), "utf8")).plans.find((p: any) => p.dealId === "POS1");
  assert.equal(snap.status, "failed"); assert.equal(snap.submittedAt, submittedAt, "sparad sändtid orörd");
  assert.equal(posts.length, 1, "avstämningen skickar inget");
  ok("N2 manuell avstämning av stängning skriver aldrig om sändtiden; N4 kontomatchning på fullt konto-id (samma fyra sista siffror räcker inte)");
}
// N4: äldre utkast med maskerad referens matchas fortfarande mot samma maskning (ingen permanent låsning).
{
  let clock = Date.parse("2026-10-09T13:00:00Z");
  const dir = path.join(tmp, "n4legacy"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "demo.json"), JSON.stringify({ drafts: [{ id: "old-1", environment: "demo", binding: "demo-old", accountRef: "••••1234", epic: EPIC, direction: "BUY", size: 1, orderType: "MARKET", entry: 1.1, stopLevel: 1.09, targetLevel: 1.12, holdingMinutes: 15, autoClose: false, createdAt: clock - 600_000, submittedAt: clock - 600_000, expiresAt: clock, status: "unknown", body: {}, risk: 1, exposure: 1, margin: 1, currency: "SEK", executionCurrency: "SEK" }], plans: [] }));
  const status = () => ({ environments: { demo: { status: "connected", connectionGeneration: "demo-new", account: { accountId: "••••1234", accountType: "CFD", currency: "SEK" } }, live: { status: "disconnected" } } }) as never;
  let fullId = "QQQ9999";
  const call = async (_m: string, route: string) => { if (route === "history/activity") return { activities: [] }; throw new Error("oväntat " + route); };
  const o = createIgOrders({ status, positions: (async () => ({ status: "ready", positions: [] })) as never, call: call as never, now: () => clock, directory: dir, enabled: () => false, identity: () => ({ accountId: fullId }) });
  await assert.rejects(o.resolveUnknown("demo", "old-1"), /annat IG-konto/);
  fullId = "QQQ1234";
  const res = await o.resolveUnknown("demo", "old-1") as any;
  assert.equal(res.status, "rejected");
  ok("N4 äldre maskerad kontoreferens jämförs mot samma maskning av det fulla id:t");
}

// ══ FX-rimlighet: > 20 % från senaste verifierade kurs, eller direkt/omvänd/kors som inte stämmer → tydligt besked ══
{
  // Ren regel
  const last = { bid: 10.0, offer: 10.01, observedAt: 0 };
  assert.equal(igFxPlausibility("USD", "SEK", { bid: 10.3, offer: 10.31 }, [], last, 1000), null, "3 % rörelse godtas");
  assert.match(String(igFxPlausibility("USD", "SEK", { bid: 100_300, offer: 100_310 }, [], last, 1000)), /avviker .* från senaste verifierade kurs/);
  assert.match(String(igFxPlausibility("USD", "SEK", { bid: 12.5, offer: 12.51 }, [], last, 1000)), /avviker 25 %/);
  assert.equal(FX_MAX_DEVIATION, 0.2);
  assert.match(String(igFxPlausibility("USD", "SEK", { bid: 10, offer: 10.01, path: "USD/SEK" }, [{ bid: 12.5, offer: 12.6, path: "1/(SEK/USD)" }], null, 0)), /stämmer inte mellan vägarna/);
  assert.equal(igFxPlausibility("USD", "SEK", { bid: 10, offer: 10.01 }, [{ bid: 10.01, offer: 10.02, path: "x" }], null, 0), null);
  // N3: parets egna instrumentregler: kvotvalutan måste vara parets och skalningen positiv.
  const q = { marketStatus: "TRADEABLE", delayTime: 0, bid: 10, offer: 10.01, receivedAt: 1000, observedAt: 1000 };
  assert.ok(igPairQuote({ type: "CURRENCIES", name: "USD/SEK", epic: "E", quote: q, instrument: { currencies: [{ code: "SEK", isDefault: true }], scalingFactor: 1 } }, "USD", "SEK", 1000));
  assert.equal(igPairQuote({ type: "CURRENCIES", name: "USD/SEK", epic: "E", quote: q, instrument: { currencies: [{ code: "USD", isDefault: true }], scalingFactor: 1 } }, "USD", "SEK", 1000), null, "fel kvotvaluta");
  assert.equal(igPairQuote({ type: "CURRENCIES", name: "USD/SEK", epic: "E", quote: q, instrument: { currencies: [{ code: "SEK", isDefault: true }], scalingFactor: 0 } }, "USD", "SEK", 1000), null, "skalning 0");

  // Fixture-marknader (samma form som granskning 2)
  let clock = Date.parse("2026-10-09T10:00:00Z"), currency = "SEK";
  const pairs: Record<string, { epic: string; bid: number; offer: number }> = {
    "USD/SEK": { epic: "CS.D.USDSEK.CFD.IP", bid: 10.0, offer: 10.01 },
    "EUR/USD": { epic: "CS.D.EURUSD.CFD.IP", bid: 1.1, offer: 1.1001 },
    "EUR/SEK": { epic: "CS.D.EURSEK.CFD.IP", bid: 11.0, offer: 11.01 },
    "GBP/SEK": { epic: "CS.D.GBPSEK.CFD.IP", bid: 13.0, offer: 13.02 },
  };
  const call = async (_m: string, route: string, _method: string, _v: string, _b?: unknown, opts?: { query?: string }) => {
    if (route === "markets") {
      const term = new URLSearchParams(opts?.query ?? "").get("searchTerm") ?? "";
      const hit = pairs[term];
      return { markets: hit ? [{ epic: hit.epic, instrumentName: term, instrumentType: "CURRENCIES" }] : [] };
    }
    const name = Object.keys(pairs).find((k) => route === `markets/${pairs[k]!.epic}`);
    if (!name) {
      // Ett vanligt instrument noterat i USD (för market() → calculationRules)
      if (route === "markets/IX.D.SPTRD.IFE.IP") return { instrument: { epic: "IX.D.SPTRD.IFE.IP", name: "US 500", type: "INDICES", unit: "AMOUNT", onePipMeans: "1", valueOfOnePip: "1", currencies: [{ code: "USD", isDefault: true }], marginFactor: 5, marginFactorUnit: "PERCENTAGE", marginDepositBands: [] }, snapshot: { marketStatus: "TRADEABLE", delayTime: 0, bid: 5000, offer: 5001, updateTimestampUTC: clock - 200, scalingFactor: 1 }, dealingRules: { minDealSize: { value: 1 } } };
      throw new Error("oväntat " + route);
    }
    const x = pairs[name]!;
    return { instrument: { epic: x.epic, name, type: "CURRENCIES", streamingPricesAvailable: true, currencies: [{ code: name.slice(4), isDefault: true }] },
      snapshot: { marketStatus: "TRADEABLE", delayTime: 0, bid: x.bid, offer: x.offer, updateTimestampUTC: clock - 200, scalingFactor: 1 }, dealingRules: {} };
  };
  const status = () => ({ environments: { demo: { status: "connected", connectionGeneration: "fx-1", account: { accountId: "A", accountType: "CFD", currency } }, live: { status: "disconnected" } } }) as never;
  const m = createIgMarkets({ call: call as never, status, now: () => clock });

  // 1. Giltig kurs sparas som senaste verifierade.
  const usd = await m.accountFx("demo", "USD");
  assert.ok(usd && usd.bid === 10.0, "USD/SEK verifierad");
  // 2. Kvoten kommer plötsligt skalad (×10 000): avvisas mot senaste kurs; INGEN fallback till äldre kurs.
  clock += 61_000; pairs["USD/SEK"]!.bid = 100_000; pairs["USD/SEK"]!.offer = 100_100;
  assert.equal(await m.accountFx("demo", "USD"), null, "orimlig kurs ger ingen storlek");
  assert.match(String(m.accountFxError("demo", "USD")), /USD\/SEK .* avviker .* från senaste verifierade kurs/);
  const mk = await m.market("demo", "IX.D.SPTRD.IFE.IP") as any;
  assert.equal(mk.calculationRules.verified, false); assert.equal(mk.calculationRules.pointValue, null);
  assert.match(mk.calculationRules.fxError, /avviker/); assert.equal(mk.calculationRules.note, mk.calculationRules.fxError);
  // 3. Rimlig igen → godtas och beskedet försvinner.
  clock += 61_000; pairs["USD/SEK"]!.bid = 10.2; pairs["USD/SEK"]!.offer = 10.21;
  assert.ok((await m.accountFx("demo", "USD"))?.bid === 10.2); assert.equal(m.accountFxError("demo", "USD"), null);
  // 4. Direkt och omvänt par säger olika (SEK/USD finns också och pekar på 12,5): avvisas.
  clock += 61_000; pairs["SEK/USD"] = { epic: "CS.D.SEKUSD.CFD.IP", bid: 0.08, offer: 0.0801 };
  const gm = createIgMarkets({ call: call as never, status, now: () => clock });
  assert.equal(await gm.accountFx("demo", "USD"), null);
  assert.match(String(gm.accountFxError("demo", "USD")), /stämmer inte mellan vägarna USD\/SEK .* 1\/\(SEK\/USD\)/);
  delete pairs["SEK/USD"];
  // 5. Kors via USD stämmer inte med direkt EUR/SEK (USD-benen redan cachade, inga extra läsningar).
  clock += 61_000; pairs["USD/SEK"]!.bid = 12.0; pairs["USD/SEK"]!.offer = 12.01;
  const cm = createIgMarkets({ call: call as never, status, now: () => clock });
  currency = "USD"; assert.ok(await cm.accountFx("demo", "EUR"), "EUR/USD-benet cachas");
  currency = "SEK"; assert.ok(await cm.accountFx("demo", "USD"), "USD/SEK-benet cachas");
  assert.equal(await cm.accountFx("demo", "EUR"), null, "EUR/SEK 11 mot kors 1,1 × 12 = 13,2");
  assert.match(String(cm.accountFxError("demo", "EUR")), /stämmer inte mellan vägarna EUR\/SEK .* EUR\/USD × USD\/SEK/);
  // 6. Ordervalideringen visar beskedet i stället för att räkna storlek.
  const orders = createIgOrders({
    status: (() => ({ environments: { demo: { status: "connected", connectionGeneration: "fx-1", account: { accountId: "A", accountType: "CFD", currency: "SEK", balance: 10_000, available: 8_000, profitLoss: 0 } }, live: { status: "disconnected" } } })) as never,
    accounts: (async () => ({ status: "ready" })) as never, positions: (async () => ({ status: "ready", positions: [] })) as never,
    market: (async (_e: string, epic: string) => ({ epic, expiry: "-", quote: { bid: 1, offer: 1, receivedAt: clock - 100, observedAt: clock - 100, delayTime: 0, marketStatus: "TRADEABLE" }, calculationRules: { verified: false, pointValue: null, fxError: "Växelkursen USD/SEK avviker 99 % från senaste verifierade kurs" }, dealingRules: {}, instrument: { currencies: [{ code: "USD" }] } })) as never,
    call: (async (_m: string, route: string) => { if (route === "workingorders") return { workingOrders: [] }; if (route === "history/transactions") return { transactions: [], metadata: { pageData: { totalPages: 1 } } }; throw new Error("oväntat " + route); }) as never,
    guard: async () => ({ killSwitchActive: false }), now: () => clock, directory: path.join(tmp, "fxorders"), enabled: () => false });
  await assert.rejects(orders.preview("demo", { epic: "IX.D.SPTRD.IFE.IP", direction: "BUY", size: 1, orderType: "MARKET", stopLevel: 0.9, targetLevel: 1.2, holdingMinutes: 15, autoClose: false }), /Växelkursen USD\/SEK avviker/);
  ok("FX-rimlighet: > 20 % från senaste verifierade kurs, direkt mot omvänt och direkt mot kors avvisas med tydligt besked; ingen storlek, ingen fallback");
}

{
  // Lördagskontrollen på dator 1: EUR/USD Mini kom som 11201,05 (IG-punkter). UI visar vanlig kurs bredvid; krypto och skala 1 lämnas orörda.
  const { igPlainRate } = await import("../src/server/igRoutes.js");
  const { isIgTemporaryRateError, IG_READ_RATE_ERROR } = await import("../src/integrations/igConnection.js");
  // Dator 1 lördag: EUR/USD Mini CEEM 11201,05 (punkter), GBP/USD Mini 1,323425 och USD/JPY Mini 158,332 (vanlig kurs).
  assert.ok(Math.abs((igPlainRate(11201.05, "CS.D.EURUSD.CEEM.IP") ?? 0) - 1.120105) < 1e-9);
  assert.equal(igPlainRate(1.323425, "CS.D.GBPUSD.MINI.IP"), null);
  assert.equal(igPlainRate(158.332, "CS.D.USDJPY.MINI.IP"), null);
  assert.ok(Math.abs((igPlainRate(15833.2, "CS.D.USDJPY.CEEM.IP") ?? 0) - 158.332) < 1e-9);
  assert.equal(igPlainRate(62000, "CS.D.BITCOIN.CFD.IP"), null);
  assert.equal(igPlainRate(62000, "CS.D.BTCUSD.CFD.IP"), null);
  assert.equal(igPlainRate(null, "CS.D.EURUSD.CEEM.IP"), null);
  assert.ok(isIgTemporaryRateError(new Error(IG_READ_RATE_ERROR)), "läsgränsen ska ge 429 med begripligt besked, inte 500");
  ok("Forex i IG-punkter visas med vanlig kurs bredvid; IG:s läsgräns känns igen som tillfällig (429, försök igen om en minut)");
}

{
  // Dator 1: GBP/USD 1m fastnade på ett strömmat ljus med "historik saknas: IG begränsade antal läsanrop",
  // eftersom serien inte längre var tom och historiken aldrig hämtades igen.
  const { EventEmitter } = await import("node:events");
  const { createIgMarketData } = await import("../src/server/igMarketData.js");
  const { IG_READ_RATE_ERROR } = await import("../src/integrations/igConnection.js");
  let t = Date.UTC(2026, 9, 10, 7, 0, 0), calls = 0, fail = true;
  const E = "CS.D.GBPUSD.MINI.IP", M = 60_000, base = t - 300 * M;
  const stream = { events: new EventEmitter(), summary: () => ({ status: "DISCONNECTED" }), ensure: () => {}, request: () => {} };
  const md = createIgMarketData({
    status: (() => ({ environments: { demo: { status: "missing", credentialsComplete: false }, live: { status: "missing", credentialsComplete: false } } })) as never,
    now: () => t, stream: stream as never, file: (e) => path.join(tmp, `wl-hist-${e}.json`),
    market: (async (_e: string, epic: string) => ({ epic, name: "GBP/USD Mini", category: "forex", quote: {} })) as never,
    candles: (async () => { calls++; if (fail) throw new Error(IG_READ_RATE_ERROR);
      return { status: "ready", candles: Array.from({ length: 200 }, (_, i) => ({ openTime: base + i * M, closeTime: base + (i + 1) * M, open: 1.32, high: 1.33, low: 1.31, close: 1.32, volume: 0, closed: true })) }; }) as never,
  });
  md.start();
  await md.ensureSeries("demo", E, "1m");
  assert.equal(calls, 1); assert.match(md.historyError(E, "1m", "demo")!, /läsanrop/);
  stream.events.emit("candle", "demo", { epic: E, scale: "1MINUTE", openTime: base + 250 * M, open: 1.32, high: 1.33, low: 1.31, close: 1.3234, closed: true });
  assert.equal(md.closed(E, "1m", "demo").length, 1, "ett strömmat ljus");
  await md.ensureSeries("demo", E, "1m");
  assert.equal(calls, 1, "inget nytt försök inom en minut");
  t += 61_000; fail = false;
  await md.ensureSeries("demo", E, "1m");
  md.stop();
  assert.equal(calls, 2, "nytt historikförsök efter en minut trots strömmat ljus");
  assert.equal(md.historyError(E, "1m", "demo"), null);
  assert.equal(md.closed(E, "1m", "demo").length, 201, "200 historiska ljus + det strömmade, äldre ljus kastas inte");
  assert.equal(md.closed(E, "1m", "demo").at(-1)!.close, 1.3234, "det strömmade ljuset ligger sist");
  ok("Misslyckad historik hämtas igen efter en minut även när strömmen lagt till ljus, och slås ihop utan att tappa äldre ljus");
  // Dator 1, IG:s svar: 403 error.public-api.exceeded-account-historical-data-allowance → tydlig text, nytt försök först om en timme.
  const { IG_HISTORY_RATE_ERROR } = await import("../src/integrations/igConnection.js");
  let hcalls = 0; const E2 = "CS.D.EURUSD.CEEM.IP";
  const md2 = createIgMarketData({
    status: (() => ({ environments: { demo: { status: "missing", credentialsComplete: false }, live: { status: "missing", credentialsComplete: false } } })) as never,
    now: () => t, stream: stream as never, file: (e) => path.join(tmp, `wl-hist2-${e}.json`),
    market: (async (_e: string, epic: string) => ({ epic, name: "EUR/USD Mini", category: "forex", quote: {} })) as never,
    candles: (async () => { hcalls++; throw new Error(IG_HISTORY_RATE_ERROR); }) as never,
  });
  await md2.ensureSeries("demo", E2, "5m");
  assert.match(md2.historyError(E2, "5m", "demo")!, /veckokvot för historiska priser är slut/);
  t += 61_000; await md2.ensureSeries("demo", E2, "5m");
  assert.equal(hcalls, 1, "veckokvoten: inget nytt IG-anrop efter en minut");
  t += 60 * 60_000; await md2.ensureSeries("demo", E2, "5m");
  assert.equal(hcalls, 2, "veckokvoten: nytt försök efter en timme");
  ok("IG:s veckokvot för historik ger tydlig text och nytt försök först efter en timme, inte varje minut");
}

console.log("Granskning 3: alla tester godkända (endast mocks, inga nätverksanrop)");
