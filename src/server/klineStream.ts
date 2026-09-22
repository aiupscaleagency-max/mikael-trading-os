import WebSocket from "ws";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Binance Kline Stream — ljus i realtid via WebSocket
//
// VARFÖR DEN HÄR FILEN FINNS:
// marketStream.ts ger tick-priser, men INGA ljus. Indikatorerna hämtade
// candles via REST-polling, vilket betyder att diagrammet och signalerna
// släpade efter priset.
//
// ── DEN VIKTIGA REGELN ───────────────────────────────────────────────────
// Binance skickar kline-uppdateringar KONTINUERLIGT medan ljuset byggs,
// flera gånger per sekund. Fältet `k.x` säger om ljuset är STÄNGT.
//
// Räknas RSI/MACD/EMA på ett ohalvfärdigt ljus ändras värdet hela tiden —
// en LONG-signal kan dyka upp och försvinna inom samma minut. Det kallas
// repainting och är den vanligaste orsaken till att en strategi ser bra ut
// i backtest men förlorar pengar live.
//
// Därför:
//   - subscribeClosedCandles()  → fyras BARA när k.x === true. Signaler här.
//   - getFormingCandle()        → ljuset som byggs just nu. ENDAST för
//                                 diagram. Aldrig för beslut.
//
// Datan är identisk med den Binance-plattformen visar — samma ström, samma
// ljus, samma stängningstider.
// ═══════════════════════════════════════════════════════════════════════════

const WS_COMBINED = "wss://stream.binance.com:9443/stream";
const REST_BASE = "https://api.binance.com";

/** Hur många historiska ljus som hämtas vid start (indikatorer behöver djup). */
const SEED_LIMIT = 500;
/** Tak för antal ljus i minnet per symbol. */
const MAX_BUFFER = 1000;

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  /** true = ljuset är slutgiltigt. Endast dessa får utlösa signaler. */
  closed: boolean;
}

type ClosedCandleHandler = (symbol: string, interval: string, candle: Candle, history: Candle[]) => void;

/** Nyckel: "BTCUSDT:1m" */
function key(symbol: string, interval: string): string {
  return `${symbol.toUpperCase()}:${interval}`;
}

const closedBuffers = new Map<string, Candle[]>();
const formingCandles = new Map<string, Candle>();
const subscribers = new Set<ClosedCandleHandler>();

let ws: WebSocket | null = null;
let watchedSymbols: string[] = [];
let watchedInterval = "1m";
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let watchdog: NodeJS.Timeout | null = null;
let lastMessageAt = 0;

function toCandle(k: Record<string, unknown>): Candle {
  return {
    openTime: Number(k.t),
    closeTime: Number(k.T),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    quoteVolume: Number(k.q),
    trades: Number(k.n),
    closed: k.x === true,
  };
}

/**
 * Hämtar historiska ljus via REST.
 *
 * Körs vid start OCH efter varje återanslutning. Utan omseedning saknas de
 * ljus som stängde medan anslutningen var nere, och indikatorerna räknar då
 * på en lucka utan att märka det.
 */
