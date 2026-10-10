// F1 (strategiresultat från egna IG-affärer) och F4 ("Fråga agenten" på varje sida) som fixturetest.
// Bara injicerade beroenden och temporär datamapp. Inga nätverksanrop, ingen order skickas.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-f1f4-"));
process.env.TRADING_DATA_DIR = tmp;
process.env.AGENT_TREE_TRADING_EVENTS = "off";
delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO; delete process.env.IG_ORDER_EXECUTION_ENABLED_LIVE;
delete process.env.LIVE_TRADING_CONFIRMED;
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;

const { listIgStrategies } = await import("../src/integrations/igStrategies.js");
const { strategyLibrary, recordStrategyTrade, isLibraryStrategy } = await import("../src/server/igStrategyLibrary.js");
const T = await import("../src/server/igStrategyTrades.js");
const { tagStrategyDeal, listStrategyDeals, reconcileStrategyDeals, rememberUnknownStrategyOrder, takeUnknownStrategyOrder, normalizeCurrency, STRATEGY_DEAL_MAX_AGE_MS } = T;
const { getResults, parseIgMoney } = await import("../src/server/results.js");

const ok = (m: string) => console.log("PASS: " + m);
const SID = listIgStrategies()[0]!.id;
const NAME = "EUR/USD Mini", EPIC = "CS.D.EURUSD.MINI.IP";
const OPENED = Date.parse("2026-10-08T09:00:00Z");
const NOW = Date.parse("2026-10-08T12:00:00Z");

function broker(env: "demo" | "live", positions: () => any[]) {
  return {
    name: env === "live" ? "ig" : "ig-demo", mode: env === "live" ? "live" : "testnet",
    getAccount: async () => ({ currency: "SEK", balance: 10000, balances: [] }),
    getPositions: async () => positions(),
  } as never;
}
const lib = (env: "demo" | "live", sid = SID) => strategyLibrary({ pdfRoot: tmp }).strategies.find((s) => s.id === sid)!.accounts[env].igTrades;
const tx = (o: Record<string, unknown>) => ({ type: "DEAL", instrumentName: NAME, currency: "SEK", ...o });
const rec = (env: "demo" | "live", positions: any[], txs: any[], now = NOW) => reconcileStrategyDeals(env, positions, txs, parseIgMoney, "SEK", now);
const deal = (o: Record<string, unknown>) => tagStrategyDeal({ env: "demo", strategyId: SID, epic: EPIC, name: NAME, direction: "BUY", size: 1, openLevel: 1.1, openedAt: OPENED, ...o } as never);

// ══ F1: ingen registrering utan strategi-id ══
{
  assert.equal(isLibraryStrategy(SID), true);
  assert.equal(deal({ dealId: "DX0", strategyId: null }), false, "utan strategi-id sparas inget");
  assert.equal(deal({ dealId: "DX0", strategyId: "påhittad-strategi" }), false, "okänt strategi-id sparas inte");
  assert.equal(deal({ dealId: "DX0", direction: null }), false, "utan riktning sparas inget");
  assert.equal(listStrategyDeals().length, 0);
  const history = (async () => ({ status: "ready", transactions: [tx({ date: "2026-10-08T10:00:00", size: "+1", openLevel: "1.1000", profitAndLoss: "SEK25.00", reference: "R0" })] })) as never;
  await getResults({ "ig-demo": broker("demo", () => []), ig: broker("live", () => []) }, "TEST", [], { history });
  assert.equal(lib("demo").trades, 0, "affär utan strategi-id räknas inte");
  assert.equal(lib("demo").label, "från dina IG-affärer (Demo)");
  assert.equal(lib("live").label, "från dina IG-affärer (Live)");
  ok("F1: ingen strategiregistrering utan (känt) strategi-id");
}

