import type { BrokerAdapter } from "../brokers/adapter.js";
import type { Kline } from "../types.js";
import { subscribeClosedCandles, getClosedCandles, type Candle } from "./klineStream.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Candle-källa — samma ljus oavsett mäklare
//
// Signal-motorn bryr sig inte om var ljusen kommer ifrån, bara att de är
// stängda. Den här filen ger två vägar in, med identisk utdata:
//
//   WebSocket  (Binance)  — push, lägst latens. Används när den finns.
//   Polling    (alla)     — hämtar via BrokerAdapter.getKlines(). Fungerar
//                           mot Alpaca, och mot Binance REST som reserv.
//
// Varför två: Mike vet ännu inte vilken mäklare han får tillgång till först.
// Båda adaptrarna finns redan i src/brokers/ bakom samma gränssnitt, så
// valet blir en konfigurationsrad istället för en ombyggnad.
//
// Polling-vägen har samma hårda regel som WebSocket-vägen: det sist
// returnerade ljuset från ett REST-anrop är det som BYGGS just nu och räknas
// aldrig som stängt. Utan den regeln repaintar signalerna precis som om
// spärren aldrig funnits.
// ═══════════════════════════════════════════════════════════════════════════

export type CandleHandler = (symbol: string, interval: string, candle: Candle, history: Candle[]) => void;

/** Intervall i millisekunder — används för att veta när nästa ljus stängt. */
const INTERVAL_MS: Record<string, number> = {
  "1s": 1_000, "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
  "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
  "1d": 86_400_000,
};

function klineToCandle(k: Kline): Candle {
  return {
    openTime: k.openTime,
    closeTime: k.closeTime,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
    quoteVolume: 0, // finns inte i det gemensamma Kline-formatet
    trades: 0,
    closed: true,
  };
}

const pollBuffers = new Map<string, Candle[]>();
const pollTimers = new Map<string, NodeJS.Timeout>();

function key(symbol: string, interval: string): string {
  return `${symbol}:${interval}`;
}

/**
 * Pollar en mäklare efter nya stängda ljus.
 *
 * Pollintervallet sätts till en tredjedel av ljusintervallet så ett stängt
 * ljus upptäcks snabbt utan att API:et överbelastas. Bara ljus som är NYA
 * sedan förra hämtningen skickas vidare — annars skulle varje poll skicka om
 * samma ljus och signalen räknas om i onödan.
 */
function startPolling(
  broker: BrokerAdapter,
  symbol: string,
  interval: string,
  onClosed: CandleHandler,
): void {
  const k = key(symbol, interval);
  const intervalMs = INTERVAL_MS[interval] ?? 60_000;
  const pollMs = Math.max(2_000, Math.floor(intervalMs / 3));

  const tick = async (): Promise<void> => {
    try {
      const raw = await broker.getKlines(symbol, interval, 200);
      if (!raw.length) return;

      // Sista ljuset från REST är det som byggs just nu — aldrig stängt.
      const closed = raw.slice(0, -1).map(klineToCandle);
      if (!closed.length) return;

      const prev = pollBuffers.get(k) ?? [];
      const lastSeen = prev[prev.length - 1]?.openTime ?? 0;
      const fresh = closed.filter((c) => c.openTime > lastSeen);

      pollBuffers.set(k, closed);
      if (!prev.length) {
        log.info(`[candle-source] ${symbol} ${interval}: ${closed.length} ljus via polling`);
        return; // första hämtningen seedar bara, inga signaler på historik
      }

      for (const c of fresh) onClosed(symbol, interval, c, closed);
    } catch (err) {
      log.warn(`[candle-source] poll-fel ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  void tick();
  pollTimers.set(k, setInterval(() => void tick(), pollMs));
  log.info(`[candle-source] pollar ${symbol} ${interval} var ${pollMs / 1000}s`);
}

export interface CandleSourceOptions {
  /** "websocket" kräver Binance. "poll" fungerar mot alla adaptrar. */
  mode: "websocket" | "poll";
  symbols: string[];
  interval: string;
  /** Krävs för poll-läget. */
  broker?: BrokerAdapter;
}

/**
 * Kopplar en källa till en hanterare. Returnerar en avslutningsfunktion.
 *
 * WebSocket-läget förutsätter att startKlineStream() redan körts — den här
 * funktionen prenumererar bara på den.
 */
export function connectCandleSource(opts: CandleSourceOptions, onClosed: CandleHandler): () => void {
  if (opts.mode === "websocket") {
    log.info(`[candle-source] WebSocket-läge — ${opts.symbols.length} symboler`);
    return subscribeClosedCandles(onClosed);
  }

  if (!opts.broker) throw new Error("poll-läget kräver en broker");
  for (const s of opts.symbols) startPolling(opts.broker, s, opts.interval, onClosed);

  return () => {
    for (const s of opts.symbols) {
      const k = key(s, opts.interval);
      const t = pollTimers.get(k);
      if (t) { clearInterval(t); pollTimers.delete(k); }
    }
  };
}

/** Stängda ljus oavsett källa — signal-motorn läser härifrån. */
export function getCandles(symbol: string, interval: string): Candle[] {
  const ws = getClosedCandles(symbol, interval);
  if (ws.length) return ws;
  return pollBuffers.get(key(symbol, interval)) ?? [];
}
