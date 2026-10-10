import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { log } from "../logger.js";
import { dataPath } from "../dataDir.js";
import { getIgStatus, testIgConnection, withIgPriority, IG_HISTORY_RATE_ERROR, IG_HISTORY_BLOCK_MS, type IgEnvironment } from "../integrations/igConnection.js";
import { getIgMarket, getIgCandles, searchIgMarkets, igMarketCategory, type IgTimeframe } from "../integrations/igMarkets.js";
import { igStreaming } from "../integrations/igStreaming.js";
import { tickIgOrders } from "../integrations/igOrders.js";
import { tickIgCatalogues } from "../integrations/igMarketDirectory.js";

// ═══════════════════════════════════════════════════════════════════════════
// IG-marknadsdata för hela servern (ersätter Bybit/Binance-strömmarna).
//
//  - Historik: IG REST (prices/{epic}), bara STÄNGDA ljus (Codex normalizeIgCandles).
//    Fel i historiken (t.ex. slut på IG:s historikkvot) sparas som historyError;
//    kvot och metadata behålls, inga ljus hittas på och inga tidsstämplar fräschas upp.
//  - Realtid: IG Lightstreamer (PRICE + CHART 1MINUTE/5MINUTE/HOUR) via Codex igStreaming.
//    Ett ljus räknas som stängt först när IG skickar CONS_END=1. Signaler får bara stängda ljus.
//  - Miljö: allt lagras per miljö (demo/live) och blandas aldrig. "Aktiv" miljö följer
//    aktiv mäklare (ig-demo → demo, ig → live).
// ═══════════════════════════════════════════════════════════════════════════

export interface Candle {
  openTime: number; closeTime: number; open: number; high: number; low: number; close: number;
  volume: number; quoteVolume: number; trades: number; closed: boolean;
}
export interface IgQuote {
  epic: string; bid: number; offer: number; mid: number; observedAt: number | null; receivedAt: number;
  delayTime: number | null; marketStatus: string | null; changePct: number | null; high: number | null; low: number | null;
  source: "stream" | "rest";
}
export type DataState = "live" | "fördröjt" | "historiskt" | "inaktuellt" | "frånkopplat";

const IV_MS: Record<string, number> = { "1m": 60e3, "3m": 180e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };
const STREAM_SCALE: Record<string, string> = { "1m": "1MINUTE", "5m": "5MINUTE", "1h": "HOUR" };
const SCALE_IV: Record<string, string> = { "1MINUTE": "1m", "5MINUTE": "5m", HOUR: "1h" };
const MAX_BUFFER = 500;
const MAX_WATCH = 10;
/** IG-strömmens diagramplatser per miljö (Codex-värdet). Varje diagram kostar REST-verifiering. */
export const MAX_STREAM_CHARTS = 4;
/** Ett diagram/serie som ingen frågat efter på så här länge slutar följas (ingen ström, ingen historikpollning). */
export const SERIES_TTL_MS = 150_000;

interface Series { closed: Candle[]; forming: Candle | null; historyError: string | null; updatedAt: number; seeding?: Promise<void>; historyRetryAt?: number }

