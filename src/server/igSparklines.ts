import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../dataDir.js";
import { getIgReadBudget, IG_HISTORY_RATE_ERROR, IG_HISTORY_BLOCK_MS, type IgEnvironment } from "../integrations/igConnection.js";
import { getIgCandles } from "../integrations/igMarkets.js";
import { igMarketData } from "./igMarketData.js";
import { tiingoIntraday, TIINGO_SPARK_LABEL, type TiingoSeries } from "./tiingoIntraday.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Minidiagram för korten på Alla par — skonsamt mot IG:s historikkvot.
//
//  IG:s historiska priser har en begränsad veckokvot (datapunkter). Hela katalogen
//  (Forex + Krypto) får därför ALDRIG hämtas vid varje sidladdning. Ordning:
//   1. Serverns minne: stängda ljus som redan finns (5m, annars 1m-signalserien). Ingen IG-läsning.
//   2. Cache (minne + fil) per miljö/EPIC, TTL ≥ 30 min. Ingen IG-läsning.
//   3. Först därefter EN IG-hämtning (5m × 72 = 6 timmar), och bara om:
//      - bakgrundsutrymme finns i läsbudgeten,
//      - serverns egen minutgräns för minidiagram inte är nådd (gäller alla flikar),
//      - senast kända återstående historikkvot ligger över reserven OCH över halva veckokvoten (huvuddiagram och signaler går först),
//      - miljön inte är spärrad efter att IG sagt att kvoten är slut (spärren gäller alla EPICs).
//  Fel cachas också (negativ cache), så samma EPIC inte provas om och om igen.
//  Detta modul anropar aldrig ensureSeries/touchSeries: inget börjar följas i bakgrunden.
// ═══════════════════════════════════════════════════════════════════════════

export const SPARK_TTL_MS = 45 * 60_000;          // lyckad hämtning återanvänds i 45 min
export const SPARK_FAIL_TTL_MS = 30 * 60_000;     // kvotfel: samma EPIC provas inte om på 30 min (miljön spärras dessutom)
export const SPARK_RETRY_MS = 5 * 60_000;         // andra fel (t.ex. IG ej anslutet): nytt försök tidigast om 5 min
export const SPARK_MAX_PER_MIN = 6;               // högst 6 IG-hämtningar per minut och miljö, oavsett antal flikar
export const SPARK_ALLOWANCE_RESERVE = 3000;      // lämna minst så många historikpunkter åt huvuddiagram/signaler
export const SPARK_ALLOWANCE_SHARE = 0.5;         // och minst halva veckokvoten när IG anger totalen
export const SPARK_INTERVAL = "5m";
export const SPARK_POINTS = 72;                   // 72 × 5 min = 6 timmar
export const SPARK_QUOTA_TEXT = "diagram ej hämtat (IG:s historikkvot)";

export interface Sparkline {
  epic: string; env: IgEnvironment; closes: number[]; interval: string; at: number;
  source: "minne" | "cache" | "ig" | "ingen" | "tiingo"; error: string | null; note?: string; retryAt?: number;
  /** Etikett under diagrammet när källan inte är IG (t.ex. "Tiingo-diagram (ej IG-pris)") */
  sourceLabel?: string; tiingoTicker?: string;
  /** Första och sista ljusets öppningstid (ms), så att etiketten visar verklig period (t.ex. helg = fredagens ljus) */
  from?: number | null; to?: number | null;
}

type CandlesFn = (env: IgEnvironment, epic: string, tf: any, limit: number) => Promise<{ candles: Array<{ close: number; openTime?: number }>; allowance?: any; error?: string | null; status?: string }>;

