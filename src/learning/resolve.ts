import type { Kline } from "../types.js";
import type { AssetClass, Direction, Outcome } from "./schema.js";

// ═══════════════════════════════════════════════════════════════════════════
//  AVGÖRNING — ren logik. Inga imports av node:fs, node:sqlite, brokers
//  eller config. Candles och kostnadsmodell kommer in som argument, utfallet
//  kommer ut. Det är förutsättningen för att kunna bevisa beteendet med
//  syntetiska candles, utan nätverk (och Binance är dessutom blockerat i
//  utvecklingsmiljön).
//
//  Genomgående princip: vi har OHLC, inte tick-ordning. Där ordningen inom en
//  bar är okänd antas ALLTID det värsta rimliga utfallet. Hellre en för
//  pessimistisk statistik än en som lurar oss att systemet är bättre än det är.
// ═══════════════════════════════════════════════════════════════════════════

export const RESOLVER_VERSION = "resolve-v1";

export const MS_PER_FUNDING_PERIOD = 8 * 60 * 60 * 1000;

export interface CostModel {
  /** Taker-avgift per sida, baspunkter. */
  feeBps: number;
  /** Antagen slippage per sida, baspunkter. */
  slippageBps: number;
  /** Funding per 8h för perps, baspunkter. Konservativt antas alltid betald. */
  fundingBpsPer8h: number;
  /** Underhållsmarginalgrad, andel (0.005 = 0,5 %). */
  mmr: number;
  /** Krymper likvidationsavståndet konservativt (0.002 = 0,2 %). */
  liqBufferPct: number;
}

export interface ResolveSignalInput {
  ts: number;
  direction: Direction;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  horizonBars: number;
  leverage: number;
  assetClass: AssetClass;
  isPerp: boolean;
  intervalMs: number;
}

export interface ResolveInput {
  signal: ResolveSignalInput;
  /** Får innehålla barer före signalens ts — de filtreras bort internt. */
  candles: Kline[];
  costs: CostModel;
}

export interface ResolveOutput {
  outcome: Outcome;
  exitPrice: number;
  tsResolved: number;
  barsToResolution: number;
  rMultipleGross: number;
  rMultiple: number;
  returnOnMarginPct: number;
  mfe: number;
  mae: number;
  liquidationPrice: number | null;
  feesUsd: number;
  slippageUsd: number;
  fundingUsd: number;
  ambiguousBar: boolean;
  gapFilled: boolean;
  notes: string[];
  resolverVersion: string;
}

/**
 * Likvidationsnivå vid isolerad marginal.
 *
 *   liq_long  = entry × (1 − 1/L + mmr)
 *   liq_short = entry × (1 + 1/L − mmr)
 *
 * Bufferten krymper avståndet till entry, eftersom formeln ignorerar upplupen
 * funding och avgifter i marginalbasen — verkligheten likviderar alltså något
 * tidigare än formeln säger.
 *
 * OBS: detta är en APPROXIMATION och är börsspecifik (Blofin ≠ Binance
 * Futures). Den får styra statistik, ingenting annat.
 */
export function liquidationPrice(
  entry: number,
  direction: Direction,
  leverage: number,
  mmr: number,
  liqBufferPct = 0,
): number | null {
  if (!(leverage > 1)) return null; // utan hävstång finns ingen likvidation
  const distance = 1 / leverage - mmr;
  const buffered = distance * (1 - liqBufferPct);
  return direction === "long" ? entry * (1 - buffered) : entry * (1 + buffered);
}

/** Validerar att nivåerna ligger på rätt sida om entry. */
export function isGeometryValid(
  direction: Direction,
  entry: number,
  stopLoss: number,
  takeProfit: number,
): boolean {
  if (![entry, stopLoss, takeProfit].every((v) => Number.isFinite(v) && v > 0)) return false;
  return direction === "long"
    ? stopLoss < entry && entry < takeProfit
    : takeProfit < entry && entry < stopLoss;
}

/**
 * Avgör en signal mot candles.
 *
 * @returns utfallet, eller null när horisonten ännu inte är slut (raden ska
 *          då förbli 'open' och prövas igen senare).
 */
