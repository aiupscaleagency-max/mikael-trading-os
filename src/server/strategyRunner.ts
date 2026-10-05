import fs from "node:fs/promises";
import { agentStart, agentDone, agentFail, agentSkip, agentScan, registerStrategies } from "./agentActivity.js";
import path from "node:path";
import crypto from "node:crypto";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { log } from "../logger.js";
import { loadLibrary, type Strategy } from "../strategies/library.js";
import { computeSeries, evalAll, type RuleResult } from "../strategies/ruleEngine.js";
import { askJev, type JevVerdict } from "./jevClient.js";
import {
  subscribeBybitClosedCandles, watchBybitKlines, getBybitClosedCandles,
} from "./bybitStream.js";
import type { Candle } from "./klineStream.js";
import {
  addPendingOrder, checkOrderGate, MAX_LIVE_STAKE_USD, testStakeCapUsd,
} from "./orderGate.js";
import { getTradeSizing } from "../risk/tradeSizing.js";
import { getHorizonMin } from "./tradeHorizon.js";
import { treeEvent } from "./treeLog.js";
import { loadPaperLedger, recordPaperSignal, resetPaper } from "./paperLedger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Strategi-löparen — kör alla påslagna strategier i biblioteket live
//
//  Varje gång Bybit stänger ett ljus (websocket) körs de strategier som
//  bevakar det paret och intervallet. Alla strategier och par körs
//  parallellt, så en långsam AI-granskning håller aldrig upp de andra.
//
//  Flödet för en KÖP-signal:
//    1. Reglerna stämmer på det stängda ljuset
//    2. JEV bedömer (krisregim, toxiskt flöde, motsatt riktning) — kan bara
//       STOPPA, aldrig skapa en signal
//    3. Separat AI-granskning är avstängd; köp kräver ordinarie tvåagentskedja.
//    4. Signalen visas i dashboarden. Den blir en väntande order först när
//       Mike trycker (eller med autoQueue), och ordern körs först vid Godkänn.
//
//  SÄLJ-signaler (exit-regel, stop eller target) granskas inte: att gå ur en
//  position ska aldrig kunna blockeras av ett AI-lager.
// ═══════════════════════════════════════════════════════════════════════════

const quote = () => (process.env.BYBIT_QUOTE || "USDC").toUpperCase();
const SIGNALS_FILE = path.resolve(process.cwd(), "data", "strategy-signals.json");
const STATE_FILE = path.resolve(process.cwd(), "data", "strategy-state.json");
const MAX_SIGNALS = 300;

export interface StrategySignalRecord {
  id: string;
  strategyId: string;
  strategyName: string;
  coin: string;
  pair: string;
  interval: string;
  side: "BUY" | "SELL";
  why: "regler" | "exit-regel" | "stop" | "target";
  price: number;
  stopLoss: number | null;
  target: number | null;
  rules: Array<{ text: string; pass: boolean; left: number | null; right: number | null }>;
  candleCloseTime: number;
  createdAt: string;
  review: {
    jev?: { available: boolean; route: string; note: string; latencyMs?: number | null; veto?: string };
    ai?: { model: string; approve: boolean; reason: string; ms: number; skipped?: string };
    final: "ok" | "stoppad";
    reason: string;
    totalMs: number;
  };
  queued?: { pendingId?: string; error?: string; at: string };
}

interface OpenPos {
  entry: number;
  stop: number | null;
  target: number | null;
  since: number;
}

let brokersRef: Record<string, BrokerAdapter> = {};
let broadcast: (event: string, data: unknown) => void = () => {};
let signals: StrategySignalRecord[] = [];
let positions: Record<string, OpenPos> = {};
let started = false;
const watched = new Set<string>();
const lastHandled = new Map<string, number>();
/** Efter en stoppad köpsignal väntar strategin några ljus innan den frågar JEV/AI igen (sparar anrop). */
const cooldownUntil = new Map<string, number>();
const COOLDOWN_CANDLES = 3;
const INTERVAL_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const stats = { evaluations: 0, lastEvalAt: 0, lastSignalAt: 0 };

