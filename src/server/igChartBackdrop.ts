// ═══════════════════════════════════════════════════════════════════════════
//  Huvuddiagrammets Tiingo-bakgrund — ENDAST VISNING.
//
//  När IG inte kan lämna historik (veckokvoten för historiska priser slut, eller för få ljus)
//  blir huvuddiagrammet nästan tomt: ljusen byggs bara från livepriserna. Då hämtas Tiingo-ljus
//  för samma par, slås ihop till diagrammets intervall (1m/5m/15m/30m/1h/4h/1d) och skickas
//  SEPARAT i /api/market/klines som "backdrop", märkt "Tiingo-historik (ej IG-pris) + IG-live".
//  IG:s egna ljus ritas ovanpå/efter. Tiingo-ljusen:
//   - skrivs aldrig in i igMarketData (signaler, strategier, indikatorer för order läser bara därifrån),
//   - används aldrig för orderpriser, TP/SL eller insatser,
//   - visas bara om senaste Tiingo-stängningen ligger inom ±3 % av IG-livepriset (annars fel par/kontrakt).
//  Importeras bara av igRoutes.ts (klines-svaret). Kontrolleras i testerna.
//  Delar Tiingo-instans och anropstak med agenternas analys (tiingoBarsShared).
// ═══════════════════════════════════════════════════════════════════════════
import type { IgEnvironment } from "../integrations/igConnection.js";
import { tiingoBarsShared, type TiingoFreq, type TiingoBarsResult } from "./tiingoIntraday.js";
import { aggregateBars, IV_MS, TIINGO_MAX_DEVIATION_PCT } from "./igAgentData.js";

export const CHART_BACKDROP_LABEL = "Tiingo-historik (ej IG-pris) + IG-live";
/** Så här få stängda IG-ljus räknas som "nästan tomt diagram" (då visas bakgrunden även utan historikfel) */
export const CHART_BACKDROP_MIN_IG_BARS = 30;
const FREQ: Record<string, TiingoFreq> = { "1m": "1min", "5m": "1min", "15m": "1min", "30m": "1min", "1h": "1hour", "4h": "1hour", "1d": "1day" };
const FREQ_MS: Record<TiingoFreq, number> = { "1min": 60e3, "1hour": 3600e3, "1day": 86400e3 };
/** Klines-svaret väntar högst så här länge på Tiingo; annars skickas diagrammet utan bakgrund (den kommer vid nästa laddning) */
export const CHART_BACKDROP_WAIT_MS = 1200;
const PENDING = Symbol("Tiingo-hämtning pågår");
/** Bakgrunden är bara historik bakom IG-ljusen: samma Tiingo-svar återanvänds 15 min per ticker/upplösning.
 *  Diagrammet laddas om var 30:e s när strömmen saknas; utan denna cache skulle det äta agenternas Tiingo-tak (20/h). */
export const CHART_BACKDROP_TTL_MS = 15 * 60_000;

export interface ChartBackdrop {
  source: "tiingo"; label: string; ticker: string | null;
  /** Diagramljus (tid i sekunder, som /api/market/klines). Bara ljus FÖRE första IG-ljuset. */
  bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
  note: string | null; deviationPct: number | null; cached: boolean;
  /** Hämtningen fortsätter i bakgrunden; klienten får försöka igen en gång. */
  pending?: boolean;
}