async function seedHistory(symbol: string, interval: string): Promise<void> {
  const url = `${REST_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${SEED_LIMIT}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      log.warn(`[kline-stream] seed misslyckades för ${symbol} ${interval}: HTTP ${res.status}`);
      return;
    }
    const rows = (await res.json()) as unknown[][];
    // Sista raden är det ljus som byggs just nu — det hör inte hemma bland
    // de stängda. REST returnerar det ändå, så det tas bort explicit.
    const closed = rows.slice(0, -1).map((r): Candle => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: Number(r[6]),
      quoteVolume: Number(r[7]),
      trades: Number(r[8]),
      closed: true,
    }));
    closedBuffers.set(key(symbol, interval), closed);
    log.info(`[kline-stream] ${symbol} ${interval}: ${closed.length} historiska ljus laddade`);
  } catch (err) {
    log.warn(`[kline-stream] seed-fel ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Lägger till ett stängt ljus. Dubbletter ignoreras — Binance kan skicka om. */
function appendClosed(k: string, candle: Candle): Candle[] {
  const buf = closedBuffers.get(k) ?? [];
  const last = buf[buf.length - 1];
  if (last && last.openTime === candle.openTime) {
    buf[buf.length - 1] = candle; // samma ljus, nyare data
  } else if (!last || candle.openTime > last.openTime) {
    buf.push(candle);
    if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
  }
  closedBuffers.set(k, buf);
  return buf;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delayMs = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempt));
  reconnectAttempt++;
  log.warn(`[kline-stream] återansluter om ${delayMs}ms (försök ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
}

function connect(): void {
  if (!watchedSymbols.length) return;

  const streams = watchedSymbols
    .map((s) => `${s.toLowerCase()}@kline_${watchedInterval}`)
    .join("/");

  ws = new WebSocket(`${WS_COMBINED}?streams=${streams}`);

  ws.on("open", () => {
    log.info(`[kline-stream] ansluten — ${watchedSymbols.length} symboler @ ${watchedInterval}`);
    reconnectAttempt = 0;
    lastMessageAt = Date.now();
    // Omseedning fyller luckan som uppstod medan anslutningen var nere.
    for (const s of watchedSymbols) void seedHistory(s, watchedInterval);
  });

  ws.on("message", (raw) => {
    lastMessageAt = Date.now();
    try {
      const frame = JSON.parse(raw.toString()) as { data?: { e?: string; k?: Record<string, unknown> } };
      const k = frame.data?.k;
      if (frame.data?.e !== "kline" || !k) return;

      const symbol = String(k.s).toUpperCase();
      const interval = String(k.i);
      const mapKey = key(symbol, interval);
      const candle = toCandle(k);

      if (!candle.closed) {
        // Ljuset byggs fortfarande. Sparas för diagrammet — men inga
        // signaler får utlösas härifrån.
        formingCandles.set(mapKey, candle);
        return;
      }

      // Ljuset är stängt och slutgiltigt.
      formingCandles.delete(mapKey);
      const history = appendClosed(mapKey, candle);

      for (const cb of subscribers) {
        try {
          cb(symbol, interval, candle, history);
        } catch (err) {
          log.warn(`[kline-stream] subscriber kastade: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch { /* trasig frame — ignorera */ }
  });

  ws.on("error", (err) => log.warn(`[kline-stream] WS-fel: ${err.message}`));

  ws.on("close", (code) => {
    log.warn(`[kline-stream] stängd, code=${code}`);
    ws = null;
    scheduleReconnect();
  });
}

/**
 * Startar strömmen.
 *
 * Binance stänger varje anslutning efter 24 timmar — det är normalt och
 * fångas av reconnect-logiken.
 */
export async function startKlineStream(symbols: string[], interval = "1m"): Promise<void> {
  if (ws) stopKlineStream();
  watchedSymbols = symbols.map((s) => s.toUpperCase());
  watchedInterval = interval;

  // Historiken laddas före anslutningen så att första stängda ljuset har
  // fullt djup bakom sig att räkna indikatorer på.
  await Promise.all(watchedSymbols.map((s) => seedHistory(s, interval)));
  connect();

  if (!watchdog) {
    watchdog = setInterval(() => {
      if (lastMessageAt && Date.now() - lastMessageAt > 60_000 && ws) {
        log.warn("[kline-stream] inga frames > 60s — tvingar reconnect");
        try { ws.close(); } catch { /* ignore */ }
      }
    }, 30_000);
  }
}

export function stopKlineStream(): void {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
  formingCandles.clear();
}

/**
 * Prenumerera på STÄNGDA ljus. Det är här signaler ska räknas.
 * Returnerar en funktion som avslutar prenumerationen.
 */
export function subscribeClosedCandles(cb: ClosedCandleHandler): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Stängda ljus, äldst först. Säkra att räkna indikatorer på. */
export function getClosedCandles(symbol: string, interval = watchedInterval): Candle[] {
  return closedBuffers.get(key(symbol, interval)) ?? [];
}

/**
 * Ljuset som byggs just nu. ENDAST för diagram — aldrig för beslut.
 * Värdena ändras flera gånger per sekund.
 */
export function getFormingCandle(symbol: string, interval = watchedInterval): Candle | null {
  return formingCandles.get(key(symbol, interval)) ?? null;
}

/**
 * Millisekunder kvar tills nuvarande ljus stänger.
 *
 * Driver nedräkningen i gränssnittet: signalen som visas gäller det ljus som
 * just stängde, och nedräkningen visar hur lång tid som återstår att agera
 * innan nästa stängning. Returnerar null om inget ljus byggs ännu.
 */
export function msUntilClose(symbol: string, interval = watchedInterval): number | null {
  const forming = formingCandles.get(key(symbol, interval));
  if (!forming) return null;
  return Math.max(0, forming.closeTime - Date.now());
}

export function getKlineStreamStatus(): {
  connected: boolean;
  symbols: string[];
  interval: string;
  bufferedSymbols: number;
  lastFrameMs: number;
} {
  return {
    connected: ws?.readyState === WebSocket.OPEN,
    symbols: watchedSymbols,
    interval: watchedInterval,
    bufferedSymbols: closedBuffers.size,
    lastFrameMs: lastMessageAt ? Date.now() - lastMessageAt : -1,
  };
}
