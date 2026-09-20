import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { openLearningDb } from "./db.js";
import {
  listOpenSignals, updateOutcome, recordResolveFailure, markUnresolvable,
  type OpenSignal,
} from "./signalJournal.js";
import { resolveSignal, type CostModel } from "./resolve.js";
import { fetchCandlesForSignal, intervalToMs, CandleUnavailableError, InvalidSymbolError } from "./candles.js";
import type { AssetClass } from "./schema.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  AVGÖRNINGSJOBBET — läser marknadsdata, skriver utfall till journalen.
//
//  Gör INGA Claude-anrop (ingen kostnad) och INGA order (ingen risk). Det
//  enda den skriver till är signal_journal.
// ═══════════════════════════════════════════════════════════════════════════

export function costModelFor(config: Config, assetClass: AssetClass): CostModel {
  return {
    feeBps: config.learning.feeBps[assetClass],
    slippageBps: config.learning.slippageBps,
    fundingBpsPer8h: config.learning.fundingBpsPer8h,
    mmr: config.learning.mmr,
    liqBufferPct: config.learning.liqBufferPct,
  };
}

export interface ResolveJobResult {
  examined: number;
  resolved: number;
  stillOpen: number;
  unresolvable: number;
  failed: number;
}

/** Väljer den broker signalen faktiskt kom ifrån, annars den primära. */
function brokerFor(
  brokers: Record<string, BrokerAdapter>,
  venue: string,
  fallback: BrokerAdapter | undefined,
): BrokerAdapter | undefined {
  return brokers[venue] ?? Object.values(brokers).find((b) => b.name === venue) ?? fallback;
}

export async function runResolveJob(params: {
  config: Config;
  brokers: Record<string, BrokerAdapter>;
  db?: DatabaseSync;
  now?: number;
  limit?: number;
}): Promise<ResolveJobResult> {
  const { config, brokers } = params;
  const db = params.db ?? openLearningDb();
  const now = params.now ?? Date.now();
  const result: ResolveJobResult = { examined: 0, resolved: 0, stillOpen: 0, unresolvable: 0, failed: 0 };

  if (!config.learning.enabled) return result;

  // Hämta bara rader vars horisont rimligen hunnit passera — vi pollar inte
  // färska signaler i onödan. Grovt mått: 1h per bar räcker som undre gräns.
  const candidates = listOpenSignals(db, {
    olderThanTs: now - 60 * 60 * 1000,
    limit: params.limit ?? 200,
  });
  result.examined = candidates.length;
  if (candidates.length === 0) return result;

  const fallbackBroker = Object.values(brokers)[0];
  // Gruppera per (venue, symbol, timeframe) så candles återanvänds inom gruppen.
  const groups = new Map<string, OpenSignal[]>();
  for (const s of candidates) {
    const key = `${s.venue}|${s.symbol}|${s.timeframe}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  for (const [key, signals] of groups) {
    const first = signals[0]!;
    const broker = brokerFor(brokers, first.venue, fallbackBroker);
    if (!broker) {
      for (const s of signals) recordResolveFailure(db, s.id, `Ingen broker för venue ${s.venue}`);
      result.failed += signals.length;
      continue;
    }

    // Ett fönster som täcker hela gruppen: äldsta signalen till den längsta
    // horisonten bland dem.
    const oldest = signals.reduce((a, b) => (a.ts <= b.ts ? a : b));
    const maxHorizon = Math.max(...signals.map((s) => s.horizon_bars));
    const spanBars =
      maxHorizon +
      Math.ceil((Math.max(...signals.map((s) => s.ts)) - oldest.ts) / intervalToMs(first.timeframe));

    let candles;
    try {
      candles = await fetchCandlesForSignal(broker, {
        symbol: first.symbol,
        timeframe: first.timeframe,
        ts: oldest.ts,
        horizonBars: spanBars,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (err instanceof InvalidSymbolError) {
        // Avlistad symbol kommer aldrig att gå att avgöra. Ge upp direkt
        // istället för att köa om den i evighet.
        for (const s of signals) markUnresolvable(db, s.id, `delisted_or_invalid_symbol: ${msg}`);
        result.unresolvable += signals.length;
        log.warn(`[Lärloop] ${first.symbol}: ${msg} — ${signals.length} rad(er) markerade ej avgörbara.`);
        continue;
      }

      // CandleUnavailableError (brokern saknar stöd) och nätverksfel
      // behandlas likadant: räkna upp försöken och låt raden vara öppen.
      for (const s of signals) {
        recordResolveFailure(db, s.id, msg);
        if (
          !(err instanceof CandleUnavailableError) &&
          s.resolve_attempts + 1 >= config.learning.maxResolveAttempts
        ) {
          markUnresolvable(db, s.id, `Gav upp efter ${s.resolve_attempts + 1} försök: ${msg}`);
          result.unresolvable++;
        } else {
          result.failed++;
        }
      }
      log.warn(`[Lärloop] Kunde inte hämta candles för ${key}: ${msg}`);
      continue;
    }

    const intervalMs = intervalToMs(first.timeframe);
    for (const s of signals) {
      const outcome = resolveSignal({
        signal: {
          ts: s.ts,
          direction: s.direction,
          entry: s.entry,
          stopLoss: s.stop_loss,
          takeProfit: s.take_profit,
          horizonBars: s.horizon_bars,
          leverage: s.leverage,
          assetClass: s.asset_class as AssetClass,
          isPerp: s.is_perp === 1,
          intervalMs,
        },
        candles,
        costs: costModelFor(config, s.asset_class as AssetClass),
      });

      if (outcome === null) {
        result.stillOpen++;
        continue;
      }

      updateOutcome(db, s.id, {
        outcome: outcome.outcome,
        exit_price: outcome.exitPrice,
        ts_resolved: outcome.tsResolved,
        r_multiple: outcome.rMultiple,
        r_multiple_gross: outcome.rMultipleGross,
        return_on_margin_pct: outcome.returnOnMarginPct,
        mfe: outcome.mfe,
        mae: outcome.mae,
        liquidation_price: outcome.liquidationPrice,
        fees_usd: outcome.feesUsd,
        slippage_usd: outcome.slippageUsd,
        funding_usd: outcome.fundingUsd,
        bars_to_resolution: outcome.barsToResolution,
        ambiguous_bar: outcome.ambiguousBar ? 1 : 0,
        gap_filled: outcome.gapFilled ? 1 : 0,
        resolver_version: outcome.resolverVersion,
      });
      result.resolved++;
      log.info(
        `[Lärloop] ${s.symbol} ${s.direction}: ${outcome.outcome} ` +
        `@ ${outcome.exitPrice} (${outcome.rMultiple.toFixed(2)}R efter kostnader)`,
      );
    }
  }

  return result;
}
