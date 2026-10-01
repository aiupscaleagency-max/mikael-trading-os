import crypto from "node:crypto";
import WebSocket from "ws";
import { log } from "../logger.js";
import type { Candle } from "./klineStream.js";

// ═══════════════════════════════════════════════════════════════════════════
// Bybit WebSocket — priser, ljus och kontosaldo i realtid
//
// Bybit EU är LIVE-mäklaren, så strategierna räknar på Bybits egna ljus,
// samma orderbok som ordrarna läggs i. Två anslutningar:
//
//   Publik  (wss://stream.bybit.eu/v5/public/spot)
//     tickers.<PAR>         → senaste pris + 24h-ändring
//     kline.<int>.<PAR>     → ljus. Fältet confirm=true betyder STÄNGT ljus.
//                             Bara stängda ljus driver strategierna, samma
//                             regel som klineStream.ts (ingen repainting).
//
//   Privat  (wss://stream.bybit.eu/v5/private), bara om BYBIT_API_KEY finns
//     wallet                → saldot uppdateras i samma sekund det ändras
//     order / execution     → fyllda ordrar
//
// Prenumerationer kan läggas till medan anslutningen är uppe: när en ny
// strategi slås på för ett nytt par börjar ljusen strömma direkt, utan omstart.
// Återansluter med backoff, pingar var 20:e sekund (Bybit kräver det) och
// tvingar ny anslutning om inget kommit på 60 sekunder.
// ═══════════════════════════════════════════════════════════════════════════

const PUBLIC_URLS = [
  process.env.BYBIT_WS_PUBLIC || "wss://stream.bybit.eu/v5/public/spot",
  // Reserv för publika priser om EU-adressen inte svarar. Används bara för
  // marknadsdata, aldrig för kontot.
  "wss://stream.bybit.com/v5/public/spot",
];
const PRIVATE_URL = process.env.BYBIT_WS_PRIVATE || "wss://stream.bybit.eu/v5/private";
const REST_BASE = process.env.BYBIT_BASE_URL || "https://api.bybit.eu";

const SEED_LIMIT = 500;
const MAX_BUFFER = 1000;
const PING_MS = 20_000;
const STALE_MS = 60_000;

/** "5m" → "5" osv. Bybits kline-intervall. */
export const BYBIT_INTERVAL: Record<string, string> = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720", "1d": "D", "1w": "W",
};
const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000, "12h": 43_200_000,
  "1d": 86_400_000, "1w": 604_800_000,
};
const FROM_BYBIT: Record<string, string> = Object.fromEntries(Object.entries(BYBIT_INTERVAL).map(([k, v]) => [v, k]));

export interface BybitTicker {
  symbol: string;
  price: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  turnover24h: number;
  ts: number;
}

export interface BybitWallet {
  accountType: string;
  totalEquityUsd: number;
  coins: Array<{ coin: string; balance: number; usdValue: number; locked: number }>;
  ts: number;
  source: "websocket" | "rest";
}

type ClosedHandler = (pair: string, interval: string, candle: Candle, history: Candle[]) => void;

// ─── Publik ström ─────────────────────────────────────────────────────────

const tickers = new Map<string, BybitTicker>();
const closedBuffers = new Map<string, Candle[]>();
const forming = new Map<string, Candle>();
const closedHandlers = new Set<ClosedHandler>();
const tickerHandlers = new Set<(t: BybitTicker) => void>();
const topics = new Set<string>();
const seeded = new Set<string>();

let pub: WebSocket | null = null;
let pubUrlIdx = 0;
let pubAttempt = 0;
let pubTimer: NodeJS.Timeout | null = null;
let pubPing: NodeJS.Timeout | null = null;
let pubLastMsg = 0;
let pubConnectedAt = 0;
let pubStarted = false;

const bkey = (pair: string, interval: string) => `${pair}:${interval}`;

function sendSubscribe(ws: WebSocket, list: string[]): void {
  // Bybit spot tar max 10 ämnen per subscribe-anrop.
  for (let i = 0; i < list.length; i += 10) {
    ws.send(JSON.stringify({ op: "subscribe", args: list.slice(i, i + 10) }));
  }
}

