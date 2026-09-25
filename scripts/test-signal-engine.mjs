import { buildSignal } from "../dist/server/signalEngine.js";
// Kör: npm run build && node scripts/test-signal-engine.mjs
// Testar signal-motorn mot genererade ljus — kräver ingen nätverksåtkomst.

// Bygger syntetiska ljus med en given lutning + brus.
function candles(n, start, driftPct, noisePct = 0.15) {
  const out = []; let price = start; let t = Date.now() - n * 60000;
  for (let i = 0; i < n; i++) {
    const open = price;
    price = price * (1 + driftPct / 100) * (1 + (Math.sin(i * 1.7) * noisePct) / 100);
    const high = Math.max(open, price) * 1.0015;
    const low  = Math.min(open, price) * 0.9985;
    out.push({ openTime: t, closeTime: t + 59999, open, high, low, close: price,
               volume: 100 + (i % 20), quoteVolume: 0, trades: 50, closed: true });
    t += 60000;
  }
  return out;
}

function show(label, sig) {
  if (!sig) { console.log(`${label}\n   → FÖRKASTAD (ingen stop möjlig, eller R:R för lågt)\n`); return; }
  const dirOk = sig.direction === "LONG"  ? sig.stopLoss < sig.entry && sig.target > sig.entry
              : sig.direction === "SHORT" ? sig.stopLoss > sig.entry && sig.target < sig.entry
              : true;
  console.log(`${label}`);
  console.log(`   riktning : ${sig.direction}  (score ${sig.score > 0 ? "+" : ""}${sig.score})`);
  console.log(`   entry    : ${sig.entry.toFixed(2)}`);
  console.log(`   stop     : ${sig.stopLoss.toFixed(2)}   ${dirOk ? "✅ på rätt sida" : "❌ FEL SIDA"}`);
  console.log(`   target   : ${sig.target.toFixed(2)}`);
  console.log(`   R:R      : ${sig.riskReward.toFixed(2)}   risk ${sig.riskPct.toFixed(2)}%`);
  console.log(`   skäl     : ${sig.reasons.length} st`);
  sig.reasons.forEach(r => console.log(`              · ${r}`));
  console.log();
  if (!dirOk) process.exitCode = 1;
}

console.log("══ Signal-motorn mot genererade ljus ══\n");
show("📈 Stark uppgång (+0.35%/ljus, 120 ljus)",  buildSignal("TEST-UPP",  "1m", candles(120, 50000,  0.35)));
show("📉 Stark nedgång (−0.35%/ljus, 120 ljus)",  buildSignal("TEST-NER",  "1m", candles(120, 50000, -0.35)));
show("➡️  Sidledes (0%/ljus, 120 ljus)",           buildSignal("TEST-FLAT", "1m", candles(120, 50000,  0.0)));
console.log("── Spärr: för lite historik (40 ljus, kräver 50) ──");
console.log(buildSignal("TEST-KORT", "1m", candles(40, 50000, 0.35)) === null
  ? "   ✅ returnerar null, som den ska\n" : "   ❌ borde ha returnerat null\n");
