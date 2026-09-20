// ═══════════════════════════════════════════════════════════════════════════
//  LÄRLOOPENS SCHEMA — signal_journal + lessons.
//
//  Fas 1 av lärloopen. Allt här är SHADOW-LÄGE: journalen observerar och
//  mäter, den handlar aldrig och påverkar aldrig ett orderbeslut.
//
//  OBS namnkrock: src/memory/lessons.ts innehåller `SaleLesson` (utfall per
//  stängd position, data/lessons.json). Det är ett ANNAT koncept än `lessons`
//  här, som är lärdomar skrivna av review-loopen i Fas 4. Därför ligger den
//  här koden under src/learning/ och typen heter JournalLesson.
// ═══════════════════════════════════════════════════════════════════════════

/** Marknadsregim, härledd från prisdata — aldrig från en modells åsikt. */
export type Regime = "trend_up" | "trend_down" | "range" | "high_vol" | "unknown";

export type AssetClass = "crypto" | "forex" | "aktie";
export type Direction = "long" | "short";
export type Outcome = "TP" | "SL" | "utgången" | "likviderad";
export type ResolutionStatus = "open" | "resolved" | "unresolvable";

/**
 * Hur ensemble-rösterna ser ut på raden.
 *  - voted        = båda modellerna röstade (kravet: BÅDA rösterna loggas alltid)
 *  - gate_skipped = grinden hoppades över (t.ex. exit-order, ENSEMBLE_GATE_EXITS=false)
 */
export type EnsembleStatus = "voted" | "gate_skipped";

/** Var raden kom ifrån. Fler källor kan tillkomma i senare faser. */
export type SignalSource = "head_trader_proposal";

/** Ensemble-fälten när båda modellerna faktiskt röstade. */
export interface EnsembleVoted {
  ensemble_status: "voted";
  model_a: string;
  model_a_verdict: string;
  model_a_rationale: string;
  model_b: string;
  model_b_provider: string;
  model_b_verdict: string;
  model_b_confidence: number;
  /** JSON-sträng när Claude-B ersatte GPT-6 Astra vid konto-/konfigfel, annars null. */
  model_b_fallback_from: string | null;
  ensemble_approved: 0 | 1;
  ensemble_ts: number;
}

/** Ensemble-fälten när grinden hoppades över — inga påhittade sentinelvärden. */
export interface EnsembleSkipped {
  ensemble_status: "gate_skipped";
  model_a: string;
  model_a_verdict: string;
  model_a_rationale: string;
  model_b: null;
  model_b_provider: null;
  model_b_verdict: null;
  model_b_confidence: null;
  model_b_fallback_from: null;
  ensemble_approved: null;
  ensemble_ts: number;
}

/**
 * Diskriminerad union: TypeScript tvingar fram båda rösterna när status är
 * "voted". DDL:en har nullbara kolumner, men skrivvägen kan inte smita undan.
 */
export type EnsembleFields = EnsembleVoted | EnsembleSkipped;

/** En rad som den skrivs vid signalens födelse (utfallsfälten fylls senare). */
export type NewSignalRow = {
  id: string;
  ts: number;
  source: SignalSource;
  signal_version: string;

  asset_class: AssetClass;
  symbol: string;
  venue: string;
  timeframe: string;
  leverage: number;
  is_perp: 0 | 1;

  direction: Direction;
  setup_type: string;
  entry: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  horizon_bars: number;
  confidence: number;
  regime: Regime;
  /** JSON-sträng. */
  features_snapshot: string;
  rationale: string;

  resolution_status: ResolutionStatus;
} & EnsembleFields;

/** Utfallet som avgörningsjobbet skriver tillbaka. */
export interface SignalOutcomeUpdate {
  outcome: Outcome;
  exit_price: number;
  ts_resolved: number;
  r_multiple: number;
  r_multiple_gross: number;
  return_on_margin_pct: number;
  mfe: number;
  mae: number;
  liquidation_price: number | null;
  fees_usd: number;
  slippage_usd: number;
  funding_usd: number;
  bars_to_resolution: number;
  ambiguous_bar: 0 | 1;
  gap_filled: 0 | 1;
  resolver_version: string;
}

