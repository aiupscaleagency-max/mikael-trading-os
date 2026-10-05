#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Samlar stängda ljus från Binance och skriver dem till fil.
//
// Kör:  npm run build
//       node scripts/export-candles.mjs BTCUSDT,ETHUSDT 1m ./data 60
//
// Argument: symboler, intervall, utkatalog, sekunder att samla.
// Kräver att Binance är nåbart från maskinen.
//
// Filerna kan sedan läsas av neural-trader, pandas, backtrader eller vilken
// backtester som helst — OHLCV-kolumner är standard.
// ═══════════════════════════════════════════════════════════════════════════
import { startKlineStream, stopKlineStream, getKlineStreamStatus } from "../dist/server/klineStream.js";
import { exportAll } from "../dist/server/candleExport.js";

const symbols  = (process.argv[2] ?? "BTCUSDT").split(",").map(s => s.trim().toUpperCase());
const interval = process.argv[3] ?? "1m";
const outDir   = process.argv[4] ?? "./data";
const collectS = Number(process.argv[5] ?? 60);

console.log(`Ansluter: ${symbols.join(", ")} @ ${interval}`);
await startKlineStream(symbols, interval);
console.log(`Historik laddad. Samlar i ${collectS}s för att fånga live-stängningar...`);

await new Promise(r => setTimeout(r, collectS * 1000));

console.log("Status:", getKlineStreamStatus());
const results = await exportAll(symbols, interval, outDir, "csv");

console.log(`\n✅ ${results.length} fil(er) skrivna:`);
for (const r of results) {
  console.log(`   ${r.filePath}  —  ${r.candles} ljus  (${r.from} → ${r.to})`);
}
stopKlineStream();
process.exit(results.length ? 0 : 1);