/** Historiska ljus via REST så indikatorerna har djup från första stängda ljuset. */
export async function fetchBybitCandles(pair: string, interval: string, limit = SEED_LIMIT): Promise<Candle[]> {
  const iv = BYBIT_INTERVAL[interval];
  if (!iv) throw new Error(`Intervallet ${interval} stöds inte av Bybit`);
  const url = `${REST_BASE}/v5/market/kline?category=spot&symbol=${pair}&interval=${iv}&limit=${Math.min(limit, 1000)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bybit kline ${pair} HTTP ${res.status}`);
  const body = (await res.json()) as { retCode: number; retMsg: string; result?: { list?: string[][] } };
  if (body.retCode !== 0) throw new Error(`Bybit kline ${pair}: ${body.retMsg}`);
  const ms = INTERVAL_MS[interval] ?? 60_000;
  // Bybit skickar nyast först; vänd. Det nyaste ljuset byggs fortfarande och tas bort.
  const rows = (body.result?.list ?? []).slice().reverse();
  const now = Date.now();
  return rows
    .map((k): Candle => {
      const openTime = Number(k[0]);
      return {
        openTime,
        closeTime: openTime + ms - 1,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        quoteVolume: Number(k[6]),
        trades: 0,
        closed: true,
      };
    })
    .filter((c) => c.closeTime < now);
}

async function seed(pair: string, interval: string): Promise<void> {
  try {
    const candles = await fetchBybitCandles(pair, interval);
    closedBuffers.set(bkey(pair, interval), candles);
    seeded.add(bkey(pair, interval));
    log.info(`[bybit-ws] ${pair} ${interval}: ${candles.length} historiska ljus laddade`);
  } catch (err) {
    log.warn(`[bybit-ws] kunde inte ladda historik för ${pair} ${interval}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function appendClosed(k: string, c: Candle): Candle[] {
  const buf = closedBuffers.get(k) ?? [];
  const last = buf[buf.length - 1];
  if (last && last.openTime === c.openTime) buf[buf.length - 1] = c;
  else if (!last || c.openTime > last.openTime) {
    buf.push(c);
    if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
  }
  closedBuffers.set(k, buf);
  return buf;
}

function onPublicMessage(raw: WebSocket.RawData): void {
  pubLastMsg = Date.now();
  let msg: { topic?: string; data?: unknown; op?: string; success?: boolean; ret_msg?: string };
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.op === "subscribe" && msg.success === false) {
    log.warn(`[bybit-ws] prenumeration nekad: ${msg.ret_msg ?? "okänt fel"}`);
    return;
  }
  const topic = msg.topic;
  if (!topic) return;

  if (topic.startsWith("tickers.")) {
    const d = msg.data as Record<string, string>;
    const t: BybitTicker = {
      symbol: d.symbol ?? topic.slice(8),
      price: Number(d.lastPrice),
      changePct24h: Number(d.price24hPcnt) * 100,
      high24h: Number(d.highPrice24h),
      low24h: Number(d.lowPrice24h),
      turnover24h: Number(d.turnover24h),
      ts: Date.now(),
    };
    if (!Number.isFinite(t.price)) return;
    tickers.set(t.symbol, t);
    for (const cb of tickerHandlers) { try { cb(t); } catch { /* ignorera */ } }
    return;
  }

  if (topic.startsWith("kline.")) {
    const [, iv, pair] = topic.split(".");
    const interval = FROM_BYBIT[iv ?? ""];
    if (!interval || !pair) return;
    for (const d of (msg.data as Array<Record<string, unknown>>) ?? []) {
      const c: Candle = {
        openTime: Number(d.start),
        closeTime: Number(d.end),
        open: Number(d.open),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close),
        volume: Number(d.volume),
        quoteVolume: Number(d.turnover),
        trades: 0,
        closed: d.confirm === true,
      };
      const k = bkey(pair, interval);
      if (!c.closed) { forming.set(k, c); continue; }
      forming.delete(k);
      const history = appendClosed(k, c);
      for (const cb of closedHandlers) {
        try { cb(pair, interval, c, history); } catch (err) {
          log.warn(`[bybit-ws] strategi-hanterare kastade: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}

function schedulePublicReconnect(): void {
  if (pubTimer) return;
  const delay = Math.min(30_000, 1000 * 2 ** pubAttempt);
  pubAttempt++;
  // Efter två misslyckade försök mot samma adress provas nästa.
  if (pubAttempt % 2 === 0) pubUrlIdx = (pubUrlIdx + 1) % PUBLIC_URLS.length;
  pubTimer = setTimeout(() => { pubTimer = null; connectPublic(); }, delay);
}

function connectPublic(): void {
  const url = PUBLIC_URLS[pubUrlIdx]!;
  const ws = new WebSocket(url);
  pub = ws;
  ws.on("open", () => {
    pubAttempt = 0;
    pubConnectedAt = Date.now();
    pubLastMsg = Date.now();
    log.ok(`[bybit-ws] publik ström ansluten (${pubUrlIdx === 0 ? "Bybit EU" : "Bybit global, reserv"}) — ${topics.size} ämnen`);
    if (topics.size) sendSubscribe(ws, [...topics]);
    // Fyll luckan som uppstod medan anslutningen var nere.
    for (const t of topics) {
      if (!t.startsWith("kline.")) continue;
      const [, iv, pair] = t.split(".");
      const interval = FROM_BYBIT[iv ?? ""];
      if (interval && pair) void seed(pair, interval);
    }
    if (pubPing) clearInterval(pubPing);
    pubPing = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping" }));
      if (Date.now() - pubLastMsg > STALE_MS) {
        log.warn("[bybit-ws] publik ström tyst > 60s — ansluter om");
        try { ws.terminate(); } catch { /* ignorera */ }
      }
    }, PING_MS);
  });
  ws.on("message", onPublicMessage);
  ws.on("error", (err) => log.warn(`[bybit-ws] publik ström fel: ${err.message}`));
  ws.on("close", () => {
    if (pub === ws) pub = null;
    if (pubPing) { clearInterval(pubPing); pubPing = null; }
    pubConnectedAt = 0;
    schedulePublicReconnect();
  });
}

