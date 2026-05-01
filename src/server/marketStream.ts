import WebSocket from "ws";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Binance Public Market Stream — realtidspriser via WebSocket
//
// Eliminerar REST-polling för pris/ticker-data:
//  - !miniTicker@arr      → tick-by-tick price + 24h-stats för ALLA symbols
//  - <symbol>@bookTicker  → best bid/ask för en specifik symbol (low-latency)
//
// Maintains in-memory price-cache som alla services kan läsa O(1).
// Auto-reconnect med exponential backoff.
// Server: stream.binance.com:9443 (mainnet — publika data, ingen auth).
// ═══════════════════════════════════════════════════════════════════════════

const WS_BASE = "wss://stream.binance.com:9443/ws";

interface TickerSnapshot {
  symbol: string;
  price: number;        // close
  open: number;
  high: number;
  low: number;
  volume: number;       // base
  quoteVolume: number;  // quote (= USDT)
  changePct24h: number;
  ts: number;
}

interface BookTickerSnapshot {
  symbol: string;
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  ts: number;
}

const tickerCache = new Map<string, TickerSnapshot>();
const bookCache = new Map<string, BookTickerSnapshot>();
const subscribers: Set<(symbol: string, snap: TickerSnapshot) => void> = new Set();

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let lastMessageAt = 0;
let watchdog: NodeJS.Timeout | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delayMs = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempt));
  reconnectAttempt++;
  log.warn(`[market-stream] återansluter om ${delayMs}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(`${WS_BASE}/!miniTicker@arr`);
  } catch (e) {
    log.warn(`[market-stream] connect fail: ${e instanceof Error ? e.message : String(e)}`);
    scheduleReconnect();
    return;
  }
  ws.on("open", () => {
    reconnectAttempt = 0;
    lastMessageAt = Date.now();
    log.ok("[market-stream] !miniTicker@arr ansluten");
  });
  ws.on("message", (raw: WebSocket.RawData) => {
    lastMessageAt = Date.now();
    try {
      const arr = JSON.parse(raw.toString()) as Array<{
        e: string; E: number; s: string; c: string; o: string; h: string; l: string; v: string; q: string;
      }>;
      if (!Array.isArray(arr)) return;
      for (const t of arr) {
        const close = parseFloat(t.c);
        const open = parseFloat(t.o);
        const snap: TickerSnapshot = {
          symbol: t.s,
          price: close,
          open,
          high: parseFloat(t.h),
          low: parseFloat(t.l),
          volume: parseFloat(t.v),
          quoteVolume: parseFloat(t.q),
          changePct24h: open > 0 ? ((close - open) / open) * 100 : 0,
          ts: t.E || Date.now(),
        };
        tickerCache.set(t.s, snap);
        for (const sub of subscribers) {
          try { sub(t.s, snap); } catch { /* ignore subscriber error */ }
        }
      }
    } catch { /* malformed frame, ignore */ }
  });
  ws.on("error", (err) => {
    log.warn(`[market-stream] WS error: ${err.message}`);
  });
  ws.on("close", (code, reason) => {
    log.warn(`[market-stream] stängd code=${code} reason=${reason.toString().slice(0, 100)}`);
    ws = null;
    scheduleReconnect();
  });
}

export function startMarketStream(): void {
  if (ws) return;
  connect();
  // Watchdog: om vi inte fått frame på 60s → tvinga reconnect
  if (!watchdog) {
    watchdog = setInterval(() => {
      if (lastMessageAt && Date.now() - lastMessageAt > 60_000 && ws) {
        log.warn("[market-stream] inga frames > 60s — tvingar reconnect");
        try { ws.close(); } catch { /* ignore */ }
      }
    }, 30_000);
  }
}

export function stopMarketStream(): void {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  tickerCache.clear();
  bookCache.clear();
}

export function getCachedPrice(symbol: string): number | null {
  const t = tickerCache.get(symbol);
  if (!t) return null;
  // Accepterar pris som är max 30s gammalt — annars trigga REST-fallback hos kallaren
  if (Date.now() - t.ts > 30_000) return null;
  return t.price;
}

export function getCachedTicker(symbol: string): TickerSnapshot | null {
  const t = tickerCache.get(symbol);
  if (!t) return null;
  if (Date.now() - t.ts > 60_000) return null;
  return t;
}

export function getAllTickers(): TickerSnapshot[] {
  const cutoff = Date.now() - 60_000;
  return Array.from(tickerCache.values()).filter((t) => t.ts >= cutoff);
}

export function getBookTicker(symbol: string): BookTickerSnapshot | null {
  return bookCache.get(symbol) || null;
}

export function subscribeTickers(cb: (symbol: string, snap: TickerSnapshot) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getMarketStreamStatus(): { connected: boolean; cachedSymbols: number; lastFrameMs: number } {
  return {
    connected: ws?.readyState === WebSocket.OPEN,
    cachedSymbols: tickerCache.size,
    lastFrameMs: lastMessageAt ? Date.now() - lastMessageAt : -1,
  };
}
