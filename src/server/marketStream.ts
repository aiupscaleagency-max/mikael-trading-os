import WebSocket from "ws";
import { log } from "../logger.js";
import { config } from "../config.js";

// ═══════════════════════════════════════════════════════════════════════════
// Bybit Public Market Stream — realtidspriser via WebSocket (tidigare Binance)
//
// Eliminerar REST-polling för pris/ticker-data:
//  - !miniTicker@arr      → tick-by-tick price + 24h-stats för ALLA symbols
//  - <symbol>@bookTicker  → best bid/ask för en specifik symbol (low-latency)
//
// Maintains in-memory price-cache som alla services kan läsa O(1).
// Auto-reconnect med exponential backoff.
// Server: stream.binance.com:9443 (mainnet — publika data, ingen auth).
// ═══════════════════════════════════════════════════════════════════════════

// Bybit (2026-10-03): tickers.<PAR> för alla mynt agenterna följer, i både
// USDT- och USDC-form. Bybit pushar en ny ticker flera gånger per sekund.
const WS_URLS = ["wss://stream.bybit.com/v5/public/spot", "wss://stream.bybit.eu/v5/public/spot"];
let urlIdx = 0;
let pingTimer: NodeJS.Timeout | null = null;
function watchedPairs(): string[] {
  const bases = config.crypto.symbols.map((s) => s.toUpperCase().replace(/(USDT|USDC|USD)$/, ""));
  return [...new Set(bases.flatMap((b) => [`${b}USDT`, `${b}USDC`]))];
}

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
  const url = WS_URLS[urlIdx % WS_URLS.length]!;
  let sock: WebSocket;
  try {
    sock = new WebSocket(url);
    ws = sock;
  } catch (e) {
    log.warn(`[market-stream] connect fail: ${e instanceof Error ? e.message : String(e)}`);
    scheduleReconnect();
    return;
  }
  sock.on("open", () => {
    reconnectAttempt = 0;
    lastMessageAt = Date.now();
    const args = watchedPairs().map((p) => `tickers.${p}`);
    for (let i = 0; i < args.length; i += 10) sock.send(JSON.stringify({ op: "subscribe", args: args.slice(i, i + 10) }));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { sock.send('{"op":"ping"}'); } catch { /* ignore */ } }, 20_000);
    log.ok(`[market-stream] Bybit tickers ansluten (${url}) — ${args.length} par`);
  });
  sock.on("message", (raw: WebSocket.RawData) => {
    lastMessageAt = Date.now();
    try {
      const m = JSON.parse(raw.toString()) as { topic?: string; ts?: number; data?: Record<string, string> };
      if (!m.topic?.startsWith("tickers.") || !m.data) return;
      const t = m.data;
      const sym = String(t.symbol || m.topic.slice(8)).toUpperCase();
      const close = parseFloat(t.lastPrice ?? "");
      if (!(close > 0)) return;
      const open = parseFloat(t.prevPrice24h ?? "") || close;
      const snap: TickerSnapshot = {
        symbol: sym,
        price: close,
        open,
        high: parseFloat(t.highPrice24h ?? "") || close,
        low: parseFloat(t.lowPrice24h ?? "") || close,
        volume: parseFloat(t.volume24h ?? "") || 0,
        quoteVolume: parseFloat(t.turnover24h ?? "") || 0,
        changePct24h: (parseFloat(t.price24hPcnt ?? "") || 0) * 100,
        ts: m.ts || Date.now(),
      };
      tickerCache.set(sym, snap);
      for (const sub of subscribers) {
        try { sub(sym, snap); } catch { /* ignore subscriber error */ }
      }
    } catch { /* malformed frame, ignore */ }
  });
  sock.on("error", (err) => {
    log.warn(`[market-stream] WS error: ${err.message}`);
  });
  sock.on("close", (code, reason) => {
    log.warn(`[market-stream] stängd code=${code} reason=${reason.toString().slice(0, 100)}`);
    if (ws !== sock) return;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    ws = null;
    urlIdx++;
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
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  const old = ws; ws = null;
  if (old) { try { old.close(); } catch {} }
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