/** Lärdom skriven av review-loopen (Fas 4). Tabellen skapas redan i Fas 1. */
export interface JournalLesson {
  id: string;
  ts: number;
  scope: string;
  lesson_text: string;
  /** JSON-array med signal-id:n. Minst 5 krävs i Fas 4. */
  supporting_signal_ids: string;
  confidence: number | null;
  active: 0 | 1;
}

// ── DDL ────────────────────────────────────────────────────────────────────
// Tider i epoch-ms (INTEGER), priser REAL. Enbart additiva satser — se db.ts.

export const DDL_SIGNAL_JOURNAL = `
CREATE TABLE IF NOT EXISTS signal_journal (
  -- Identitet
  id                    TEXT PRIMARY KEY,
  ts                    INTEGER NOT NULL,
  source                TEXT NOT NULL,
  signal_version        TEXT NOT NULL,

  -- Instrument
  asset_class           TEXT NOT NULL CHECK (asset_class IN ('crypto','forex','aktie')),
  symbol                TEXT NOT NULL,
  venue                 TEXT NOT NULL,
  timeframe             TEXT NOT NULL,
  leverage              REAL NOT NULL DEFAULT 1,
  is_perp               INTEGER NOT NULL DEFAULT 0,

  -- Setup
  direction             TEXT NOT NULL CHECK (direction IN ('long','short')),
  setup_type            TEXT NOT NULL,
  entry                 REAL,
  stop_loss             REAL,
  take_profit           REAL,
  horizon_bars          INTEGER NOT NULL,
  confidence            REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  regime                TEXT NOT NULL,
  features_snapshot     TEXT NOT NULL DEFAULT '{}',
  rationale             TEXT NOT NULL DEFAULT '',

  -- Ensemble (2-modell). Nullbara i DDL, men skrivvägens typ kräver båda
  -- rösterna när ensemble_status = 'voted'.
  ensemble_status       TEXT NOT NULL CHECK (ensemble_status IN ('voted','gate_skipped')),
  model_a               TEXT,
  model_a_verdict       TEXT,
  model_a_rationale     TEXT,
  model_b               TEXT,
  model_b_provider      TEXT,
  model_b_verdict       TEXT,
  model_b_confidence    REAL,
  model_b_fallback_from TEXT,
  ensemble_approved     INTEGER,
  ensemble_ts           INTEGER,

  -- Utfall
  resolution_status     TEXT NOT NULL DEFAULT 'open'
                          CHECK (resolution_status IN ('open','resolved','unresolvable')),
  outcome               TEXT CHECK (outcome IS NULL OR outcome IN ('TP','SL','utgången','likviderad')),
  exit_price            REAL,
  ts_resolved           INTEGER,
  r_multiple            REAL,
  r_multiple_gross      REAL,
  return_on_margin_pct  REAL,
  mfe                   REAL,
  mae                   REAL,
  liquidation_price     REAL,
  fees_usd              REAL,
  slippage_usd          REAL,
  funding_usd           REAL,
  bars_to_resolution    INTEGER,
  ambiguous_bar         INTEGER NOT NULL DEFAULT 0,
  gap_filled            INTEGER NOT NULL DEFAULT 0,
  resolver_version      TEXT,
  resolve_error         TEXT,
  resolve_attempts      INTEGER NOT NULL DEFAULT 0
)`;

export const DDL_LESSONS = `
CREATE TABLE IF NOT EXISTS lessons (
  id                    TEXT PRIMARY KEY,
  ts                    INTEGER NOT NULL,
  scope                 TEXT NOT NULL,
  lesson_text           TEXT NOT NULL,
  supporting_signal_ids TEXT NOT NULL DEFAULT '[]',
  confidence            REAL,
  active                INTEGER NOT NULL DEFAULT 1
)`;

export const DDL_INDEXES = [
  // Avgörningsjobbets arbetskö
  `CREATE INDEX IF NOT EXISTS idx_journal_open ON signal_journal (resolution_status, ts)`,
  // Statistik per tillgångsklass — blandas aldrig
  `CREATE INDEX IF NOT EXISTS idx_journal_class ON signal_journal (asset_class, resolution_status)`,
  // Fas 2: retrieval av liknande tidigare signaler
  `CREATE INDEX IF NOT EXISTS idx_journal_setup ON signal_journal (setup_type, regime, timeframe)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_symbol ON signal_journal (symbol, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_lessons_active ON lessons (active, scope)`,
];
