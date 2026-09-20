import type { BrokerAdapter } from "../brokers/adapter.js";
import type { Kline } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════════
//  CANDLE-HÄMTNING för avgörningsjobbet.
//
//  Enda stället som vet hur en signals horisont översätts till ett
//  tidsintervall. Läser bara marknadsdata — inga konton, inga nycklar.
// ═══════════════════════════════════════════════════════════════════════════

/** Brokern saknar stöd för intervallhämtning — signalen ska förbli öppen. */
export class CandleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandleUnavailableError";
  }
}

/** Symbolen finns inte hos börsen (avlistad eller felstavad) — ge upp direkt. */
export class InvalidSymbolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSymbolError";
  }
}

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

export function intervalToMs(interval: string): number {
  const ms = INTERVAL_MS[interval];
  if (!ms) throw new Error(`Okänt intervall: ${interval}`);
  return ms;
}

/** Känner igen Binances svar på en avlistad eller okänd symbol. */
export function isInvalidSymbolError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b400\b/.test(msg) && /invalid symbol/i.test(msg);
}

export interface SignalWindow {
  symbol: string;
  timeframe: string;
  ts: number;
  horizonBars: number;
}

/**
 * Hämtar candles som täcker signalens horisont.
 *
 * Fönstret startar en bar FÖRE signalen (så filtret i resolveSignal har något
 * att kasta bort och lookahead-skyddet bevisligen träder in) och sträcker sig
 * en bar EFTER horisonten (marginal för börsens bar-gränser).
 */
export async function fetchCandlesForSignal(
  broker: BrokerAdapter,
  signal: SignalWindow,
): Promise<Kline[]> {
  const barMs = intervalToMs(signal.timeframe);
  const start = signal.ts - barMs;
  const end = signal.ts + (signal.horizonBars + 1) * barMs;

  if (!broker.getKlinesRange) {
    throw new CandleUnavailableError(
      `Brokern ${broker.name} stödjer inte getKlinesRange — signalen lämnas öppen ` +
      `tills stöd finns (forex/aktier implementeras i en senare fas).`,
    );
  }

  try {
    return await broker.getKlinesRange(signal.symbol, signal.timeframe, start, end);
  } catch (err) {
    if (isInvalidSymbolError(err)) {
      throw new InvalidSymbolError(
        `Börsen känner inte igen ${signal.symbol} (avlistad eller felstavad).`,
      );
    }
    throw err;
  }
}
