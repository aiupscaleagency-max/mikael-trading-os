import WebSocket from "ws";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Bybit Kline Stream — ljus i realtid via WebSocket (tidigare Binance)
//
// VARFÖR DEN HÄR FILEN FINNS:
// marketStream.ts ger tick-priser, men INGA ljus. Indikatorerna hämtade
// candles via REST-polling, vilket betyder att diagrammet och signalerna
// släpade efter priset.
//
// ── DEN VIKTIGA REGELN ───────────────────────────────────────────────────
// Bybit skickar kline-uppdateringar KONTINUERLIGT medan ljuset byggs,
// flera gånger per sekund. Fältet `confirm` säger om ljuset är STÄNGT.
//
// Räknas RSI/MACD/EMA på ett ohalvfärdigt ljus ändras värdet hela tiden —
// en LONG-signal kan dyka upp och försvinna inom samma minut. Det kallas
// repainting och är den vanligaste orsaken till att en strategi ser bra ut
// i backtest men förlorar pengar live.
//
// Därför:
//   - subscribeClosedCandles()  → fyras BARA när confirm === true. Signaler här.
//   - getFormingCandle()        → ljuset som byggs just nu. ENDAST för
//                                 diagram. Aldrig för beslut.
//
// Datan är identisk med den Bybit visar — samma ström, samma ljus, samma
// stängningstider.
// ═══════════════════════════════════════════════════════════════════════════

// Bybit (2026-10-03): samma börs som Mike handlar på. Publik data, inga nycklar.
// Bybit EU:s publika data är samma som bybit.com, så .com används först och .eu som reserv.
const WS_URLS = ["wss://stream.bybit.com/v5/public/spot", "wss://stream.bybit.eu/v5/public/spot"];
const REST_BASES = ["https://api.bybit.com", "https://api.bybit.eu"];
/** Bybits intervallnamn ("1" = 1 min, "60" = 1 tim, "D" = dag). */
const BYBIT_IV: Record<string, string> = { "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720", "1d": "D", "1w": "W" };
const IV_MS: Record<string, number> = { "1m": 60e3, "3m": 180e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "2h": 7200e3, "4h": 14400e3, "6h": 21600e3, "12h": 43200e3, "1d": 86400e3, "1w": 604800e3 };
let urlIdx = 0;
let pingTimer: NodeJS.Timeout | null = null;

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

/** Bybit kline-frame → Candle. `confirm` = ljuset är stängt. */
function toCandle(k: Record<string, unknown>): Candle {
  return {
    openTime: Number(k.start),
    closeTime: Number(k.end),
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
    volume: Number(k.volume),
    quoteVolume: Number(k.turnover),
    trades: 0,
    closed: k.confirm === true,
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
  const iv = BYBIT_IV[interval];
  const ivMs = IV_MS[interval] ?? 60e3;
  if (!iv) { log.warn(`[kline-stream] okänt intervall ${interval}`); return; }
  let lastErr = "";
  for (const base of REST_BASES) {
    try {
      const res = await fetch(`${base}/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&limit=${SEED_LIMIT}`);
      const body = (await res.json()) as { retCode: number; retMsg: string; result?: { list?: string[][] } };
      if (!res.ok || body.retCode !== 0 || !body.result?.list?.length) { lastErr = `${base}: ${body.retMsg || res.status}`; continue; }
      // Bybit ger nyast först, och det nyaste ljuset byggs fortfarande. Det
      // hör inte hemma bland de stängda, så det tas bort explicit.
      const rows = body.result.list.slice().reverse();
      const closed = rows.slice(0, -1).map((r): Candle => ({
        openTime: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
        closeTime: Number(r[0]) + ivMs - 1,
        quoteVolume: Number(r[6]),
        trades: 0,
        closed: true,
      }));
      closedBuffers.set(key(symbol, interval), closed);
      log.info(`[kline-stream] ${symbol} ${interval}: ${closed.length} historiska ljus från Bybit`);
      return;
    } catch (err) {
      lastErr = `${base}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  log.warn(`[kline-stream] seed misslyckades för ${symbol} ${interval}: ${lastErr}`);
}

/** Lägger till ett stängt ljus. Dubbletter ignoreras — börsen kan skicka om. */
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

  const iv = BYBIT_IV[watchedInterval];
  if (!iv) return;
  const url = WS_URLS[urlIdx % WS_URLS.length]!;
  const sock = new WebSocket(url);
  ws = sock;

  ws.on("open", () => {
    log.info(`[kline-stream] ansluten till Bybit (${url}) — ${watchedSymbols.length} symboler @ ${watchedInterval}`);
    reconnectAttempt = 0;
    lastMessageAt = Date.now();
    // Bybit tar max 10 ämnen per prenumeration
    const args = watchedSymbols.map((s) => `kline.${iv}.${s}`);
    for (let i = 0; i < args.length; i += 10) sock.send(JSON.stringify({ op: "subscribe", args: args.slice(i, i + 10) }));
    // Bybit kopplar ner utan ping inom 20 s
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { sock.send('{"op":"ping"}'); } catch { /* ignore */ } }, 20_000);
    // Omseedning fyller luckan som uppstod medan anslutningen var nere.
    for (const s of watchedSymbols) void seedHistory(s, watchedInterval);
  });

  ws.on("message", (raw) => {
    lastMessageAt = Date.now();
    try {
      const frame = JSON.parse(raw.toString()) as { topic?: string; data?: Array<Record<string, unknown>> };
      if (!frame.topic?.startsWith("kline.") || !Array.isArray(frame.data)) return;
      const symbol = frame.topic.split(".")[2]!.toUpperCase();
      const interval = watchedInterval;
      const mapKey = key(symbol, interval);
      for (const k of frame.data) {
      const candle = toCandle(k);

      if (!candle.closed) {
        // Ljuset byggs fortfarande. Sparas för diagrammet — men inga
        // signaler får utlösas härifrån.
        formingCandles.set(mapKey, candle);
        continue;
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
      }
    } catch { /* trasig frame — ignorera */ }
  });

  ws.on("error", (err) => log.warn(`[kline-stream] WS-fel: ${err.message}`));

  ws.on("close", (code) => {
    log.warn(`[kline-stream] stängd, code=${code}`);
    if (ws !== sock) return;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    ws = null;
    urlIdx++; // nästa försök: den andra Bybit-adressen
    scheduleReconnect();
  });
}

/**
 * Startar strömmen.
 *
 * Avbrott fångas av reconnect-logiken, som byter mellan bybit.com och bybit.eu.
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
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  const old = ws; ws = null;
  if (old) { try { old.close(); } catch { /* ignore */ } }
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
