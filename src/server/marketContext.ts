import { computeIndicators } from "../indicators/ta.js";
import { log } from "../logger.js";
import { detectAllPatterns, type DetectedPattern } from "./patternDetection.js";

// ═══════════════════════════════════════════════════════════════════════════
// Market Context — ger agenterna ÖGONEN på marknaden
//
// Hämtar live-priser från Binance public API + räknar tekniska indikatorer
// (RSI, SMA, EMA, MACD, ATR) lokalt. Resultatet injiceras i prompten
// innan agenter (Hanna, Tomas, Karin, Viktor) anropas.
//
// Cache: 60s TTL för att inte spam:a Binance
// ═══════════════════════════════════════════════════════════════════════════

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "MATICUSDT"];
const CACHE_TTL_MS = 60_000;

interface MarketSnapshot {
  fetchedAt: number;
  symbols: SymbolSnapshot[];
  marketSummary: string;
}

interface SymbolSnapshot {
  symbol: string;
  price: number;
  changePct24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  rsi14: number | null;
  sma20: number | null;
  sma50: number | null;
  ema20: number | null;
  macd: { macd: number | null; signal: number | null; histogram: number | null };
  atr14: number | null;
  trend: string; // "bullish" | "bearish" | "neutral"
  nearResistance: boolean;
  nearSupport: boolean;
  patterns: DetectedPattern[];
  obv: number | null;
}

let cache: MarketSnapshot | null = null;

