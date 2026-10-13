// A: Tiingo tar högst 5 kryptotickers per anrop (fler → HTTP 400 för hela anropet).
// B: IG-läsbudgeten: mätning per förbrukare, katalogen klar ett dygn, rättvisa tak för bakgrundsjobb.
// Bara mockar: inga nätverksanrop mot IG eller Tiingo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-budget-"));
process.env.TRADING_DATA_DIR = tmp;
process.env.AGENT_TREE_TRADING_EVENTS = "off";
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;
const ok = (m: string) => console.log("PASS: " + m);

const T = await import("../src/server/tiingoIntraday.js");
const { createIgReadStats, withIgReadConsumer, IG_BACKGROUND_CAPS, igRouteKind } = await import("../src/integrations/igReadStats.js");
const { createIgMarkets, IG_CATALOGUE_FULL_REFRESH_MS, IG_CATALOGUE_TRICKLE_MS } = await import("../src/integrations/igMarkets.js");
const { createIgMarketDirectory } = await import("../src/integrations/igMarketDirectory.js");
const SP = await import("../src/server/igSparklines.js");

// ── A. Tiingo: som det riktiga Tiingo (verifierat 2026-10-11): > 5 tickers → HTTP 400, okänd ticker → utelämnas ──
const KNOWN = new Set(["aaveusd","arbusd","avaxusd","btcusd","bchusd","bchbtc","adausd","linkusd","atomusd","dogeusd","ethusd","ethbtc","ltcusd","nearusd","dotusd","polusd","xrpusd","shibusd","solusd","xlmusd","suiusd","tonusd","trxusd","uniusd"]);
function fakeTiingo(clock: () => number) {
  const sizes: number[] = [];
  const fetchFn = async (url: string, init: any) => {
    assert.ok(!/token=/i.test(url) && init.headers.Authorization, "nyckeln skickas som header, aldrig i URL:en");
    const u = new URL(url);
    const tickers = (u.searchParams.get("tickers") ?? "").split(",").filter(Boolean);
    sizes.push(tickers.length);
    if (tickers.length > 5) return { ok: false, status: 400, json: async () => ({ detail: "Error: A limit of 5 tickers may be requested at a time" }) };
    const base = clock() - 3 * 3_600_000;
    return { ok: true, status: 200, json: async () => tickers.filter((t) => KNOWN.has(t)).map((t) => ({ ticker: t, priceData: Array.from({ length: 80 }, (_, i) => { const d = base + i * 300_000; return { date: new Date(d).toISOString(), open: 1, high: 1.1, low: 0.9, close: 1 + i / 1000, volume: 1 }; }) })) };
  };
  return { fetchFn, sizes };
}
{
  // Alla 38 krypto-EPICs i IG Live-katalogen (2026-10-11) → 24 Tiingo-tickers, alla verifierade hos Tiingo
  const live: Array<[string, string]> = [["CS.D.AAVEUSD.CFD.IP","Aave ($1)"],["CS.D.ARBUSD.CFD.IP","Arbitrum ($1)"],["CS.D.AVXUSD.CFD.IP","Avalanche ($1)"],["CS.D.BITCOIN.CEEM.IP","Bitcoin ($0.1)"],["CS.D.BITCOIN.CEE.IP","Bitcoin ($1)"],["CS.D.BITCOIN.CNEM.IP","Bitcoin (E0.1)"],["CS.D.BITCOIN.CNE.IP","Bitcoin (E1)"],["CS.D.BCHUSD.CFD.IP","Bitcoin Cash ($1)"],["CS.D.BCHUSD.CFE.IP","Bitcoin Cash (E1)"],["CS.D.BCHXBT.CFD.IP","Bitcoin Cash/Bitcoin ($1)"],["CS.D.ADAUSD.CFD.IP","Cardano ($1)"],["CS.D.ADAUSD.CFE.IP","Cardano (E1)"],["CS.D.LNKUSD.CFD.IP","Chainlink ($1)"],["CS.D.LNKUSD.CFE.IP","Chainlink (E1)"],["CS.D.ATOMUSD.CFD.IP","Cosmos ($1)"],["CS.D.DOGUSD.CFD.IP","Dogecoin ($1)"],["CS.D.DOGUSD.CFE.IP","Dogecoin (E1)"],["CS.D.ETHUSD.CFD.IP","Ether ($1)"],["CS.D.ETHUSD.CFE.IP","Ether (E1)"],["CS.D.ETHXBT.CFD.IP","Ether/Bitcoin ($1)"],["CS.D.LTCUSD.CFD.IP","Litecoin ($1)"],["CS.D.LTCUSD.CFE.IP","Litecoin (E1)"],["CS.D.NEAUSD.CFD.IP","Near ($1)"],["CS.D.DOTUSD.CFD.IP","Polkadot ($1)"],["CS.D.DOTUSD.CFE.IP","Polkadot (E1)"],["CS.D.POLUSD.CFD.IP","Polygon ($1)"],["CS.D.XRPUSD.CFD.IP","Ripple ($1)"],["CS.D.SHIUSD.CFD.IP","Shiba Inu ($1)"],["CS.D.SOLUSD.CFD.IP","Solana ($1)"],["CS.D.SOLUSD.CFE.IP","Solana (E1)"],["CS.D.XLMUSD.CFD.IP","Stellar ($1)"],["CS.D.XLMUSD.CFE.IP","Stellar (E1)"],["CS.D.SUIUSD.CFD.IP","Sui ($1)"],["CS.D.TONUSD.CFD.IP","Toncoin ($1)"],["CS.D.TRXUSD.CFD.IP","Tron ($1)"],["CS.D.UNIUSD.CFD.IP","Uniswap ($1)"],["CS.D.UNIUSD.CFE.IP","Uniswap (E1)"]];
  const mapped = live.map(([e, n]) => T.tiingoTickerFor(e, n)?.ticker);
  assert.ok(mapped.every((t) => t && KNOWN.has(t)), "alla mappade tickers finns hos Tiingo");
  assert.equal(new Set(mapped).size, 24);
  assert.equal(T.tiingoTickerFor("CS.D.CRYPTOB10.CFD.IP", "Krypto 10 Index"), null, "index har ingen Tiingo-motsvarighet");
  assert.equal(T.TIINGO_BATCH_MAX, 5);

  // Minidiagram: alla 37 kort på en gång (som Alla par) → inga anrop med fler än 5 tickers, alla får diagram
  let clock = Date.UTC(2026, 9, 11, 9, 0, 0);
  const f = fakeTiingo(() => clock);
  const ti = T.createTiingoIntraday({ fetch: f.fetchFn as any, key: () => "k", now: () => clock, batchMs: 0 });
  const res = await Promise.all(live.map(([e, n]) => ti.get(e, n)));
  assert.ok(f.sizes.every((n) => n <= 5), `högst 5 per anrop (fick ${f.sizes.join(",")})`);
  assert.ok(res.every((r) => r.closes.length > 0 && r.note === null), "inga 'Tiingo svarade HTTP 400'");

  // Om Tiingo ändå avvisar ett samlat anrop (400): varje ticker provas för sig, inget fel cachas på de andra
  let calls = 0;
  const strict = T.createTiingoIntraday({ key: () => "k", now: () => clock, batchMs: 0, fetch: (async (url: string, init: any) => {
    calls++; const n = (new URL(url).searchParams.get("tickers") ?? "").split(",").length;
    if (n > 1) return { ok: false, status: 400, json: async () => ({}) };
    return f.fetchFn(url, init);
  }) as any });
  const three = await Promise.all([["CS.D.ATOMUSD.CFD.IP","Cosmos ($1)"],["CS.D.DOGUSD.CFD.IP","Dogecoin ($1)"],["CS.D.NEAUSD.CFD.IP","Near ($1)"]].map(([e, n]) => strict.get(e!, n)));
  assert.ok(three.every((r) => r.closes.length > 0), "ett avvisat samlat anrop förgiftar inte paren");
  assert.equal(calls, 4, "1 samlat + 3 enskilda");
  // Okänt par: bara det paret får "Tiingo saknar paret" (cachat per ticker), grannarna har diagram
  const unk = await Promise.all([strict.get("CS.D.FOOUSD.CFD.IP", "Bitcoin ($1)"), ti.get("CS.D.ZZZ.CFD.IP", "Tezos ($1)")]);
  assert.equal(unk[1].ticker, null, "par utan mappning görs inget anrop för");

  // Agenternas OHLC-instans: egna + förhandshämtade tickers ryms alltid i 5
  const fb = fakeTiingo(() => clock);
  const bars = T.createTiingoBars({ fetch: fb.fetchFn as any, key: () => "k", now: () => clock, batchMs: 0, maxPerHour: () => 50 });
  bars.hint(live.map(([epic, name]) => ({ epic, name })));
  const br = await Promise.all(live.slice(0, 7).map(([e, n]) => bars.bars(e, n, "1min")));
  assert.ok(fb.sizes.every((n) => n <= 5), `agenterna: högst 5 per anrop (fick ${fb.sizes.join(",")})`);
  assert.ok(br.every((r) => r.bars.length > 0));
  ok("Tiingo: högst 5 kryptotickers per anrop (Tiingos gräns, orsaken till HTTP 400), 400 delas upp per ticker, alla 37 krypto-EPICs mappar till verifierade tickers");
}

