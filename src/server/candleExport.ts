import fs from "node:fs/promises";
import path from "node:path";
import { getClosedCandles, type Candle } from "./klineStream.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Candle-export — stängda ljus ut i standardformat
//
// VARFÖR STANDARDFORMAT och inte ett direkt API-anrop mot en backtester:
// Backtest-bibliotek byter signaturer, deprekerar funktioner och försvinner.
// OHLCV-kolumnerna har sett likadana ut i decennier. Exporteras ljusen som
// CSV eller JSON fungerar de med neural-trader, pandas, backtrader,
// TradingView-import och TradingAgents — utan att någon kod här behöver
// känna till något av dem.
//
// Endast STÄNGDA ljus exporteras. Ett ohalvfärdigt ljus i en backtest ger
// resultat som inte går att upprepa, eftersom värdena ändrades medan filen
// skrevs.
// ═══════════════════════════════════════════════════════════════════════════

export interface ExportResult {
  filePath: string;
  candles: number;
  from: string;
  to: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * CSV med kolumnrubriker. Det format de flesta backtesters läser direkt.
 * Tidsstämplar skrivs både som millisekunder och ISO — ms för maskinen,
 * ISO för att kunna läsa filen med ögat.
 */
function toCsv(candles: Candle[]): string {
  const head = "open_time_ms,open_time_iso,open,high,low,close,volume,quote_volume,trades";
  const rows = candles.map((c) =>
    [c.openTime, iso(c.openTime), c.open, c.high, c.low, c.close, c.volume, c.quoteVolume, c.trades].join(","),
  );
  return [head, ...rows].join("\n") + "\n";
}

/**
 * Exporterar de stängda ljusen för en symbol.
 *
 * `format` styr filändelse och innehåll. JSON behåller fälten namngivna,
 * CSV är kompaktare och tas emot av fler verktyg.
 */
export async function exportCandles(
  symbol: string,
  interval: string,
  outDir: string,
  format: "csv" | "json" = "csv",
): Promise<ExportResult | null> {
  const candles = getClosedCandles(symbol, interval);
  if (!candles.length) {
    log.warn(`[candle-export] inga stängda ljus för ${symbol} ${interval} — har strömmen hunnit fylla på?`);
    return null;
  }

  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `${symbol}_${interval}.${format}`);

  const body = format === "csv"
    ? toCsv(candles)
    : JSON.stringify({ symbol, interval, source: "binance-websocket", closedOnly: true, candles }, null, 2);

  await fs.writeFile(filePath, body, "utf8");

  const result: ExportResult = {
    filePath,
    candles: candles.length,
    from: iso(candles[0]!.openTime),
    to: iso(candles[candles.length - 1]!.closeTime),
  };
  log.info(`[candle-export] ${symbol} ${interval}: ${result.candles} ljus → ${filePath}`);
  return result;
}

/** Exporterar flera symboler. Misslyckade hoppas över, inte hela körningen. */
export async function exportAll(
  symbols: string[],
  interval: string,
  outDir: string,
  format: "csv" | "json" = "csv",
): Promise<ExportResult[]> {
  const out: ExportResult[] = [];
  for (const s of symbols) {
    const r = await exportCandles(s, interval, outDir, format).catch((err) => {
      log.warn(`[candle-export] ${s} misslyckades: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (r) out.push(r);
  }
  return out;
}