export async function getMarketSnapshot(): Promise<MarketSnapshot | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }
  try {
    // Hämta 24h ticker (pris, volym, change)
    const tickerRes = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    if (!tickerRes.ok) throw new Error(`Binance ticker svar ${tickerRes.status}`);
    const allTickers = (await tickerRes.json()) as Array<{
      symbol: string;
      lastPrice: string;
      priceChangePercent: string;
      volume: string;
      quoteVolume: string;
      highPrice: string;
      lowPrice: string;
    }>;

    const symbolSnapshots: SymbolSnapshot[] = [];

    // För varje symbol: hämta 1h candles för indikatorer
    for (const sym of SYMBOLS) {
      const ticker = allTickers.find((t) => t.symbol === sym);
      if (!ticker) continue;

      try {
        // 50 senaste 1h candles räcker för RSI(14), SMA(20), MACD osv
        const klineRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=50`);
        if (!klineRes.ok) continue;
        const raw = (await klineRes.json()) as Array<Array<string | number>>;
        const klines = raw.map((k) => ({
          high: parseFloat(k[2] as string),
          low: parseFloat(k[3] as string),
          close: parseFloat(k[4] as string),
        }));
        const ind = computeIndicators(klines);
        const price = parseFloat(ticker.lastPrice);

        // Trend-detection enkel: SMA20 vs SMA50
        let trend = "neutral";
        if (ind.sma20 != null && ind.sma50 != null) {
          if (ind.sma20 > ind.sma50 * 1.005) trend = "bullish";
          else if (ind.sma20 < ind.sma50 * 0.995) trend = "bearish";
        }

        // S/R-närhet: jämför med 24h high/low
        const high24 = parseFloat(ticker.highPrice);
        const low24 = parseFloat(ticker.lowPrice);
        const nearResistance = price > high24 * 0.995;
        const nearSupport = price < low24 * 1.005;
        // Detektera alla mönster (candlestick + reversal + continuation)
        const patternsRaw = detectAllPatterns(klines.map((k, i) => ({
          time: i,
          open: 0, // ej tillgänglig från ind-input, men candlestick-detection behöver det
          high: k.high,
          low: k.low,
          close: k.close,
        })));

        symbolSnapshots.push({
          symbol: sym,
          price,
          changePct24h: parseFloat(ticker.priceChangePercent),
          volume24h: parseFloat(ticker.quoteVolume),
          high24h: high24,
          low24h: low24,
          rsi14: ind.rsi14,
          sma20: ind.sma20,
          sma50: ind.sma50,
          ema20: ind.ema20,
          macd: ind.macd,
          atr14: ind.atr14,
          obv: ind.obv,
          trend,
          nearResistance,
          nearSupport,
          patterns: patternsRaw.slice(0, 3), // top 3 senaste patterns
        });
      } catch (err) {
        log.warn(`Klines-fel för ${sym}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Bygg marknads-sammanfattning
    const totalVolume = symbolSnapshots.reduce((s, x) => s + x.volume24h, 0);
    const bullCount = symbolSnapshots.filter((s) => s.trend === "bullish").length;
    const bearCount = symbolSnapshots.filter((s) => s.trend === "bearish").length;
    const avgChange = symbolSnapshots.reduce((s, x) => s + x.changePct24h, 0) / Math.max(1, symbolSnapshots.length);
    const regime = avgChange > 1 ? "RISK-ON" : avgChange < -1 ? "RISK-OFF" : "NEUTRAL";
    const marketSummary = `Regim: ${regime} · Bull/Bear: ${bullCount}/${bearCount} av ${symbolSnapshots.length} · Snitt 24h: ${avgChange.toFixed(2)}% · Total volym: $${(totalVolume / 1e9).toFixed(1)}B`;

    cache = {
      fetchedAt: now,
      symbols: symbolSnapshots,
      marketSummary,
    };
    return cache;
  } catch (err) {
    log.error(`Market snapshot-fel: ${err instanceof Error ? err.message : String(err)}`);
    return cache; // returnera gammal cache om fail
  }
}

// Format snapshot som markdown-text för att stoppa in i prompt
export function formatSnapshotForPrompt(snap: MarketSnapshot): string {
  const lines: string[] = [];
  lines.push(`# 📊 LIVE MARKNADSDATA — Binance (${new Date(snap.fetchedAt).toISOString().slice(11, 19)} UTC)`);
  lines.push(``);
  lines.push(`**${snap.marketSummary}**`);
  lines.push(``);
  lines.push(`| Symbol | Pris | 24h % | RSI | Trend | SMA20 | SMA50 | MACD-hist | Note |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const s of snap.symbols) {
    const rsiStr = s.rsi14 != null ? s.rsi14.toFixed(0) : "–";
    const sma20 = s.sma20 != null ? s.sma20.toFixed(s.price > 1000 ? 0 : 2) : "–";
    const sma50 = s.sma50 != null ? s.sma50.toFixed(s.price > 1000 ? 0 : 2) : "–";
    const hist = s.macd.histogram != null ? (s.macd.histogram > 0 ? "+" : "") + s.macd.histogram.toFixed(2) : "–";
    const notes: string[] = [];
    if (s.nearResistance) notes.push("🔼 nära 24h-high");
    if (s.nearSupport) notes.push("🔽 nära 24h-low");
    if (s.rsi14 != null && s.rsi14 > 70) notes.push("överköpt");
    if (s.rsi14 != null && s.rsi14 < 30) notes.push("översålt");
    // Lägg till detekterade patterns som notes
    for (const p of s.patterns.slice(0, 2)) {
      const arrow = p.bullish === true ? "📈" : p.bullish === false ? "📉" : "⚠";
      notes.push(`${arrow} ${p.type.replace(/_/g, " ")} (${p.strength}/5)`);
    }
    const note = notes.join(", ") || "–";
    lines.push(`| ${s.symbol} | $${s.price.toFixed(s.price > 100 ? 2 : 4)} | ${s.changePct24h >= 0 ? "+" : ""}${s.changePct24h.toFixed(2)}% | ${rsiStr} | ${s.trend} | $${sma20} | $${sma50} | ${hist} | ${note} |`);
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
  lines.push(`*Källa: Binance public API · Cache 60s*`);
  return lines.join("\n");
}
