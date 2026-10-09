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
