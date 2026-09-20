import { config } from "../config.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { BinanceBroker } from "../brokers/binance.js";
import { runResolveJob } from "../learning/resolveJob.js";
import { openLearningDb } from "../learning/db.js";
import { summarizeByAssetClass } from "../learning/signalJournal.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Manuell körning av lärloopens avgörningsjobb + sammanfattning.
//
//  Kör:  npm run journal:resolve
//
//  Behövs eftersom --once/--propose hoppar över schedulern. Jobbet läser bara
//  publik marknadsdata och skriver till data/learning.db — inga order, inga
//  Claude-anrop, ingen kostnad.
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const brokers: Record<string, BrokerAdapter> = {};
  if (config.binance.enabled) {
    brokers.binance = new BinanceBroker({
      apiKey: config.binance.apiKey,
      apiSecret: config.binance.apiSecret,
      baseUrl: config.binance.baseUrl,
      mode: config.mode,
    });
  }

  if (Object.keys(brokers).length === 0) {
    log.warn("Ingen broker med candle-stöd konfigurerad — kör bara sammanfattningen.");
  } else {
    const res = await runResolveJob({ config, brokers });
    log.info(
      `Avgörning klar: ${res.resolved} avgjorda, ${res.stillOpen} fortfarande öppna, ` +
      `${res.unresolvable} ej avgörbara, ${res.failed} misslyckade (av ${res.examined} granskade).`,
    );
  }

  // Statistiken hålls ALLTID isär per tillgångsklass — krypto med 5x hävstång
  // och aktier är inte jämförbara storheter.
  const rows = summarizeByAssetClass(openLearningDb());
  if (rows.length === 0) {
    log.info("Journalen är tom. Kör `npm run propose` för att skapa signaler.");
    return;
  }

  log.info("─".repeat(78));
  log.info("SIGNAL-JOURNAL — per tillgångsklass (aldrig sammanslaget)");
  log.info("─".repeat(78));
  for (const r of rows) {
    log.info(
      `${r.asset_class.padEnd(7)} totalt=${r.total} | öppna=${r.open} avgjorda=${r.resolved} ` +
      `ej avgörbara=${r.unresolvable}`,
    );
    log.info(
      `        TP=${r.tp} SL=${r.sl} utgångna=${r.expired} likviderade=${r.liquidated} ` +
      `| tvetydiga barer=${r.ambiguous} | snitt-R=${r.avg_r === null ? "–" : r.avg_r.toFixed(3)}`,
    );
  }
  log.info("─".repeat(78));
  log.info(
    "OBS: detta är rå räkning, inte kalibrerad statistik. Expectancy med " +
    "konfidensintervall, reliability-tabell och baslinjer kommer i Fas 3.",
  );
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