// ══ F1: en gång per dealId, Demo och Live separat (via getResults) ══
{
  assert.equal(deal({ dealId: "D1" }), true);
  assert.equal(deal({ dealId: "D1" }), false, "samma dealId märks inte två gånger");
  let demoOpen: any[] = [{ dealId: "D1", symbol: EPIC, name: NAME, quantity: 1, avgEntryPrice: 1.1, currentPrice: 1.1, direction: "BUY", pnlVerified: false, unrealizedPnlUsdt: 0 }];
  const demoTx: any[] = [], liveTx: any[] = [];
  let partial = false;
  const history = (async (e: string) => ({ status: partial ? "partial" : "ready", transactions: e === "demo" ? demoTx : liveTx })) as never;
  const brokers = () => ({ "ig-demo": broker("demo", () => demoOpen), ig: broker("live", () => []) });
  demoTx.push(tx({ date: "2026-10-08T09:30:00", size: "+1", openLevel: "1.1000", profitAndLoss: "SEK-12.50", reference: "R1" }));
  await getResults(brokers(), "TEST", [], { history });
  assert.equal(lib("demo").trades, 0, "öppen position räknas inte");
  demoOpen = [];
  partial = true;
  await getResults(brokers(), "TEST", [], { history });
  assert.equal(lib("demo").trades, 0, "ofullständig historik (partial) → ingen registrering");
  partial = false;
  await getResults(brokers(), "TEST", [], { history });
  let d = lib("demo");
  assert.equal(d.trades, 1); assert.equal(d.wins, 0); assert.equal(d.winRate, 0); assert.deepEqual(d.pnl, { SEK: -12.5 });
  assert.equal(d.lastAt, Date.parse("2026-10-08T09:30:00Z"));
  await getResults(brokers(), "TEST", [], { history });
  await getResults(brokers(), "TEST", [], { history });
  assert.equal(lib("demo").trades, 1, "en affär räknas en gång per dealId");
  assert.deepEqual(recordStrategyTrade("demo", SID, { dealId: "D1", pnl: 50, currency: "SEK", at: Date.now() }), { ok: true, duplicate: true });
  assert.equal(lib("live").trades, 0, "Demo-affären syns aldrig i Live");

  assert.equal(deal({ env: "live", dealId: "D1", direction: "SELL", size: 2 }), true);
  liveTx.push(tx({ date: "2026-10-08T09:40:00", size: "-2", openLevel: "1.1000", profitAndLoss: "SEK40.00", reference: "L1" }));
  await getResults(brokers(), "LIVE", [], { history });
  const l = lib("live");
  assert.equal(l.trades, 1); assert.equal(l.wins, 1); assert.equal(l.winRate, 100); assert.deepEqual(l.pnl, { SEK: 40 });
  d = lib("demo");
  assert.equal(d.trades, 1); assert.deepEqual(d.pnl, { SEK: -12.5 }, "Live-affären blandas aldrig in i Demo");
  ok("F1: stängd strategiaffär registreras en gång per dealId; Demo och Live separata; partial historik väntar");
}

// ══ Granskning MAJOR 1: en manuell affär krediteras aldrig strategin ══
{
  const S2 = listIgStrategies()[1]!.id;
  const t0 = Date.parse("2026-10-08T10:00:00Z");
  // Okänd öppningskurs (ingen bekräftelse, aldrig sedd som position) → räknas aldrig
  assert.equal(deal({ dealId: "M0", strategyId: S2, openLevel: null, openedAt: t0 }), true);
  rec("demo", [], [tx({ date: "2026-10-08T10:05:00", size: "+1", openLevel: "1.1000", profitAndLoss: "SEK5" })]);
  assert.equal(lib("demo", S2).trades, 0, "utan öppningskurs ingen träff");
  // Fel riktning (manuell kort affär med samma kurs) räknas inte
  assert.equal(deal({ dealId: "M1", strategyId: S2, openLevel: 1.2345, openedAt: t0 }), true);
  rec("demo", [], [tx({ date: "2026-10-08T10:05:00", size: "-1", openLevel: "1.2345", profitAndLoss: "SEK7", reference: "MAN1" })]);
  assert.equal(lib("demo", S2).trades, 0, "motsatt riktning är inte strategins affär");
  // Annan öppningskurs räknas inte
  rec("demo", [], [tx({ date: "2026-10-08T10:05:00", size: "+1", openLevel: "1.2346", profitAndLoss: "SEK7", reference: "MAN2" })]);
  assert.equal(lib("demo", S2).trades, 0, "annan öppningskurs är inte strategins affär");
  // Öppningstid långt från orderns → räknas inte
  rec("demo", [], [tx({ date: "2026-10-08T11:00:00", openDate: "2026-10-08T10:40:00", size: "+1", openLevel: "1.2345", profitAndLoss: "SEK7", reference: "MAN3" })]);
  assert.equal(lib("demo", S2).trades, 0, "öppnad 40 min efter ordern är en annan affär");
  // Rätt riktning, kurs och öppningstid inom fönstret → räknas
  rec("demo", [], [tx({ date: "2026-10-08T10:20:00", openDate: "2026-10-08T10:00:20", size: "+1", openLevel: "1.2345", profitAndLoss: "SEK7", reference: "OK1" })]);
  assert.equal(lib("demo", S2).trades, 1);

  // Limitorder: väntar tills positionen syns; stängning innan dess räknas aldrig
  const t1 = Date.parse("2026-10-08T10:30:00Z");
  assert.equal(deal({ dealId: "LIM1", strategyId: S2, openLevel: 1.3, orderType: "LIMIT", openedAt: t1 }), true);
  assert.equal(listStrategyDeals("demo").find((x) => x.dealId === "LIM1")!.awaitingFill, true);
  const limTx = tx({ date: "2026-10-08T11:30:00", size: "+1", openLevel: "1.3000", profitAndLoss: "SEK3", reference: "LT" });
  rec("demo", [], [limTx], Date.parse("2026-10-08T11:31:00Z"));
  assert.equal(lib("demo", S2).trades, 1, "ofylld limitorder räknas inte");
  rec("demo", [{ dealId: "LIM1", name: NAME, quantity: 1, avgEntryPrice: 1.3 }], [], Date.parse("2026-10-08T11:00:00Z"));
  assert.equal(listStrategyDeals("demo").find((x) => x.dealId === "LIM1")!.awaitingFill, false, "fylld när positionen syns");
  rec("demo", [], [limTx], Date.parse("2026-10-08T11:31:00Z"));
  assert.equal(lib("demo", S2).trades, 2, "fylld limitorder räknas när den stängts");

  // Efter 7 dagar utan träff tas affären bort utan registrering
  assert.equal(deal({ dealId: "OLD", strategyId: S2, openLevel: 9.99, openedAt: t0 }), true);
  rec("demo", [], [], t0 + STRATEGY_DEAL_MAX_AGE_MS + 1);
  assert.equal(listStrategyDeals("demo").some((x) => x.dealId === "OLD"), false, "utgången affär tas bort");
  assert.equal(lib("demo", S2).trades, 2, "utgången affär registreras inte");
  ok("Granskning M1: kräver öppningskurs, riktning, öppningstid nära ordern, fylld limitorder, full historik; 7 dagar → borttagen");
}

