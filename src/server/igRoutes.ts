import type http from "node:http";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { IgBroker, IG_EXECUTION_OFF } from "../brokers/ig.js";
import { getIgStatus, testIgConnection, getIgReadBudget, withIgPriority, isIgTemporaryRateError, type IgEnvironment } from "../integrations/igConnection.js";
import { localIgCredentialRequest, saveIgCredentials } from "../integrations/igCredentialStore.js";
import { igChanged } from "../integrations/igEvents.js";
import { getIgMarket, getIgHistory, searchIgMarkets } from "../integrations/igMarkets.js";
import { getIgMarketDirectory, getIgDirectoryEnrichment, peekIgMarketDirectory, igLiveOnlyReferences } from "../integrations/igMarketDirectory.js";
import { getIgOrderState, resolveIgUnknown, answerIgLateExit } from "../integrations/igOrders.js";
import { igMarketData, type IgQuote, type Candle } from "./igMarketData.js";
import { currentStake } from "../risk/stakeLadder.js";
import { igOrderMoneyView } from "../integrations/igRiskLimits.js";
import { listIgImportedSignals, saveIgImportedSignal, deleteIgImportedSignal } from "../integrations/igImportedSignals.js";
import { igPreferences } from "../integrations/igPreferences.js";
import { cancelTimedExitForDeal, listTimedExits } from "./tradeHorizon.js";
import { checkOrderGate, liveAllowedByServer } from "./orderGate.js";
import { userAction } from "./agentActivity.js";
import { log } from "../logger.js";
import { strategyLibrary } from "./igStrategyLibrary.js";
import { getTiingoStatus } from "../data/tiingoHistory.js";
import { igCourse } from "../integrations/igCourse.js";

// ═══════════════════════════════════════════════════════════════════════════
//  IG-rutter (auth-grinden i api.ts körs före dessa)
//
//   GET  /api/ig/status                 → Demo + Live: ansluten?, kontovaluta, orderläge, läsbudget
//   POST /api/ig/connect {environment}  → anslut (inloggning ligger lokalt i trading-ig.json)
//   POST /api/ig/credentials            → spara inloggning, bara från localhost (Codex igCredentialStore)
//   GET  /api/ig/balance                → saldo/tillgängligt/P-L i kontovaluta (aktiv miljö)
//   POST /api/ig/stake-quote            → storlek, marginal, SL/TP i kontovaluta för en insats (skickar inget)
//   POST /api/ig/positions/:dealId/close → "Sälj nu": lägger en stängning i Väntande ordrar (GODKÄNN krävs)
//   GET  /api/ig/history                → IG-transaktioner/aktivitet 30 dagar (aktiv miljö)
//   GET  /api/market/watchlist          → bevakade EPICs med namn
//   POST /api/market/watchlist {epic}   → lägg till (verifieras mot IG)
//   DELETE /api/market/watchlist/:epic  → ta bort
//   GET  /api/market/directory?category=forex|crypto → IG-katalogen för aktiv miljö
//   GET  /api/market/search?q=          → IG-sökning
//   GET  /api/market/klines?symbol=EPIC&interval=1m&limit=300 → stängda IG-ljus + pågående + datatillstånd
//   GET  /api/market/prices?symbols=a,b → kvoter med ålder/tillstånd
//   GET  /api/market/stream?epics=a,b   → SSE: quote, candle, stream-status (IG Lightstreamer via servern)
// ═══════════════════════════════════════════════════════════════════════════

const EPIC_RE = /^[A-Za-z0-9._-]{1,100}$/;
const sse = new Set<{ res: http.ServerResponse; epics: Set<string> }>();
let sseWired = false;