// ── B1. Läsräknare per förbrukare och rättvisa tak ──
{
  let clock = 1_000_000;
  const st = createIgReadStats({ now: () => clock });
  await withIgReadConsumer("katalog", async () => { st.record("live", "markets"); st.record("live", "categories/X/instruments"); });
  await withIgReadConsumer("minidiagram", async () => { st.record("live", "prices/CS.D.X.CFD.IP"); st.record("live", "markets/CS.D.X.CFD.IP", true); });
  st.record("live", "positions"); // ingen märkning = vy
  st.record("demo", "markets", false, "katalog");
  const snap: any = st.snapshot(() => ({ used: 7, remaining: 17, reserve: 12, backgroundRemaining: 5 }));
  const L = snap.environments.live;
  assert.equal(L.consumers.katalog.lastMinute, 2); assert.deepEqual(L.consumers.katalog.kinds, { "sök": 1, kategorier: 1 });
  assert.equal(L.consumers.minidiagram.lastMinute, 1); assert.equal(L.consumers.minidiagram.rejectedLast10Min, 1);
  assert.equal(L.consumers.vy.lastMinute, 1);
  assert.equal(L.otherLastMinute, 3, "övrigt = använt i budgeten − det som räknats här (saldo, positioner, order)");
  assert.equal(snap.environments.demo.consumers.katalog.lastMinute, 1, "Demo och Live räknas var för sig");
  assert.equal(igRouteKind("prices/CS.D.X.CFD.IP"), "historik");
  assert.ok(!JSON.stringify(snap).includes("CS.D.X"), "inga EPICs eller data i statistiken, bara antal och vägtyp");
  // Tak: katalog 4/min, minidiagram 4/min, sim 2/min; summan lämnar ≥ 2 av 12 bakgrundsläsningar åt vyerna
  const sum = Object.values(IG_BACKGROUND_CAPS).reduce((t, c) => t + c.perMinute, 0);
  assert.ok(sum <= 12 - 2, `bakgrundsjobbens tak ${sum}/min lämnar plats åt vyer`);
  assert.equal(st.backgroundBlock("live", "katalog", 12), null);
  st.record("live", "markets", false, "katalog"); st.record("live", "markets", false, "katalog");
  assert.match(String(st.backgroundBlock("live", "katalog", 12)), /högst 4/, "minuttaket");
  assert.match(String(st.backgroundBlock("live", "minidiagram", 2)), /lågt läsutrymme/, "golvet: backar när bakgrundsutrymmet är lågt");
  clock += 61_000;
  assert.equal(st.backgroundBlock("live", "katalog", 12), null, "nästa minut får katalogen läsa igen");
  ok("Läsräknare per förbrukare (katalog, minidiagram, vy …, övrigt) + tak/golv för bakgrundsjobb; inga EPICs/data i statistiken");
}

