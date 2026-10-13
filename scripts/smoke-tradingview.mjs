// Webbläsarkontroll av TradingView-analysdiagrammet mot en lokalt startad dashboard.
// Kräver Playwright (PLAYWRIGHT_PATH) och en server på DASHBOARD_URL (standard http://127.0.0.1:3955).
// Instrumentnamn läggs in som fixtures i sidan (IG.remember); inga IG-anrop och ingen order görs.
// Själva TradingView-sidan behöver inte laddas: kontrollen gäller behållaren, etiketten, iframe-adressen
// och att orderpanelen fortfarande följer IG-diagrammet.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_PATH + "/index.mjs").catch(() => import(process.env.PLAYWRIGHT_PATH));
const BASE = process.env.DASHBOARD_URL || "http://127.0.0.1:3955";
const LABEL = "TradingView · analysdiagram · inte IG:s priser";
const EUR = "CS.D.EURUSD.MINI.IP", BTC = "CS.D.BITCOIN.CFD.IP", OMX = "IX.D.OMX.IFM.IP";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/opt/google/chrome/chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// TradingView-iframen får inte hämtas i testet (ingen nätverkstrafik utåt).
await page.route(/tradingview\.com/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<html><body style='background:#0f1520'></body></html>" }));
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.evaluate(() => switchPage("trade"));
await page.evaluate(([EUR, BTC, OMX]) => {
  IG.remember([{ epic: EUR, name: "EUR/USD Mini", category: "forex" }, { epic: BTC, name: "Bitcoin", category: "crypto" }, { epic: OMX, name: "OMX Stockholm 30" }]);
  IG.st.watchlist = [EUR, BTC, OMX]; IG.emit("watchlist", IG.st.watchlist);
  window.__opened = [];
  const orig = window.openChartFor;
  window.openChartFor = (e) => { window.__opened.push(e); try { STATE.symbol = e; } catch (_) {} if (typeof orig === "function") try { orig(e); } catch (_) {} };
}, [EUR, BTC, OMX]);
await page.click('#multiChart [data-mc="2"]');
await page.waitForTimeout(300);
const pick = async (i, sel, value) => page.evaluate(([i, sel, value]) => { const el = document.querySelectorAll("#mcGrid .mc-pane")[i].querySelector(sel); el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); }, [i, sel, value]);
await pick(0, ".mc-mode", "ig"); await pick(0, ".mc-s", EUR);
await pick(1, ".mc-s", BTC); await pick(1, ".mc-mode", "tv");
await page.waitForTimeout(400);
const tv = await page.evaluate(() => { const p = document.querySelectorAll("#mcGrid .mc-pane")[1]; const f = p.querySelector(".mc-tv iframe"); return { label: p.querySelector(".tv-label")?.firstChild?.textContent, src: f?.src || null, chartHidden: p.querySelector(".mc-chart").style.display === "none" }; });
assert.equal(tv.label, LABEL, "etiketten syns i TradingView-rutan");
assert.ok(tv.src && tv.src.startsWith("https://s.tradingview.com/widgetembed/"), "officiell TradingView-inbäddning");
assert.match(tv.src, /symbol=BITSTAMP%3ABTCUSD/); assert.match(tv.src, /interval=60/);
assert.ok(tv.chartHidden, "IG-diagrammet i rutan döljs bara i TradingView-läge");
// Orderpanelen följer IG-diagrammet: klick på TradingView-rutan byter inte huvudinstrument; klick på IG-rutan gör det.
await page.evaluate(() => { window.__opened = []; STATE.symbol = "CS.D.GBPUSD.MINI.IP"; });
await page.click("#mcGrid .mc-pane:nth-child(2) .mc-tv");
assert.deepEqual(await page.evaluate(() => window.__opened), [], "TradingView styr aldrig orderpanelen");
assert.equal(await page.evaluate(() => STATE.symbol), "CS.D.GBPUSD.MINI.IP");
await page.click("#mcGrid .mc-pane:nth-child(1) .mc-lbl");
assert.deepEqual(await page.evaluate(() => window.__opened), [EUR], "IG-rutan blir huvuddiagram");
assert.equal(await page.evaluate(() => STATE.symbol), EUR);
// Ingen säker mappning → symbolsökning, ingen gissad iframe.
await pick(1, ".mc-s", OMX); await page.waitForTimeout(300);
assert.equal(await page.evaluate(() => STATE.symbol), EUR, "byte av instrument i TradingView-rutan rör inte huvuddiagrammet");
const omx = await page.evaluate(() => { const p = document.querySelectorAll("#mcGrid .mc-pane")[1]; return { search: !!p.querySelector(".tv-search"), frame: !!p.querySelector(".mc-tv iframe") }; });
assert.deepEqual(omx, { search: true, frame: false });
// Trade-sidan: valfritt TradingView under IG-huvuddiagrammet följer valt IG-instrument; IG-diagrammet ligger kvar.
await page.evaluate(() => { const c = document.getElementById("tvMainOn"); c.checked = true; c.dispatchEvent(new Event("change")); });
await page.waitForTimeout(1300);
const main = await page.evaluate(() => ({ label: document.querySelector("#tvMainBox .tv-label")?.firstChild?.textContent, src: document.querySelector("#tvMainBox iframe")?.src || "", igChart: !!document.querySelector("#chart canvas, #chart table, #chart div"), symbol: STATE.symbol }));
assert.equal(main.label, LABEL); assert.match(main.src, /symbol=FX%3AEURUSD/); assert.ok(main.igChart, "IG-huvuddiagrammet finns kvar"); assert.equal(main.symbol, EUR);
assert.deepEqual(errors, [], "inga sidfel");
console.log("PASS: TradingView-rutan visar etiketten och officiell inbäddning; symbolsökning utan säker mappning; orderpanelen följer IG-diagrammet");
await browser.close();
