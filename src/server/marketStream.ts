// ═══════════════════════════════════════════════════════════════════════════
// Priscache — nu IG-kvoter (Lightstreamer PRICE, REST som reserv) via igMarketData.
// Tidigare Bybit/Binance-tickers. symbol = IG EPIC. Pris = mitt (bid+ask)/2.
// ═══════════════════════════════════════════════════════════════════════════
import { igMarketData, type IgQuote } from "./igMarketData.js";

interface TickerSnapshot { symbol: string; price: number; bid: number; ask: number; changePct: number | null; ts: number; source: string }
const toSnap = (q: IgQuote): TickerSnapshot => ({ symbol: q.epic, price: q.mid, bid: q.bid, ask: q.offer, changePct: q.changePct, ts: q.observedAt ?? q.receivedAt, source: q.source });

export function addTickerBase(_base: string, _usdc: boolean): void { /* IG: bevakningslistan styr strömmen */ }
export function startMarketStream(): void { igMarketData.start(); }
export function stopMarketStream(): void { /* stoppas med igMarketData */ }
/** Mittpris om kvoten är högst 30 s gammal, annars null (kallaren får hämta färskt). */
export function getCachedPrice(symbol: string): number | null {
  const q = igMarketData.quote(symbol);
  if (!q || q.observedAt === null || Date.now() - q.observedAt > 30_000) return null;
  return q.mid;
}
export function getCachedTicker(symbol: string): TickerSnapshot | null {
  const q = igMarketData.quote(symbol);
  if (!q || q.observedAt === null || Date.now() - q.observedAt > 60_000) return null;
  return toSnap(q);
}
export function getAllTickers(): TickerSnapshot[] { return igMarketData.quotes().filter((q) => q.observedAt !== null && Date.now() - q.observedAt <= 60_000).map(toSnap); }
export function getBookTicker(symbol: string): { symbol: string; bid: number; ask: number } | null {
  const q = igMarketData.quote(symbol);
  return q ? { symbol, bid: q.bid, ask: q.offer } : null;
}
export function subscribeTickers(cb: (symbol: string, snap: TickerSnapshot) => void): () => void {
  const fn = (env: string, q: IgQuote) => { if (env === igMarketData.getActiveEnv()) cb(q.epic, toSnap(q)); };
  igMarketData.events.on("quote", fn);
  return () => igMarketData.events.off("quote", fn);
}
export function getMarketStreamStatus(): { connected: boolean; cachedSymbols: number; lastFrameMs: number } {
  const st = igMarketData.streamStatus();
  return { connected: st.status === "CONNECTED:WS-STREAMING", cachedSymbols: igMarketData.quotes().length, lastFrameMs: st.lastPriceAt ? Date.now() - st.lastPriceAt : -1 };
}