/** Startar den publika strömmen (idempotent). */
export function startBybitPublicStream(): void {
  if (pubStarted) return;
  pubStarted = true;
  connectPublic();
}

/** Bevaka pris för ett par (t.ex. "BTCUSDC"). */
export function watchBybitTicker(pair: string): void {
  const t = `tickers.${pair.toUpperCase()}`;
  if (topics.has(t)) return;
  topics.add(t);
  startBybitPublicStream();
  if (pub?.readyState === WebSocket.OPEN) sendSubscribe(pub, [t]);
}

/** Bevaka ljus för ett par + intervall. Laddar historik första gången. */
export async function watchBybitKlines(pair: string, interval: string): Promise<void> {
  const p = pair.toUpperCase();
  const iv = BYBIT_INTERVAL[interval];
  if (!iv) throw new Error(`Intervallet ${interval} stöds inte`);
  watchBybitTicker(p);
  const t = `kline.${iv}.${p}`;
  if (!seeded.has(bkey(p, interval))) await seed(p, interval);
  if (topics.has(t)) return;
  topics.add(t);
  startBybitPublicStream();
  if (pub?.readyState === WebSocket.OPEN) sendSubscribe(pub, [t]);
}

export function subscribeBybitClosedCandles(cb: ClosedHandler): () => void {
  closedHandlers.add(cb);
  return () => closedHandlers.delete(cb);
}

export function subscribeBybitTickers(cb: (t: BybitTicker) => void): () => void {
  tickerHandlers.add(cb);
  return () => tickerHandlers.delete(cb);
}

export function getBybitClosedCandles(pair: string, interval: string): Candle[] {
  return closedBuffers.get(bkey(pair.toUpperCase(), interval)) ?? [];
}

export function getBybitFormingCandle(pair: string, interval: string): Candle | null {
  return forming.get(bkey(pair.toUpperCase(), interval)) ?? null;
}

export function getBybitTicker(pair: string): BybitTicker | null {
  return tickers.get(pair.toUpperCase()) ?? null;
}

export function getBybitTickers(): BybitTicker[] {
  return [...tickers.values()];
}

// ─── Privat ström (kontot) ────────────────────────────────────────────────

let priv: WebSocket | null = null;
let privAttempt = 0;
let privTimer: NodeJS.Timeout | null = null;
let privPing: NodeJS.Timeout | null = null;
let privLastMsg = 0;
let privAuthed = false;
let privError = "";
let privStarted = false;
let wallet: BybitWallet | null = null;
const walletHandlers = new Set<(w: BybitWallet) => void>();
const orderHandlers = new Set<(o: Record<string, unknown>) => void>();

function creds(): { key: string; secret: string } | null {
  const key = process.env.BYBIT_API_KEY?.trim();
  const secret = process.env.BYBIT_API_SECRET?.trim();
  return key && secret ? { key, secret } : null;
}

export function parseWallet(raw: Record<string, unknown>, source: "websocket" | "rest"): BybitWallet {
  const coins = ((raw.coin as Array<Record<string, string>>) ?? [])
    .map((c) => ({
      coin: c.coin ?? "",
      balance: Number(c.walletBalance || c.equity || 0),
      usdValue: Number(c.usdValue || 0),
      locked: Number(c.locked || 0),
    }))
    .filter((c) => c.balance > 0);
  return {
    accountType: String(raw.accountType ?? "UNIFIED"),
    totalEquityUsd: Number(raw.totalEquity || 0),
    coins,
    ts: Date.now(),
    source,
  };
}

function setWallet(w: BybitWallet): void {
  wallet = w;
  for (const cb of walletHandlers) { try { cb(w); } catch { /* ignorera */ } }
}

function schedulePrivateReconnect(): void {
  if (privTimer) return;
  const delay = Math.min(60_000, 2000 * 2 ** privAttempt);
  privAttempt++;
  privTimer = setTimeout(() => { privTimer = null; connectPrivate(); }, delay);
}

