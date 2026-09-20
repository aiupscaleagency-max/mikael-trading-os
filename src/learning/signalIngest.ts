import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import type { TechnicalReport } from "../orchestrator/types.js";
import type { EnsembleVerdict } from "../orchestrator/secondOpinion.js";
import { openLearningDb } from "./db.js";
import { insertSignal } from "./signalJournal.js";
import { deriveRegime, REGIME_VERSION } from "./regime.js";
import { isGeometryValid } from "./resolve.js";
import type { AssetClass, EnsembleFields, NewSignalRow } from "./schema.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  SIGNAL-INGEST — skriver en journalrad när en trade FÖRESLÅS.
//
//  En "signal" är här ett riktat orderförslag med entry/SL/TP, journalfört
//  vid place_order tillsammans med BÅDA ensemble-rösterna. Rena HOLD
//  journalförs inte.
//
//  Varför just den punkten: det är det enda stället där både förslaget och
//  granskarens röst finns samtidigt. En nedröstad trade får därför också en
//  rad — och avgörs ändå mot prisdata. Raderna med ensemble_approved=0 är de
//  mest värdefulla i hela tabellen: de svarar på om grinden räddade eller
//  kostade pengar.
//
//  SHADOW-LÄGE: ingenting här rör order, nycklar eller risk. Anroparen ska
//  alltid .catch():a — ett journalfel får aldrig påverka ett orderbeslut.
// ═══════════════════════════════════════════════════════════════════════════

export const SIGNAL_VERSION = `proposal-v1+${REGIME_VERSION}`;

/** Timeframe som den tekniska analysen faktiskt körs på (specialists.ts). */
export const TA_TIMEFRAME = "4h";
/** Antal candles som hämtas för att härleda regimen. */
const REGIME_KLINE_LIMIT = 100;

/**
 * Klassificerar instrumentet. Krypto-quote-valutor först, sedan forex-mönstret
 * (OANDA använder EUR_USD), annars aktie.
 */
export function classifyAssetClass(symbol: string, forexSymbols: string[] = []): AssetClass {
  const s = symbol.toUpperCase();
  if (/(USDT|USDC|BUSD|FDUSD)$/.test(s)) return "crypto";
  if (/^[A-Z]{3}_[A-Z]{3}$/.test(s) || forexSymbols.includes(s)) return "forex";
  return "aktie";
}

/** Grov setup-etikett ur teknikerns nyckelsignaler. Styr Fas 2:s retrieval. */
export function deriveSetupType(keySignals: string[] | undefined): string {
  const text = (keySignals ?? []).join(" ").toLowerCase();
  if (!text) return "head_trader_discretionary";
  if (text.includes("macd")) return "macd_cross";
  if (text.includes("breakout") || text.includes("utbrott")) return "breakout";
  if (text.includes("oversold") || text.includes("översåld")) return "rsi_oversold";
  if (text.includes("overbought") || text.includes("överköpt")) return "rsi_overbought";
  if (text.includes("ema") || text.includes("sma") || text.includes("ma-kors")) return "ma_cross";
  if (text.includes("support")) return "support_bounce";
  return "ta_score";
}

/**
 * Översätter granskarens verdict-confidence till signalens confidence (0–1).
 *
 * Viktig nyans: model_b_confidence är hur säker granskaren är på SITT UTLÅTANDE,
 * inte på att traden går bra. Ett "disagree" med 0,8 betyder 80 % säker på att
 * traden är dålig → signalens confidence blir 0,2. Utan den inversionen blir
 * Fas 3:s kalibrering direkt felvänd.
 */
export function proposalConfidence(verdict: EnsembleVerdict): number {
  if (verdict.skipped) return 0.5; // grinden kördes inte — ingen åsikt att gå på
  const c = verdict.modelB.confidence;
  const raw = verdict.modelB.verdict === "agree" ? c : 1 - c;
  return Math.min(1, Math.max(0, raw));
}

/** Bygger ensemble-kolumnerna. Typen tvingar fram båda rösterna vid "voted". */
function buildEnsembleFields(verdict: EnsembleVerdict, now: number): EnsembleFields {
  const base = {
    model_a: verdict.modelA.model,
    model_a_verdict: verdict.modelA.verdict,
    model_a_rationale: verdict.modelA.reasoning,
    ensemble_ts: now,
  };
  if (verdict.skipped) {
    return {
      ...base,
      ensemble_status: "gate_skipped",
      model_b: null, model_b_provider: null, model_b_verdict: null,
      model_b_confidence: null, model_b_fallback_from: null, ensemble_approved: null,
    };
  }
  return {
    ...base,
    ensemble_status: "voted",
    model_b: verdict.modelB.model,
    model_b_provider: verdict.modelB.provider,
    model_b_verdict: verdict.modelB.verdict,
    model_b_confidence: verdict.modelB.confidence,
    // Satt när Claude-B ersatte GPT-6 Astra vid konto-/konfigfel. Fas 3 måste
    // räkna bort dessa rader ur provider-jämförelsen — Astra röstade inte.
    model_b_fallback_from: verdict.modelB.fallbackFrom
      ? JSON.stringify(verdict.modelB.fallbackFrom)
      : null,
    ensemble_approved: verdict.approved ? 1 : 0,
  };
}