export function createIgSparklines(deps: {
  candles?: CandlesFn;
  budget?: (env: IgEnvironment) => { backgroundRemaining?: number; remaining?: number };
  memory?: (epic: string, iv: string, env: IgEnvironment) => Array<{ close: number; openTime?: number }>;
  signalInterval?: () => string;
  now?: () => number;
  file?: (env: IgEnvironment) => string;
  persist?: boolean;
  /** Tiingo-reserv när IG:s historikkvot är slut (endast visning). null = avstängd. */
  tiingo?: { get: (epic: string, name: string | null | undefined, opts?: { cacheOnly?: boolean }) => Promise<TiingoSeries> } | null;
  /** Instrumentnamn (för att mappa EPIC → Tiingo-ticker) */
  name?: (env: IgEnvironment, epic: string) => string | null;
} = {}) {
  const candles = deps.candles ?? (getIgCandles as unknown as CandlesFn);
  const budget = deps.budget ?? getIgReadBudget;
  const memory = deps.memory ?? ((epic, iv, env) => igMarketData.closed(epic, iv, env));
  const signalInterval = deps.signalInterval ?? (() => igMarketData.getSignalInterval());
  const now = deps.now ?? Date.now;
  const file = deps.file ?? ((env: IgEnvironment) => dataPath(`ig-sparklines-${env}.json`));
  const persist = deps.persist !== false;
  const tiingo = deps.tiingo === undefined ? tiingoIntraday : deps.tiingo;
  const nameOf = deps.name ?? ((env: IgEnvironment, epic: string) => igMarketData.nameOf(epic, env));
  const cache = new Map<IgEnvironment, Map<string, Sparkline>>();
  const pending = new Map<string, Promise<Sparkline>>();
  const fetches = new Map<IgEnvironment, number[]>();
  const blockedUntil = new Map<IgEnvironment, number>();
  const allowance = new Map<IgEnvironment, { left: number; total: number | null }>(); // senast kända historikkvot
  let stats = { igFetches: 0 };

  function store(env: IgEnvironment): Map<string, Sparkline> {
    let m = cache.get(env);
    if (m) return m;
    m = new Map();
    if (persist) {
      try {
        const d = JSON.parse(fs.readFileSync(file(env), "utf8"));
        for (const s of Array.isArray(d?.items) ? d.items : []) if (s && typeof s.epic === "string" && s.env === env && Array.isArray(s.closes)) m.set(s.epic, s);
      } catch { /* ingen cache än */ }
    }
    cache.set(env, m);
    return m;
  }
  function save(env: IgEnvironment): void {
    if (!persist) return;
    try {
      fs.mkdirSync(path.dirname(file(env)), { recursive: true });
      // Bara färska poster sparas, så filen växer inte
      const items = [...store(env).values()].filter((s) => now() - s.at < Math.max(SPARK_TTL_MS, SPARK_FAIL_TTL_MS));
      fs.writeFileSync(file(env), JSON.stringify({ savedAt: new Date(now()).toISOString(), items }));
    } catch { /* bara en cache */ }
  }
  function fromMemory(env: IgEnvironment, epic: string): Sparkline | null {
    for (const iv of [SPARK_INTERVAL, signalInterval()]) {
      const bars = memory(epic, iv, env) ?? [];
      if (bars.length >= 12) {
        const per = iv === "1m" ? 360 : SPARK_POINTS, use = bars.slice(-per);
        return { epic, env, closes: use.map((b) => b.close), interval: iv, at: now(), source: "minne", error: null, from: use[0]?.openTime ?? null, to: use[use.length - 1]?.openTime ?? null };
      }
    }
    return null;
  }
  /** Varför en IG-hämtning inte får göras just nu (null = får hämta). */
  function blockReason(env: IgEnvironment): string | null {
    if (now() < (blockedUntil.get(env) ?? 0)) return SPARK_QUOTA_TEXT;
    const a = allowance.get(env);
    if (a !== undefined && (a.left < SPARK_ALLOWANCE_RESERVE || (a.total !== null && a.left < a.total * SPARK_ALLOWANCE_SHARE))) return SPARK_QUOTA_TEXT;
    const b = budget(env);
    if ((b.backgroundRemaining ?? b.remaining ?? 0) <= 0) return "diagram väntar (IG:s läsgräns denna minut)";
    const list = (fetches.get(env) ?? []).filter((t) => now() - t < 60_000);
    fetches.set(env, list);
    if (list.length >= SPARK_MAX_PER_MIN) return "diagram väntar (högst " + SPARK_MAX_PER_MIN + " per minut)";
    return null;
  }

  async function getIg(env: IgEnvironment, epic: string, opts: { cacheOnly?: boolean } = {}): Promise<Sparkline> {
    const mem = fromMemory(env, epic);
    if (mem) return mem;
    const hit = store(env).get(epic);
    if (hit && (hit.error ? now() < (hit.retryAt ?? hit.at + SPARK_FAIL_TTL_MS) : now() - hit.at < SPARK_TTL_MS)) return { ...hit, source: hit.error ? hit.source : "cache" };
    if (opts.cacheOnly) return { epic, env, closes: hit?.closes ?? [], interval: SPARK_INTERVAL, at: hit?.at ?? 0, source: hit ? "cache" : "ingen", error: hit ? null : "diagram ej hämtat" };
    const why = blockReason(env);
    // Spärrad: visa äldre cache om den finns, annars förklaringen. Ingen IG-läsning.
    if (why) return hit && hit.closes.length ? { ...hit, source: "cache", note: why } : { epic, env, closes: [], interval: SPARK_INTERVAL, at: now(), source: "ingen", error: why };
    const key = `${env}|${epic}`;
    const running = pending.get(key);
    if (running) return running;
    const job = (async (): Promise<Sparkline> => {
      fetches.get(env)!.push(now());
      stats.igFetches++;
      let out: Sparkline;
      try {
        const r = await candles(env, epic, SPARK_INTERVAL, SPARK_POINTS);
        const left = Number(r.allowance?.remainingAllowance), total = Number(r.allowance?.totalAllowance);
        if (Number.isFinite(left)) allowance.set(env, { left, total: Number.isFinite(total) && total > 0 ? total : null });
        const bars = (r.candles ?? []).filter((c) => Number.isFinite(c.close));
        const closes = bars.map((c) => c.close);
        out = { epic, env, closes, interval: SPARK_INTERVAL, at: now(), source: "ig", error: closes.length ? null : (r.error ?? "historik saknas"), from: bars[0]?.openTime ?? null, to: bars[bars.length - 1]?.openTime ?? null, ...(closes.length ? {} : { retryAt: now() + SPARK_RETRY_MS }) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const quota = msg === IG_HISTORY_RATE_ERROR || /historikkvot/i.test(msg);
        // Kvoten slut: spärra HELA miljön (alla EPICs) i minst en timme
        if (quota) blockedUntil.set(env, now() + IG_HISTORY_BLOCK_MS);
        out = { epic, env, closes: [], interval: SPARK_INTERVAL, at: now(), source: "ig", error: quota ? SPARK_QUOTA_TEXT : `diagram ej hämtat: ${msg.slice(0, 120)}`, retryAt: now() + (quota ? SPARK_FAIL_TTL_MS : SPARK_RETRY_MS) };
      }
      store(env).set(epic, out);
      save(env);
      return out;
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  }
  /**
   * IG först (oförändrat). Bara när IG:s historikkvot är slut eller IG saknar ljus provas Tiingo,
   * tydligt märkt "ej IG-pris". Tiingo-svaren lagras i Tiingo-modulens egen cache, aldrig i IG-cachen
   * eller igMarketData, så de når aldrig signaler, strategier eller ordrar.
   */
  async function get(env: IgEnvironment, epic: string, opts: { cacheOnly?: boolean } = {}): Promise<Sparkline> {
    const s = await getIg(env, epic, opts);
    if (s.closes.length || !tiingo) return s;
    const quota = s.error === SPARK_QUOTA_TEXT || /historik saknas/i.test(s.error ?? "");
    if (!quota && !opts.cacheOnly) return s; // tillfälliga väntelägen (läsgräns, minuttak) och andra fel: ingen reserv
    let t: TiingoSeries;
    try { t = await tiingo.get(epic, nameOf(env, epic), { cacheOnly: !!opts.cacheOnly || !quota }); }
    catch { return quota ? { ...s, note: "Tiingo-reserven misslyckades" } : s; }
    if (t.closes.length) {
      return { epic, env, closes: t.closes, interval: SPARK_INTERVAL, at: t.at, source: "tiingo", error: null,
        note: quota ? "IG:s historikkvot slut" : undefined, sourceLabel: TIINGO_SPARK_LABEL, tiingoTicker: t.ticker ?? undefined, from: t.from, to: t.to };
    }
    // Ingen reserv: IG:s felmeddelande står kvar oförändrat, Tiingos skäl läggs i note
    return quota && t.note ? { ...s, note: t.note } : s;
  }
  return { get, stats: () => ({ ...stats }), blockedUntil: (env: IgEnvironment) => blockedUntil.get(env) ?? 0 };
}

export const igSparklines = createIgSparklines();
