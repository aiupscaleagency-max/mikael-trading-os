// Agenternas marknadsdata (Mike 2026-10-11): IG-minne → IG REST (om kvot/budget) → Tiingo (märkt ej IG-pris),
// Risk utan krasch vid läsgräns, Hannas tips per instrument, och paus av bakgrundsläsningar under analys.
// Bara mockad fetch och injicerade beroenden. Inga nätverksanrop mot IG eller Tiingo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-agent-data-"));
process.env.TRADING_DATA_DIR = tmp;
process.env.AGENT_TREE_TRADING_EVENTS = "off";
delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO; delete process.env.IG_ORDER_EXECUTION_ENABLED_LIVE;
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;

const ok = (m: string) => console.log(`  ✓ ${m}`);
const { IG_HISTORY_RATE_ERROR, IG_READ_RATE_ERROR } = await import("../src/integrations/igConnection.js");
const { createTiingoBars, TIINGO_AGENT_LABEL } = await import("../src/server/tiingoIntraday.js");
const AD = await import("../src/server/igAgentData.js");
const { IgBroker } = await import("../src/brokers/ig.js");
const { runTool } = await import("../src/agent/tools.js");

let clock = Date.parse("2026-10-11T10:00:30Z");
const now = () => clock;
// Tiingo-svar: 1-minutsljus de senaste 40 timmarna kring baspriset, sista ljuset fortfarande öppet (ska kastas)
const tiingoRows = (base: number, n = 2400) => Array.from({ length: n }, (_, i) => {
  const t = Math.floor(clock / 60_000) * 60_000 - (n - 1 - i) * 60_000;
  const c = base * (1 + Math.sin(i / 25) * 0.004 + i * 0.000002);
  return { date: new Date(t).toISOString(), open: c * 0.999, high: c * 1.002, low: c * 0.998, close: c, volume: 10 };
});
const urls: string[] = [];
let tiingoMode: "ok" | "batch400" = "ok";
const fakeFetch = async (url: string) => {
  urls.push(url);
  const u = new URL(url);
  const list = (u.searchParams.get("tickers") ?? "").split(",").filter(Boolean);
  if (u.pathname === "/tiingo/crypto/prices") {
    if (tiingoMode === "batch400" && list.length > 1) return { ok: false, status: 400, json: async () => ({ detail: "okänd ticker" }) };
    const base: Record<string, number> = { avaxusd: 25, arbusd: 0.5, suiusd: 3.4 };
    return { ok: true, status: 200, json: async () => list.filter((t) => base[t]).map((t) => ({ ticker: t, priceData: tiingoRows(base[t]!) })) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const tiingo = createTiingoBars({ fetch: fakeFetch as any, key: () => "test-nyckel", now, batchMs: 0 });

// IG: veckokvoten slut och läsgränsen nådd (både Demo och Live som i loggen 2026-10-10)
const names: Record<string, string> = { "CS.D.AVXUSD.CFD.IP": "Avalanche ($1)", "CS.D.ARBUSD.CFD.IP": "Arbitrum ($1)", "CS.D.SUIUSD.CFD.IP": "Sui ($1)" };
const quotes: Record<string, any> = {};
const igQuote = (epic: string, mid: number, ageMs = 5_000) => { quotes[epic] = { epic, bid: mid * 0.999, offer: mid * 1.001, mid, observedAt: clock - ageMs, receivedAt: clock - ageMs, delayTime: 0, marketStatus: "TRADEABLE", changePct: 4.2, high: null, low: null, source: "stream" }; };
let memoryBars: Record<string, any[]> = {};
let bgRemaining = 0;
let historyBlocked = clock + 3_600_000;
const streamAcc: any = { balance: 10_000, available: 9_500, profitLoss: 12, margin: 0, equity: 10_012, at: clock - 3_000 };
const agent = AD.createIgAgentData({
  memory: (epic, iv) => memoryBars[`${epic}|${iv}`] ?? [],
  dataEnv: (env) => env,
  quote: (epic) => quotes[epic] ?? null,
  name: (_env, epic) => names[epic] ?? null,
  budget: () => ({ backgroundRemaining: bgRemaining }),
  historyBlockedUntil: () => historyBlocked,
  tiingo,
  streamAccount: () => streamAcc,
  streamWaitMs: 0,
  now,
});
AD.useIgAgentData(agent);

let candleCalls = 0, marketCalls = 0, positionsMode: "ok" | "limit" = "ok";
const broker = new IgBroker("live", {
  status: () => ({ environments: { live: { environment: "live", configured: true, credentialsComplete: true, status: "connected", error: null, connectionGeneration: "g1", checkedAt: clock, account: { accountId: "A", accountType: "CFD", currency: "SEK", balance: 10_000, available: 9_500, deposit: 0, profitLoss: 0, updatedAt: clock } }, demo: { status: "missing" } } }) as any,
  connect: (async () => ({ status: "connected" })) as any,
  accounts: (async () => { throw new Error(IG_READ_RATE_ERROR); }) as any,
  positions: (async () => {
    if (positionsMode === "limit") throw new Error(IG_READ_RATE_ERROR);
    return { status: "ready", positions: [{ epic: "CS.D.AVXUSD.CFD.IP", dealId: "D1", direction: "BUY", size: 1, level: 24, bid: 25, offer: 25.1, currency: "SEK" }] };
  }) as any,
  market: (async () => { marketCalls++; throw new Error(IG_READ_RATE_ERROR); }) as any,
  candles: (async () => { candleCalls++; throw new Error(IG_HISTORY_RATE_ERROR); }) as any,
  now,
});
const ctx = { broker, brokers: { ig: broker }, risk: {} as any, config: {} as any, state: {} as any, engines: [], sideEffects: { placedOrders: [], killSwitchToggled: false } } as any;

// ══ 1. Läsgräns + slut veckokvot → Tiingo-indikatorer, märkta, IG-livepris med ══
{
  igQuote("CS.D.AVXUSD.CFD.IP", 25.05); igQuote("CS.D.ARBUSD.CFD.IP", 0.5);
  const [a, b] = await Promise.all([
    runTool("get_indicators", { symbol: "CS.D.AVXUSD.CFD.IP", interval: "5m", limit: 100 }, ctx) as Promise<any>,
    runTool("get_indicators", { symbol: "CS.D.ARBUSD.CFD.IP", interval: "1m", limit: 100 }, ctx) as Promise<any>,
  ]);
  assert.equal(a.källa, TIINGO_AGENT_LABEL, "källan står i verktygets svar"); assert.equal(a.källa, "Tiingo (ej IG-pris)");
  assert.match(a.obs, /ej IG-pris/); assert.match(a.obs, /Ordrar prissätts alltid av IG/);
  assert.ok(a.candlesAnalyzed >= 50, "5m slås ihop från 1-minutsljus"); assert.ok(a.indicators?.rsi14 !== undefined);
  assert.equal(a.senastePrisIgLive.källa, "IG-strömmen"); assert.ok(Math.abs(a.senastePrisIgLive.pris - 25.05) < 1e-9);
  assert.equal(b.källa, "Tiingo (ej IG-pris)"); assert.equal(b.interval, "1m");
  assert.equal(candleCalls, 0, "IG REST-historik provas inte när veckokvoten är spärrad/budget saknas");
  assert.equal(urls.length, 1, "kryptotickers samlas i ETT Tiingo-anrop");
  assert.match(urls[0]!, /tickers=avaxusd%2Carbusd|tickers=arbusd%2Cavaxusd/); assert.match(urls[0]!, /resampleFreq=1min/);
  assert.ok(!urls[0]!.includes("test-nyckel"), "nyckeln skickas aldrig i URL:en");
  // Ingen Tiingo-stapel hamnar i IG:s ljusserier
  const { igMarketData } = await import("../src/server/igMarketData.js");
  assert.equal(igMarketData.closed("CS.D.AVXUSD.CFD.IP", "1m", "live").length, 0);
  ok("Läsgräns + slut historikkvot: get_indicators ger Tiingo-indikatorer märkta \"källa: Tiingo (ej IG-pris)\" + IG-livepris, ett samlat anrop");
  console.log("    exempel:", JSON.stringify({ symbol: a.symbol, interval: a.interval, källa: a.källa, senastePrisIgLive: a.senastePrisIgLive, obs: a.obs, candlesAnalyzed: a.candlesAnalyzed, rsi14: a.indicators.rsi14 }));
}

// ══ 2. ±3 %-kontroll mot IG-livepriset ══
{
  igQuote("CS.D.SUIUSD.CFD.IP", 3.9); // Tiingo ~3,4 → >3 % ifrån
  const r: any = await runTool("get_indicators", { symbol: "CS.D.SUIUSD.CFD.IP", interval: "1m" }, ctx);
  assert.equal(r.källa, "ingen"); assert.match(r.error, /avviker .* från IG-livepriset/);
  ok("Tiingo som avviker mer än 3 % från IG-livepriset används inte");
}

// ══ 3. IG först när IG kan: minne, sedan REST ══
{
  const bars = Array.from({ length: 120 }, (_, i) => { const t = Math.floor(clock / 60_000) * 60_000 - (120 - i) * 60_000; return { openTime: t, closeTime: t + 60_000, open: 25, high: 25.1, low: 24.9, close: 25 + i * 0.001, volume: 0 }; });
  memoryBars["CS.D.AVXUSD.CFD.IP|1m"] = bars;
  const m: any = await runTool("get_indicators", { symbol: "CS.D.AVXUSD.CFD.IP", interval: "1m" }, ctx);
  assert.equal(m.källa, AD.SOURCE_IG_MEMORY, "IG:s strömmade ljus i minnet vinner");
  const n0 = urls.length;
  memoryBars = {};
  // Budget finns och kvoten är inte spärrad → IG REST provas (här: kvoten tar slut → spärras en timme, Tiingo tar över)
  bgRemaining = 5; historyBlocked = 0; tiingoMode = "ok";
  const r: any = await runTool("get_indicators", { symbol: "CS.D.AVXUSD.CFD.IP", interval: "1m" }, ctx);
  assert.equal(candleCalls, 1, "IG REST provades först"); assert.equal(r.källa, "Tiingo (ej IG-pris)"); assert.match(r.obs, /IG REST/);
  await runTool("get_indicators", { symbol: "CS.D.AVXUSD.CFD.IP", interval: "1m" }, ctx);
  assert.equal(candleCalls, 1, "efter kvotfelet provas IG REST inte igen på en timme");
  assert.equal(urls.length, n0, "Tiingo-cachen återanvänds (2 min för minutljus)");
  bgRemaining = 0; historyBlocked = clock + 3_600_000;
  ok("IG först: strömmade ljus i minnet → IG REST när kvot och budget finns → Tiingo; kvotfel spärrar REST en timme");
}

// ══ 4. Pris: IG-strömmen utan REST; läsgräns → Tiingo märkt ══
{
  const t: any = await runTool("get_ticker", { symbol: "CS.D.AVXUSD.CFD.IP" }, ctx);
  assert.equal(t.källa, "IG-strömmen (IG-pris)"); assert.equal(marketCalls, 0, "inget REST-anrop när strömmen har pris");
  delete quotes["CS.D.ARBUSD.CFD.IP"];
  const t2: any = await runTool("get_ticker", { symbol: "CS.D.ARBUSD.CFD.IP" }, ctx);
  assert.equal(marketCalls, 1, "IG REST provas med förtur"); assert.match(t2.källa, /^Tiingo \(ej IG-pris\)/); assert.match(t2.obs, /ordrar prissätts ändå av IG/);
  ok("get_ticker: IG-strömmens pris (inget REST), annars IG REST med förtur, sist Tiingo märkt ej IG-pris");
}

// ══ 5. Risk/konto/positioner kraschar inte på läsgräns: cachad ══
{
  const p1: any = await runTool("get_positions", {}, ctx);
  assert.equal(p1.källa, "IG (positioner)"); assert.equal(p1.positions.length, 1);
  clock += 61_000; positionsMode = "limit";
  const p2: any = await runTool("get_positions", {}, ctx);
  assert.match(p2.källa, /cachad, 61 s gammal/); assert.equal(p2.positions[0].epic, "CS.D.AVXUSD.CFD.IP");
  const r = await agent.positions(() => broker.getPositions(), () => broker.lastKnownPositions());
  assert.match(r.source, /cachad/); assert.equal(r.positions!.length, 1);
  const a = await agent.account("live", async () => { throw new Error(IG_READ_RATE_ERROR); });
  assert.match(a.source, /IG-strömmen \(cachad/); assert.equal(a.account!.balance, 10_000);
  const all: any = await runTool("get_all_positions", {}, ctx);
  assert.ok(JSON.stringify(all).includes("cachad"), "get_all_positions säger cachad"); assert.ok(!JSON.stringify(all).includes("error"));
  // Risk-analytikern använder samma vägar (ingen krasch-väg kvar för IG)
  const riskSrc = fs.readFileSync(path.resolve("src/orchestrator/advancedSpecialists.ts"), "utf8");
  assert.match(riskSrc, /igAgentData\.positions\(\(\) => broker\.getPositions\(\), \(\) => broker\.lastKnownPositions\(\), igEnv\)/);
  assert.match(riskSrc, /igAgentData\.account\(igEnv/);
  positionsMode = "ok";
  ok("Läsgräns: positioner/saldo från cache och IG-strömmens ACCOUNT, märkt cachad; Risk-analytikern kraschar inte");
}

// ══ 6. Tiingo HTTP 400 på samlat anrop → en och en ══
{
  const u: string[] = [];
  const t400 = createTiingoBars({ key: () => "k", now, batchMs: 0, fetch: (async (url: string) => {
    u.push(url); const list = (new URL(url).searchParams.get("tickers") ?? "").split(",");
    if (list.length > 1) return { ok: false, status: 400, json: async () => ({}) };
    if (list[0] === "polusd") return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => [{ ticker: list[0], priceData: tiingoRows(10, 200) }] };
  }) as any });
  const [x, y] = await Promise.all([t400.bars("CS.D.SOLUSD.CFD.IP", "Solana ($1)", "1min"), t400.bars("CS.D.POLUSD.CFD.IP", "Polygon ($1)", "1min")]);
  assert.ok(x.bars.length > 100, "giltigt par får ljus trots att ett annat par fick 400"); assert.equal(y.bars.length, 0); assert.match(y.note!, /HTTP 400/);
  assert.equal(u.length, 3, "ett samlat + ett anrop per ticker");
  ok("Tiingo HTTP 400 på samlat anrop: tickers provas en och en, ett okänt par förgiftar inte resten");
}

// ══ 6b. Glesa minutljus (tunn marknad) och 400 med förhandshämtningar ══
{
  const base = Math.floor(clock / 900_000) * 900_000 - 10 * 900_000;
  const mins = Array.from({ length: 150 }, (_, i) => ({ openTime: base + i * 60_000, open: 1, high: 1.1, low: 0.9, close: 1 + i / 1000, volume: 1 }))
    .filter((_, i) => i % 15 !== 7); // en saknad minut i varje 15-minutersgrupp
  const k15 = AD.aggregateBars(mins, 60_000, 900_000, clock);
  assert.equal(k15.length, 10, "en saknad minut fäller inte 15m-ljuset (≥ 80 % av delljusen räcker)");
  const sparse = mins.filter((_, i) => i % 3 === 0); // bara var tredje minut: för glest
  assert.equal(AD.aggregateBars(sparse, 60_000, 900_000, clock).length, 0, "för glesa grupper hoppas över");
  // HTTP 400 på ett samlat anrop med förhandshämtade tickers: bara de efterfrågade provas en och en
  const u: string[] = [];
  const th = createTiingoBars({ key: () => "k", now, batchMs: 0, fetch: (async (url: string) => {
    u.push(url); const list = (new URL(url).searchParams.get("tickers") ?? "").split(",");
    if (list.length > 1) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => [{ ticker: list[0], priceData: tiingoRows(10, 200) }] };
  }) as any });
  th.hint(["CS.D.ETHUSD.CFD.IP", "CS.D.LTCUSD.CFD.IP", "CS.D.XRPUSD.CFD.IP", "CS.D.DOTUSD.CFD.IP"].map((epic) => ({ epic, name: null })));
  const r = await th.bars("CS.D.SOLUSD.CFD.IP", "Solana ($1)", "1min");
  assert.ok(r.bars.length > 100); assert.equal(u.length, 2, "ett samlat anrop + bara den efterfrågade tickern, förhandshämtningarna släpps");
  assert.match(u[0]!, /tickers=solusd%2Cethusd/, "förhandshämtningar följer med i det samlade anropet");
  ok("Glesa minutljus ger ändå 15m (≥ 80 %); HTTP 400 med förhandshämtningar kostar bara de efterfrågade anropen");
}

// ══ 6c. Risk-analytikern med IG:s läsgräns: kör hela analytikern (LLM-svaret mockat), ingen krasch, "cachad" i underlaget ══
{
  delete process.env.AI_GATEWAY_API_KEY; delete process.env.OPENROUTER_API_KEY; process.env.ANTHROPIC_API_KEY = "test-ingen-riktig-nyckel";
  const bodies: string[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (!/anthropic\.com/.test(url)) throw new Error("Nätverk förbjudet i testerna");
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify({ portfolioHeat: 5, overallRisk: "moderate", warnings: [], recommendation: "ok", suggestedPositionSize: 100 }) }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    positionsMode = "limit"; clock += 61_000;
    const { runRiskAnalyst } = await import("../src/orchestrator/advancedSpecialists.js");
    const rep = await runRiskAnalyst("test-ingen-riktig-nyckel", broker, { maxPositionUsd: 100, maxTotalExposureUsd: 500, maxDailyLossUsd: 50, maxOpenPositions: 3 });
    assert.equal(rep.role, "risk_analyst"); assert.equal(rep.riskLevel, "medium");
    assert.equal(bodies.length, 1, "analytikern nådde LLM-steget i stället för att krascha på IG:s läsgräns");
    assert.match(bodies[0]!, /cachad/, "underlaget säger att positionerna/saldot är cachade");
    ok("Risk-analytikern vid läsgräns: ingen krasch, kör på cachat saldo/positioner märkta cachad (LLM-svaret mockat)");
  } finally { globalThis.fetch = prevFetch; positionsMode = "ok"; }
}

// ══ 6d. Analysens IG-läsningar äter aldrig orderreserven ══
{
  const { igPriorityActive, withIgPriority, IG_ORDER_READ_NEED } = await import("../src/integrations/igConnection.js");
  let R = 20; let prioReads = 0;
  // Samma regel som igConnection.consumeRead: utan förtur måste bakgrundsutrymme (R − reserv) finnas, med förtur räcker R > 0
  const consume = (cost: number) => { for (let i = 0; i < cost; i++) { if (R === 0 || (!igPriorityActive() && R - IG_ORDER_READ_NEED <= 0)) throw new Error(IG_READ_RATE_ERROR); R--; } if (igPriorityActive()) prioReads++; };
  const ag = AD.createIgAgentData({ memory: () => [], dataEnv: (e) => e, quote: () => null, name: () => null, tiingo: null, streamWaitMs: 0, now,
    budget: () => ({ remaining: R, backgroundRemaining: Math.max(0, R - IG_ORDER_READ_NEED) }), streamAccount: () => null, historyBlockedUntil: () => 0 });
  const tickers = Array.from({ length: 10 }, (_, i) => ag.ticker("live", `CS.D.T${i}USD.CFD.IP`, async () => { consume(2); return { symbol: "x", price: 1, changePct24h: 0, volume24h: 0 }; }));
  const acc = ag.account("live", async () => { consume(1); return { balances: [], totalValueUsdt: 1, updatedAt: clock }; });
  const pos = ag.positions(async () => { consume(1); return []; }, () => null, "live");
  await Promise.allSettled([...tickers, acc, pos]);
  assert.ok(R >= IG_ORDER_READ_NEED, `orderreserven kvar (${R} ≥ ${IG_ORDER_READ_NEED})`);
  assert.ok(prioReads <= AD.ANALYSIS_PRIORITY_PER_MIN, "högst 3 förturs-läsningar per minut för analysen");
  assert.ok(prioReads >= 1, "förturen används när det är säkert");
  // En order samma minut (Godkänn/stängning/tidsstopp) får hela sin reserv
  await withIgPriority(async () => consume(IG_ORDER_READ_NEED));
  assert.equal(R, 0);
  ok("10 parallella analys-ticker + saldo + positioner lämnar IG_ORDER_READ_NEED läsningar åt en order med förtur");
}

// ══ 6e. Tiingo-pris utan IG-livekurs märks tydligt ══
{
  delete quotes["CS.D.ARBUSD.CFD.IP"];
  const t: any = await runTool("get_ticker", { symbol: "CS.D.ARBUSD.CFD.IP" }, ctx);
  assert.equal(t.varning, AD.NO_IG_PRICE_TEXT); assert.equal(t.igPrisVerifierat, false);
  assert.equal(AD.NO_IG_PRICE_TEXT, "ingen IG-livekurs; nivåerna måste kontrolleras mot IG innan order");
  const i: any = await runTool("get_indicators", { symbol: "CS.D.ARBUSD.CFD.IP", interval: "1m" }, ctx);
  assert.equal(i.källa, "Tiingo (ej IG-pris)"); assert.equal(i.varning, AD.NO_IG_PRICE_TEXT);
  const all: any = await runTool("get_all_positions", {}, ctx);
  assert.ok(all.brokers.every((b: any) => b.mode !== "källa"), "ingen låtsad kontorad i portföljsammanfattningen");
  ok("Tiingo utan IG-livekurs: \"ingen IG-livekurs; nivåerna måste kontrolleras mot IG innan order\"; portföljen utan låtsad rad");
}

// ══ 6f. XSS: tipstexter escapas i Alla par, topplistan och Agentsessioner ══
{
  const html = fs.readFileSync(path.resolve("dashboard.html"), "utf8");
  const escSrc = /function esc\(t\) \{ return String\(t == null \? "" : t\)\.replace\(\/\[&<>"'\]\/g[^\n]*\}/.exec(html)![0];
  const esc = new Function(`${escSrc}; return esc;`)();
  const start = html.indexOf("window.AGTIP = (function(){"), end = html.indexOf("})();", start) + 5;
  const win: any = {};
  new Function("window", "IG", "document", html.slice(start, end))(win, { esc, px: (v: unknown) => String(v), label: (e: string) => e, isEpic: () => true, envLabel: () => "IG Live" }, { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; } });
  const evil = '<img src=x onerror=alert(1)>';
  const tip = { epic: `CS.D.X.IP"><script>alert(1)</script>`, rank: `<b>1</b>`, action: "buy", why: evil, entry: 1, takeProfit: 2, stopLoss: 0.5, sizePct: 1, sizeText: evil, horizonMin: `<i>5</i>`, confidence: evil, note: evil, unverifiedLevels: true, name: evil };
  for (const out of [win.AGTIP.line(tip), win.AGTIP.table([tip]), win.AGTIP.button(tip)]) {
    assert.ok(!/<img|<script|<i>|<b>1/.test(out), "inga råa taggar från tipstexten"); assert.ok(!/"><script/.test(out));
  }
  assert.match(win.AGTIP.line(tip), /&lt;img src=x onerror=alert\(1\)&gt;/);
  ok("XSS: Hannas tipstext (varför, not, storlek, namn, EPIC) escapas i kort, topplista och sessioner");
}

// ══ 7. Hannas tips: rang per instrument även vid HOLD ══
{
  const { parseHeadTips, sortTips } = await import("../src/orchestrator/headTips.js");
  const text = `**Beslut: HOLD överlag.**\n[1] Regim: neutral\n[2] Action: avvakta\n[3] Bevaka: AVAX\n\nTIPS_JSON:\n\`\`\`json\n[
    {"epic":"CS.D.AVXUSD.CFD.IP","rank":1,"action":"KÖP","why":"Utbrott över 25,0 med stigande RSI","entry":25.05,"tp":25.6,"sl":24.8,"sizePct":5,"horizonMin":4,"confidence":"medel"},
    {"epic":"CS.D.ARBUSD.CFD.IP","rank":2,"action":"SÄLJ","why":"Fel nivåer","entry":0.5,"tp":0.52,"sl":0.49,"sizePct":1,"horizonMin":15,"confidence":"låg"},
    {"epic":"CS.D.SUIUSD.CFD.IP","rank":3,"action":"AVVAKTA","why":"Väntar på 3,45","entry":3.45,"horizonMin":30,"confidence":"hög"},
    {"epic":"CS.D.OKÄND.CFD.IP","rank":4,"action":"KÖP","why":"inte vald"}
  ]\n\`\`\``;
  const syms = ["CS.D.AVXUSD.CFD.IP", "CS.D.ARBUSD.CFD.IP", "CS.D.SUIUSD.CFD.IP", "CS.D.NEAUSD.CFD.IP"];
  const r = parseHeadTips(text, syms, { maxStakePct: 1, stakeAmount: 100, currency: "SEK", defaultHorizonMin: 5 });
  assert.equal(r.found, true); assert.equal(r.tips.length, 4, "exakt ett tips per valt instrument");
  assert.deepEqual(r.tips.map((t) => t.rank), [1, 2, 3, 4]);
  const [avx, arb, sui, nea] = r.tips;
  assert.equal(avx!.action, "buy"); assert.equal(avx!.takeProfit, 25.6); assert.equal(avx!.stopLoss, 24.8);
  assert.equal(avx!.sizePct, 1, "storleken begränsas till insats-steget"); assert.equal(avx!.sizeText, "1 % av saldot ≈ 100 SEK"); assert.equal(avx!.horizonMin, 5, "horisont 1/5/15/30");
  assert.equal(arb!.action, "sell"); assert.equal(arb!.takeProfit, null, "ologiska SÄLJ-nivåer tas bort"); assert.match(arb!.note!, /inte logiska/);
  assert.equal(sui!.action, "hold"); assert.equal(sui!.entry, 3.45); assert.equal(sui!.sizePct, null); assert.equal(sui!.horizonMin, 30); assert.equal(sui!.confidence, "high");
  assert.equal(nea!.epic, "CS.D.NEAUSD.CFD.IP"); assert.equal(nea!.action, "hold"); assert.match(nea!.why, /inget tips/);
  assert.ok(!r.cleanedText.includes("TIPS_JSON") && r.cleanedText.includes("[3] Bevaka"), "sammanfattningen visas utan JSON-blocket");
  const none = parseHeadTips("Bara text, ingen lista.", syms.slice(0, 2), { maxStakePct: 1 });
  // Utan angiven storlek: lägsta insats-steget, inte det högsta
  const noSize = parseHeadTips(`TIPS_JSON: [{"epic":"CS.D.AVXUSD.CFD.IP","rank":1,"action":"KÖP","why":"x","entry":25,"tp":26,"sl":24}]`, ["CS.D.AVXUSD.CFD.IP"], { maxStakePct: 3, minStakePct: 1 });
  assert.equal(noSize.tips[0]!.sizePct, 1, "standardstorlek = lägsta steget");
  const { markUnverified } = await import("../src/orchestrator/headTips.js");
  const uv = markUnverified({ ...noSize.tips[0]! });
  assert.equal(uv.unverifiedLevels, true); assert.match(uv.note!, /ingen IG-livekurs; nivåerna måste kontrolleras mot IG innan order/);
  assert.match(fs.readFileSync(path.resolve("src/orchestrator/headTrader.ts"), "utf8"), /if \(!igAgentData\.igLive\(igEnv, t\.epic\)\) markUnverified\(t\)/, "tips utan IG-livepris märks overifierade");
  assert.equal(none.found, false); assert.equal(none.tips.length, 2); assert.ok(none.tips.every((t) => t.action === "hold"));
  assert.deepEqual(sortTips([{ action: "hold", confidence: "high", rank: 1 }, { action: "buy", confidence: "low", rank: 3 }, { action: "sell", confidence: "high", rank: 2 }] as any).map((t: any) => t.rank), [2, 3, 1], "Bästa först: handlingsbara, säkerhet, rang");
  // Prompten ber om tips (additivt) och Hanna-prompten innehåller kravet
  const ht = fs.readFileSync(path.resolve("src/orchestrator/headTrader.ts"), "utf8");
  assert.match(ht, /buildHeadTraderPrompt\(config, state, performance\) \+ \(igEnv \? tipsPromptBlock\(\) : ""\)/);
  assert.match(ht, /modelFor\("head", "claude-sonnet-4-6"\)/, "Hannas modell/provider oförändrad");

  // Anteckningar per EPIC + topplista över sessionens omgångar
  const { buildAgentNotes, createAgentNotes } = await import("../src/server/igAgentNotes.js");
  const store = createAgentNotes({ persist: false });
  const n1 = buildAgentNotes({ env: "live", symbols: syms.slice(0, 2), picks: [], technical: [], summary: "HOLD", tips: r.tips.slice(0, 2), runId: "session-1", at: "2026-10-11T10:00:00.000Z" });
  const n2 = buildAgentNotes({ env: "live", symbols: syms.slice(2), picks: [], technical: [], summary: "HOLD", tips: r.tips.slice(2).map((t, i) => ({ ...t, rank: i + 1 })), runId: "session-1", at: "2026-10-11T10:01:00.000Z" });
  store.record(n1); store.record(n2);
  assert.equal(store.get("live")["CS.D.AVXUSD.CFD.IP"]!.tip!.action, "buy", "tipset sparas per EPIC");
  const top = store.top("live");
  assert.equal(top.runId, "session-1"); assert.equal(top.items.length, 4, "hela sessionen, inte bara sista omgången");
  assert.deepEqual(top.items.map((n) => n.epic), ["CS.D.AVXUSD.CFD.IP", "CS.D.ARBUSD.CFD.IP", "CS.D.SUIUSD.CFD.IP", "CS.D.NEAUSD.CFD.IP"]);
  assert.equal(store.top("demo").items.length, 0, "Demo blandas aldrig med Live");
  ok("Hannas TIPS_JSON → rangordnade tips per EPIC (KÖP/SÄLJ/AVVAKTA, entry/TP/SL, storlek, horisont, säkerhet), även vid HOLD; topplista Bästa först");

  // Agentsessionen: 7 instrument i omgångar om 5/min, varje instrument får sitt tips
  const { createIgSessions } = await import("../src/server/igSessions.js");
  const seven = ["CS.D.AVXUSD.CFD.IP", "CS.D.ARBUSD.CFD.IP", "CS.D.BCHUSD.CFD.IP", "CS.D.ADAUSD.CFD.IP", "CS.D.ADAUSD.CFE.IP", "CS.D.SUIUSD.CFD.IP", "CS.D.NEAUSD.CFD.IP"];
  const batches: string[][] = [];
  let sclock = clock;
  const ses = createIgSessions({
    binding: () => "g1", activeEnv: () => "live", guard: async () => null, directory: path.join(tmp, "ses"), now: () => sclock,
    runBatch: async (_env, epics) => { batches.push(epics); return { picks: [], status: "done", notes: epics.map((e, i) => ({ epic: e, verdict: "HOLD", technical: null, tip: { epic: e, rank: i + 1, action: "hold", why: "test", entry: null, takeProfit: null, stopLoss: null, sizePct: null, sizeText: null, horizonMin: 5, confidence: "low", note: null } })) }; },
  } as any);
  ses.start("live", { epics: seven, durationMinutes: 15 });
  await ses.runNext("live"); sclock += 61_000; await ses.runNext("live");
  assert.deepEqual(batches.map((b) => b.length), [5, 2], "5 per minut, alla 7 körs");
  const items = ses.state("live").session!.items;
  assert.ok(items.every((i) => i.status === "analyserad" && i.tip?.epic === i.epic), "alla 7 analyserade med tips");
  const { DIRECT_ANALYSIS_MAX } = await import("../src/server/igSessions.js");
  assert.equal(DIRECT_ANALYSIS_MAX, 10, "Analysera valda tar upp till 10");
  assert.match(fs.readFileSync(path.resolve("src/orchestrator/specialists.ts"), "utf8"), /symbols\.slice\(0, DIRECT_ANALYSIS_MAX\)/, "teknisk analytiker tar alla valda (inte bara 6)");
  ok("Analysera valda: 7 instrument tillåts (max 10); agentsessionen kör alla 7 (5 + 2) och sparar tips per instrument");
}

// ══ 8. Analys har förtur: bakgrundsläsningar pausas i miljön ══
{
  const G = await import("../src/integrations/igAnalysisGate.js");
  const release = G.beginIgAnalysis("live");
  assert.equal(G.igAnalysisActive("live"), true); assert.equal(G.igAnalysisActive("demo"), false);
  // Minidiagram: ingen IG-hämtning och bara Tiingo-cache medan agenterna analyserar
  const SP = await import("../src/server/igSparklines.js");
  let spCalls = 0; const tiCalls: Array<{ cacheOnly?: boolean }> = [];
  const sp = SP.createIgSparklines({ now, persist: false, memory: () => [], signalInterval: () => "1m", budget: () => ({ backgroundRemaining: 10 }), name: () => "Bitcoin ($1)",
    candles: async () => { spCalls++; return { candles: [] }; }, tiingo: { get: async (_e, _n, o) => { tiCalls.push(o ?? {}); return { ticker: "btcusd", closes: [], from: null, to: null, at: clock, note: "Tiingo-diagram ej hämtat" }; } } });
  const s1 = await sp.get("live", "CS.D.BITCOIN.CEE.IP");
  assert.equal(spCalls, 0, "ingen IG-hämtning under analys"); assert.match(s1.error!, /agenterna analyserar/); assert.equal(tiCalls[0]!.cacheOnly, true, "Tiingo bara cache");
  await sp.get("demo", "CS.D.BITCOIN.CEE.IP"); assert.equal(spCalls, 1, "andra miljön påverkas inte");
  // Katalogkrypningen hoppar över miljön
  const { createIgMarketDirectory } = await import("../src/integrations/igMarketDirectory.js");
  const crawled: string[] = [];
  const dir = createIgMarketDirectory({ now, status: () => ({ environments: { demo: { status: "connected", connectionGeneration: "d1" }, live: { status: "connected", connectionGeneration: "l1" } } }) as any,
    fallback: (async (mode: string, category: string) => { crawled.push(`${mode}:${category}`); return { markets: [], complete: true }; }) as any });
  await dir.tickCatalogues();
  assert.ok(crawled.length > 0 && crawled.every((c) => c.startsWith("demo:")), "Live-katalogen pausas, Demo fortsätter");
  // Katalogens läsbudget i igMarkets säger nej i miljön
  const { createIgMarkets } = await import("../src/integrations/igMarkets.js");
  let calls = 0;
  const mk = createIgMarkets({ now, call: (async () => { calls++; return { categories: [] }; }) as any, status: () => ({ environments: { live: { status: "connected", connectionGeneration: "l1" }, demo: { status: "connected", connectionGeneration: "d1" } } }) as any });
  await mk.catalogue("live", "crypto").catch(() => null);
  assert.equal(calls, 0, "katalogens IG-läsningar pausas under analys");
  release();
  assert.equal(G.igAnalysisActive("live"), false, "förturen släpps");
  await mk.catalogue("live", "crypto").catch(() => null);
  assert.ok(calls > 0, "efter analysen läser katalogen igen");
  // Självutlösning efter 10 min om en tur hänger
  let gc = 0; const g2 = G.createIgAnalysisGate({ now: () => gc });
  g2.begin("demo"); assert.equal(g2.active("demo"), true); gc += G.ANALYSIS_GATE_MAX_MS; assert.equal(g2.active("demo"), false);
  // Orkestreringen tar förturen och släpper den i finally
  const orch = fs.readFileSync(path.resolve("src/orchestrator/orchestrator.ts"), "utf8");
  assert.match(orch, /const release = beginIgAnalysis\(env\);[\s\S]*finally \{ release\(\); \}/);
  ok("Under analys: katalog, minidiagrammens IG-hämtningar och Tiingo-anrop pausas i miljön; förturen släpps (och löper ut efter 10 min)");
}

console.log("Agenternas data: alla tester godkända (endast mocks, inga nätverksanrop)");