// ══ Granskning mindre 2: delstängningar summeras, registreras när positionen är helt stängd ══
{
  const S3 = listIgStrategies()[2]!.id;
  const t0 = Date.parse("2026-10-08T13:00:00Z");
  assert.equal(deal({ dealId: "P1", strategyId: S3, size: 3, openLevel: 2.5, openedAt: t0 }), true);
  const part1 = tx({ date: "2026-10-08T13:10:00", size: "+1", openLevel: "2.5000", profitAndLoss: "SEK10", reference: "P-a" });
  // Delstängd: positionen finns kvar med storlek 2 → inget registreras och ursprunglig storlek behålls
  rec("demo", [{ dealId: "P1", name: NAME, quantity: 2, avgEntryPrice: 2.5 }], [part1], t0 + 15 * 60_000);
  assert.equal(lib("demo", S3).trades, 0);
  assert.equal(listStrategyDeals("demo").find((x) => x.dealId === "P1")!.size, 3, "ursprunglig storlek behålls");
  // Borta men bara 1 av 3 i historiken → vänta
  rec("demo", [], [part1], t0 + 20 * 60_000);
  assert.equal(lib("demo", S3).trades, 0, "ofullständiga stängningsrader → vänta");
  const part2 = tx({ date: "2026-10-08T13:30:00", size: "+2", openLevel: "2.5000", profitAndLoss: "SEK-4", reference: "P-b" });
  rec("demo", [], [part1, part2], t0 + 40 * 60_000);
  const s = lib("demo", S3);
  assert.equal(s.trades, 1, "en affär trots två stängningsrader"); assert.deepEqual(s.pnl, { SEK: 6 }); assert.equal(s.lastAt, Date.parse("2026-10-08T13:30:00Z"));
  ok("Granskning mindre 2: delstängningar summeras och registreras en gång när positionen är helt stängd");
}

// ══ Granskning mindre 4: valuta normaliseras ══
{
  assert.equal(normalizeCurrency("kr", "SEK"), "SEK"); assert.equal(normalizeCurrency("EUR", "SEK"), "EUR"); assert.equal(normalizeCurrency(null, "SEK"), "SEK");
  const S4 = listIgStrategies()[3]!.id;
  const t0 = Date.parse("2026-10-08T14:00:00Z");
  assert.equal(deal({ dealId: "C1", strategyId: S4, openLevel: 3.1, openedAt: t0 }), true);
  rec("demo", [], [tx({ date: "2026-10-08T14:10:00", size: "+1", openLevel: "3.1", profitAndLoss: "-kr2.50", currency: "kr" })], t0 + 20 * 60_000);
  assert.deepEqual(lib("demo", S4).pnl, { SEK: -2.5 }, "'kr' blir kontots valuta SEK");
  ok("Granskning mindre 4: icke-ISO-valuta ersätts med kontots valuta");
}