const posKey = (strategyId: string, coin: string) => `${strategyId}:${coin}`;
export const pairOf = (coin: string) => `${coin}${quote()}`;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return fallback; }
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fs.mkdir(path.dirname(SIGNALS_FILE), { recursive: true });
      await fs.writeFile(SIGNALS_FILE, JSON.stringify(signals.slice(-MAX_SIGNALS), null, 1), "utf8");
      await fs.writeFile(STATE_FILE, JSON.stringify(positions, null, 1), "utf8");
    } catch (err) {
      log.warn(`[strategi] kunde inte spara: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 1000);
}

// ─── Granskning: JEV + AI-modell ──────────────────────────────────────────

/** Vilken modell ska granska? null = ingen behövs. */
export function pickReviewModel(s: Strategy, jev: JevVerdict | undefined): { model: string | null; why: string } {
  if (s.reviewModel && s.reviewModel !== "auto") return { model: s.reviewModel, why: "vald i strategin" };
  if (s.venue === "live") return { model: "anthropic/claude-sonnet-5.5", why: "LIVE granskas alltid av Sonnet" };
  const bias = jev?.answers.direction?.choice;
  const conf = jev?.answers.direction?.confidence ?? 0;
  if (jev?.available && bias === "up" && conf >= 0.6) {
    return { model: null, why: `JEV säker (uppåt ${conf.toFixed(2)}) — ingen modell behövs i TEST` };
  }
  return { model: "anthropic/claude-haiku-4.5", why: "JEV osäker — snabb granskning av Haiku" };
}

async function review(s: Strategy, sig: StrategySignalRecord, ind: Record<string, number | null>): Promise<StrategySignalRecord["review"]> {
  const t0 = Date.now();
  if (sig.side === "SELL") return { final: "ok", reason: "Sälj granskas inte — utgångar ska aldrig blockeras", totalMs: 0 };
  if (s.review === "off") return { final: "ok", reason: "Bara regler (ingen granskning vald)", totalMs: 0 };
  // Separata AI-granskare får inte starta en tredje roll utanför ordinarie kedja.
  if (s.review === "jev_ai") return { final: "stoppad", reason: "Separat AI-granskning är avstängd. Kör ordinarie JEV → Teknisk → Hanna för valt par.", totalMs: 0 };

  const out: StrategySignalRecord["review"] = { final: "ok", reason: "", totalMs: 0 };
  let jev: JevVerdict | undefined;
  const who = `strategy:${s.id}`;
  agentStart("jev", `granskar ${s.name} · ${sig.coin}`, { from: who, coin: sig.coin });
  try {
    jev = await askJev({
      symbol: sig.pair, interval: sig.interval, close: sig.price,
      rsi14: ind.rsi14, sma50: ind.sma50, ema20: ind.ema20, atr14: ind.atr14,
      proposed_direction: "LONG", strategy_rules: sig.rules.map((r) => r.text),
    });
    const veto = undefined;
    out.jev = { available: jev.available, route: jev.mode, note: jev.note, latencyMs: jev.latencyMs, veto };
    if (veto) { agentDone("jev", `stoppade ${sig.coin}: ${veto}`); return { ...out, final: "stoppad", reason: veto, totalMs: Date.now() - t0 }; }
    if (jev.available) agentDone("jev", "Uppgiftsdjup bedömt; signalen kommer från regler"); else agentSkip("jev", `svarade inte: ${jev.note ?? "rules_only"}`);
  } catch (err) {
    out.jev = { available: false, route: "rules_only", note: err instanceof Error ? err.message : String(err) };
    agentFail("jev", out.jev.note ?? "fel");
  }


  out.reason = out.jev?.available ? "JEV har bedömt uppgiftsdjup; marknadssignalen kommer från verifierade regler" : "JEV svarade inte — reglerna gäller (rules_only)";
  out.totalMs = Date.now() - t0;
  return out;
}

// ─── Utvärdering per stängt ljus ──────────────────────────────────────────

function snapshot(series: ReturnType<typeof computeSeries>, i: number): Record<string, number | null> {
  const keys = ["close", "rsi14", "sma20", "sma50", "sma200", "ema9", "ema20", "atr14", "atr_pct", "macd_hist", "volume", "vol_sma20"] as const;
  return Object.fromEntries(keys.map((k) => {
    const v = series[k][i];
    return [k, v == null ? null : Number(v.toPrecision(8))];
  }));
}

const shortRules = (r: RuleResult[]) => r.map((x) => ({ text: x.text, pass: x.pass, left: x.left, right: x.right }));

async function evaluate(s: Strategy, coin: string, history: Candle[]): Promise<void> {
  const i = history.length - 1;
  if (i < 30) return;
  const bar = history[i]!;
  const k = posKey(s.id, coin);
  const handledKey = `${k}:${s.interval}`;
  if ((lastHandled.get(handledKey) ?? 0) >= bar.closeTime) return; // samma ljus två gånger
  lastHandled.set(handledKey, bar.closeTime);

  stats.evaluations++;
  stats.lastEvalAt = Date.now();
  const prevClose = history[i - 1]?.close;
  agentScan(`strategy:${s.id}`, coin, prevClose ? ((bar.close - prevClose) / prevClose) * 100 : null);
  const series = computeSeries(history);
  const pos = positions[k];

  let side: "BUY" | "SELL" | null = null;
  let why: StrategySignalRecord["why"] = "regler";
  let price = bar.close;
  let rules: RuleResult[] = [];

  if (pos) {
    if (pos.stop != null && bar.low <= pos.stop) { side = "SELL"; why = "stop"; price = pos.stop; }
    else if (pos.target != null && bar.high >= pos.target) { side = "SELL"; why = "target"; price = pos.target; }
    else if (s.exit.length) {
      const ex = evalAll(series, s.exit, i);
      rules = ex.results;
      if (ex.pass) { side = "SELL"; why = "exit-regel"; }
    }
  } else {
    const en = evalAll(series, s.entry, i);
    rules = en.results;
    if (en.pass) side = "BUY";
  }
  if (!side) return;
  if (side === "BUY" && (cooldownUntil.get(k) ?? 0) > bar.closeTime) return;

  const atr = series.atr14[i] ?? null;
  const sig: StrategySignalRecord = {
    id: crypto.randomUUID(),
    strategyId: s.id,
    strategyName: s.name,
    coin,
    pair: pairOf(coin),
    interval: s.interval,
    side,
    why,
    price,
    stopLoss: side === "BUY" && atr && s.stopAtr > 0 ? bar.close - atr * s.stopAtr : null,
    target: side === "BUY" && atr && s.targetAtr > 0 ? bar.close + atr * s.targetAtr : null,
    rules: shortRules(rules),
    candleCloseTime: bar.closeTime,
    createdAt: new Date().toISOString(),
    review: { final: "ok", reason: "granskas…", totalMs: 0 },
  };

  agentStart(`strategy:${s.id}`, `${side} ${coin}: ${why}`, { coin });
  sig.review = await review(s, sig, snapshot(series, i));
  agentDone(`strategy:${s.id}`, `${side} ${coin} ${sig.review.final === "ok" ? "godkänd" : "stoppad"}`);
  if (side === "BUY" && s.review !== "off") {
    treeEvent({
      branch: "strategi", subject: `${s.name} · ${coin}`,
      jev: sig.review.jev ? { available: sig.review.jev.available, route: sig.review.jev.route, latencyMs: sig.review.jev.latencyMs } : undefined,
      model: sig.review.ai && !sig.review.ai.skipped ? sig.review.ai.model : null,
      outcome: sig.review.final, why: sig.review.reason,
    });
  }

  if (sig.review.final !== "ok" && side === "BUY") {
    cooldownUntil.set(k, bar.closeTime + COOLDOWN_CANDLES * (INTERVAL_MS[s.interval] ?? 60_000));
    sig.review.reason += ` · nytt försök om ${COOLDOWN_CANDLES} ljus`;
  }
  if (sig.review.final === "ok") {
    if (side === "BUY") positions[k] = { entry: sig.price, stop: sig.stopLoss, target: sig.target, since: bar.closeTime };
    else delete positions[k];
    recordPaperSignal(sig, s.venue);
    agentStart("paper", `${side} ${coin} @ ${price}`, { from: s.review === "jev_ai" ? "review-ai" : "jev", coin });
    agentDone("paper", `${side} ${coin} bokförd`);
  }

  signals.push(sig);
  if (signals.length > MAX_SIGNALS) signals.splice(0, signals.length - MAX_SIGNALS);
  stats.lastSignalAt = Date.now();
  log.info(`[strategi] ${s.name} · ${side} ${sig.pair} @ ${price} — ${sig.review.final === "ok" ? "OK" : "STOPPAD"} (${sig.review.reason})`);

  if (sig.review.final === "ok" && s.autoQueue) {
    await queueSignal(sig.id).catch(() => { /* felet sparas på signalen */ });
  }
  scheduleSave();
  broadcast("strategy-signal", sig);
}

// ─── Köa som väntande order ──────────────────────────────────────────────

export async function queueSignal(signalId: string, venueOverride?: "test" | "live"): Promise<{ ok: boolean; error?: string; pendingId?: string }> {
  const sig = signals.find((x) => x.id === signalId);
  if (!sig) return { ok: false, error: "Signalen finns inte" };
  if (sig.queued?.pendingId) return { ok: false, error: "Signalen ligger redan bland väntande ordrar" };
  if (sig.review.final !== "ok") return { ok: false, error: `Signalen stoppades: ${sig.review.reason}` };
  const strategy = (await loadLibrary()).find((s) => s.id === sig.strategyId);
  const venue = venueOverride ?? strategy?.venue ?? "test";

  const fail = (error: string) => {
    sig.queued = { error, at: new Date().toISOString() };
    agentStart("orders", `${sig.side} ${sig.coin}`, { from: "paper", coin: sig.coin });
    agentFail("orders", error.slice(0, 140));
    scheduleSave();
    broadcast("strategy-signal", sig);
    return { ok: false, error };
  };

  let brokerName: string | undefined;
  if (venue === "live") brokerName = brokersRef.bybit ? "bybit" : Object.keys(brokersRef).find((n) => brokersRef[n]!.mode === "live");
  else brokerName = brokersRef["bybit-paper"] ? "bybit-paper" : brokersRef["bybit-demo"] ? "bybit-demo" : Object.keys(brokersRef).find((n) => brokersRef[n]!.mode === "paper");
  const broker = brokerName ? brokersRef[brokerName] : undefined;
  if (!broker || !brokerName) return fail(venue === "live" ? "Ingen LIVE-mäklare (Bybit) är kopplad" : "Ingen TEST-mäklare (Bybit TEST) är kopplad");
  const live = broker.mode === "live";

  const symbol = `${sig.coin}USDC`; // Bybit EU använder USDC-par
  let quoteUsd: number | undefined;
  let quantity: number | undefined;
  let note = "";
  if (sig.side === "BUY") {
    try { const sizing = await getTradeSizing(broker); quoteUsd = sizing.amount; note = ` (${sizing.percent} % av kontovärdet)`; }
    catch (err) { return fail(`Kunde inte värdera kontot: ${err instanceof Error ? err.message : String(err)}`); }
  } else {
    try {
      const held = (await broker.getPositions()).find((p) => p.baseAsset.toUpperCase() === sig.coin);
      if (!held || !(held.quantity > 0)) return fail(`Inget ${sig.coin} att sälja hos ${brokerName}`);
      quantity = held.quantity;
    } catch (err) {
      return fail(`Kunde inte läsa innehav hos ${brokerName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const gate = await checkOrderGate({ live, side: sig.side, quoteUsd, source: `strategi:${sig.strategyName}` });
  if (!gate.ok) return fail(gate.error);

  const p = await addPendingOrder({
    source: `strategi:${sig.strategyName}`.slice(0, 60),
    venue: `broker:${brokerName}`,
    live,
    symbol,
    side: sig.side,
    quoteUsd,
    quantity,
    ...(sig.side === "BUY" ? { horizonSec: getHorizonMin() * 60 } : {}),
    reason: `${sig.strategyName}: ${sig.why}${note}`.slice(0, 200),
  });
  sig.queued = { pendingId: p.id, at: new Date().toISOString() };
  agentStart("orders", `${sig.side} ${sig.coin}`, { from: "paper", coin: sig.coin });
  agentDone("orders", `${sig.side} ${sig.coin} väntar på ditt OK (${venue.toUpperCase()})`);
  scheduleSave();
  broadcast("pending-orders", { id: p.id });
  broadcast("strategy-signal", sig);
  return { ok: true, pendingId: p.id };
}

// ─── Start / synk ─────────────────────────────────────────────────────────

/** Ser till att varje påslagen strategis par strömmar. Körs efter varje ändring. */
export async function syncStrategies(): Promise<void> {
  const lib = await loadLibrary();
  registerStrategies(lib);
  const jobs: Promise<void>[] = [];
  for (const s of lib.filter((x) => x.enabled)) {
    for (const coin of s.coins) {
      const key = `${pairOf(coin)}:${s.interval}`;
      if (watched.has(key)) continue;
      watched.add(key);
      jobs.push(watchBybitKlines(pairOf(coin), s.interval).catch((err) => {
        watched.delete(key);
        log.warn(`[strategi] kan inte bevaka ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }));
    }
  }
  await Promise.all(jobs);
}

export async function startStrategyRunner(
  brokers: Record<string, BrokerAdapter>,
  emit: (event: string, data: unknown) => void,
): Promise<void> {
  brokersRef = brokers;
  broadcast = emit;
  if (started) return;
  started = true;
  signals = await readJson<StrategySignalRecord[]>(SIGNALS_FILE, []);
  positions = await readJson<Record<string, OpenPos>>(STATE_FILE, {});
  await loadPaperLedger();

  subscribeBybitClosedCandles((pair, interval, _c, history) => {
    void (async () => {
      const lib = await loadLibrary();
      const jobs = lib
        .filter((s) => s.enabled && s.interval === interval)
        .flatMap((s) => s.coins.filter((c) => pairOf(c) === pair).map((c) => evaluate(s, c, history)));
      // Alla strategier för paret körs samtidigt.
      const res = await Promise.allSettled(jobs);
      for (const r of res) {
        if (r.status === "rejected") log.warn(`[strategi] fel: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    })();
  });

  await syncStrategies();
  const lib = await loadLibrary();
  log.ok(`[strategi] biblioteket igång — ${lib.filter((s) => s.enabled).length} av ${lib.length} strategier påslagna, ${watched.size} par/intervall strömmar`);
}

export function getStrategySignals(limit = 100, strategyId?: string): StrategySignalRecord[] {
  const list = strategyId ? signals.filter((s) => s.strategyId === strategyId) : signals;
  return list.slice(-limit).reverse();
}

export function getStrategyPositions(): Record<string, OpenPos> {
  return positions;
}

/** Nollställ strategins läge för ett coin (t.ex. om Mike sålt manuellt). */
export function resetStrategyPosition(strategyId: string, coin?: string): void {
  for (const k of Object.keys(positions)) {
    if (k.startsWith(`${strategyId}:`) && (!coin || k === posKey(strategyId, coin))) delete positions[k];
  }
  resetPaper(strategyId, coin);
  scheduleSave();
}

export function getRunnerStatus(): { started: boolean; streams: string[]; evaluations: number; lastEvalAt: number; lastSignalAt: number } {
  return { started, streams: [...watched], ...stats };
}

export function getRunnerCandles(coin: string, interval: string): Candle[] {
  return getBybitClosedCandles(pairOf(coin), interval);
}
