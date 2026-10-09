import { computeIndicators } from "../indicators/ta.js";
import { log } from "../logger.js";
import { detectAllPatterns, type DetectedPattern } from "./patternDetection.js";

// ═══════════════════════════════════════════════════════════════════════════
// Market Context — ger agenterna ÖGONEN på marknaden (IG)
//
// Läser IG-data som servern redan har (bevakningslistan i aktiv miljö):
// kvot (bid/offer, IG:s dagsförändring, hög/låg) + STÄNGDA IG-ljus, och räknar
// indikatorer (RSI, SMA, EMA, MACD, ATR) lokalt. Inga extra IG-anrop och inga
// påhittade värden: saknas något står det "–" i prompten.
// Cache: 60 s.
// ═══════════════════════════════════════════════════════════════════════════

import { igMarketData } from "./igMarketData.js";

const CACHE_TTL_MS = 60_000;

interface MarketSnapshot {
  fetchedAt: number;
  env: string;
  symbols: SymbolSnapshot[];
  marketSummary: string;
}

interface SymbolSnapshot {
  symbol: string;
  name: string;
  interval: string;
  dataState: string;
  price: number;
  changePct24h: number | null;
  volume24h: number | null;
  high24h: number | null;
  low24h: number | null;
  rsi14: number | null;
  sma20: number | null;
  sma50: number | null;
  ema20: number | null;
  macd: { macd: number | null; signal: number | null; histogram: number | null } | null;
  atr14: number | null;
  trend: string;
  nearResistance: boolean;
  nearSupport: boolean;
  patterns: DetectedPattern[];
  obv: number | null;
}

let cache: MarketSnapshot | null = null;

export async function getMarketSnapshot(): Promise<MarketSnapshot | null> {
  const now = Date.now();
  const env = igMarketData.getActiveEnv();
  if (cache && cache.env === env && now - cache.fetchedAt < CACHE_TTL_MS) return cache;
  try {
    const symbolSnapshots: SymbolSnapshot[] = [];
    for (const epic of igMarketData.watchlist(env)) {
      const q = igMarketData.quote(epic, env);
      let interval = "1h";
      let bars = igMarketData.closed(epic, "1h", env);
      if (bars.length < 20) { interval = igMarketData.getSignalInterval(); bars = igMarketData.closed(epic, interval, env); }
      const price = q?.mid ?? bars[bars.length - 1]?.close;
      if (!price) continue;
      const klines = bars.slice(-60).map((k) => ({ high: k.high, low: k.low, close: k.close }));
      const ind = klines.length >= 15 ? computeIndicators(klines) : { rsi14: null, sma20: null, sma50: null, ema20: null, macd: null, atr14: null, obv: null };
      let trend = "neutral";
      if (ind.sma20 != null && ind.sma50 != null) {
        if (ind.sma20 > ind.sma50 * 1.005) trend = "bullish";
        else if (ind.sma20 < ind.sma50 * 0.995) trend = "bearish";
      }
      const high24 = q?.high ?? null, low24 = q?.low ?? null;
      const patternsRaw = klines.length >= 10 ? detectAllPatterns(bars.slice(-60).map((k, i) => ({ time: i, open: k.open, high: k.high, low: k.low, close: k.close }))) : [];
      symbolSnapshots.push({
        symbol: epic, name: igMarketData.nameOf(epic, env) ?? epic, interval, dataState: igMarketData.dataState(epic, env).state,
        price, changePct24h: q?.changePct ?? null, volume24h: null, high24h: high24, low24h: low24,
        rsi14: ind.rsi14, sma20: ind.sma20, sma50: ind.sma50, ema20: ind.ema20, macd: ind.macd, atr14: ind.atr14, obv: ind.obv,
        trend, nearResistance: high24 !== null && price > high24 * 0.995, nearSupport: low24 !== null && price < low24 * 1.005,
        patterns: patternsRaw.slice(0, 3),
      });
    }
    const bullCount = symbolSnapshots.filter((s) => s.trend === "bullish").length;
    const bearCount = symbolSnapshots.filter((s) => s.trend === "bearish").length;
    const ch = symbolSnapshots.map((s) => s.changePct24h).filter((x): x is number => x !== null);
    const avgChange = ch.length ? ch.reduce((a, x) => a + x, 0) / ch.length : null;
    const regime = avgChange === null ? "OKÄND" : avgChange > 1 ? "RISK-ON" : avgChange < -1 ? "RISK-OFF" : "NEUTRAL";
    const marketSummary = `Regim: ${regime} · Bull/Bear: ${bullCount}/${bearCount} av ${symbolSnapshots.length} · Snitt IG-dagsförändring: ${avgChange === null ? "saknas" : `${avgChange.toFixed(2)}%`}`;
    cache = { fetchedAt: now, env, symbols: symbolSnapshots, marketSummary };
    return cache;
  } catch (err) {
    log.error(`Market snapshot-fel: ${err instanceof Error ? err.message : String(err)}`);
    return cache && cache.env === env ? cache : null;
  }
}