export interface JournalProposalParams {
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  /** MARKET → senaste pris, LIMIT → limitpriset. */
  entryPrice: number;
  /** Från verktygets valfria parametrar. Journal-fält — inga stop-ordrar läggs. */
  stopLoss?: number;
  takeProfit?: number;
  reasoning: string;
  verdict: EnsembleVerdict;
  config: Config;
  broker: BrokerAdapter;
  /** Teknikerns analyser, för nivå-fallback och setup_type. */
  technical?: TechnicalReport["analyses"];
  db?: DatabaseSync;
  now?: number;
}

/**
 * Skriver en journalrad för ett orderförslag.
 * @returns radens id, eller null om lärloopen är avstängd.
 */
export async function journalProposal(params: JournalProposalParams): Promise<string | null> {
  const { symbol, side, config, verdict } = params;
  if (!config.learning.enabled) return null;

  const now = params.now ?? Date.now();
  const db = params.db ?? openLearningDb();
  const direction = side === "BUY" ? "long" : "short";
  const assetClass = classifyAssetClass(symbol, config.oanda.symbols as unknown as string[]);
  const ta = params.technical?.find((a) => a.symbol === symbol);

  // ── Nivåer: verktygets parametrar först, teknikerns zoner som fallback ──
  const entry = params.entryPrice;
  let stopLoss = params.stopLoss ?? ta?.entryZone?.stopLoss ?? null;
  let takeProfit = params.takeProfit ?? ta?.targetZone?.tp1 ?? null;

  // SELL är EXIT i detta spot-system, inte en short. En exit har ingen
  // TP/SL-geometri att mäta — vi bevarar rösten men håller den utanför
  // TP/SL-statistiken.
  const isExit = side === "SELL";
  let setupType = isExit ? "exit" : deriveSetupType(ta?.keySignals);
  let resolutionStatus: NewSignalRow["resolution_status"] = "open";
  const rejectionNotes: string[] = [];

  if (isExit) {
    resolutionStatus = "unresolvable";
    rejectionNotes.push("Exit-order: ingen TP/SL-geometri att avgöra.");
    stopLoss = null;
    takeProfit = null;
  } else if (stopLoss === null || takeProfit === null) {
    resolutionStatus = "unresolvable";
    rejectionNotes.push("Saknar stop loss och/eller take profit — ingen R-multipel möjlig.");
  } else if (!isGeometryValid(direction, entry, stopLoss, takeProfit)) {
    // Nivåerna kommer i slutänden från en språkmodell och är inte garanterat
    // sunda. Hellre en rad markerad som ej avgörbar än förgiftad statistik.
    resolutionStatus = "unresolvable";
    rejectionNotes.push(
      `Orimlig geometri (entry ${entry}, SL ${stopLoss}, TP ${takeProfit}) för ${direction}.`,
    );
    setupType = `${setupType}_ogiltig_geometri`;
  }

  // ── Regim: härledd ur prisdata, aldrig ur en modells åsikt ──
  let regimeResult;
  try {
    const klines = await params.broker.getKlines(symbol, TA_TIMEFRAME, REGIME_KLINE_LIMIT);
    regimeResult = deriveRegime(klines);
  } catch (err) {
    regimeResult = deriveRegime([]);
    rejectionNotes.push(
      `Kunde inte hämta candles för regim: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const isPerp = params.broker.name.toLowerCase().includes("blofin");
  const leverage = assetClass === "crypto" && isPerp ? config.crypto.leverage : 1;

  const row: NewSignalRow = {
    id: crypto.randomUUID(),
    ts: now,
    source: "head_trader_proposal",
    signal_version: SIGNAL_VERSION,

    asset_class: assetClass,
    symbol,
    venue: params.broker.name,
    timeframe: TA_TIMEFRAME,
    leverage,
    is_perp: isPerp ? 1 : 0,

    direction,
    setup_type: setupType,
    entry,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    horizon_bars: config.learning.horizonBars[assetClass],
    confidence: proposalConfidence(verdict),
    regime: regimeResult.regime,
    features_snapshot: JSON.stringify({
      orderType: params.orderType,
      taScore: ta?.score ?? null,
      taBias: ta?.bias ?? null,
      keySignals: ta?.keySignals ?? [],
      targetZone: ta?.targetZone ?? null,
      regimeInputs: regimeResult.inputs,
      ensembleSummary: verdict.summary,
      notes: rejectionNotes,
    }),
    rationale: params.reasoning.slice(0, 2000),
    resolution_status: resolutionStatus,
    ...buildEnsembleFields(verdict, now),
  };

  insertSignal(db, row);
  log.info(
    `[Lärloop] Journalförde ${direction} ${symbol} @ ${entry} ` +
    `(${row.ensemble_status}, approved=${row.ensemble_approved ?? "–"}, ` +
    `regim=${row.regime}, status=${resolutionStatus})`,
  );
  return row.id;
}