function connectPrivate(): void {
  const c = creds();
  if (!c) return;
  const ws = new WebSocket(PRIVATE_URL);
  priv = ws;
  privAuthed = false;
  ws.on("open", () => {
    privLastMsg = Date.now();
    // Signatur: hex HMAC-SHA256("GET/realtime" + expires, secret)
    const expires = Date.now() + 10_000;
    const sig = crypto.createHmac("sha256", c.secret).update(`GET/realtime${expires}`).digest("hex");
    ws.send(JSON.stringify({ op: "auth", args: [c.key, expires, sig] }));
    if (privPing) clearInterval(privPing);
    privPing = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping" }));
      if (Date.now() - privLastMsg > STALE_MS * 2) {
        log.warn("[bybit-ws] kontoströmmen tyst — ansluter om");
        try { ws.terminate(); } catch { /* ignorera */ }
      }
    }, PING_MS);
  });
  ws.on("message", (raw) => {
    privLastMsg = Date.now();
    let msg: { op?: string; success?: boolean; ret_msg?: string; topic?: string; data?: unknown };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.op === "auth") {
      if (msg.success) {
        privAuthed = true;
        privAttempt = 0;
        privError = "";
        log.ok("[bybit-ws] kontoström inloggad — saldo och ordrar i realtid");
        ws.send(JSON.stringify({ op: "subscribe", args: ["wallet", "order", "execution"] }));
      } else {
        privError = `Inloggning nekad: ${msg.ret_msg ?? "okänt"}`;
        log.warn(`[bybit-ws] ${privError}`);
      }
      return;
    }
    if (msg.topic === "wallet") {
      const list = (msg.data as Array<Record<string, unknown>>) ?? [];
      const unified = list.find((w) => w.accountType === "UNIFIED") ?? list[0];
      if (unified) setWallet(parseWallet(unified, "websocket"));
      return;
    }
    if (msg.topic === "order" || msg.topic === "execution") {
      for (const o of (msg.data as Array<Record<string, unknown>>) ?? []) {
        for (const cb of orderHandlers) { try { cb({ topic: msg.topic, ...o }); } catch { /* ignorera */ } }
      }
    }
  });
  ws.on("error", (err) => { privError = err.message; log.warn(`[bybit-ws] kontoström fel: ${err.message}`); });
  ws.on("close", () => {
    if (priv === ws) priv = null;
    privAuthed = false;
    if (privPing) { clearInterval(privPing); privPing = null; }
    schedulePrivateReconnect();
  });
}

/** Startar kontoströmmen om Bybit-nycklar finns (idempotent). */
export function startBybitPrivateStream(): boolean {
  if (privStarted) return true;
  if (!creds()) return false;
  privStarted = true;
  connectPrivate();
  return true;
}

/** Sätt saldo från REST (vid start, innan första websocket-uppdateringen). */
export function setBybitWalletFromRest(raw: Record<string, unknown>): BybitWallet {
  const w = parseWallet(raw, "rest");
  // Skriv inte över ett färskare websocket-saldo.
  if (!wallet || wallet.source === "rest") setWallet(w);
  return wallet ?? w;
}

export function getBybitWallet(): BybitWallet | null {
  return wallet;
}

export function subscribeBybitWallet(cb: (w: BybitWallet) => void): () => void {
  walletHandlers.add(cb);
  return () => walletHandlers.delete(cb);
}

export function subscribeBybitOrders(cb: (o: Record<string, unknown>) => void): () => void {
  orderHandlers.add(cb);
  return () => orderHandlers.delete(cb);
}

// ─── Status för live-lamporna ─────────────────────────────────────────────

export interface StreamLamp {
  connected: boolean;
  lastMessageAgoMs: number | null;
  detail: string;
}

export function getBybitStreamStatus(): { public: StreamLamp; private: StreamLamp } {
  const now = Date.now();
  return {
    public: {
      connected: pub?.readyState === WebSocket.OPEN,
      lastMessageAgoMs: pubLastMsg ? now - pubLastMsg : null,
      detail: !pubStarted
        ? "inte startad"
        : `${topics.size} ämnen · ${pubUrlIdx === 0 ? "Bybit EU" : "Bybit global (reserv)"}`
          + (pubConnectedAt ? ` · uppe ${Math.round((now - pubConnectedAt) / 60_000)} min` : ""),
    },
    private: {
      connected: priv?.readyState === WebSocket.OPEN && privAuthed,
      lastMessageAgoMs: privLastMsg ? now - privLastMsg : null,
      detail: !creds()
        ? "ingen Bybit-nyckel"
        : privAuthed ? "inloggad · wallet, order, execution" : privError || "ansluter",
    },
  };
}
