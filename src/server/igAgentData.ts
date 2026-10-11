import type { Account, Kline, Position, Ticker } from "../types.js";
import { getIgReadBudget, getIgHistoryBlockedUntil, withIgPriority, IG_HISTORY_RATE_ERROR, IG_HISTORY_BLOCK_MS, type IgEnvironment } from "../integrations/igConnection.js";
import { igMarketData, type IgQuote } from "./igMarketData.js";
import { createTiingoBars, TIINGO_AGENT_LABEL, type TiingoFreq, type TiingoBarsResult } from "./tiingoIntraday.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Agenternas marknadsdata för IG-instrument (Mike 2026-10-11).
//
//  Problemet: IG:s veckokvot för historik var slut och minutbudgeten upptagen av
//  bakgrunden, så teknisk analytiker, Risk och Hanna fick "försök igen om en minut"
//  på varje anrop och gav HOLD utan tips. Nu tar agenterna data i den här ordningen:
//    (a) IG i minnet: stängda ljus från IG-strömmen/bufferten (15m/30m/4h slås ihop från
//        mindre IG-ljus) och IG-livepriset från strömmen. Inga REST-anrop.
//    (b) IG REST-historik, bara när veckokvoten inte är spärrad och bakgrundsutrymme finns.
//    (c) Tiingo som research-reserv (OHLC, samma tidsram), ALLTID märkt "källa: Tiingo (ej IG-pris)".
//        Tiingos sista stängning jämförs med IG-livepriset: avviker den mer än 3 % används den inte.
//  En serie kommer alltid från EN källa (blandas aldrig). Ordrar prissätts alltid av IG
//  (createIgPendingOrder → IgBroker), aldrig härifrån. Modulen skriver aldrig in något i igMarketData.
// ═══════════════════════════════════════════════════════════════════════════

export const IV_MS: Record<string, number> = { "1m": 60e3, "3m": 180e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };
/** Minst så många ljus för att indikatorerna (SMA50, MACD) ska betyda något */
export const AGENT_MIN_BARS = 50;
/** Tiingo får avvika högst så mycket från IG-livepriset */
export const TIINGO_MAX_DEVIATION_PCT = 3;
/** IG-livepriset räknas som färskt så här länge */
export const IG_QUOTE_FRESH_MS = 60_000;
/** Äldre IG-pris (från strömmen eller REST) får användas, märkt med ålder, upp till så här länge */
export const IG_QUOTE_MAX_AGE_MS = 30 * 60_000;
/** IG REST-historik kräver minst så mycket bakgrundsutrymme (marknad + priser), så att orderreserven aldrig rörs */
export const IG_REST_MIN_BACKGROUND = 2;

export const SOURCE_IG_MEMORY = "IG (strömmade ljus i minnet)";
export const SOURCE_IG_REST = "IG REST-historik";
export const SOURCE_TIINGO = "Tiingo (ej IG-pris)";

// Mindre IG-ljus som kan slås ihop till tidsramen (största först, färre ljus att lägga ihop)
const MEMORY_SOURCES: Record<string, string[]> = {
  "1m": ["1m"], "3m": ["3m", "1m"], "5m": ["5m", "1m"], "15m": ["15m", "5m", "1m"], "30m": ["30m", "15m", "5m", "1m"],
  "1h": ["1h", "15m", "5m"], "4h": ["4h", "1h"], "1d": ["1d", "1h"],
};
const TIINGO_FREQ: Record<string, TiingoFreq> = { "1m": "1min", "3m": "1min", "5m": "1min", "15m": "1min", "30m": "1min", "1h": "1hour", "4h": "1hour", "1d": "1day" };

type Bar = { openTime: number; closeTime?: number; open: number; high: number; low: number; close: number; volume?: number };