export function resolveSignal(input: ResolveInput): ResolveOutput | null {
  const { signal, costs } = input;
  const { direction, entry, stopLoss, takeProfit, horizonBars, leverage } = signal;
  const isLong = direction === "long";

  // ── LOOKAHEAD-SKYDDET ──
  // Strikt >, på openTime. En candle vars openTime === signal.ts var redan
  // påbörjad när signalen föddes, så dess high/low innehåller prisrörelse
  // FÖRE signalen. Att släppa in den vore en tyst framåtblickande läcka.
  const bars = input.candles
    .filter((k) => k.openTime > signal.ts)
    .sort((a, b) => a.openTime - b.openTime);

  const R = Math.abs(entry - stopLoss);
  if (!(R > 0)) return null; // utan risk går ingen R-multipel att beräkna

  const liq = liquidationPrice(entry, direction, leverage, costs.mmr, costs.liqBufferPct);
  const notes: string[] = [];

  let mfe = 0; // största orealiserade vinst i pris
  let mae = 0; // största orealiserade förlust i pris

  const finish = (
    outcome: Outcome,
    exitPrice: number,
    bar: Kline,
    barsToResolution: number,
    flags: { ambiguousBar?: boolean; gapFilled?: boolean } = {},
  ): ResolveOutput => {
    const sign = isLong ? 1 : -1;
    const grossPnl = sign * (exitPrice - entry);

    const slippageUsd = ((entry + exitPrice) * costs.slippageBps) / 10_000;
    const feesUsd = ((entry + exitPrice) * costs.feeBps) / 10_000;
    const holdMs = Math.max(0, bar.closeTime - signal.ts);
    const fundingPeriods = signal.isPerp ? Math.ceil(holdMs / MS_PER_FUNDING_PERIOD) : 0;
    const fundingUsd = signal.isPerp
      ? (entry * costs.fundingBpsPer8h * fundingPeriods) / 10_000
      : 0;

    const netPnl = grossPnl - slippageUsd - feesUsd - fundingUsd;

    // Hävstång påverkar INTE R — R är riskbaserad och därmed
    // hävstångsneutral, vilket är precis det som gör den jämförbar mellan
    // tillgångsklasser. Hävstångseffekten fångas i return_on_margin_pct.
    const margin = leverage > 0 ? entry / leverage : entry;
    const returnOnMarginPct =
      outcome === "likviderad" ? -100 : (netPnl / margin) * 100;

    return {
      outcome,
      exitPrice,
      tsResolved: bar.closeTime,
      barsToResolution,
      rMultipleGross: grossPnl / R,
      rMultiple: netPnl / R,
      returnOnMarginPct,
      mfe,
      mae,
      liquidationPrice: liq,
      feesUsd,
      slippageUsd,
      fundingUsd,
      ambiguousBar: flags.ambiguousBar ?? false,
      gapFilled: flags.gapFilled ?? false,
      notes,
      resolverVersion: RESOLVER_VERSION,
    };
  };

  const limit = Math.min(bars.length, horizonBars);
  for (let i = 0; i < limit; i++) {
    const bar = bars[i]!;
    const barNr = i + 1;

    // ── 1. Gap på open ──
    // Hanterar aktie-/forexgap över natt och helg utan börskalender: utebliven
    // handel syns som ett hål i barserien, och gapet syns i nästa open.
    if (liq !== null && (isLong ? bar.open <= liq : bar.open >= liq)) {
      notes.push("Öppningskursen gapade förbi likvidationsnivån.");
      return finish("likviderad", liq, bar, barNr, { gapFilled: true });
    }
    if (isLong ? bar.open <= stopLoss : bar.open >= stopLoss) {
      notes.push("Öppningskursen gapade förbi stop loss; fyllt på open, inte på SL-nivån.");
      return finish("SL", bar.open, bar, barNr, { gapFilled: true });
    }

    // MFE/MAE uppdateras innan utgång, på den bar som avgör.
    mfe = Math.max(mfe, isLong ? bar.high - entry : entry - bar.low);
    mae = Math.max(mae, isLong ? entry - bar.low : bar.high - entry);

    // ── 2. Likvidation prövas FÖRE stop loss ──
    // Om SL av misstag ligger bortom likvidationsnivån är det likvidationen
    // som gäller i verkligheten — hela insatsen är borta oavsett var SL låg.
    if (liq !== null && (isLong ? bar.low <= liq : bar.high >= liq)) {
      notes.push("Priset nådde likvidationsnivån — total förlust av insatsen.");
      return finish("likviderad", liq, bar, barNr);
    }

    const slHit = isLong ? bar.low <= stopLoss : bar.high >= stopLoss;
    const tpHit = isLong ? bar.high >= takeProfit : bar.low <= takeProfit;

    // ── 3. Tvetydig bar: både TP och SL inom samma candle ──
    if (slHit && tpHit) {
      notes.push("TP och SL i samma bar; antog SL först (konservativt).");
      return finish("SL", stopLoss, bar, barNr, { ambiguousBar: true });
    }
    if (slHit) return finish("SL", stopLoss, bar, barNr);
    if (tpHit) return finish("TP", takeProfit, bar, barNr);
  }

  // ── 4. Horisonten inte slut än → låt raden vara öppen ──
  if (bars.length < horizonBars) return null;

  // ── 5. Utgången: exit på sista barens close inom horisonten ──
  const last = bars[horizonBars - 1]!;
  notes.push(`Horisonten (${horizonBars} barer) passerad utan träff på TP eller SL.`);
  return finish("utgången", last.close, last, horizonBars);
}
