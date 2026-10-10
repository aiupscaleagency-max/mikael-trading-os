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
const { tagStrategyDeal, listStrategyDeals } = await import("../src/server/igStrategyTrades.js");
const { getResults } = await import("../src/server/results.js");

const ok = (m: string) => console.log("PASS: " + m);
const SID = listIgStrategies()[0]!.id;
const NAME = "EUR/USD Mini", EPIC = "CS.D.EURUSD.MINI.IP";
const OPENED = Date.parse("2026-10-08T09:00:00Z");

function broker(env: "demo" | "live", positions: () => any[]) {
  return {
    name: env === "live" ? "ig" : "ig-demo", mode: env === "live" ? "live" : "testnet",
    getAccount: async () => ({ currency: "SEK", balance: 10000, balances: [] }),
    getPositions: async () => positions(),
  } as never;
}
const lib = (env: "demo" | "live") => strategyLibrary({ pdfRoot: tmp }).strategies.find((s) => s.id === SID)!.accounts[env].igTrades;

// ══ F1: ingen registrering utan strategi-id ══
{
  assert.equal(isLibraryStrategy(SID), true);
  assert.equal(tagStrategyDeal({ env: "demo", dealId: "DX0", strategyId: null, epic: EPIC, name: NAME, size: 1, openedAt: OPENED }), false, "utan strategi-id sparas inget");
  assert.equal(tagStrategyDeal({ env: "demo", dealId: "DX0", strategyId: "påhittad-strategi", epic: EPIC, name: NAME, size: 1, openedAt: OPENED }), false, "okänt strategi-id sparas inte");
  assert.equal(listStrategyDeals().length, 0);
  // En stängd affär UTAN märkning registreras aldrig på någon strategi
  const history = (async () => ({ status: "ready", transactions: [{ type: "DEAL", date: "2026-10-08T10:00:00", instrumentName: NAME, size: "+1", openLevel: "1.1000", closeLevel: "1.1010", profitAndLoss: "SEK25.00", currency: "SEK", reference: "R0" }] })) as never;
  await getResults({ "ig-demo": broker("demo", () => []), ig: broker("live", () => []) }, "TEST", [], { history });
  assert.equal(lib("demo").trades, 0, "affär utan strategi-id räknas inte");
  assert.equal(lib("demo").label, "från dina IG-affärer (Demo)");
  assert.equal(lib("live").label, "från dina IG-affärer (Live)");
  ok("F1: ingen strategiregistrering utan (känt) strategi-id");
}

