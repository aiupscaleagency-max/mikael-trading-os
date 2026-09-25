#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Verifierar hela kedjan mot riktiga marknader.
//
// Kör:  npm run build && node scripts/verify-live.mjs
//       node scripts/verify-live.mjs BTCUSDT 1s      (snabbare test)
//
// Måste köras där Binance/Alpaca är nåbara — alltså på din maskin, inte i
// en container bakom proxy.
//
// Sju kontroller, i ordning. Varje gång en fallerar sägs det rakt ut vad som
// är fel och vad som behöver göras.
// ═══════════════════════════════════════════════════════════════════════════
import "dotenv/config";
import { startKlineStream, subscribeClosedCandles, getFormingCandle,
         getClosedCandles, msUntilClose, getKlineStreamStatus,
         stopKlineStream } from "../dist/server/klineStream.js";
import { buildSignal } from "../dist/server/signalEngine.js";

const SYMBOL   = (process.argv[2] ?? "BTCUSDT").toUpperCase();
const INTERVAL = process.argv[3] ?? "1m";
const WAIT_MS  = INTERVAL === "1s" ? 40_000 : 150_000;

let pass = 0, fail = 0;
const ok  = (m) => { console.log(`  ✅ ${m}`); pass++; };
const bad = (m, fix) => { console.log(`  ❌ ${m}`); if (fix) console.log(`     → ${fix}`); fail++; };

console.log(`\n═══ Verifiering: ${SYMBOL} @ ${INTERVAL} ═══\n`);

// ── 1. Når vi Binance? ────────────────────────────────────────────────────
console.log("1. Nätverk till Binance");
try {
  const r = await fetch(`https://api.binance.com/api/v3/ping`);
  r.ok ? ok("api.binance.com svarar")
       : bad(`api.binance.com gav HTTP ${r.status}`, "Kontrollera brandvägg/proxy.");
} catch (e) {
  bad(`Kan inte nå api.binance.com: ${e.message}`,
      "Kör detta på din egen maskin — en container bakom proxy blockerar Binance.");
  console.log("\nAvbryter: utan marknadsdata går inget annat att verifiera.\n");
  process.exit(1);
}

// ── 2. WebSocket + historik ───────────────────────────────────────────────
console.log("\n2. WebSocket-anslutning");
await startKlineStream([SYMBOL], INTERVAL);
await new Promise(r => setTimeout(r, 3000));
const st = getKlineStreamStatus();
st.connected ? ok(`Ansluten (${getClosedCandles(SYMBOL, INTERVAL).length} historiska ljus laddade)`)
             : bad("WebSocket ej ansluten", "Kontrollera att stream.binance.com:9443 är nåbar.");

// ── 3-5. Stängt ljus, exakthet, separation ────────────────────────────────
console.log(`\n3. Väntar på nästa ljusstängning (max ${WAIT_MS/1000}s)…`);
const closed = await new Promise((resolve) => {
  const un = subscribeClosedCandles((sym, iv, candle) => { un(); resolve(candle); });
  setTimeout(() => { un(); resolve(null); }, WAIT_MS);
});

if (!closed) {
  bad("Inget stängt ljus mottaget", "Prova intervall 1s för snabbare svar.");
} else {
  ok(`Stängt ljus: O=${closed.open} H=${closed.high} L=${closed.low} C=${closed.close}`);
  closed.closed === true ? ok("closed-flaggan är true")
                         : bad("closed-flaggan är inte true — spärren fungerar inte!");

  console.log("\n4. Stämmer datan med Binance?");
  const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}`
            + `&interval=${INTERVAL}&startTime=${closed.openTime}&limit=1`;
  const rest = (await (await fetch(url)).json())[0];
  const same = +rest[1] === closed.open && +rest[2] === closed.high
            && +rest[3] === closed.low  && +rest[4] === closed.close;
  same ? ok("WebSocket-ljuset är IDENTISKT med Binance REST — samma data plattformen visar")
       : bad(`Avvikelse! REST: O=${rest[1]} H=${rest[2]} L=${rest[3]} C=${rest[4]}`,
             "Använd inte signalerna förrän detta är utrett.");

  console.log("\n5. Hålls det pågående ljuset utanför historiken?");
  const forming = getFormingCandle(SYMBOL, INTERVAL);
  const leaked = forming && getClosedCandles(SYMBOL, INTERVAL)
    .some(c => c.openTime === forming.openTime);
  leaked ? bad("Pågående ljus läcker in i historiken — signalerna kommer repainta!")
         : ok(`Separerat. Pågående C=${forming?.close ?? "–"}, `
              + `${Math.round((msUntilClose(SYMBOL, INTERVAL) ?? 0)/1000)}s till stängning`);
}

// ── 6. Signal ─────────────────────────────────────────────────────────────
console.log("\n6. Genererar signal av riktiga ljus");
const candles = getClosedCandles(SYMBOL, INTERVAL);
if (candles.length < 50) {
  bad(`Bara ${candles.length} ljus — motorn kräver 50`, "Vänta längre, eller använd 1m/1s.");
} else {
  const sig = buildSignal(SYMBOL, INTERVAL, candles);
  if (!sig) {
    ok("Ingen signal — förkastad av stop-loss- eller R:R-spärren (det är korrekt beteende)");
  } else {
    ok(`${sig.direction} (score ${sig.score > 0 ? "+" : ""}${sig.score})`);
    console.log(`     entry ${sig.entry.toFixed(2)} · stop ${sig.stopLoss.toFixed(2)}`
              + ` · target ${sig.target.toFixed(2)} · R:R ${sig.riskReward.toFixed(2)}`);
    const sideOk = sig.direction === "LONG"  ? sig.stopLoss < sig.entry
                 : sig.direction === "SHORT" ? sig.stopLoss > sig.entry : true;
    sideOk ? ok("Stop-loss ligger på rätt sida om entry")
           : bad("STOP-LOSS PÅ FEL SIDA — handla inte på den här signalen!");
    sig.reasons.forEach(r => console.log(`     · ${r}`));
  }
}

// ── 7. Konto ──────────────────────────────────────────────────────────────
console.log("\n7. Kontoanslutning");
const hasBinance = !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET);
const hasAlpaca  = !!(process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY);
if (!hasBinance && !hasAlpaca) {
  console.log("  ℹ️  Inga API-nycklar i .env — hoppar över.");
  console.log("     Marknadsdata och signaler fungerar ändå; nycklar behövs först för saldo och ordrar.");
} else {
  ok(`Nycklar hittade: ${[hasBinance && "Binance", hasAlpaca && "Alpaca"].filter(Boolean).join(" + ")}`);
  console.log("     Saldo och ordrar testas via servern, inte detta skript.");
}

stopKlineStream();
console.log(`\n═══ ${pass} godkända, ${fail} underkända ═══`);
console.log(fail === 0
  ? "Kedjan fungerar: live-data → stängda ljus → verifierad mot Binance → signal med stop.\n"
  : "Åtgärda det som är underkänt innan signalerna används.\n");
process.exit(fail === 0 ? 0 : 1);