// Format snapshot som markdown-text för att stoppa in i prompt
export function formatSnapshotForPrompt(snap: MarketSnapshot): string {
  const lines: string[] = [];
  lines.push(`# 📊 MARKNADSDATA — IG ${snap.env === "live" ? "Live" : "Demo"} (${new Date(snap.fetchedAt).toISOString().slice(11, 19)} UTC)`);
  lines.push(``);
  lines.push(`**${snap.marketSummary}**`);
  lines.push(``);
  lines.push(`| Instrument (EPIC) | Data | Pris | IG idag % | RSI | Trend | SMA20 | SMA50 | MACD-hist | Ljus | Note |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of snap.symbols) {
    const rsiStr = s.rsi14 != null ? s.rsi14.toFixed(0) : "–";
    const sma20 = s.sma20 != null ? s.sma20.toFixed(s.price > 1000 ? 0 : 2) : "–";
    const sma50 = s.sma50 != null ? s.sma50.toFixed(s.price > 1000 ? 0 : 2) : "–";
    const histVal = s.macd?.histogram;
    const hist = histVal != null ? (histVal > 0 ? "+" : "") + histVal.toFixed(2) : "–";
    const notes: string[] = [];
    if (s.nearResistance) notes.push("🔼 nära dagens high");
    if (s.nearSupport) notes.push("🔽 nära dagens low");
    if (s.rsi14 != null && s.rsi14 > 70) notes.push("överköpt");
    if (s.rsi14 != null && s.rsi14 < 30) notes.push("översålt");
    // Lägg till detekterade patterns som notes
    for (const p of s.patterns.slice(0, 2)) {
      const arrow = p.bullish === true ? "📈" : p.bullish === false ? "📉" : "⚠";
      notes.push(`${arrow} ${p.type.replace(/_/g, " ")} (${p.strength}/5)`);
    }
    const note = notes.join(", ") || "–";
    lines.push(`| ${s.name} (${s.symbol}) | ${s.dataState} | ${s.price.toFixed(s.price > 100 ? 2 : 5)} | ${s.changePct24h === null ? "–" : `${s.changePct24h >= 0 ? "+" : ""}${s.changePct24h.toFixed(2)}%`} | ${rsiStr} | ${s.trend} | ${sma20} | ${sma50} | ${hist} | ${s.interval} | ${note} |`);
  }
  // Lägg till en sektion med alla detekterade patterns
  const allPatterns = snap.symbols.flatMap((s) => s.patterns.map((p) => ({ symbol: s.symbol, ...p })));
  if (allPatterns.length > 0) {
    lines.push("");
    lines.push("## 🔍 Detekterade chart-mönster");
    for (const p of allPatterns.slice(0, 8)) {
      const dir = p.bullish === true ? "BULLISH" : p.bullish === false ? "BEARISH" : "NEUTRAL";
      lines.push(`- **${p.symbol}**: ${p.type.replace(/_/g, " ")} (${dir}, styrka ${p.strength}/5) — ${p.description}`);
    }
  }
  lines.push(``);
  lines.push(`*Källa: IG (kvoter + stängda ljus som servern redan har) · Cache 60s*`);
  return lines.join("\n");
}
