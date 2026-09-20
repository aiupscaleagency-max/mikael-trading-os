import type { DatabaseSync } from "node:sqlite";
import { openLearningDb } from "./db.js";
import type { NewSignalRow, SignalOutcomeUpdate } from "./schema.js";

// ═══════════════════════════════════════════════════════════════════════════
//  SIGNAL-JOURNALEN — enda stället med SQL mot signal_journal.
//
//  Håller SQLite-beroendet på ett ställe (tillsammans med db.ts), så ett byte
//  av databasmotor blir en tvåfilsändring.
//
//  STATISTIK-REGEL: krypto, forex och aktier blandas ALDRIG. Varje
//  aggregerande fråga här har GROUP BY asset_class. Lägg aldrig till en
//  hjälpfunktion som summerar utan den kolumnen.
// ═══════════════════════════════════════════════════════════════════════════

const INSERT_SQL = `
INSERT INTO signal_journal (
  id, ts, source, signal_version,
  asset_class, symbol, venue, timeframe, leverage, is_perp,
  direction, setup_type, entry, stop_loss, take_profit, horizon_bars,
  confidence, regime, features_snapshot, rationale,
  ensemble_status, model_a, model_a_verdict, model_a_rationale,
  model_b, model_b_provider, model_b_verdict, model_b_confidence,
  model_b_fallback_from, ensemble_approved, ensemble_ts,
  resolution_status
) VALUES (
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?,
  ?
)`;

export function insertSignal(db: DatabaseSync, row: NewSignalRow): string {
  db.prepare(INSERT_SQL).run(
    row.id, row.ts, row.source, row.signal_version,
    row.asset_class, row.symbol, row.venue, row.timeframe, row.leverage, row.is_perp,
    row.direction, row.setup_type, row.entry, row.stop_loss, row.take_profit, row.horizon_bars,
    row.confidence, row.regime, row.features_snapshot, row.rationale,
    row.ensemble_status, row.model_a, row.model_a_verdict, row.model_a_rationale,
    row.model_b, row.model_b_provider, row.model_b_verdict, row.model_b_confidence,
    row.model_b_fallback_from, row.ensemble_approved, row.ensemble_ts,
    row.resolution_status,
  );
  return row.id;
}

/** En öppen rad som avgörningsjobbet ska försöka avgöra. */
export interface OpenSignal {
  id: string;
  ts: number;
  asset_class: string;
  symbol: string;
  venue: string;
  timeframe: string;
  direction: "long" | "short";
  entry: number;
  stop_loss: number;
  take_profit: number;
  horizon_bars: number;
  leverage: number;
  is_perp: number;
  resolve_attempts: number;
}

/**
 * Hämtar avgörbara rader: öppna, med fullständiga nivåer, och tillräckligt
 * gamla för att horisonten rimligen ska ha hunnit passera.
 */
export function listOpenSignals(
  db: DatabaseSync,
  opts: { olderThanTs: number; limit?: number; assetClass?: string },
): OpenSignal[] {
  const params: unknown[] = [opts.olderThanTs];
  let sql = `
    SELECT id, ts, asset_class, symbol, venue, timeframe, direction, entry,
           stop_loss, take_profit, horizon_bars, leverage, is_perp, resolve_attempts
      FROM signal_journal
     WHERE resolution_status = 'open'
       AND entry IS NOT NULL AND stop_loss IS NOT NULL AND take_profit IS NOT NULL
       AND ts < ?`;
  if (opts.assetClass) {
    sql += ` AND asset_class = ?`;
    params.push(opts.assetClass);
  }
  sql += ` ORDER BY ts LIMIT ?`;
  params.push(opts.limit ?? 200);

  return db.prepare(sql).all(...params) as unknown as OpenSignal[];
}

export function updateOutcome(db: DatabaseSync, id: string, o: SignalOutcomeUpdate): void {
  db.prepare(`
    UPDATE signal_journal
       SET resolution_status = 'resolved',
           outcome = ?, exit_price = ?, ts_resolved = ?,
           r_multiple = ?, r_multiple_gross = ?, return_on_margin_pct = ?,
           mfe = ?, mae = ?, liquidation_price = ?,
           fees_usd = ?, slippage_usd = ?, funding_usd = ?,
           bars_to_resolution = ?, ambiguous_bar = ?, gap_filled = ?,
           resolver_version = ?, resolve_error = NULL
     WHERE id = ?`).run(
    o.outcome, o.exit_price, o.ts_resolved,
    o.r_multiple, o.r_multiple_gross, o.return_on_margin_pct,
    o.mfe, o.mae, o.liquidation_price,
    o.fees_usd, o.slippage_usd, o.funding_usd,
    o.bars_to_resolution, o.ambiguous_bar, o.gap_filled,
    o.resolver_version, id,
  );
}

/** Registrerar ett misslyckat avgörningsförsök utan att stänga raden. */
export function recordResolveFailure(db: DatabaseSync, id: string, error: string): void {
  db.prepare(
    `UPDATE signal_journal
        SET resolve_attempts = resolve_attempts + 1, resolve_error = ?
      WHERE id = ?`,
  ).run(error.slice(0, 500), id);
}

/** Ger upp en rad permanent (avlistad symbol, för många försök, saknade nivåer). */
export function markUnresolvable(db: DatabaseSync, id: string, error: string): void {
  db.prepare(
    `UPDATE signal_journal
        SET resolution_status = 'unresolvable', resolve_error = ?
      WHERE id = ?`,
  ).run(error.slice(0, 500), id);
}

export function getSignal(db: DatabaseSync, id: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM signal_journal WHERE id = ?").get(id);
}

export interface AssetClassSummary {
  asset_class: string;
  total: number;
  open: number;
  resolved: number;
  unresolvable: number;
  tp: number;
  sl: number;
  expired: number;
  liquidated: number;
  ambiguous: number;
  avg_r: number | null;
}

/**
 * Sammanfattning PER TILLGÅNGSKLASS. Det finns medvetet ingen variant som
 * slår ihop klasserna — krypto med 5x hävstång och aktier är inte jämförbara.
 *
 * Detta är rå räkning, inte Fas 3:s kalibrering (expectancy med
 * konfidensintervall, reliability-tabell, baslinjer). Den kommer senare.
 */
export function summarizeByAssetClass(db: DatabaseSync): AssetClassSummary[] {
  return db.prepare(`
    SELECT asset_class,
           COUNT(*)                                                     AS total,
           SUM(CASE WHEN resolution_status = 'open' THEN 1 ELSE 0 END)  AS open,
           SUM(CASE WHEN resolution_status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
           SUM(CASE WHEN resolution_status = 'unresolvable' THEN 1 ELSE 0 END) AS unresolvable,
           SUM(CASE WHEN outcome = 'TP' THEN 1 ELSE 0 END)              AS tp,
           SUM(CASE WHEN outcome = 'SL' THEN 1 ELSE 0 END)              AS sl,
           SUM(CASE WHEN outcome = 'utgången' THEN 1 ELSE 0 END)        AS expired,
           SUM(CASE WHEN outcome = 'likviderad' THEN 1 ELSE 0 END)      AS liquidated,
           SUM(ambiguous_bar)                                           AS ambiguous,
           AVG(r_multiple)                                              AS avg_r
      FROM signal_journal
     GROUP BY asset_class
     ORDER BY asset_class`).all() as unknown as AssetClassSummary[];
}

/** Bekvämlighet för script: öppnar standarddatabasen. */
export function journalDb(): DatabaseSync {
  return openLearningDb();
}
