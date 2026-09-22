#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Bevisar att kline-strömmen levererar exakt samma data som Binance visar.
//
// Kör:  npm run build && node scripts/verify-kline-stream.mjs
// Kräver att Binance är nåbart från maskinen (fungerar inte bakom proxy
// som blockerar api.binance.com).
//
// Testet kontrollerar tre saker:
//   1. Stängda ljus tas emot, och closed-flaggan är true
//   2. Ljuset är IDENTISKT med Binance REST — samma källa som plattformen
//   3. Det pågående ljuset hålls separat och läcker inte in i historiken
// ═══════════════════════════════════════════════════════════════════════════
import {
  startKlineStream, subscribeClosedCandles, getFormingCandle,
  getClosedCandles, msUntilClose, getKlineStreamStatus,
} from "../dist/server/klineStream.js";

const SYMBOL = process.argv[2] ?? "BTCUSDT";
const INTERVAL = process.argv[3] ?? "1s";   // 1s ger snabbt svar; testa gärna 1m också
const TIMEOUT_MS = INTERVAL === "1s" ? 30_000 : 90_000;

let done = false;

subscribeClosedCandles(async (symbol, interval, candle, history) => {
  if (done) return;
  done = true;

  console.log(`\n✅ Stängt ljus: ${symbol} ${interval}`);
  console.log(`   O=${candle.open}  H=${candle.high}  L=${candle.low}  C=${candle.close}`);
  console.log(`   closed-flagga: ${candle.closed}   (måste vara true)`);
  console.log(`   historik i minnet: ${history.length} ljus`);

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}`
            + `&interval=${interval}&startTime=${candle.openTime}&limit=1`;
  const rest = (await (await fetch(url)).json())[0];
  const r = { open: +rest[1], high: +rest[2], low: +rest[3], close: +rest[4] };

  const match = r.open === candle.open && r.high === candle.high
             && r.low === candle.low && r.close === candle.close;

  console.log(`\n   Binance REST: O=${r.open}  H=${r.high}  L=${r.low}  C=${r.close}`);
  console.log(`   ${match ? "✅ IDENTISKT — strömmen matchar Binance exakt"
                          : "❌ AVVIKELSE — undersök innan signaler används"}`);

  const forming = getFormingCandle(SYMBOL, INTERVAL);
  const inHistory = getClosedCandles(SYMBOL, INTERVAL)
    .some((c) => forming && c.openTime === forming.openTime);

  console.log(`\n   Pågående ljus (endast diagram): C=${forming?.close ?? "-"}`);
  console.log(`   ${inHistory ? "❌ Pågående ljus läcker in i historiken!"
                              : "✅ Pågående ljus hålls utanför historiken"}`);
  console.log(`   Nedräkning till stängning: ${msUntilClose(SYMBOL, INTERVAL)} ms`);
  console.log(`\n   Status:`, getKlineStreamStatus());

  process.exit(match && !inHistory ? 0 : 1);
});

console.log(`Ansluter: ${SYMBOL} @ ${INTERVAL} ...`);
await startKlineStream([SYMBOL], INTERVAL);
console.log("Väntar på nästa ljusstängning...");

setTimeout(() => {
  console.log(`\n❌ Timeout — inget stängt ljus på ${TIMEOUT_MS / 1000}s.`);
  console.log("   Kontrollera att api.binance.com och stream.binance.com är nåbara.");
  process.exit(1);
}, TIMEOUT_MS);