// ══ F1: en gång per dealId, Demo och Live separat ══
{
  assert.equal(tagStrategyDeal({ env: "demo", dealId: "D1", strategyId: SID, epic: EPIC, name: NAME, size: 1, openedAt: OPENED }), true);
  assert.equal(tagStrategyDeal({ env: "demo", dealId: "D1", strategyId: SID, epic: EPIC, name: NAME, size: 1, openedAt: OPENED }), false, "samma dealId märks inte två gånger");
  let demoOpen: any[] = [{ dealId: "D1", symbol: EPIC, name: NAME, quantity: 1, avgEntryPrice: 1.1, currentPrice: 1.1, direction: "BUY", pnlVerified: false, unrealizedPnlUsdt: 0 }];
  const demoTx = [
    { type: "DEAL", date: "2026-10-08T10:00:00", instrumentName: NAME, size: "+1", openLevel: "1.1000", closeLevel: "1.1010", profitAndLoss: "SEK25.00", currency: "SEK", reference: "R0" },
  ];
  const liveTx: any[] = [];
  const history = (async (e: string) => ({ status: "ready", transactions: e === "demo" ? demoTx : liveTx })) as never;
  const brokers = () => ({ "ig-demo": broker("demo", () => demoOpen), ig: broker("live", () => []) });
  // Fortfarande öppen → inget registreras, men öppningskursen tas från IG-positionen
  await getResults(brokers(), "TEST", [], { history });
  assert.equal(lib("demo").trades, 0, "öppen position räknas inte");
  assert.equal(listStrategyDeals("demo")[0]!.openLevel, 1.1);
  // R0 stängdes FÖRE öppningen och har annan öppningskurs-matchning: den ska aldrig räknas för D1
  demoOpen = [];
  demoTx.length = 0;
  demoTx.push(
    { type: "DEAL", date: "2026-10-08T08:00:00", instrumentName: NAME, size: "+1", openLevel: "1.1000", closeLevel: "1.1010", profitAndLoss: "SEK99.00", currency: "SEK", reference: "OLD" },
    { type: "DEAL", date: "2026-10-08T09:30:00", instrumentName: NAME, size: "+1", openLevel: "1.1000", closeLevel: "1.0990", profitAndLoss: "SEK-12.50", currency: "SEK", reference: "R1" },
  );
  await getResults(brokers(), "TEST", [], { history });
  let d = lib("demo");
  assert.equal(d.trades, 1); assert.equal(d.wins, 0); assert.equal(d.winRate, 0); assert.deepEqual(d.pnl, { SEK: -12.5 });
  assert.equal(d.lastAt, Date.parse("2026-10-08T09:30:00Z"));
  // Samma historik läses igen (panelen frågar ofta) → fortfarande en affär
  await getResults(brokers(), "TEST", [], { history });
  await getResults(brokers(), "TEST", [], { history });
  assert.equal(lib("demo").trades, 1, "en affär räknas en gång per dealId");
  // Direkt anrop med samma dealId (t.ex. annan strategi) räknas inte heller
  const again = recordStrategyTrade("demo", SID, { dealId: "D1", pnl: 50, currency: "SEK", at: Date.now() });
  assert.deepEqual(again, { ok: true, duplicate: true });
  assert.equal(lib("demo").trades, 1);
  assert.equal(lib("live").trades, 0, "Demo-affären syns aldrig i Live");

  // Live: samma dealId-namn i Live är en annan affär och hålls separat
  assert.equal(tagStrategyDeal({ env: "live", dealId: "D1", strategyId: SID, epic: EPIC, name: NAME, size: 2, openedAt: OPENED }), true);
  liveTx.push({ type: "DEAL", date: "2026-10-08T09:40:00", instrumentName: NAME, size: "-2", openLevel: "1.1000", closeLevel: "1.0980", profitAndLoss: "SEK40.00", currency: "SEK", reference: "L1" });
  await getResults(brokers(), "LIVE", [], { history });
  const l = lib("live");
  assert.equal(l.trades, 1); assert.equal(l.wins, 1); assert.equal(l.winRate, 100); assert.deepEqual(l.pnl, { SEK: 40 });
  d = lib("demo");
  assert.equal(d.trades, 1); assert.deepEqual(d.pnl, { SEK: -12.5 }, "Live-affären blandas aldrig in i Demo");
  ok("F1: stängd strategiaffär registreras en gång per dealId; Demo och Live separata; antal, vinst %, P/L SEK och senaste tid");
}

// ══ F1: tvetydig historik → ingen gissning ══
{
  assert.equal(tagStrategyDeal({ env: "demo", dealId: "D2", strategyId: SID, epic: EPIC, name: NAME, size: 3, openedAt: Date.parse("2026-10-09T09:00:00Z") }), true);
  const tx = [
    { type: "DEAL", date: "2026-10-09T09:10:00", instrumentName: NAME, size: "+3", openLevel: "1.2000", closeLevel: "1.2010", profitAndLoss: "SEK5.00", currency: "SEK", reference: "A" },
    { type: "DEAL", date: "2026-10-09T09:20:00", instrumentName: NAME, size: "+3", openLevel: "1.2050", closeLevel: "1.2010", profitAndLoss: "SEK-5.00", currency: "SEK", reference: "B" },
  ];
  const history = (async () => ({ status: "ready", transactions: tx })) as never;
  await getResults({ "ig-demo": broker("demo", () => []), ig: broker("live", () => []) }, "TEST", [], { history });
  assert.equal(lib("demo").trades, 1, "två möjliga rader och okänd öppningskurs → väntar, gissar inte");
  // Fel vid läsning av positioner → ingen registrering
  const bad = { name: "ig-demo", mode: "testnet", getAccount: async () => ({ currency: "SEK", balance: 1, balances: [] }), getPositions: async () => { throw new Error("IG nere"); } } as never;
  await getResults({ "ig-demo": bad, ig: broker("live", () => []) }, "TEST", [], { history: (async () => ({ status: "ready", transactions: [tx[0]] })) as never });
  assert.equal(lib("demo").trades, 1, "utan säkra positioner registreras inget");
  ok("F1: tvetydig historik eller läsfel ger ingen registrering");
}

// ══ F1: orderns strategi-id följer med bara när det finns i biblioteket (källkod) ══
{
  const api = fs.readFileSync(path.resolve("src/server/api.ts"), "utf8");
  assert.match(api, /isLibraryStrategy\(b\.strategyId\) \? \{ strategyId: b\.strategyId \}/, "createIgPendingOrder tar bara med kända strategi-id");
  assert.match(api, /if \(order\.dealId && p\.strategyId\) \{\s*tagStrategyDeal\(/, "accepterad IG-affär märks med strategin");
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