// ══ Granskning mindre 1: sen bekräftelse av order med okänt utfall kopplas via utkastets id ══
{
  assert.equal(rememberUnknownStrategyOrder({ env: "demo", draftId: "DR1", strategyId: SID, epic: EPIC, name: null }), true);
  assert.equal(rememberUnknownStrategyOrder({ env: "demo", draftId: "DR2", strategyId: "påhittad", epic: EPIC, name: null }), false);
  assert.equal(takeUnknownStrategyOrder("live", "DR1"), null, "Live ser aldrig Demos utkast");
  const m = takeUnknownStrategyOrder("demo", "DR1");
  assert.equal(m?.strategyId, SID);
  assert.equal(takeUnknownStrategyOrder("demo", "DR1"), null, "kopplas bara en gång");
  const api = fs.readFileSync(path.resolve("src/server/api.ts"), "utf8");
  assert.match(api, /setIgLateDealHook\(\(mode, d\) => \{[\s\S]{0,200}takeUnknownStrategyOrder\(env, d\.draftId\)[\s\S]{0,300}tagStrategyDeal\(/, "sen avstämning märker affären med strategin");
  assert.match(api, /igOutcome[\s\S]{0,40}=== "unknown" && draftId && p\.strategyId\) \{\s*rememberUnknownStrategyOrder\(/, "okänt utfall sparar strategin för utkastet");
  assert.match(api, /name: m\.name \?\? igMarketData\.nameOf\(d\.epic, env\)/, "namn från EPIC när namnet saknas");
  const orders = fs.readFileSync(path.resolve("src/integrations/igOrders.ts"), "utf8");
  assert.match(orders, /function lateAccepted\([^)]*\)\{\n\s*if\(d\.status==='accepted'&&d\.dealId&&lateDealHook\)/, "igOrders meddelar varje sen accept (även manuell)");
  assert.match(orders, /d\.dealId=result\.dealId;d\.error=undefined;if\(finite\(result\.level\)&&result\.level>0\)d\.fillLevel=result\.level;/, "fyllnadskursen sparas ur IG:s bekräftelse");
  ok("Granskning mindre 1: sen accept kopplas till strategin via utkastets id, namn från EPIC");
}

// ══ Granskning mindre 3: chatten bär strategi bara när modellen anger den; kortet visar strategin ══
{
  const { executeIgChatTool } = await import("../src/server/igChat.js");
  const seen: Array<Record<string, unknown>> = [];
  const deps = { llm: {} as never, watchlist: () => [{ epic: EPIC, name: NAME, category: "forex" }],
    createPending: async (b: Record<string, unknown>) => { seen.push(b); return { ok: true, pendingOrder: { id: "x", symbol: EPIC, side: "BUY" } }; } };
  const fakeBroker = { env: "demo", mode: "testnet" } as never;
  await executeIgChatTool("queue_ig_orders", { epics: [EPIC], side: "BUY" }, fakeBroker, deps as never);
  await executeIgChatTool("queue_ig_orders", { epics: [EPIC], side: "BUY", strategy_id: SID }, fakeBroker, deps as never);
  assert.equal(seen[0]!.strategyId, undefined, "utan strategy_id ingen strategi");
  assert.equal(seen[1]!.strategyId, SID, "modellens strategy_id följer med");
  const api = fs.readFileSync(path.resolve("src/server/api.ts"), "utf8");
  assert.doesNotMatch(api, /strategyId: ctx\.used\.strategy/, "chattens kontext ärvs inte längre automatiskt");
  const dash = fs.readFileSync(path.resolve("dashboard.html"), "utf8");
  assert.ok(dash.includes("window.strategyTag = function"), "kortet har Strategi: X");
  assert.ok((dash.match(/strategyTag\(o\)/g) || []).length >= 3, "Strategi: X visas i Väntande ordrar, popupen och Trades");
  ok("Granskning mindre 3: chattens strategi bara när modellen anger den; Strategi: X syns före GODKÄNN");
}

// ══ F1: orderns strategi-id följer med bara när det finns i biblioteket (källkod) ══
{
  const api = fs.readFileSync(path.resolve("src/server/api.ts"), "utf8");
  assert.match(api, /isLibraryStrategy\(b\.strategyId\) \? \{ strategyId: b\.strategyId \}/, "createIgPendingOrder tar bara med kända strategi-id");
  assert.match(api, /if \(order\.dealId && p\.strategyId\) \{\s*tagStrategyDeal\(/, "accepterad IG-affär märks med strategin");
  assert.match(api, /openLevel: order\.fillLevel \?\? null, orderType: p\.orderType === "LIMIT"/, "fyllnadskurs och ordertyp sparas vid märkning");
  const dash = fs.readFileSync(path.resolve("dashboard.html"), "utf8");
  assert.ok(dash.includes("function igTradesLine("), "Strategibiblioteket visar resultat från IG-affärer per miljö");
  ok("F1: strategi-id följer ordern och visas per miljö i Strategibiblioteket");
}

// ══ F1: Strategi-val i orderpanelen och popupens "Köp ändå" skickar strategyId ══
{
  const dash = fs.readFileSync(path.resolve("dashboard.html"), "utf8");
  assert.match(dash, /<select id="ot-strategy"[^>]*><option value="">Ingen strategi<\/option><\/select>/, "orderpanelen har valet Strategi med Ingen strategi som standard");
  const submit = dash.slice(dash.indexOf('source: "orderpanel"'), dash.indexOf('source: "orderpanel"') + 400);
  assert.match(submit, /if\(strategyId\) body\.strategyId = strategyId;/, "orderpanelens POST-body får strategyId");
  assert.match(dash, /source: "popup: köp ändå",\s*strategyId: \(window\.OT_STRATEGY && OT_STRATEGY\.get\(\)\) \|\| undefined,/, "popupens Köp ändå skickar strategyId");
  assert.match(dash, /"ot-strategy-" \+ env\(\)/, "senaste val sparas per miljö");
  assert.match(dash, /function saved\(\)\{ try \{ return localStorage\.getItem/, "localStorage läses inom try/catch");
  ok("F1: Strategi-val i orderpanelen och Köp ändå skickar strategyId, sparat per miljö");
}

// ══ F4: "Fråga agenten" i varje sidhuvud ══
{
  const html = fs.readFileSync(path.resolve("dashboard.html"), "utf8");
  const pages: Array<[string, string]> = [["trade", "Trade"], ["trades", "Trades"], ["cost", "Cost"], ["markets", "Valutapar"], ["strategies", "Strategier"],
    ["signals", "Signaler"], ["sessions", "Agentsessioner"], ["live", "Alla marknader"], ["tools", "Verktyg"], ["settings", "Inställningar"], ["library", "Strategibibliotek"], ["course", "Backtest"]];
  for (const [id, label] of pages) {
    const start = html.indexOf(`id="page-${id}"`);
    assert.ok(start > 0, `sidan ${label} finns`);
    const h = html.indexOf('class="page-header"', start);
    const end = html.indexOf("</div>", h);
    const header = html.slice(h, end);
    assert.ok(header.includes(label), `${label}: rätt sidhuvud`);
    assert.ok(header.includes(`data-ask-agent="${id}"`) && header.includes("Fråga agenten"), `${label}: knappen Fråga agenten finns i sidhuvudet`);
  }
  // Samma mekanism: knappen öppnar chatten med sida, EPIC, strategi och miljö
  assert.match(html, /closest\("\[data-ask-agent\]"\)[\s\S]{0,80}openChat\(g\.getAttribute\("data-ask-agent"\)/);
  assert.match(html, /return \{ page: page \|\| null, epic: epic \|\| null, strategy: strategy \|\| null, env: IG\.st\.env,/);
  const ctx = await import("../src/server/igChatContext.js");
  for (const [id] of pages) assert.equal(ctx.sanitizeChatContext({ page: id, env: "demo" }, "demo").used.page, id, `servern godtar sidan ${id}`);
  const u = ctx.sanitizeChatContext({ page: "trade", epic: EPIC, strategy: SID, env: "live" }, "live").used;
  assert.deepEqual([u.page, u.epic, u.strategy, u.env], ["trade", EPIC, SID, "live"]);
  ok(`F4: Fråga agenten finns i ${pages.length} sidhuvuden och skickar sida, EPIC, strategi och miljö`);
}

fs.rmSync(tmp, { recursive: true, force: true });