/** Slår ihop stängda ljus till en större tidsram. Bara kompletta grupper (alla delljus finns, sista gruppen stängd). */
export function aggregateBars(bars: Bar[], srcMs: number, dstMs: number, now: number): Kline[] {
  if (srcMs === dstMs) return bars.filter((b) => b.openTime + dstMs <= now).map((b) => ({ openTime: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0, closeTime: b.openTime + dstMs }));
  if (dstMs % srcMs !== 0) return [];
  // Tunna marknader (t.ex. små altcoins) saknar ibland en minut: en grupp räknas om minst 80 % av delljusen finns.
  // Open från första befintliga delljuset, close från sista; inget hittas på.
  const need = dstMs / srcMs, minParts = Math.max(1, Math.ceil(need * 0.8)), groups = new Map<number, Bar[]>();
  for (const b of bars) {
    const g = Math.floor(b.openTime / dstMs) * dstMs;
    const list = groups.get(g) ?? [];
    list.push(b); groups.set(g, list);
  }
  const out: Kline[] = [];
  for (const [g, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (list.length < minParts || list.length > need || g + dstMs > now) continue; // för glest, dubbletter eller ännu inte stängd: hoppas över
    list.sort((a, b) => a.openTime - b.openTime);
    out.push({ openTime: g, open: list[0]!.open, high: Math.max(...list.map((b) => b.high)), low: Math.min(...list.map((b) => b.low)), close: list[list.length - 1]!.close, volume: list.reduce((t, b) => t + (b.volume ?? 0), 0), closeTime: g + dstMs });
  }
  return out;
}

export interface IgLivePoint { price: number; bid: number; offer: number; ageSec: number | null; source: string; changePct: number | null }
export interface AgentKlines {
  klines: Kline[];
  /** Klartext om källan, t.ex. "Tiingo (ej IG-pris)" */
  source: string;
  sourceKey: "ig-memory" | "ig-rest" | "tiingo" | "none";
  /** Varför en högre prioriterad källa inte användes, eller varför data saknas */
  note: string | null;
  igLive: IgLivePoint | null;
  /** Tiingo: sista stängningens avvikelse från IG-livepriset i procent */
  deviationPct?: number | null;
  cached?: boolean;
}
export interface AgentTicker extends Ticker { source: string; bid?: number | null; offer?: number | null; ageSec?: number | null; note?: string | null }

export function createIgAgentData(deps: {
  memory?: (epic: string, iv: string, env: IgEnvironment) => Bar[];
  dataEnv?: (env: IgEnvironment, epic: string) => IgEnvironment;
  quote?: (epic: string, env: IgEnvironment) => IgQuote | null;
  name?: (env: IgEnvironment, epic: string) => string | null;
  budget?: (env: IgEnvironment) => { backgroundRemaining: number };
  historyBlockedUntil?: (env: IgEnvironment) => number;
  tiingo?: { bars: (epic: string, name: string | null | undefined, f: TiingoFreq) => Promise<TiingoBarsResult>; hint: (list: Array<{ epic: string; name?: string | null }>) => void } | null;
  streamAccount?: (env: IgEnvironment) => { balance: number | null; available: number | null; profitLoss: number | null; at: number } | null;
  now?: () => number;
} = {}) {
  const memory = deps.memory ?? ((epic, iv, env) => igMarketData.closed(epic, iv, env));
  const dataEnv = deps.dataEnv ?? ((env, epic) => igMarketData.dataEnv(env, epic));
  const quoteOf = deps.quote ?? ((epic, env) => igMarketData.quote(epic, env));
  const nameOf = deps.name ?? ((env, epic) => igMarketData.nameOf(epic, env));
  const budget = deps.budget ?? getIgReadBudget;
  const historyBlockedUntil = deps.historyBlockedUntil ?? getIgHistoryBlockedUntil;
  const tiingo = deps.tiingo === undefined ? createTiingoBars() : deps.tiingo;
  const streamAccount = deps.streamAccount ?? ((env) => igMarketData.streamAccount(env));
  const now = deps.now ?? Date.now;
  const ownHistoryBlock = new Map<IgEnvironment, number>();

  /** IG-livepriset ur minnet (ström eller senaste REST-kvot). Inget IG-anrop. */
  function igLive(env: IgEnvironment, epic: string, maxAgeMs = IG_QUOTE_MAX_AGE_MS): IgLivePoint | null {
    const q = quoteOf(epic, dataEnv(env, epic));
    if (!q || !Number.isFinite(q.bid) || !Number.isFinite(q.offer)) return null;
    const ref = q.observedAt ?? q.receivedAt;
    const age = Number.isFinite(ref) ? now() - ref : null;
    if (age !== null && age > maxAgeMs) return null;
    return { price: (q.bid + q.offer) / 2, bid: q.bid, offer: q.offer, ageSec: age === null ? null : Math.max(0, Math.round(age / 1000)), source: q.source === "stream" ? "IG-strömmen" : "IG REST-kvot", changePct: q.changePct };
  }

  function fromMemory(env: IgEnvironment, epic: string, iv: string, limit: number): Kline[] | null {
    const dst = IV_MS[iv];
    if (!dst) return null;
    const src = dataEnv(env, epic);
    for (const s of MEMORY_SOURCES[iv] ?? [iv]) {
      const bars = memory(epic, s, src) ?? [];
      if (!bars.length) continue;
      const out = aggregateBars(bars, IV_MS[s]!, dst, now());
      if (out.length >= Math.min(AGENT_MIN_BARS, limit)) return out.slice(-limit);
    }
    return null;
  }

  function restBlockedReason(env: IgEnvironment, epic: string): string | null {
    const src = dataEnv(env, epic);
    if (now() < Math.max(historyBlockedUntil(src) || 0, ownHistoryBlock.get(src) ?? 0)) return "IG:s veckokvot för historik är slut";
    let b: { backgroundRemaining: number };
    try { b = budget(src); } catch { return "IG:s läsbudget kunde inte läsas"; }
    if (!(b.backgroundRemaining >= IG_REST_MIN_BACKGROUND)) return "IG:s läsgräns denna minut (orderreserven rörs inte)";
    return null;
  }

  /** Ljus för agenterna: IG-minne → IG REST (om tillåtet) → Tiingo. rest = mäklarens vanliga IG-hämtning. */
  async function klines(env: IgEnvironment, epic: string, iv: string, limit: number, rest: (() => Promise<Kline[]>) | null): Promise<AgentKlines> {
    const lim = Math.min(300, Math.max(20, Math.round(limit) || 100));
    const live = igLive(env, epic);
    const mem = fromMemory(env, epic, iv, lim);
    if (mem) return { klines: mem, source: SOURCE_IG_MEMORY, sourceKey: "ig-memory", note: null, igLive: live };
    const notes: string[] = ["inga IG-ljus i minnet för tidsramen"];
    if (rest) {
      const why = restBlockedReason(env, epic);
      if (why) notes.push(`IG REST hoppades över: ${why}`);
      else {
        try {
          const k = await rest();
          if (k.length >= 20) return { klines: k.slice(-lim), source: SOURCE_IG_REST, sourceKey: "ig-rest", note: null, igLive: live };
          notes.push("IG REST gav för få ljus");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === IG_HISTORY_RATE_ERROR) ownHistoryBlock.set(dataEnv(env, epic), now() + IG_HISTORY_BLOCK_MS);
          notes.push(`IG REST: ${msg.slice(0, 120)}`);
        }
      }
    }
    if (!tiingo || !TIINGO_FREQ[iv]) return { klines: [], source: "ingen", sourceKey: "none", note: notes.join("; "), igLive: live };
    const f = TIINGO_FREQ[iv]!;
    let t: TiingoBarsResult;
    try { t = await tiingo.bars(epic, nameOf(env, epic) ?? nameOf(dataEnv(env, epic), epic), f); }
    catch { return { klines: [], source: "ingen", sourceKey: "none", note: [...notes, "Tiingo-reserven misslyckades"].join("; "), igLive: live }; }
    const k = t.bars.length ? aggregateBars(t.bars, IV_MS[f === "1min" ? "1m" : f === "1hour" ? "1h" : "1d"]!, IV_MS[iv]!, now()).slice(-lim) : [];
    if (k.length < 20) return { klines: [], source: "ingen", sourceKey: "none", note: [...notes, `Tiingo: ${t.note ?? "för få ljus"}`].join("; "), igLive: live };
    // Priskontroll mot IG: Tiingo måste ligga nära IG-livepriset, annars är det fel par/kontrakt eller gammal data
    let deviationPct: number | null = null;
    if (live) {
      deviationPct = +(((k[k.length - 1]!.close / live.price) - 1) * 100).toFixed(2);
      if (Math.abs(deviationPct) > TIINGO_MAX_DEVIATION_PCT) {
        return { klines: [], source: "ingen", sourceKey: "none", deviationPct, igLive: live,
          note: [...notes, `Tiingo avviker ${deviationPct} % från IG-livepriset (gräns ±${TIINGO_MAX_DEVIATION_PCT} %), används inte`].join("; ") };
      }
    } else notes.push("IG-livepris saknas, Tiingo kunde inte jämföras med IG");
    if (t.stale) notes.push(`Tiingo cachad (${Math.round((now() - t.at) / 60_000)} min gammal)`);
    return { klines: k, source: SOURCE_TIINGO, sourceKey: "tiingo", note: notes.join("; "), igLive: live, deviationPct, cached: !!t.cached };
  }

  /** Pris för agenterna: IG-strömmen (≤60 s) → IG REST med förtur → äldre IG-pris → Tiingo (märkt). */
  async function ticker(env: IgEnvironment, epic: string, rest: (() => Promise<Ticker>) | null): Promise<AgentTicker> {
    const fresh = igLive(env, epic, IG_QUOTE_FRESH_MS);
    if (fresh) return { symbol: epic, price: fresh.price, bid: fresh.bid, offer: fresh.offer, changePct24h: fresh.changePct ?? 0, volume24h: 0, source: `${fresh.source} (IG-pris)`, ageSec: fresh.ageSec, note: null };
    const notes: string[] = [];
    if (rest) {
      try {
        const t = await withIgPriority(rest);
        return { ...t, source: "IG REST (IG-pris)", ageSec: 0, note: null };
      } catch (e) { notes.push(`IG REST: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`); }
    }
    const old = igLive(env, epic);
    if (old) return { symbol: epic, price: old.price, bid: old.bid, offer: old.offer, changePct24h: old.changePct ?? 0, volume24h: 0, source: `${old.source} (IG-pris, cachad)`, ageSec: old.ageSec, note: notes.join("; ") || null };
    if (tiingo) {
      try {
        const t = await tiingo.bars(epic, nameOf(env, epic), "1min");
        const last = t.bars[t.bars.length - 1];
        if (last) return { symbol: epic, price: last.close, changePct24h: 0, volume24h: 0, source: `${SOURCE_TIINGO}, senaste stängda minutljus`, ageSec: Math.round((now() - last.closeTime) / 1000), note: [...notes, "IG-livepris saknas; ordrar prissätts ändå av IG"].join("; ") };
        notes.push(`Tiingo: ${t.note ?? "inget pris"}`);
      } catch { notes.push("Tiingo-reserven misslyckades"); }
    }
    throw new Error(`Inget pris för ${epic}: ${notes.join("; ") || "ingen källa"}`);
  }

  /** Saldo: mäklarens (cachade) läsning → IG-strömmens ACCOUNT-fält. Kastar aldrig för en läsgräns. */
  async function account(env: IgEnvironment, read: () => Promise<Account>): Promise<{ account: Account | null; source: string }> {
    // Analysen läser med förtur (orderreserven), en läsning per 30 s tack vare mäklarens cache
    try { return { account: await withIgPriority(read), source: "IG (konto)" }; }
    catch (e) {
      const a = streamAccount(env);
      if (a && (a.balance !== null || a.available !== null)) {
        return {
          account: { balances: [{ asset: "?", free: a.available ?? 0, locked: 0 }], totalValueUsdt: a.balance ?? 0, updatedAt: a.at, balance: a.balance, available: a.available, profitLoss: a.profitLoss },
          source: `IG-strömmen (cachad, ${Math.round((now() - a.at) / 1000)} s gammal)`,
        };
      }
      return { account: null, source: `saknas: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
    }
  }

  /** Positioner: färsk/cachad läsning → senast kända (märkt cachad). Kastar aldrig för en läsgräns. */
  async function positions(read: () => Promise<Position[]>, lastKnown: (() => { at: number; positions: Position[] } | null) | null): Promise<{ positions: Position[] | null; source: string }> {
    // Med förtur: mäklarens cache är singleflight och 30 s, så det blir högst ungefär en läsning per tur.
    // Utan förtur gav en fullt upptagen bakgrundsbudget fel varje gång, och den senast kända listan
    // nollställs när IG-sessionen förnyas (varje timme), så cachen räcker inte ensam.
    try { return { positions: await withIgPriority(read), source: "IG (positioner)" }; }
    catch (e) {
      const c = lastKnown?.();
      if (c) return { positions: c.positions, source: `IG (cachad, ${Math.round((now() - c.at) / 1000)} s gammal)` };
      return { positions: null, source: `saknas: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
    }
  }

  /** Kommande instrument (t.ex. agentsessionens nästa omgångar) får följa med i nästa samlade Tiingo-anrop. */
  function hint(env: IgEnvironment, epics: string[]): void {
    try { tiingo?.hint(epics.map((e) => ({ epic: e, name: nameOf(env, e) }))); } catch { /* bara en optimering */ }
  }
  return { klines, ticker, account, positions, igLive, hint, fromMemory };
}

// Gemensam instans (Demo och Live). let + useIgAgentData så att testerna kan byta till mockade källor.
export let igAgentData = createIgAgentData();
/** Endast tester: byt instans (t.ex. med falsk Tiingo-fetch och falsk läsbudget). */
export function useIgAgentData(x: ReturnType<typeof createIgAgentData>): void { igAgentData = x; }
export { TIINGO_AGENT_LABEL };

/** Är mäklaren en IG-mäklare (har env)? Andra mäklare går oförändrat direkt mot sina egna metoder. */
export function igEnvOf(broker: { name: string }): IgEnvironment | null {
  return broker.name === "ig" ? "live" : broker.name === "ig-demo" ? "demo" : null;
}