// ── B2. Katalogen: hel genomgång en gång per dygn, sedan bara långsam uppfriskning; sparas över ny inloggning ──
{
  let clock = Date.UTC(2026, 9, 11, 6, 0, 0), gen = "g1";
  const searches: string[] = [], routes: string[] = [];
  const call = async (_m: string, route: string, _v: string, _x: string, _b: unknown, extra?: { query?: string }) => {
    routes.push(route);
    if (route === "categories") return { categories: [] }; // kontot saknar kategorier → sökvägen
    if (route === "markets") { const term = new URLSearchParams(extra?.query).get("searchTerm")!; searches.push(term); return { markets: [{ epic: `CS.D.${term.toUpperCase().replace(/[^A-Z]/g, "")}.CFD.IP`, instrumentName: `${term} ($1)`, instrumentType: "CURRENCIES", bid: 1, offer: 2 }] }; }
    throw new Error("oväntat " + route);
  };
  const status = () => ({ environments: { live: { status: "connected", connectionGeneration: gen, account: { accountId: "A1" } }, demo: { status: "disconnected" } } }) as never;
  const file = () => path.join(tmp, "crawl-live.json");
  const mk = () => createIgMarkets({ call: call as never, status, now: () => clock, paused: () => false, crawlFile: file, crawlAccount: () => "konto-hash", readStats: null });
  let m = mk();
  // Hela genomgången (29 kryptosökord) inom katalogens tak: högst 4 läsningar/min (2 per kategori)
  let r: any, minutes = 0;
  do { r = await m.catalogue("live", "crypto"); const perMin = searches.length; assert.ok(perMin <= 2 * (minutes + 1), "högst 2 kryptosökningar/min"); clock += 61_000; minutes++; } while (r.remainingSearches > 0 && minutes < 40);
  assert.equal(r.remainingSearches, 0); assert.ok(Number.isFinite(r.searchCompletedAt)); const full = searches.length;
  assert.ok(full >= 29 && full <= 30, `en hel genomgång (${full} sökningar)`);
  // Klar: 1 h senare har bara uppfriskningen körts (ett sökord per 2 min), inte en ny genomgång var 5:e min
  searches.length = 0;
  for (let i = 0; i < 60; i++) { clock += 60_000; await m.catalogue("live", "crypto"); }
  assert.ok(searches.length <= Math.ceil(3_600_000 / IG_CATALOGUE_TRICKLE_MS) + 1, `bara uppfriskning: ${searches.length} sökningar/h (förr ≈ 350)`);
  assert.ok(searches.length >= 25, "uppfriskningen håller sökraderna någorlunda färska");
  // Sparad på disk utan konto-id och utan priser
  const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
  assert.equal(saved.account, "konto-hash"); assert.ok(!JSON.stringify(saved).includes("A1")); assert.ok(!/"bid"|"offer"/.test(JSON.stringify(saved)));
  // Ny inloggning (ny connectionGeneration) eller omstart: ingen ny genomgång, listan finns direkt
  gen = "g2"; m = mk(); searches.length = 0;
  const again: any = await m.catalogue("live", "crypto");
  assert.ok(searches.length <= 1, "ingen ny genomgång efter omstart/ny inloggning"); assert.ok(again.markets.length >= 29); assert.equal(again.remainingSearches, 0);
  // Annat konto: sparad genomgång används inte
  const other = createIgMarkets({ call: call as never, status, now: () => clock, paused: () => false, crawlFile: file, crawlAccount: () => "annat-konto", readStats: null });
  searches.length = 0; await other.catalogue("live", "crypto"); assert.ok(searches.length >= 2, "annat konto genomsöks från början");
  // Efter ett dygn: ny hel genomgång
  clock += IG_CATALOGUE_FULL_REFRESH_MS; searches.length = 0;
  for (let i = 0; i < 20; i++) { await m.catalogue("live", "crypto"); clock += 61_000; }
  assert.ok(searches.length >= 29, "ny hel genomgång efter ett dygn");
  ok("Katalogen: hel sökgenomgång en gång per dygn och konto (sparad över omstart/ny inloggning), därefter 1 uppfriskning/2 min per kategori; inom 4 läsningar/min");
}

