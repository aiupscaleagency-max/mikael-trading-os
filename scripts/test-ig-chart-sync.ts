// Huvuddiagrammet styr orderpanelerna + huvuddiagrammets Tiingo-bakgrund (endast visning).
// Bara mockar: inga nätverksanrop mot IG eller Tiingo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-chart-sync-"));
process.env.TRADING_DATA_DIR = tmp;
process.env.AGENT_TREE_TRADING_EVENTS = "off";
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;
const ok = (m: string) => console.log("PASS: " + m);

// ── 1. Dashboard: ORDERSYNK-blocket körs i en minimal låtsas-DOM ──
{
  const html = fs.readFileSync(path.resolve("dashboard.html"), "utf8");
  const a = html.indexOf("// ── ORDERSYNK START"), b = html.indexOf("// ── ORDERSYNK SLUT");
  assert.ok(a > 0 && b > a, "ORDERSYNK-blocket finns");
  // loadCandles anropar synken först, och Snabb-tradens par/horisont kopplas åt andra hållet
  assert.match(html, /function loadCandles\(sym, tf\)\{\n  syncOrderPanelsToChart\(sym, tf\);/);
  assert.match(html, /getElementById\("bet-sym"\)\?\.addEventListener\("change", e=>\{ orderPanelPickedSymbol\(e\.target\.value\); \}\)/);
  assert.match(html, /orderPanelPickedHorizon\(STATE\.betTf\)/);
  assert.match(html, /document\.addEventListener\("chart-instrument"/);
  // Instrumentet sparas/synkas aldrig till andra fönster: inte i synk-payloaden, inte i localStorage
  const payload = html.slice(html.indexOf("function buildSyncPayload"), html.indexOf("function applySyncPayload"));
  assert.ok(!/symbol|betSym/.test(payload), "valt instrument synkas inte mellan fönster");
  assert.ok(!/localStorage\.setItem\([^)]*betSym/.test(html));

  type El = { id: string; value: string; options: Array<{ value: string; textContent: string }>; dataset: Record<string, string>; textContent: string; classList: { toggle: (c: string, on: boolean) => void; has: Set<string> }; appendChild: (o: any) => void; click?: () => void };
  const mk = (id: string, opts: string[] = []): El => {
    const el: El = { id, value: opts[0] ?? "", options: opts.map((v) => ({ value: v, textContent: v })), dataset: {}, textContent: "", classList: { has: new Set(), toggle(c, on) { on ? this.has.add(c) : this.has.delete(c); } }, appendChild(o) { el.options.push(o); } };
    return el;
  };
  const els: Record<string, El> = { "bet-sym": mk("bet-sym", ["CS.D.EURUSD.MINI.IP", "CS.D.GBPUSD.MINI.IP"]), "ot-chart-iv": mk("ot-chart-iv", ["1m", "5m", "15m", "30m", "1h", "4h", "1d"]), "bet-tf-current": mk("bet-tf-current") };
  const betBtns = [60, 300, 900, 1800, 3600, 14400, 86400].map((s) => { const e = mk("b" + s); e.dataset.tf = String(s); return e; });
  const tfClicks: string[] = [];
  const events: any[] = [];
  const ctx: any = {
    STATE: { symbol: "CS.D.EURUSD.MINI.IP", tf: "1h", betTf: 300, betSym: "" },
    IG: { label: (s: string) => "namn:" + s },
    document: {
      getElementById: (id: string) => els[id] ?? null,
      querySelectorAll: (q: string) => (q === "#bet-tf button" ? betBtns : []),
      querySelector: (q: string) => { const m = /data-tf="([^"]+)"/.exec(q); return m ? { click: () => { tfClicks.push(m[1]!); ctx.STATE.tf = m[1]; ctx.loadCandles(ctx.STATE.symbol, m[1]); } } : null; },
      createElement: () => ({ value: "", textContent: "" }),
      dispatchEvent: (e: any) => { events.push(e.detail); return true; },
    },
    CustomEvent: class { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o?.detail; } },
    openChartFor: (sym: string) => { ctx.STATE.symbol = sym; ctx.loadCandles(sym, ctx.STATE.tf); },
    loadCalls: [] as string[],
  };
  ctx.loadCandles = (sym: string, tf: string) => { ctx.loadCalls.push(sym + "|" + tf); ctx.syncOrderPanelsToChart(sym, tf); };
  vm.createContext(ctx);
  vm.runInContext(html.slice(a, b) + "\nthis.syncOrderPanelsToChart = syncOrderPanelsToChart; this.orderPanelPickedSymbol = orderPanelPickedSymbol; this.orderPanelPickedHorizon = orderPanelPickedHorizon;", ctx);

  // Diagrammet byter EUR/USD → Ether ($1): Snabb-tradens par följer (även om Ether saknades i listan), STATE.betSym också
  ctx.STATE.symbol = "CS.D.ETHUSD.CFD.IP"; ctx.loadCandles("CS.D.ETHUSD.CFD.IP", "1h");
  assert.equal(els["bet-sym"]!.value, "CS.D.ETHUSD.CFD.IP", "orderpanelens par följer huvuddiagrammet");
  assert.equal(ctx.STATE.betSym, "CS.D.ETHUSD.CFD.IP");
  assert.ok(els["bet-sym"]!.options.some((o) => o.value === "CS.D.ETHUSD.CFD.IP" && o.textContent === "namn:CS.D.ETHUSD.CFD.IP"), "samma fullständiga namn som i diagrammet");
  assert.equal(events.at(-1).symChanged, true, "Köp/Sälj-panelen får besked direkt (kvot, insats, TP/SL)");
  // Intervall 1h → 5m: horisont och diagramintervall-menyn följer
  ctx.STATE.tf = "5m"; ctx.loadCandles("CS.D.ETHUSD.CFD.IP", "5m");
  assert.equal(ctx.STATE.betTf, 300); assert.equal(els["ot-chart-iv"]!.value, "5m"); assert.equal(els["bet-tf-current"]!.textContent, "5m");
  assert.ok(betBtns.find((x) => x.dataset.tf === "300")!.classList.has.has("active"));
  assert.equal(events.at(-1).symChanged, false); assert.equal(events.at(-1).tfChanged, true);
  // Samma instrument + intervall igen: inget nytt besked (TP/SL töms inte i onödan)
  const n = events.length; ctx.loadCandles("CS.D.ETHUSD.CFD.IP", "5m"); assert.equal(events.length, n);

  // Åt andra hållet: val i orderpanelen byter diagrammet, utan loop
  ctx.loadCalls.length = 0;
  assert.equal(ctx.orderPanelPickedSymbol("CS.D.GBPUSD.MINI.IP"), true);
  assert.equal(ctx.STATE.symbol, "CS.D.GBPUSD.MINI.IP"); assert.deepEqual(ctx.loadCalls, ["CS.D.GBPUSD.MINI.IP|5m"], "exakt en diagramladdning");
  assert.equal(els["bet-sym"]!.value, "CS.D.GBPUSD.MINI.IP");
  assert.equal(ctx.orderPanelPickedSymbol("CS.D.GBPUSD.MINI.IP"), false, "samma instrument: ingen ny laddning");
  // Horisont 1h i orderpanelen → diagrammet byter till 1h; egen tid (t.ex. 30 s) rör inte diagrammet
  assert.equal(ctx.orderPanelPickedHorizon(3600), true); assert.deepEqual(tfClicks, ["1h"]); assert.equal(ctx.STATE.tf, "1h");
  assert.equal(ctx.orderPanelPickedHorizon(30), false); assert.deepEqual(tfClicks, ["1h"]);
  ok("Huvuddiagrammet styr orderpanelerna (par, horisont, diagramintervall, kvot/TP/SL-besked) och val i orderpanelen byter diagrammet; inga loopar, inget delas mellan fönster");
}