export function createIgMarketData(deps: {
  status?: typeof getIgStatus; connect?: typeof testIgConnection; market?: typeof getIgMarket; candles?: typeof getIgCandles;
  search?: typeof searchIgMarkets; stream?: typeof igStreaming; now?: () => number; file?: (env: IgEnvironment) => string;
} = {}) {
  const status = deps.status ?? getIgStatus, connect = deps.connect ?? testIgConnection, market = deps.market ?? getIgMarket;
  const candles = deps.candles ?? getIgCandles, search = deps.search ?? searchIgMarkets, stream = deps.stream ?? igStreaming;
  const now = deps.now ?? Date.now, file = deps.file ?? ((env: IgEnvironment) => dataPath(`ig-watchlist-${env}.json`));
  const events = new EventEmitter();
  events.setMaxListeners(100);
  let activeEnv: IgEnvironment = "demo";
  const series = new Map<string, Series>();
  const quotes = new Map<string, IgQuote>();
  const names = new Map<string, { name: string; category: string | null }>();
  const watch = new Map<IgEnvironment, string[]>();
  const watchedSeries = new Map<IgEnvironment, Map<string, number>>(); // "epic|interval" → senast begärd
  const pins = new Map<string, Set<string>>(); // ägare → "env|epic|interval" som alltid följs (t.ex. strategier)
  const streamedKeys = new Map<IgEnvironment, Set<string>>(); // serier som just nu har en IG-diagramplats
  const extraStreamEpics = new Map<IgEnvironment, Map<string, number>>(); // epic → senast begärd
  let signalInterval = "1m";
  const k = (env: IgEnvironment, epic: string, iv?: string) => iv ? `${env}|${epic}|${iv}` : `${env}|${epic}`;

  // ── Bevakningslista (EPICs, max 10 per miljö) ──
  function loadWatch(env: IgEnvironment): string[] {
    if (watch.has(env)) return watch.get(env)!;
    let list: string[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file(env), "utf8")) as { epics?: Array<{ epic: string; name?: string; category?: string | null }> };
      for (const e of raw.epics ?? []) if (typeof e.epic === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(e.epic)) {
        list.push(e.epic);
        if (e.name) names.set(k(env, e.epic), { name: e.name, category: e.category ?? null });
      }
    } catch { list = []; }
    list = [...new Set(list)].slice(0, MAX_WATCH);
    watch.set(env, list);
    return list;
  }
  function saveWatch(env: IgEnvironment): void {
    const list = loadWatch(env);
    try {
      fs.mkdirSync(path.dirname(file(env)), { recursive: true });
      fs.writeFileSync(file(env), JSON.stringify({ epics: list.map((epic) => ({ epic, ...names.get(k(env, epic)) })) }, null, 1));
    } catch (err) { log.warn(`[ig] bevakningslistan kunde inte sparas: ${err instanceof Error ? err.message : String(err)}`); }
    events.emit("watchlist", env, [...list]);
  }
  function nameOf(epic: string, env = activeEnv): string | null { return names.get(k(env, epic))?.name ?? null; }
  function rememberName(env: IgEnvironment, epic: string, name: unknown, category?: string | null): void {
    if (typeof name === "string" && name.trim()) names.set(k(env, epic), { name: name.slice(0, 120), category: category ?? names.get(k(env, epic))?.category ?? null });
  }

  /** Lägg till ett instrument. Det måste finnas i IG för miljön (verifieras mot /markets/{epic}). */
  async function addWatch(epic: string, env = activeEnv): Promise<{ epic: string; name: string | null }> {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(epic)) throw new Error("Ogiltig IG-EPIC");
    const list = loadWatch(env);
    if (list.includes(epic)) return { epic, name: nameOf(epic, env) };
    if (list.length >= MAX_WATCH) throw new Error(`Högst ${MAX_WATCH} instrument följs samtidigt. Ta bort ett först.`);
    const m = await market(env, epic); // kastar om EPIC inte finns på kontot
    if (m.epic !== epic) throw new Error("IG svarade för fel instrument");
    rememberName(env, epic, m.name, m.category);
    list.push(epic);
    saveWatch(env);
    if (env === activeEnv) { void ensureSeries(env, epic, signalInterval); syncStream(env); }
    return { epic, name: m.name ?? null };
  }
  function removeWatch(epic: string, env = activeEnv): void {
    const list = loadWatch(env);
    const i = list.indexOf(epic);
    if (i < 0) return;
    list.splice(i, 1);
    for (const key of [...(watchedSeries.get(env)?.keys() ?? [])]) if (key.startsWith(`${epic}|`)) watchedSeries.get(env)!.delete(key);
    saveWatch(env);
    syncStream(env);
  }

  /** Första gången: fyll listan med verkliga EPICs ur kontots egna IG-sökningar (aldrig påhittade). */
  async function seedDefaultWatch(env: IgEnvironment): Promise<void> {
    if (loadWatch(env).length) return;
    const terms = (process.env.IG_DEFAULT_WATCH || "EUR/USD,GBP/USD,USD/JPY,Bitcoin,Ether").split(",").map((t) => t.trim()).filter(Boolean);
    for (const term of terms) {
      if (loadWatch(env).length >= MAX_WATCH) break;
      try {
        const res = await search(env, term);
        const want = term.includes("/") ? new RegExp(`^${term.replace("/", "\\s*/\\s*")}(\\s+Mini)?$`, "i") : new RegExp(term, "i");
        const pick = (res.markets as any[]).filter((m) => m.category && want.test(m.name ?? "")).sort((a, b) => Number(b.marketStatus === "TRADEABLE") - Number(a.marketStatus === "TRADEABLE"))[0];
        if (!pick) continue;
        rememberName(env, pick.epic, pick.name, pick.category);
        if (!loadWatch(env).includes(pick.epic)) loadWatch(env).push(pick.epic);
      } catch (err) { log.warn(`[ig] standardinstrument "${term}" hittades inte: ${err instanceof Error ? err.message : String(err)}`); }
    }
    saveWatch(env);
  }

  // ── Ljus ──
  function getSeries(env: IgEnvironment, epic: string, iv: string): Series {
    let s = series.get(k(env, epic, iv));
    if (!s) { s = { closed: [], forming: null, historyError: null, updatedAt: 0 }; series.set(k(env, epic, iv), s); }
    return s;
  }
  const toCandle = (b: any, closed = true): Candle => ({ openTime: b.openTime, closeTime: b.closeTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: typeof b.volume === "number" ? b.volume : 0, quoteVolume: 0, trades: 0, closed });

  /** Hämtar (eller fyller på) stängda ljus via REST. Historikfel lämnar befintliga ljus orörda. */
  async function refreshHistory(env: IgEnvironment, epic: string, iv: string): Promise<void> {
    const tf = iv as IgTimeframe;
    if (!IV_MS[iv]) throw new Error(`IG stöder inte intervallet ${iv}`);
    const s = getSeries(env, epic, iv);
    try {
      const res = await candles(env, epic, tf, 200);
      if (res.quote) setRestQuote(env, epic, res.quote);
      const got = (res.candles as any[]).map((b) => toCandle(b));
      const last = s.closed[s.closed.length - 1]?.openTime ?? -Infinity;
      const fresh = got.filter((c) => c.openTime > last);
      if (!s.closed.length) s.closed = got.slice(-MAX_BUFFER);
      else if (s.closed.length < got.length) {
        // Serien har bara några strömmade ljus (historiken misslyckades först): slå ihop så att äldre historik inte kastas.
        const merged = new Map<number, Candle>(got.map((c) => [c.openTime, c]));
        for (const c of s.closed) merged.set(c.openTime, c);
        s.closed = [...merged.values()].sort((a, b) => a.openTime - b.openTime).slice(-MAX_BUFFER);
      }
      else if (fresh.length) { s.closed.push(...fresh); if (s.closed.length > MAX_BUFFER) s.closed.splice(0, s.closed.length - MAX_BUFFER); }
      s.historyError = res.status === "unavailable" ? (res.error ?? "historik saknas") : null;
      s.updatedAt = now();
      // Stort glapp (alla hämtade ljus nya): signalera bara det senaste stängda ljuset, inte 200 gamla
      const emitList = last === -Infinity ? [] : fresh.length < got.length ? fresh : fresh.slice(-1);
      if (s.closed.length) for (const c of emitList) events.emit("closed", env, epic, iv, c, s.closed);
    } catch (err) {
      s.historyError = `historik saknas: ${err instanceof Error ? err.message : String(err)}`;
      // Nytt försök om en minut (läsgräns), eller om en timme när IG:s veckokvot för historik är slut. Strömmens ljus läggs till under tiden.
      s.historyRetryAt = now() + (err instanceof Error && err.message === IG_HISTORY_RATE_ERROR ? IG_HISTORY_BLOCK_MS : 60_000);
      // Kvot/metadata behålls: hämta bara kvoten (cachad) så att priset fortfarande syns.
      try { const m = await market(env, epic); if (m.epic === epic) { rememberName(env, epic, m.name, m.category); setRestQuote(env, epic, m.quote); } } catch { /* visas som frånkopplat */ }
    }
  }
  function touchSeries(env: IgEnvironment, epic: string, iv: string): void {
    if (!IV_MS[iv] || !/^[A-Za-z0-9._-]{1,100}$/.test(epic)) return;
    let m = watchedSeries.get(env);
    if (!m) { m = new Map(); watchedSeries.set(env, m); }
    m.set(`${epic}|${iv}`, now());
  }
  const isPinned = (env: IgEnvironment, key: string) => {
    const [epic, iv] = key.split("|");
    if (iv === signalInterval && loadWatch(env).includes(epic!)) return 2; // bevakningslistans signalserie först
    for (const set of pins.values()) if (set.has(`${env}|${key}`)) return 1;
    return 0;
  };
  /** Serier som följs nu: fästa + de som begärts inom SERIES_TTL_MS. Gamla tas bort. */
  function activeSeries(env: IgEnvironment): string[] {
    const m = watchedSeries.get(env) ?? new Map<string, number>();
    for (const set of pins.values()) for (const x of set) if (x.startsWith(`${env}|`)) { const key = x.slice(env.length + 1); if (!m.has(key)) m.set(key, 0); }
    for (const epic of loadWatch(env)) if (!m.has(`${epic}|${signalInterval}`)) m.set(`${epic}|${signalInterval}`, 0);
    watchedSeries.set(env, m);
    for (const [key, at] of m) if (!isPinned(env, key) && now() - at > SERIES_TTL_MS) m.delete(key);
    return [...m.entries()].sort((a, b) => isPinned(env, b[0]) - isPinned(env, a[0]) || b[1] - a[1]).map(([key]) => key);
  }
  /** Ägare (t.ex. "strategies") fäster sina serier; en ny lista ersätter den gamla. */
  function pinSeries(owner: string, env: IgEnvironment, list: Array<{ epic: string; iv: string }>): void {
    pins.set(owner, new Set(list.filter((x) => IV_MS[x.iv]).map((x) => `${env}|${x.epic}|${x.iv}`)));
    syncStream(env);
  }
  async function ensureSeries(env: IgEnvironment, epic: string, iv: string): Promise<Series> {
    if (!IV_MS[iv]) throw new Error(`IG stöder inte intervallet ${iv}`);
    touchSeries(env, epic, iv);
    const s = getSeries(env, epic, iv);
    // Ny hämtning när serien är tom, eller när förra historikförsöket misslyckades (efter en minut). Tidigare fastnade
    // serien på ett enda strömmat ljus med ett gammalt fel, eftersom den inte längre var tom.
    const due = now() >= (s.historyRetryAt ?? 0);
    if ((!s.closed.length || (!!s.historyError && s.closed.length < 50)) && due && !s.seeding) {
      s.seeding = refreshHistory(env, epic, iv).finally(() => { s.seeding = undefined; });
    }
    if (s.seeding) await s.seeding;
    return s;
  }

  // ── Kvoter ──
  function setRestQuote(env: IgEnvironment, epic: string, q: any): void {
    if (typeof q?.bid !== "number" || typeof q?.offer !== "number") return;
    const prev = quotes.get(k(env, epic));
    // En REST-kvot ersätter aldrig en nyare strömkvot och får aldrig ny tidsstämpel.
    if (prev && prev.observedAt !== null && (q.observedAt ?? 0) <= prev.observedAt) return;
    quotes.set(k(env, epic), { epic, bid: q.bid, offer: q.offer, mid: (q.bid + q.offer) / 2, observedAt: q.observedAt ?? null, receivedAt: q.receivedAt ?? now(), delayTime: q.delayTime ?? null, marketStatus: q.marketStatus ?? null, changePct: q.percentageChange ?? prev?.changePct ?? null, high: q.high ?? prev?.high ?? null, low: q.low ?? prev?.low ?? null, source: "rest" });
  }
  function onQuote(env: IgEnvironment, q: any): void {
    // B1: trasiga eller ofullständiga strömsvar kastas (ingen gissning av pris eller tid).
    if (!q || typeof q.epic !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(q.epic) || !Number.isFinite(q.bid) || !Number.isFinite(q.offer) || !Number.isFinite(q.observedAt)) return;
    const prev = quotes.get(k(env, q.epic));
    if (prev && prev.observedAt === q.observedAt && prev.bid === q.bid && prev.offer === q.offer && prev.delayTime === (q.delayTime ?? null) && prev.marketStatus === (q.marketStatus ?? null)) return; // dubblett (en ändrad fördröjnings-/statusflagga släpps igenom)
    if (prev && prev.observedAt !== null && q.observedAt < prev.observedAt) return; // gammal/dubblett
    const next: IgQuote = { epic: q.epic, bid: q.bid, offer: q.offer, mid: (q.bid + q.offer) / 2, observedAt: q.observedAt, receivedAt: q.receivedAt, delayTime: q.delayTime, marketStatus: q.marketStatus, changePct: q.changePercent ?? prev?.changePct ?? null, high: prev?.high ?? null, low: prev?.low ?? null, source: "stream" };
    quotes.set(k(env, q.epic), next);
    events.emit("quote", env, next);
  }
  function onCandle(env: IgEnvironment, c: any): void {
    if (!c || typeof c.epic !== "string" || ![c.openTime, c.open, c.high, c.low, c.close].every(Number.isFinite)) return;
    const iv = SCALE_IV[c.scale];
    if (!iv) return;
    const s = series.get(k(env, c.epic, iv));
    if (!s) return;
    const candle: Candle = { openTime: c.openTime, closeTime: c.openTime + IV_MS[iv]!, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0, quoteVolume: 0, trades: 0, closed: !!c.closed };
    const last = s.closed[s.closed.length - 1];
    if (last && candle.openTime <= last.openTime) return; // redan stängt ljus: avvisa
    if (candle.closed) {
      s.closed.push(candle);
      if (s.closed.length > MAX_BUFFER) s.closed.shift();
      s.forming = null;
      s.updatedAt = now();
      events.emit("closed", env, c.epic, iv, candle, s.closed);
    } else s.forming = candle;
    events.emit("candle", env, c.epic, iv, candle);
  }

  function dataState(epic: string, env = activeEnv): { state: DataState; ageMs: number | null; source: string | null } {
    const q = quotes.get(k(env, epic));
    const st = stream.summary(env);
    const ageMs = q?.observedAt != null ? now() - q.observedAt : null;
    if (!q) return { state: "frånkopplat", ageMs: null, source: null };
    if (q.marketStatus && q.marketStatus !== "TRADEABLE") return { state: "historiskt", ageMs, source: q.source };
    if (ageMs === null || ageMs > 60_000) return { state: st.status === "CONNECTED:WS-STREAMING" ? "inaktuellt" : "frånkopplat", ageMs, source: q.source };
    if (q.delayTime !== 0) return { state: "fördröjt", ageMs, source: q.source };
    return { state: "live", ageMs, source: q.source };
  }

  // ── Ström ──
  function streamEpics(env: IgEnvironment): string[] {
    const extra = extraStreamEpics.get(env) ?? new Map();
    for (const [e, at] of extra) if (now() - at > 120_000) extra.delete(e);
    return [...new Set([...loadWatch(env), ...extra.keys()])].slice(0, 30);
  }
  function syncStream(env: IgEnvironment): void {
    if (status().environments[env].status !== "connected") return;
    const keys = activeSeries(env).filter((x) => !!STREAM_SCALE[x.split("|")[1]!]).slice(0, MAX_STREAM_CHARTS);
    streamedKeys.set(env, new Set(keys));
    const charts = keys.map((x) => { const [epic, iv] = x.split("|"); return { epic: epic!, scale: STREAM_SCALE[iv!]! }; });
    try { stream.ensure(env, streamEpics(env), charts, MAX_STREAM_CHARTS); } catch (err) { log.warn(`[ig] streaming: ${err instanceof Error ? err.message : String(err)}`); }
  }
  /** Diagram/kort i webbläsaren ber om kvoter för fler EPICs (gäller 2 min). */
  function requestStream(epics: string[], env = activeEnv): void {
    let m = extraStreamEpics.get(env);
    if (!m) { m = new Map(); extraStreamEpics.set(env, m); }
    for (const e of epics.slice(0, 30)) if (/^[A-Za-z0-9._-]{1,100}$/.test(e)) m.set(e, now());
    syncStream(env);
  }

  // ── Livscykel ──
  let timer: NodeJS.Timeout | null = null, slow: NodeJS.Timeout | null = null;
  const lastConnectTry = new Map<IgEnvironment, number>();
  async function ensureConnected(env: IgEnvironment): Promise<boolean> {
    const s = status().environments[env];
    if (s.status === "connected") return true;
    if (!s.credentialsComplete || now() - (lastConnectTry.get(env) ?? 0) < 60_000) return false;
    lastConnectTry.set(env, now());
    const r = await connect(env);
    if (r.status === "connected") log.ok(`[ig] ${env === "live" ? "IG Live" : "IG Demo"} anslutet (${r.account?.currency ?? "?"})`);
    else log.warn(`[ig] ${env} kunde inte anslutas: ${r.error ?? r.status}`);
    return r.status === "connected";
  }
  const listeners: Array<[string, (...a: any[]) => void]> = [
    ["quote", (env: IgEnvironment, q: any) => onQuote(env, q)],
    ["candle", (env: IgEnvironment, c: any) => onCandle(env, c)],
    ["status", (env: IgEnvironment, s: any) => events.emit("stream-status", env, s)],
    ["account", (env: IgEnvironment, a: any) => events.emit("account", env, a)],
    ["trade", (env: IgEnvironment, t: any) => events.emit("trade", env, t)],
  ];
  async function tick(): Promise<void> {
    const env = activeEnv;
    if (!(await ensureConnected(env))) return;
    await seedDefaultWatch(env);
    for (const epic of loadWatch(env)) void ensureSeries(env, epic, signalInterval);
    syncStream(env);
    // Serier utan IG-diagramplats (15m, 30m, 4h, 1d, eller fler än 4 diagram): hämta via REST när
    // ett ljus stängt. Serier som ingen följer längre hämtas inte alls.
    const streamUp = stream.summary(env).status === "CONNECTED:WS-STREAMING";
    for (const x of activeSeries(env)) {
      const [epic, iv] = x.split("|") as [string, string];
      const s = getSeries(env, epic, iv), last = s.closed[s.closed.length - 1];
      if (s.historyError && s.closed.length < 50 && now() >= (s.historyRetryAt ?? 0) && !s.seeding) { s.seeding = refreshHistory(env, epic, iv).finally(() => { s.seeding = undefined; }); continue; }
      if (streamUp && streamedKeys.get(env)?.has(x)) continue;
      if (last && now() >= last.closeTime + IV_MS[iv]! + 5_000 && !s.seeding) { s.seeding = refreshHistory(env, epic, iv).finally(() => { s.seeding = undefined; }); }
    }
  }
  function start(): void {
    if (timer) return;
    for (const [ev, fn] of listeners) stream.events.on(ev, fn);
    const run = () => void tick().catch((err) => log.warn(`[ig] marknadsdata: ${err instanceof Error ? err.message : String(err)}`));
    run();
    timer = setInterval(run, 15_000); timer.unref?.();
    slow = setInterval(() => {
      void withIgPriority(() => tickIgOrders()).catch(() => log.warn("[ig] orderavstämningen misslyckades"));
      // Katalogen körs 7 s efter orderavstämningen så att de inte slåss om samma minutbudget.
      setTimeout(() => void tickIgCatalogues().catch(() => {}), 7_000).unref?.();
    }, 15_000); slow.unref?.();
  }
  function stop(): void {
    if (timer) clearInterval(timer); if (slow) clearInterval(slow); timer = slow = null;
    for (const [ev, fn] of listeners) stream.events.off(ev, fn);
  }

  return {
    events, start, stop, tick, ensureConnected,
    setActiveEnv(env: IgEnvironment) { if (env !== activeEnv) { activeEnv = env; events.emit("env", env); void tick().catch(() => {}); } },
    getActiveEnv: () => activeEnv,
    setSignalInterval(iv: string) { signalInterval = iv; },
    getSignalInterval: () => signalInterval,
    watchlist: (env = activeEnv) => [...loadWatch(env)],
    watchlistDetailed: (env = activeEnv) => loadWatch(env).map((epic) => ({ epic, name: nameOf(epic, env), category: names.get(k(env, epic))?.category ?? null })),
    addWatch, removeWatch, seedDefaultWatch, nameOf, rememberName,
    ensureSeries, refreshHistory, requestStream,
    closed: (epic: string, iv: string, env = activeEnv) => series.get(k(env, epic, iv))?.closed ?? [],
    forming: (epic: string, iv: string, env = activeEnv) => series.get(k(env, epic, iv))?.forming ?? null,
    historyError: (epic: string, iv: string, env = activeEnv) => series.get(k(env, epic, iv))?.historyError ?? null,
    quote: (epic: string, env = activeEnv) => quotes.get(k(env, epic)) ?? null,
    quotes: (env = activeEnv) => [...quotes.entries()].filter(([key]) => key.startsWith(`${env}|`)).map(([, q]) => q),
    setRestQuote, dataState,
    streamStatus: (env = activeEnv) => stream.summary(env),
    watchedSeries: (env = activeEnv) => activeSeries(env),
    streamedSeries: (env = activeEnv) => [...(streamedKeys.get(env) ?? [])],
    touchSeries, pinSeries,
    category: (m: Record<string, unknown>) => igMarketCategory(m),
  };
}

export const igMarketData = createIgMarketData();