export function createIgChartBackdrop(deps: {
  tiingo?: { bars: (epic: string, name: string | null | undefined, f: TiingoFreq) => Promise<TiingoBarsResult> } | null;
  now?: () => number;
  /** Tester: väntetid på Tiingo (standard CHART_BACKDROP_WAIT_MS) */
  waitMs?: number;
} = {}) {
  const tiingo = deps.tiingo === undefined ? tiingoBarsShared : deps.tiingo;
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? CHART_BACKDROP_WAIT_MS;
  const cache = new Map<string, { at: number; t: TiingoBarsResult }>();   // "epic|freq"
  const inflight = new Map<string, Promise<TiingoBarsResult | null>>();
  /** Tiingo-ljus för EPIC/upplösning: cache (15 min) → pågående hämtning → ny hämtning. Väntar högst waitMs. */
  async function source(epic: string, name: string | null, f: TiingoFreq): Promise<TiingoBarsResult | null | typeof PENDING> {
    const k = `${epic}|${f}`, hit = cache.get(k);
    if (hit && now() - hit.at < CHART_BACKDROP_TTL_MS) return hit.t;
    let job = inflight.get(k);
    if (!job) {
      job = tiingo!.bars(epic, name, f).then((t) => { if (t.bars.length) cache.set(k, { at: now(), t }); return t; }, () => null)
        .finally(() => inflight.delete(k));
      inflight.set(k, job);
    }
    // Hinner Tiingo inte svara: inget väntande diagram; svaret hamnar i cachen och visas vid nästa laddning
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<typeof PENDING>((res) => { timer = setTimeout(() => res(PENDING), waitMs); });
    try { return await Promise.race([job, late]); } finally { clearTimeout(timer); }
  }
  /**
   * Bakgrund för huvuddiagrammet, eller null när den inte behövs/inte kan visas.
   * igFirstOpenMs = första IG-ljusets öppningstid (ms) eller null; livePrice = IG:s mittkurs (för rimlighetskontroll).
   */
  async function get(args: { env: IgEnvironment; epic: string; name: string | null; interval: string; limit: number;
    igBars: number; historyError: string | null; igFirstOpenMs: number | null; livePrice: number | null;
    /** Endast visning: om IG anger forexkvoten i punkter skalas Tiingo till samma enhet. */
    scale?: number }): Promise<ChartBackdrop | null> {
    if (!tiingo) return null;
    // Bara när IG inte kan fylla diagrammet: historikfel eller för få stängda IG-ljus
    if (!args.historyError && args.igBars >= CHART_BACKDROP_MIN_IG_BARS) return null;
    const f = FREQ[args.interval], dst = IV_MS[args.interval];
    if (!f || !dst) return null;
    const t = await source(args.epic, args.name, f);
    if (t === PENDING) return { source: "tiingo", label: CHART_BACKDROP_LABEL, ticker: null, bars: [], note: "Tiingo-historik hämtas", deviationPct: null, cached: false, pending: true };
    if (!t) return null;
    if (!t.bars.length) return { source: "tiingo", label: CHART_BACKDROP_LABEL, ticker: t.ticker, bars: [], note: t.note ?? "Tiingo saknar ljus", deviationPct: null, cached: !!t.cached };
    let k = aggregateBars(t.bars, FREQ_MS[f], dst, now());
    // Råcachen hålls orörd: Demo och Live kan ha olika prisenhet för samma EPIC.
    const scale = typeof args.scale === "number" && Number.isFinite(args.scale) && args.scale > 0 ? args.scale : 1;
    if (scale !== 1) k = k.map((b) => ({ ...b, open: b.open * scale, high: b.high * scale, low: b.low * scale, close: b.close * scale }));
    if (args.igFirstOpenMs !== null) k = k.filter((b) => b.openTime < args.igFirstOpenMs!); // IG-ljusen vinner där de finns
    k = k.slice(-args.limit);
    let deviationPct: number | null = null;
    if (k.length && args.livePrice !== null && args.livePrice > 0) {
      deviationPct = +(((k[k.length - 1]!.close / args.livePrice) - 1) * 100).toFixed(2);
      if (Math.abs(deviationPct) > TIINGO_MAX_DEVIATION_PCT) {
        return { source: "tiingo", label: CHART_BACKDROP_LABEL, ticker: t.ticker, bars: [], deviationPct, cached: !!t.cached,
          note: `Tiingo avviker ${deviationPct} % från IG-livepriset (gräns ±${TIINGO_MAX_DEVIATION_PCT} %), visas inte` };
      }
    }
    return {
      source: "tiingo", label: CHART_BACKDROP_LABEL, ticker: t.ticker, deviationPct, cached: !!t.cached,
      note: args.livePrice === null ? "IG-livepris saknas, Tiingo kunde inte jämföras med IG" : (t.stale ? "Tiingo cachad" : null),
      bars: k.map((b) => ({ time: Math.floor(b.openTime / 1000), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 })),
    };
  }
  return { get };
}

export const igChartBackdrop = createIgChartBackdrop();