// ── 2. Tiingo-bakgrund för huvuddiagrammet (endast visning) ──
{
  const { createIgChartBackdrop, CHART_BACKDROP_LABEL } = await import("../src/server/igChartBackdrop.js");
  const now = Date.UTC(2026, 9, 11, 10, 0, 0);
  // 1min-ljus 08:00–09:59 (120 st), pris 2000
  const minute = Array.from({ length: 120 }, (_, i) => { const t = Date.UTC(2026, 9, 11, 8, 0, 0) + i * 60_000; return { openTime: t, closeTime: t + 60_000, open: 2000, high: 2001 + (i % 5), low: 1999, close: 2000 + (i % 3), volume: 1 }; });
  const asked: string[] = [];
  const tiingo = { bars: async (_e: string, _n: string | null | undefined, f: any) => { asked.push(f); return { ticker: "ethusd", freq: f, bars: minute, at: now, note: null }; } };
  const bd = createIgChartBackdrop({ tiingo: tiingo as any, now: () => now });
  const base = { env: "live" as const, epic: "CS.D.ETHUSD.CFD.IP", name: "Ether ($1)", limit: 300, livePrice: 2000 };
  // IG har gott om ljus och inget fel: ingen bakgrund, inget Tiingo-anrop
  assert.equal(await bd.get({ ...base, interval: "5m", igBars: 200, historyError: null, igFirstOpenMs: null }), null); assert.equal(asked.length, 0);
  // Veckokvoten slut, IG har ljus från 09:30: 5m-ljus från Tiingo FÖRE 09:30, märkta
  const firstIg = Date.UTC(2026, 9, 11, 9, 30, 0);
  const r = await bd.get({ ...base, interval: "5m", igBars: 6, historyError: "IG:s veckokvot för historiska priser är slut", igFirstOpenMs: firstIg });
  assert.ok(r && r.bars.length === 18, "08:00–09:25 = 18 femminutersljus"); assert.equal(r!.label, CHART_BACKDROP_LABEL); assert.equal(r!.source, "tiingo");
  assert.ok(r!.bars.every((x) => x.time * 1000 < firstIg), "IG-ljusen vinner där de finns");
  assert.equal(r!.bars[1]!.time - r!.bars[0]!.time, 300, "omsamplat till 5m"); assert.equal(asked.at(-1), "1min");
  // 1h från 1hour, 1d från 1day
  await bd.get({ ...base, interval: "1h", igBars: 0, historyError: "x", igFirstOpenMs: null }); assert.equal(asked.at(-1), "1hour");
  await bd.get({ ...base, interval: "1d", igBars: 0, historyError: "x", igFirstOpenMs: null }); assert.equal(asked.at(-1), "1day");
  // Tiingo avviker > 3 % från IG-livepriset: visas inte
  const off = await bd.get({ ...base, livePrice: 2200, interval: "5m", igBars: 0, historyError: "x", igFirstOpenMs: null });
  assert.equal(off!.bars.length, 0); assert.match(off!.note!, /avviker/);
  // Ingen Tiingo-motsvarighet/fel: tom bakgrund med förklaring, aldrig undantag
  const none = createIgChartBackdrop({ tiingo: { bars: async () => ({ ticker: null, freq: "1min", bars: [], at: now, note: "ingen Tiingo-motsvarighet" }) } as any, now: () => now });
  const n2 = await none.get({ ...base, interval: "5m", igBars: 0, historyError: "x", igFirstOpenMs: null }); assert.equal(n2!.bars.length, 0); assert.match(n2!.note!, /motsvarighet/);
  // 15 min cache per EPIC/upplösning: diagrammets 30 s-omladdning kostar inga nya Tiingo-anrop
  const before = asked.length;
  for (let i = 0; i < 5; i++) await bd.get({ ...base, interval: "15m", igBars: 0, historyError: "x", igFirstOpenMs: null });
  assert.equal(asked.length, before, "1min-svaret återanvänds (även för 15m)");
  // Långsamt Tiingo: klines väntar högst waitMs, bakgrunden kommer vid nästa laddning
  let release: () => void = () => {};
  const slow = createIgChartBackdrop({ now: () => now, waitMs: 20, tiingo: { bars: (_e: string, _n: unknown, f: any) => new Promise((res) => { release = () => res({ ticker: "ethusd", freq: f, bars: minute, at: now, note: null }); }) } as any });
  const t0 = Date.now();
  const pending = await slow.get({ ...base, interval: "5m", igBars: 0, historyError: "x", igFirstOpenMs: null });
  assert.equal(pending?.pending, true, "enbart väntetid ger pending så klienten kan försöka en gång till");
  assert.equal(pending?.bars.length, 0);
  assert.ok(Date.now() - t0 < 1000, "diagrammet väntar inte på Tiingo");
  release(); await new Promise((r) => setTimeout(r, 5));
  const later = await slow.get({ ...base, interval: "5m", igBars: 0, historyError: "x", igFirstOpenMs: null });
  assert.ok(later && later.bars.length > 0, "nästa laddning visar bakgrunden ur cachen");
  const thr = createIgChartBackdrop({ tiingo: { bars: async () => { throw new Error("nät"); } } as any, now: () => now });
  assert.equal(await thr.get({ ...base, interval: "5m", igBars: 0, historyError: "x", igFirstOpenMs: null }), null);

  // Samma råa Tiingo-cache får olika visningsenhet per begäran, aldrig mellan miljöerna.
  const demoScaled = await bd.get({ ...base, env: "demo", livePrice: 20_000_000, scale: 10_000, interval: "5m", igBars: 0, historyError: "x", igFirstOpenMs: null });
  assert.ok(demoScaled && demoScaled.bars.length > 0);
  assert.equal(demoScaled.bars[0]!.open, 20_000_000);
  const liveUnscaled = await bd.get({ ...base, scale: 1, interval: "5m", igBars: 0, historyError: "x", igFirstOpenMs: null });
  assert.equal(liveUnscaled!.bars[0]!.open, 2000, "Demo får inte skala råcachen för Live");
  const scaledOff = await bd.get({ ...base, livePrice: 22_000_000, scale: 10_000, interval: "5m", igBars: 0, historyError: "x", igFirstOpenMs: null });
  assert.equal(scaledOff!.bars.length, 0); assert.match(scaledOff!.note!, /avviker/);

  const { igBackdropScale } = await import("../src/server/igRoutes.js");
  assert.equal(igBackdropScale(11201.05, "CS.D.EURUSD.CEEM.IP"), 10_000);
  assert.equal(igBackdropScale(1.12024, "CS.D.EURUSD.CEEM.IP"), 1);
  assert.equal(igBackdropScale(1.32, "CS.D.GBPUSD.MINI.IP"), 1, "scalingFactor 10000 betyder inte att kvoten är i punkter");
  assert.equal(igBackdropScale(15833.2, "CS.D.USDJPY.MINI.IP"), 100);
  assert.equal(igBackdropScale(158.332, "CS.D.USDJPY.MINI.IP"), 1);
  assert.equal(igBackdropScale(82995, "CS.D.BITCOIN.CEEM.IP"), 1);
  assert.equal(igBackdropScale(null, "CS.D.EURUSD.CEEM.IP"), 1);

  // Dashboard: Tiingo-ljusen hålls utanför STATE.candleData (indikatorer/rubrik/ström), ritas grå, märks i källraden och i CSV
  const html = fs.readFileSync(path.resolve("dashboard.html"), "utf8");
  const lrc = html.slice(html.indexOf("async function loadRealCandles"), html.indexOf('IG.on("quote"'));
  assert.match(lrc, /STATE\.candleData\[sym\+"\|"\+tf\] = bars;/); assert.ok(!/candleData[^\n]*bd/.test(lrc), "Tiingo-ljus hamnar aldrig i candleData");
  assert.match(lrc, /applyIndicators\(bars\)/);
  assert.match(html, /\(grå = Tiingo\)/);
  assert.match(html, /time,open,high,low,close,source/); assert.match(html, /"Tiingo \(ej IG-pris\)"\]\.join/);
  ok("Huvuddiagrammets Tiingo-bakgrund: väntar högst 1,2 s, 15 min cache, bara när IG-historik saknas, omsamplad till diagrammets intervall, före IG-ljusen, ±3 % mot IG-live, märkt och utanför signaler/indikatorer; CSV märker källan");
}
// ── 3. Kör huvuddiagrammets riktiga frontendkod mot svar och timers under testets kontroll ──
{
  const html = fs.readFileSync(path.resolve("dashboard.html"), "utf8");
  const code = html.slice(html.indexOf("async function loadRealCandles("), html.indexOf('IG.on("quote", q=>{'));
  let response: any, drawn: any[] = [], format: any, fits = 0, calls = 0, nextTimer = 0;
  const timers = new Map<number, () => void>();
  const handlers = new Map<string, () => void>();
  const bar = (time: number, price: number) => ({ time, open: price, high: price, low: price, close: price });
  const ctx: any = {
    STATE: { symbol: "EUR", tf: "1h", candleData: {}, livePrices: {} }, IG_TF: { "1h": 1 },
    igMain: { key: null, loadId: 0, backdropRetryId: -1 },
    IG: { st: { env: "live" }, isEpic: () => true, klines: async () => { calls++; return response; }, want: () => {}, on: (event: string, fn: () => void) => handlers.set(event, fn) },
    candleSeries: { setData: (data: any[]) => { drawn = data; }, data: () => drawn, applyOptions: (o: any) => { format = o.priceFormat; } },
    chart: { timeScale: () => ({ fitContent: () => fits++ }) },
    setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, 11000, "återförsöket väntar ut Tiingos 10 s timeout"); timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id: number) => timers.delete(id),
    showIgSource: () => {}, clearPriceHeader: () => {}, applyIndicators: () => {}, updatePriceHeader: () => {}, refreshIgSymbols: () => {},
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const envStart = html.indexOf('IG.on("env", ()=>{');
  vm.runInContext(html.slice(envStart, html.indexOf("function bybitChartLive()", envStart)), ctx);
  response = { env: "live", klines: [], backdrop: { bars: [bar(1, 1.120155), bar(2, 1.120165)] } };
  await ctx.loadRealCandles("EUR", "1h");
  assert.equal(format.precision, 6); assert.equal(fits, 1); assert.equal(drawn.length, 2);
  assert.equal(drawn[0].color, "#4b5563"); assert.equal(ctx.STATE.candleData["EUR|1h"].length, 0);
  await ctx.loadRealCandles("EUR", "1h"); assert.equal(fits, 1, "uppdatering behåller zoom");
  response = { env: "live", klines: [], backdrop: { bars: [], pending: true } };
  await ctx.loadRealCandles("EUR", "1h"); await ctx.loadRealCandles("EUR", "1h");
  assert.equal(nextTimer, 1, "polling lägger inte upp flera återförsök");
  const retry = timers.get(1)!; timers.delete(1); retry(); await new Promise(setImmediate);
  assert.equal(nextTimer, 1, "återförsöket får inte starta en ny timerloop");
  assert.equal(calls, 5);
  // Ett svar som redan är på väg får inte överleva Live → Demo → Live.
  let release: (d: any) => void = () => {};
  response = new Promise((resolve) => { release = resolve; });
  const old = ctx.loadRealCandles("EUR", "1h");
  ctx.IG.st.env = "demo"; handlers.get("env")!(); ctx.IG.st.env = "live"; handlers.get("env")!();
  release({ env: "live", klines: [bar(3, 9999)] }); await old;
  assert.equal(drawn.length, 0, "gammalt miljösvar återfyller inte det tömda diagrammet");
  const before = calls; retry(); await new Promise(setImmediate); assert.equal(calls, before, "gammal timer avvisas av generationen");
  response = { env: "live", klines: [bar(3, 0.00000123)], backdrop: { bars: [bar(1, 0.00000122), bar(3, 9999)] } };
  await ctx.loadRealCandles("EUR", "1h");
  assert.equal(format.precision, 8); assert.equal(drawn.length, 2); assert.equal(drawn[1].close, 0.00000123, "IG vinner vid överlapp");
  response = { env: "live", klines: [], backdrop: { bars: [], note: "Tiingo kunde inte nås" } };
  await ctx.loadRealCandles("EUR", "1h"); assert.equal(nextTimer, 1, "leverantörsfel startar ingen retry");
  ok("Huvuddiagram: prisprecision, historik/IG-separation, zoom, ett återförsök och generationsskydd vid miljöbyte");
}
console.log("Diagram/ordersynk: alla tester godkända (endast mocks, inga nätverksanrop)");