// ── B3. Katalogrytm: en klar sökgenomgång med oklassificerade instrument tickas inte var 15:e sekund ──
{
  let clock = 5_000_000, calls = 0;
  const status = () => ({ environments: { live: { status: "connected", connectionGeneration: "l1" }, demo: { status: "disconnected" } } }) as never;
  const fallback = async (_m: string, category: string) => { calls++; return { complete: false, searchCompletedAt: clock - 1000, remainingSearches: 0, unclassifiedInstruments: 69, progress: { search: { failedTerms: [] } }, markets: [{ epic: category === "crypto" ? "CS.D.ETHUSD.CFD.IP" : "CS.D.EURUSD.MINI.IP", name: category === "crypto" ? "Ether ($1)" : "EUR/USD Mini", type: "CURRENCIES" }] }; };
  const dir = createIgMarketDirectory({ status, fallback: fallback as never, now: () => clock, paused: () => false });
  await dir.tickCatalogues(); const first = calls;
  const d: any = await dir.catalogue("live", "crypto"); assert.equal(d.complete, false, "complete förblir ärligt false (UI visar delvis)");
  clock += 15_000; await dir.tickCatalogues();
  assert.equal(calls, first, "klar genomgång: ingen ny katalogrunda efter 15 s");
  clock += 60_000; await dir.tickCatalogues(); assert.ok(calls > first, "men efter ≈65 s");
  ok("Katalogrytmen: klar sökgenomgång räknas som klar för schemat (65 s) även när complete=false (69 oklassificerade)");
}

