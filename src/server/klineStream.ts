// ═══════════════════════════════════════════════════════════════════════════
// Ljus för signalmotorn och diagrammet — nu från IG (src/server/igMarketData.ts).
// Tidigare Bybit-WebSocket. API:t är detsamma så att signalmotorn, strategierna
// och exporten inte behöver ändras. symbol = IG EPIC.
//
// DEN VIKTIGA REGELN gäller fortfarande: signaler räknas BARA på stängda ljus
// (IG CHART CONS_END=1 eller REST-historikens stängda ljus). Det pågående ljuset
// är endast för diagram.
// ═══════════════════════════════════════════════════════════════════════════
import { igMarketData, type Candle } from "./igMarketData.js";
export type { Candle };

type ClosedCandleHandler = (symbol: string, interval: string, candle: Candle, history: Candle[]) => void;
let watchedInterval = "1m";
const handlers = new Set<ClosedCandleHandler>();
let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  igMarketData.events.on("closed", (env: string, epic: string, iv: string, c: Candle, history: Candle[]) => {
    if (env !== igMarketData.getActiveEnv()) return; // aldrig Live-ljus i Demo-signaler eller tvärtom
    for (const cb of handlers) { try { cb(epic, iv, c, history); } catch { /* en trasig lyssnare stoppar inte de andra */ } }
  });
}

export async function startKlineStream(symbols: string[], interval = "1m"): Promise<void> {
  wire();
  watchedInterval = interval;
  igMarketData.setSignalInterval(interval);
  igMarketData.start();
  await Promise.all(symbols.map((s) => igMarketData.ensureSeries(igMarketData.getActiveEnv(), s, interval).catch(() => undefined)));
}
export async function addKlineSymbol(symbol: string): Promise<void> { await igMarketData.addWatch(symbol); }
export function removeKlineSymbol(symbol: string): void { igMarketData.removeWatch(symbol); }
export function stopKlineStream(): void { igMarketData.stop(); }
export function subscribeClosedCandles(cb: ClosedCandleHandler): () => void { wire(); handlers.add(cb); return () => handlers.delete(cb); }
export function getClosedCandles(symbol: string, interval = watchedInterval): Candle[] { return igMarketData.closed(symbol, interval); }
export function getFormingCandle(symbol: string, interval = watchedInterval): Candle | null { return igMarketData.forming(symbol, interval); }
export function msUntilClose(symbol: string, interval = watchedInterval): number | null {
  const f = igMarketData.forming(symbol, interval);
  return f ? Math.max(0, f.closeTime - Date.now()) : null;
}
export function getKlineStreamStatus(): { connected: boolean; symbols: string[]; interval: string; bufferedSymbols: number; lastFrameMs: number; source: string } {
  const st = igMarketData.streamStatus();
  return {
    connected: st.status === "CONNECTED:WS-STREAMING",
    symbols: igMarketData.watchlist(),
    interval: watchedInterval,
    bufferedSymbols: igMarketData.watchlist().filter((e) => igMarketData.closed(e, watchedInterval).length).length,
    lastFrameMs: st.lastPriceAt ? Date.now() - st.lastPriceAt : -1,
    source: `IG ${igMarketData.getActiveEnv() === "live" ? "Live" : "Demo"} · Lightstreamer + REST-historik`,
  };
}