function send(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
async function body(req: http.IncomingMessage, readBody: (r: http.IncomingMessage) => Promise<string>): Promise<Record<string, any>> {
  const raw = await readBody(req);
  if (raw.length > 8192) throw new Error("För stor begäran");
  if (!raw.trim()) return {};
  const v = JSON.parse(raw);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
const envLabel = (e: IgEnvironment) => (e === "live" ? "IG Live" : "IG Demo");
export const LIVE_LOCKED = "IG Live är låst på servern (MODE=live och LIVE_TRADING_CONFIRMED=true krävs i .env). Ingen inloggning eller läsning mot Live görs.";
/** M4: belopp visas bara för aktiv miljö; den andra miljön visar bara valuta/kontotyp. */
export function accountView<T extends { currency: string | null; accountType: string | null }>(a: T | null, active: boolean): T | { currency: string | null; accountType: string | null; hidden: true } | null {
  if (!a) return null;
  return active ? a : { currency: a.currency, accountType: a.accountType, hidden: true };
}

/** Vanlig kurs när IG anger ett forexpris i punkter (EUR/USD Mini CEEM 11201,05 = 1,1201050), annars null.
 *  IG:s scalingFactor säger inte om priset är i punkter (dator 1: GBP/USD Mini har 10000 men kurs 1,32), så paret i EPIC avgör:
 *  pipstorlek 0,01 för JPY, annars 0,0001, och bara när priset är orimligt högt för en vanlig kurs. Order och nivåer använder IG:s pris. */
const PIP4_QUOTES = new Set(["USD", "EUR", "GBP", "CHF", "CAD", "AUD", "NZD", "SGD", "SEK", "NOK", "DKK", "PLN", "ZAR", "MXN", "TRY", "CNH", "HKD"]);
export function igPlainRate(price: number | null | undefined, epic: string): number | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  const m = /^(?:CS\.D\.|IX\.D\.SUN)([A-Z]{3})([A-Z]{3})\./.exec(epic); if (!m) return null; // IX.D.SUN… = IG:s helgmarknad (Weekend EUR/USD)
  const [, base, quote] = m as unknown as [string, string, string];
  if (!PIP4_QUOTES.has(base) && base !== "JPY") return null; // inte ett valutapar (t.ex. krypto)
  if (quote === "JPY") return price >= 2000 ? price * 0.01 : null;
  if (PIP4_QUOTES.has(quote)) return price >= 1000 ? price * 0.0001 : null;
  return null;
}
function quoteView(q: IgQuote | null, epic: string, env: IgEnvironment = igMarketData.getActiveEnv()) {
  const ds = igMarketData.dataState(epic, env);
  const plain = q ? { plainRate: igPlainRate(q.mid, epic) } : {};
  return q ? { ...plain, epic, name: igMarketData.nameOf(epic, env), bid: q.bid, offer: q.offer, mid: q.mid, changePct: q.changePct, high: q.high, low: q.low, observedAt: q.observedAt, receivedAt: q.receivedAt, delayTime: q.delayTime, marketStatus: q.marketStatus, source: q.source, state: ds.state, ageMs: ds.ageMs }
    : { epic, name: igMarketData.nameOf(epic, env), state: ds.state, ageMs: null };
}
/** Katalogframsteg i klartext: antal, komplett/delvis, fel och nästa försök (~60 s, singleflight i katalogen). */
export function catalogueProgress(d: { markets?: unknown[]; status?: string; complete?: boolean; error?: string | null; note?: string; updatedAt?: number; progress?: any; remainingSearches?: number | null }) {
  const count = Array.isArray(d.markets) ? d.markets.length : 0;
  const complete = d.complete === true;
  const retryAt = Number(d.progress?.retryAt ?? d.progress?.category?.retryAt) || null;
  const state = d.status === "unavailable" ? "fel" : complete ? "fullständig" : "delvis";
  const text = state === "fel" ? `Katalogen kunde inte hämtas: ${d.error ?? "okänt fel"}. Nytt försök inom ~60 s.`
    : complete ? `${count} instrument · fullständig`
    : `${count} instrument hittills · delvis${d.remainingSearches ? ` · ${d.remainingSearches} sökningar kvar` : ""}${d.error ? ` · ${d.error}` : ""} · fortsätter automatiskt inom IG:s läskvot`;
  return { count, complete, state, error: d.error ?? null, note: d.note ?? null, updatedAt: d.updatedAt ?? null, retryAt, remainingSearches: d.remainingSearches ?? null, text };
}
const chartBar = (c: Candle) => ({ time: Math.floor(c.openTime / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, closed: c.closed });

function wireSse(): void {
  if (sseWired) return;
  sseWired = true;
  const write = (epic: string | null, event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sse) if (!epic || c.epics.has(epic)) { try { c.res.write(msg); } catch { sse.delete(c); } }
  };
  igMarketData.events.on("quote", (env: IgEnvironment, q: IgQuote) => { if (env === igMarketData.getActiveEnv()) write(q.epic, "quote", { env, ...quoteView(q, q.epic, env) }); });
  igMarketData.events.on("candle", (env: IgEnvironment, epic: string, iv: string, c: Candle) => { if (env === igMarketData.getActiveEnv()) write(epic, "candle", { env, epic, interval: iv, bar: chartBar(c) }); });
  // Stängda ljus som kom via REST (serier utan IG-diagramplats) når också webbläsaren
  igMarketData.events.on("closed", (env: IgEnvironment, epic: string, iv: string, c: Candle) => { if (env === igMarketData.getActiveEnv() && !igMarketData.streamedSeries(env).includes(`${epic}|${iv}`)) write(epic, "candle", { env, epic, interval: iv, bar: chartBar(c) }); });
  igMarketData.events.on("stream-status", (env: IgEnvironment, s: unknown) => { if (env === igMarketData.getActiveEnv()) write(null, "stream-status", { env, ...(s as object) }); });
  igMarketData.events.on("env", (env: IgEnvironment) => write(null, "env", { env, label: envLabel(env) }));
  const hb = setInterval(() => write(null, "heartbeat", { at: Date.now(), env: igMarketData.getActiveEnv(), stream: igMarketData.streamStatus() }), 15_000);
  hb.unref?.();
}

/** IG:s egen sida där ProRealTime öppnas efter inloggning hos IG. Endast https på ig.com, inga query-parametrar (ingen sessionstoken). */
export const PRT_DEFAULT_URL = "https://www.ig.com/se";
export function prtLink(configured?: string) {
  let url = PRT_DEFAULT_URL;
  if (configured) {
    try {
      const u = new URL(configured);
      if (u.protocol === "https:" && (u.hostname === "ig.com" || u.hostname.endsWith(".ig.com")) && !u.search && !u.hash && !u.username && !u.password) url = u.toString();
    } catch { /* ogiltig adress → standard */ }
  }
  return {
    url,
    api: false as const,
    note: "ProRealTime har inget API i vårt system. Knappen öppnar IG:s egen sida i ett nytt fönster; logga in där och starta ProRealTime från IG-plattformen. Inget delas mellan PRT och dashboarden.",
  };
}

export async function handleIgRoutes(
  url: URL, method: string, req: http.IncomingMessage, res: http.ServerResponse,
  readBody: (r: http.IncomingMessage) => Promise<string>,
  brokers: Record<string, BrokerAdapter>,
  activeBroker: () => string | undefined,
  onEvent: (e: string, d: unknown) => void,
  addPending: (o: Record<string, any>) => Promise<{ id: string }>,
): Promise<boolean> {
  const p = url.pathname;
  const OTHER = ["/api/strategy-library", "/api/reference-status", "/api/course", "/api/course/backtest", "/api/tools/prt"];
  if (!p.startsWith("/api/ig/") && !p.startsWith("/api/market/") && !OTHER.includes(p)) return false;
  const env = igMarketData.getActiveEnv();
  const activeIg = (): IgBroker | null => { const b = brokers[activeBroker() ?? ""]; return b instanceof IgBroker ? b : null; };
  try {
    if (p === "/api/ig/status" && method === "GET") {
      const st = getIgStatus();
      send(res, 200, {
        activeEnv: env, label: envLabel(env), liveLocked: !liveAllowedByServer(),
        environments: Object.fromEntries((["demo", "live"] as const).map((e) => [e, {
          ...st.environments[e], connectionGeneration: undefined,
          // M4 (granskning 2): bara aktiv miljö visar belopp. Den andra miljöns saldo lämnar aldrig servern.
          account: accountView(st.environments[e].account, e === env),
          locked: e === "live" && !liveAllowedByServer(),
          executionEnabled: (brokers[e === "live" ? "ig" : "ig-demo"] as IgBroker | undefined)?.executionEnabled() ?? false,
          readBudget: getIgReadBudget(e), stream: igMarketData.streamStatus(e),
        }])),
      });
      return true;
    }
    if (p === "/api/ig/connect" && method === "POST") {
      const b = await body(req, readBody);
      if (b.environment !== "demo" && b.environment !== "live") { send(res, 400, { error: "Välj demo eller live" }); return true; }
      if (b.environment === "live" && !liveAllowedByServer()) { send(res, 403, { status: "locked", error: LIVE_LOCKED }); return true; }
      const r = await testIgConnection(b.environment);
      igChanged(b.environment);
      send(res, 200, { ...r, connectionGeneration: undefined });
      return true;
    }
    if (p === "/api/ig/credentials" && method === "POST") {
      if (!localIgCredentialRequest({ address: req.socket.remoteAddress, host: req.headers.host, origin: req.headers.origin, contentType: req.headers["content-type"], fetchSite: String(req.headers["sec-fetch-site"] ?? "") })) {
        send(res, 403, { error: "IG-uppgifter kan bara sparas från localhost på denna dator" }); return true;
      }
      try {
        const saved = saveIgCredentials(await body(req, readBody));
        if (saved.environment === "live" && !liveAllowedByServer()) { send(res, 200, { saved: true, environment: "live", ok: false, error: `Sparat. ${LIVE_LOCKED}` }); return true; }
        const r = await testIgConnection(saved.environment);
        send(res, 200, { saved: true, environment: saved.environment, ok: r.status === "connected", error: r.error });
      } catch (e) { send(res, 400, { error: e instanceof Error && e.message.startsWith("IG") ? e.message : "IG-uppgifterna kunde inte sparas säkert" }); }
      return true;
    }
    if (p === "/api/ig/balance" && method === "GET") {
      const b = activeIg();
      if (!b) { send(res, 200, { connected: false, error: "Ingen IG-mäklare aktiv" }); return true; }
      try {
        const a = await b.getAccount();
        send(res, 200, { connected: true, env: b.env, label: envLabel(b.env), currency: a.currency, balance: a.balance, available: a.available, profitLoss: a.profitLoss, stake: currentStake(), executionEnabled: b.executionEnabled() });
      } catch (e) { send(res, 200, { connected: false, env: b.env, label: envLabel(b.env), error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/ig/stake-quote" && method === "POST") {
      const b = activeIg();
      const q = await body(req, readBody);
      if (!b) { send(res, 409, { ok: false, error: "Ingen IG-mäklare aktiv" }); return true; }
      if (!EPIC_RE.test(String(q.epic)) || (q.direction !== "BUY" && q.direction !== "SELL")) { send(res, 400, { ok: false, error: "epic och direction (BUY/SELL) krävs" }); return true; }
      const acc = await b.getAccount();
      const pct = Number(q.pct) > 0 ? Math.min(3, Number(q.pct)) : currentStake()?.pct ?? 1;
      const stake = Number(q.stake) > 0 ? Number(q.stake) : (acc.balance ?? 0) * pct / 100;
      const out = await b.stakeQuote({ epic: q.epic, direction: q.direction, stake, stopLoss: Number(q.stopLoss) || undefined, takeProfit: Number(q.takeProfit) || undefined, ...(Number(q.size) > 0 ? { size: Number(q.size) } : {}) });
      const portfolio = await b.portfolioMargin().catch(() => null);
      const money = igOrderMoneyView({ currency: acc.currency ?? null, balance: acc.balance ?? null, available: acc.available ?? null, profitLoss: acc.profitLoss ?? null, pct, stake, quote: out, portfolio });
      send(res, 200, { ...out, pct, money, account: { currency: acc.currency, balance: acc.balance, available: acc.available, profitLoss: acc.profitLoss }, env: b.env, label: envLabel(b.env), executionEnabled: b.executionEnabled() });
      return true;
    }
    {
      const m = p.match(/^\/api\/ig\/positions\/([A-Za-z0-9_-]{1,100})\/close$/);
      if (m && method === "POST") {
        const b = activeIg();
        if (!b) { send(res, 409, { ok: false, error: "Ingen IG-mäklare aktiv" }); return true; }
        const dealId = m[1]!;
        const pos = (await b.getPositions()).find((x) => x.dealId === dealId);
        if (!pos) { send(res, 404, { ok: false, error: "Positionen finns inte (längre) i IG" }); return true; }
        const gate = await checkOrderGate({ live: b.mode === "live", side: pos.direction === "SELL" ? "BUY" : "SELL", unitsOrder: true, opening: false, source: "Sälj nu" });
        if (!gate.ok) { send(res, 200, { ok: false, error: gate.error }); return true; }
        const pend = await addPending({ source: "Sälj nu", venue: `broker:${b.name}`, live: b.mode === "live", symbol: pos.symbol, name: pos.name, side: pos.direction === "SELL" ? "BUY" : "SELL", quantity: pos.quantity, closeDealId: dealId, refPrice: pos.currentPrice, reason: `Stäng ${pos.name ?? pos.symbol} (${pos.direction === "SELL" ? "kort" : "lång"} ${pos.quantity})` });
        userAction(`Sälj nu: stäng ${pos.name ?? pos.symbol}`, { to: "orders", coin: pos.symbol });
        onEvent("pending-orders", { id: pend.id });
        send(res, 200, { ok: true, pendingOrder: pend, executionEnabled: b.executionEnabled(), note: b.executionEnabled() ? "Väntar på GODKÄNN" : `${IG_EXECUTION_OFF}: stängningen skickas inte förrän orderläget slås på.` });
        return true;
      }
    }
    if (p === "/api/ig/history" && method === "GET") {
      const e = url.searchParams.get("env") === "live" ? "live" : url.searchParams.get("env") === "demo" ? "demo" : env;
      if (e === "live" && !liveAllowedByServer()) { send(res, 403, { env: e, status: "locked", error: LIVE_LOCKED }); return true; }
      try { send(res, 200, { env: e, ...(await getIgHistory(e)) }); } catch (err) { send(res, 200, { env: e, status: "unavailable", error: err instanceof Error ? err.message : String(err) }); }
      return true;
    }
    {
      // Manuell avstämning av ett okänt orderutfall utan IG-referens. Läser positioner + IG-aktivitet, skickar inget.
      const m = p.match(/^\/api\/ig\/orders\/([A-Za-z0-9_-]{1,100})\/resolve$/);
      if (m && method === "POST") {
        try {
          const r = await withIgPriority(() => resolveIgUnknown(env, m[1]!));
          userAction(`stämde av okänt IG-utfall: ${r.note}`, { to: "orders" });
          onEvent("pending-orders", { resolved: m[1] });
          send(res, 200, { ok: true, env, ...r });
        } catch (e) { send(res, 200, { ok: false, env, error: e instanceof Error ? e.message : String(e) }); }
        return true;
      }
    }
    {
      // N1 (granskning 3): Mikes uttryckliga svar på "tidsstängning saknas – lägg till?" efter manuell avstämning.
      // Body {add:true} lägger till tidsstängningen, {add:false} avböjer. Läser bara positioner, skickar inget till IG.
      const m = p.match(/^\/api\/ig\/orders\/([A-Za-z0-9_-]{1,100})\/timed-exit$/);
      if (m && method === "POST") {
        try {
          const b = await body(req, readBody);
          if (typeof b.add !== "boolean") throw new Error("Svara uttryckligen ja eller nej (add: true/false)");
          const r = await withIgPriority(() => answerIgLateExit(env, m[1]!, b.add));
          userAction(`tidsstängning efter avstämning: ${r.note}`, { to: "orders" });
          onEvent("pending-orders", { timedExit: m[1] });
          send(res, 200, { ok: true, env, ...r });
        } catch (e) { send(res, 200, { ok: false, env, error: e instanceof Error ? e.message : String(e) }); }
        return true;
      }
    }
    if (p === "/api/ig/orders" && method === "GET") {
      send(res, 200, { env, ...getIgOrderState(env), timedExits: listTimedExits().filter((x) => x.dealId) });
      return true;
    }

    // ── Favoriter per miljö (servern, Codex igPreferences) ──
    if (p === "/api/ig/preferences" && method === "GET") { send(res, 200, { env, ...igPreferences.get(env) }); return true; }
    if (p === "/api/ig/preferences" && method === "POST") {
      try { send(res, 200, { ok: true, env, ...igPreferences.set(env, await body(req, readBody)) }); } catch (e) { send(res, 409, { ok: false, env, error: e instanceof Error ? e.message : String(e), ...igPreferences.get(env) }); }
      return true;
    }
    // ── Inklistrade IG-signaler (overifierade utkast; ingen order) ──
    if (p === "/api/ig/imported-signals" && method === "GET") {
      try { send(res, 200, { ok: true, env, signals: listIgImportedSignals(env) }); } catch (e) { send(res, 200, { ok: false, env, signals: [], error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/ig/imported-signals" && method === "POST") {
      try {
        const b = await body(req, readBody);
        const signal = saveIgImportedSignal(env, { epic: String(b.epic ?? ""), sourceText: String(b.sourceText ?? ""), direction: b.direction, entryLevel: Number(b.entryLevel), stopLevel: Number(b.stopLevel), targetLevel: Number(b.targetLevel), validUntil: Number(b.validUntil) });
        userAction(`klistrade in IG-signal ${signal.direction} ${signal.epic} (overifierad)`);
        send(res, 200, { ok: true, env, signal, signals: listIgImportedSignals(env) });
      } catch (e) { send(res, 400, { ok: false, env, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    {
      const m = p.match(/^\/api\/ig\/imported-signals\/([a-zA-Z0-9-]{1,100})$/);
      if (m && method === "DELETE") {
        try { deleteIgImportedSignal(env, m[1]!); send(res, 200, { ok: true, env, signals: listIgImportedSignals(env) }); } catch (e) { send(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
        return true;
      }
    }

    // ── Marknad ──
    if (p === "/api/market/watchlist" && method === "GET") {
      send(res, 200, { env, label: envLabel(env), watchlist: igMarketData.watchlistDetailed(env), max: 10 });
      return true;
    }
    if (p === "/api/market/watchlist" && method === "POST") {
      const b = await body(req, readBody);
      try {
        const r = await igMarketData.addWatch(String(b.epic ?? ""), env);
        userAction(`följer ${r.name ?? r.epic}`, { coin: r.epic });
        send(res, 200, { ok: true, env, ...r, watchlist: igMarketData.watchlistDetailed(env) });
      } catch (e) { send(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    {
      const m = p.match(/^\/api\/market\/watchlist\/([A-Za-z0-9._-]{1,100})$/);
      if (m && method === "DELETE") { igMarketData.removeWatch(m[1]!, env); send(res, 200, { ok: true, env, watchlist: igMarketData.watchlistDetailed(env) }); return true; }
    }
    if (p === "/api/market/directory" && method === "GET") {
      const category = url.searchParams.get("category") === "crypto" ? "crypto" : "forex";
      try {
        const d = await getIgMarketDirectory(env, category);
        for (const m of d.markets) igMarketData.rememberName(env, m.epic, m.name, m.category);
        // Demo: Live-EPICs som saknas här visas som katalogreferens ("ej tillgänglig på Demo"), utan Live-priser
        const liveReferences = env === "demo" ? igLiveOnlyReferences(d.markets, peekIgMarketDirectory("live", category)?.markets) : [];
        send(res, 200, { env, label: envLabel(env), ...d, liveReferences, catalogue: catalogueProgress(d) });
      } catch (e) {
        // Fel: visa senast kända katalog för samma inloggning (urvalet tappas inte) + felet
        const last = peekIgMarketDirectory(env, category);
        const error = e instanceof Error ? e.message : String(e);
        if (last) send(res, 200, { env, label: envLabel(env), ...last, status: "partial", error, liveReferences: [], catalogue: catalogueProgress({ ...last, status: "partial", error }) });
        else send(res, 200, { env, label: envLabel(env), category, markets: [], liveReferences: [], status: "unavailable", error, catalogue: catalogueProgress({ markets: [], status: "unavailable", error }) });
      }
      return true;
    }
    // Krav G: ProRealTime. Ingen inbäddning, ingen sessionslänk, inget API – bara IG:s egen sida i nytt fönster.
    if (p === "/api/tools/prt" && method === "GET") {
      send(res, 200, prtLink(process.env.IG_PRT_URL));
      return true;
    }
    // Krav F1–F3: Strategy Library (definitioner gemensamma, resultat per miljö)
    if (p === "/api/strategy-library" && method === "GET") {
      send(res, 200, { env, label: envLabel(env), ...strategyLibrary() });
      return true;
    }
    // Krav F5: Backtest & kurs. Tiingo används bara om nyckel finns; dagsdata validerar inte 1–5 min.
    if (p === "/api/reference-status" && method === "GET") {
      const t = getTiingoStatus();
      send(res, 200, { provider: t.provider, configured: t.configured, status: t.status, error: t.error, interval: t.interval, purpose: t.purpose, note: "Dagliga Tiingo-data validerar inte 1–5 minuters innehav." });
      return true;
    }
    if (p === "/api/course" && method === "GET") {
      let view: unknown;
      try { view = igCourse.view(); } catch (e) { view = { status: "blocked", canRun: false, note: e instanceof Error ? e.message : String(e) }; }
      send(res, 200, view);
      return true;
    }
    if (p === "/api/course/backtest" && method === "POST") {
      try {
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new Error("JSON krävs");
        const b = await body(req, readBody);
        if (Object.keys(b).length) throw new Error("Backtest tar inga ändringar av strategi eller sökväg via HTTP");
        send(res, 200, await igCourse.run());
      } catch (e) { send(res, 400, { error: e instanceof Error ? e.message : "Backtest kunde inte startas" }); }
      return true;
    }
    if (p === "/api/market/catalogue-status" && method === "GET") {
      const out: Record<string, unknown> = {};
      for (const c of ["forex", "crypto"] as const) { const d = peekIgMarketDirectory(env, c); out[c] = d ? catalogueProgress(d) : { count: 0, state: "väntar", text: "Katalogen har inte hämtats än", complete: false }; }
      send(res, 200, { env, label: envLabel(env), ...out, readBudget: getIgReadBudget(env) });
      return true;
    }
    if (p === "/api/market/enrichment" && method === "GET") {
      const epic = String(url.searchParams.get("epic") ?? "");
      try { send(res, 200, await getIgDirectoryEnrichment(env, epic)); } catch (e) { send(res, 200, { epic, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/market/search" && method === "GET") {
      try {
        const r = await searchIgMarkets(env, String(url.searchParams.get("q") ?? ""));
        for (const m of r.markets) igMarketData.rememberName(env, m.epic, m.name, m.category);
        send(res, 200, { env, markets: r.markets });
      } catch (e) { send(res, 200, { env, markets: [], error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/market/klines" && method === "GET") {
      const epic = String(url.searchParams.get("epic") ?? url.searchParams.get("symbol") ?? "");
      const iv = url.searchParams.get("interval") || "1m";
      const limit = Math.min(500, Math.max(10, Number(url.searchParams.get("limit")) || 300));
      if (!EPIC_RE.test(epic)) { send(res, 400, { error: "Välj ett IG-instrument (EPIC)", klines: [] }); return true; }
      let meta: Record<string, unknown> = {};
      try { const m = await getIgMarket(env, epic); if (m.epic !== epic) throw new Error("IG svarade för fel instrument"); igMarketData.rememberName(env, epic, m.name, m.category); igMarketData.setRestQuote(env, epic, m.quote); meta = { name: m.name, type: m.type, category: m.category, marketStatus: m.quote.marketStatus }; }
      catch (e) { meta = { metaError: e instanceof Error ? e.message : String(e) }; }
      try { await igMarketData.ensureSeries(env, epic, iv); } catch { /* historyError visas nedan */ }
      igMarketData.requestStream([epic], env);
      // Miljön är bunden vid begärans start: allt nedan läses ur samma miljö (aldrig blandat)
      const closed = igMarketData.closed(epic, iv, env).slice(-limit);
      const forming = igMarketData.forming(epic, iv, env);
      send(res, 200, {
        env, label: envLabel(env), symbol: epic, epic, interval: iv, ...meta, name: (meta.name as string) ?? igMarketData.nameOf(epic, env),
        klines: closed.map(chartBar), forming: forming ? chartBar(forming) : null,
        historyError: igMarketData.historyError(epic, iv, env), quote: quoteView(igMarketData.quote(epic, env), epic, env),
        streamed: igMarketData.streamedSeries(env).includes(`${epic}|${iv}`), envChanged: env !== igMarketData.getActiveEnv(),
        source: `${envLabel(env)} · REST-historik (stängda mid-ljus) + Lightstreamer`, at: Date.now(),
      });
      return true;
    }
    if (p === "/api/market/prices" && method === "GET") {
      const symbols = (url.searchParams.get("symbols") || igMarketData.watchlist(env).join(",")).split(",").map((x) => x.trim()).filter((x) => EPIC_RE.test(x)).slice(0, 30);
      igMarketData.requestStream(symbols, env);
      const prices: Record<string, number> = {};
      const quotes: Record<string, unknown> = {};
      for (const s of symbols) {
        let q = igMarketData.quote(s, env);
        if (!q || q.observedAt === null || Date.now() - q.observedAt > 60_000) {
          try { const m = await getIgMarket(env, s); igMarketData.setRestQuote(env, s, m.quote); igMarketData.rememberName(env, s, m.name, m.category); q = igMarketData.quote(s, env); } catch { /* visas som saknad */ }
        }
        quotes[s] = quoteView(q, s, env);
        if (q) prices[s] = q.mid;
      }
      send(res, 200, { env, prices, quotes, source: envLabel(env), at: Date.now(), envChanged: env !== igMarketData.getActiveEnv() });
      return true;
    }
    if (p === "/api/market/stream" && method === "GET") {
      wireSse();
      const epics = new Set((url.searchParams.get("epics") || "").split(",").map((x) => x.trim()).filter((x) => EPIC_RE.test(x)).slice(0, 30));
      // Öppna diagram (charts=EPIC|1m,...) hålls vid liv så länge strömmen är öppen; stängs fliken slutar de följas.
      const charts = (url.searchParams.get("charts") || "").split(",").map((x) => x.trim().split("|")).filter((x) => x.length === 2 && EPIC_RE.test(x[0]!) && /^(1m|3m|5m|15m|30m|1h|4h|1d)$/.test(x[1]!)).slice(0, 8) as Array<[string, string]>;
      const touch = () => { igMarketData.requestStream([...epics], env); for (const [e, iv] of charts) igMarketData.touchSeries(env, e, iv); };
      touch();
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const client = { res, epics };
      sse.add(client);
      res.write(`event: hello\ndata: ${JSON.stringify({ env, label: envLabel(env), stream: igMarketData.streamStatus() })}\n\n`);
      for (const e of epics) { const q = igMarketData.quote(e, env); if (q) res.write(`event: quote\ndata: ${JSON.stringify({ env, ...quoteView(q, e, env) })}\n\n`); }
      const keep = setInterval(touch, 60_000);
      req.on("close", () => { sse.delete(client); clearInterval(keep); });
      return true;
    }
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[ig-api] ${method} ${p}: ${msg}`);
    // IG:s läsgräns är tillfällig: svara 429 med ett begripligt meddelande i stället för ett tekniskt 500-fel.
    if (isIgTemporaryRateError(err)) { send(res, 429, { ok: false, rateLimited: true, retryAfterSeconds: 60, error: "IG:s läsgräns är nådd just nu. Försök igen om en minut." }); return true; }
    send(res, 500, { ok: false, error: msg.slice(0, 300) });
    return true;
  }
}