// ── B4. Minidiagram: rättvist tak via läsräknaren; Tiingo tar över i stället för IG ──
{
  let clock = 9_000_000, igCalls = 0;
  const st = createIgReadStats({ now: () => clock });
  for (let i = 0; i < 4; i++) st.record("live", "prices/X", false, "minidiagram");
  const sp = SP.createIgSparklines({ now: () => clock, budget: () => ({ backgroundRemaining: 10, remaining: 22 }), signalInterval: () => "1m", persist: false, memory: () => [], name: () => "Ether ($1)", readStats: st, paused: () => false,
    candles: async () => { igCalls++; return { candles: [{ close: 1 }, { close: 2 }] }; },
    tiingo: { get: async () => ({ ticker: "ethusd", closes: [1, 2, 3], from: 1, to: 2, at: clock, note: null }) } });
  const s1 = await sp.get("live", "CS.D.ETHUSD.CFD.IP");
  assert.equal(igCalls, 0, "taket nått: ingen IG-läsning"); assert.equal(s1.source, "tiingo");
  clock += 61_000;
  const s2 = await sp.get("live", "CS.D.SOLUSD.CFD.IP"); assert.equal(igCalls, 1); assert.equal(s2.source, "ig");
  const low = SP.createIgSparklines({ now: () => clock, budget: () => ({ backgroundRemaining: 2, remaining: 14 }), signalInterval: () => "1m", persist: false, memory: () => [], name: () => "Ether ($1)", readStats: createIgReadStats({ now: () => clock }), paused: () => false,
    candles: async () => { igCalls++; return { candles: [{ close: 1 }] }; }, tiingo: null });
  await low.get("live", "CS.D.ADAUSD.CFD.IP"); assert.equal(igCalls, 1, "golvet 3: under det läser minidiagrammen inte IG");
  ok("Minidiagram: högst 4 IG-läsningar/min och inget under golvet 3; Tiingo visas i stället");
}

// ── B5. Orderreserven rörs inte: inga ändringar i igConnection/igOrders/orderGate ──
{
  const conn = fs.readFileSync(path.resolve("src/integrations/igConnection.ts"), "utf8");
  assert.ok(!/igReadStats/.test(conn), "läsräknaren sitter utanför igConnection (reserven och skrivstoppet orörda)");
  assert.match(conn, /export const IG_ORDER_READ_NEED=12;/);
  ok("Orderreserven (12/min) och igConnection orörda; mätningen sitter i igMarkets.read");
}
console.log("Läsbudget/Tiingo-batch: alla tester godkända (endast mocks, inga nätverksanrop)");
