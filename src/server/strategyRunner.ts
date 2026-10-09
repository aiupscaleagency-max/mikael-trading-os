import { dataDir, dataPath } from "../dataDir.js";
import fs from "node:fs/promises";
import { agentStart, agentDone, agentFail, agentSkip, agentScan, registerStrategies } from "./agentActivity.js";
import path from "node:path";
import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { log } from "../logger.js";
import { loadLibrary, type Strategy } from "../strategies/library.js";
import { computeSeries, evalAll, type RuleResult } from "../strategies/ruleEngine.js";
import { askJev, type JevVerdict } from "./jevClient.js";
import { igMarketData } from "./igMarketData.js";
import type { Candle } from "./klineStream.js";
import {
  addPendingOrder, checkOrderGate, MAX_LIVE_STAKE_USD, testStakeCapUsd,
} from "./orderGate.js";
import { treeEvent } from "./treeLog.js";
import { loadPaperLedger, recordPaperSignal, resetPaper } from "./paperLedger.js";
import { createLlmClient, extractJson, hasLlmCredentials, toDirectModel, usingGateway } from "../llm/gateway.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Strategi-löparen — kör alla påslagna strategier i biblioteket live
//
//  Varje gång IG stänger ett ljus (Lightstreamer CONS_END=1 eller REST-historik) körs de strategier som
//  bevakar det paret och intervallet. Alla strategier och par körs
//  parallellt, så en långsam AI-granskning håller aldrig upp de andra.
//
//  Flödet för en KÖP-signal:
//    1. Reglerna stämmer på det stängda ljuset
//    2. JEV bedömer (krisregim, toxiskt flöde, motsatt riktning) — kan bara
//       STOPPA, aldrig skapa en signal
//    3. Vid "jev_ai": en AI-modell granskar. JEV avgör i auto-läget om en
//       modell behövs och vilken: säker JEV-bedömning i TEST → ingen modell,
//       annars Haiku, och i LIVE alltid Sonnet. Modellen kan också bara stoppa.
//    4. Signalen visas i dashboarden. Den blir en väntande order först när
//       Mike trycker (eller med autoQueue), och ordern körs först vid Godkänn.
//
//  SÄLJ-signaler (exit-regel, stop eller target) granskas inte: att gå ur en
//  position ska aldrig kunna blockeras av ett AI-lager.
// ═══════════════════════════════════════════════════════════════════════════

const SIGNALS_FILE = dataPath("strategy-signals.json");
const STATE_FILE = dataPath("strategy-state.json");
const MAX_SIGNALS = 300;
const AI_TIMEOUT_MS = 20_000;

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
let llm: Anthropic | null = null;
const stats = { evaluations: 0, lastEvalAt: 0, lastSignalAt: 0 };

// Per IG-miljö: samma EPIC finns i Demo och Live, och "i position" får inte följa med vid byte.
const posKey = (strategyId: string, coin: string, env: string = igMarketData.getActiveEnv()) => `${env}:${strategyId}:${coin}`;
/**
 * IG: strategins "coin" är en IG-EPIC (t.ex. CS.D.BITCOIN.CFD.IP) eller ett kortnamn.
 * Kortnamn översätts BARA till en EPIC som redan finns i bevakningslistan för aktiv
 * miljö (verifierad mot kontot); annars null och strategin bevakar inte paret.
 */
const COIN_NAME: Record<string, RegExp> = {
  BTC: /bitcoin/i, ETH: /ether(eum)?\b/i, SOL: /solana/i, XRP: /ripple|xrp/i, ADA: /cardano/i, DOGE: /dogecoin/i, LTC: /litecoin/i,
  BCH: /bitcoin cash/i, DOT: /polkadot/i, LINK: /chainlink/i,
};
export function pairOf(coin: string): string | null {
  if (/^[A-Z]{2}\.[A-Z0-9._-]+$/i.test(coin)) return coin;
  const c = coin.toUpperCase().replace(/(USDT|USDC|USD)$/, "");
  const list = igMarketData.watchlistDetailed();
  const fx = /^[A-Z]{6}$/.test(coin.toUpperCase()) ? new RegExp(`^${coin.slice(0, 3)}\\s*/\\s*${coin.slice(3, 6)}`, "i") : null;
  const want = fx ?? COIN_NAME[c];
  if (!want) return null;
  const hit = list.filter((m) => m.name && want.test(m.name) && !(c === "BTC" && /cash/i.test(m.name)))[0];
  return hit?.epic ?? null;
}

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

function jevVeto(v: JevVerdict): string | undefined {
  if (!v.available) return undefined;
  if (v.answers.regime?.choice === "crisis") return "JEV: krisregim — ingen ny position";
  const toxic = v.answers.toxic_flow?.noul ?? 0;
  if (toxic > 0.7) return `JEV: toxiskt flöde ${toxic.toFixed(2)}`;
  const bias = v.answers.direction?.choice;
  const conf = v.answers.direction?.confidence ?? 0;
  if (bias === "down" && conf > 0.6) return `JEV: bedömer riktningen nedåt (säkerhet ${conf.toFixed(2)})`;
  return undefined;
}

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

async function aiReview(model: string, s: Strategy, sig: StrategySignalRecord, ind: Record<string, number | null>): Promise<{ approve: boolean; reason: string }> {
  if (!hasLlmCredentials()) throw new Error("ingen AI-nyckel (AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY)");
  if (!usingGateway() && !model.startsWith("anthropic/")) throw new Error(`${model} kräver Vercel/OpenRouter-nyckel`);
  llm ??= createLlmClient();
  const body = {
    model: usingGateway() ? model : toDirectModel(model),
    max_tokens: 250,
    system:
      "Du granskar en köpsignal från en regelbaserad krypto-strategi (spot, bara köp/sälj). "
      + "Du kan bara STOPPA en signal, aldrig skapa en. Stoppa om läget uppenbart motsäger signalen "
      + "(t.ex. kraftig nedtrend, extrem volatilitet, uppenbart dålig risk/reward). Annars godkänn. "
      + 'Svara ENDAST med JSON: {"approve": true|false, "reason": "en kort mening på svenska"}',
    messages: [{
      role: "user" as const,
      content: JSON.stringify({
        strategi: s.name,
        beskrivning: s.description,
        par: sig.pair,
        intervall: sig.interval,
        pris: sig.price,
        stop: sig.stopLoss,
        target: sig.target,
        regler_som_stämde: sig.rules.map((r) => r.text),
        indikatorer: ind,
        läge: s.venue === "live" ? "LIVE (riktiga pengar)" : "TEST",
      }),
    }],
  };
  const res = await Promise.race([
    llm.messages.create(body),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("AI svarade inte inom 20 s")), AI_TIMEOUT_MS)),
  ]) as Anthropic.Message;
  const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const parsed = JSON.parse(extractJson(text)) as { approve?: unknown; reason?: unknown };
  return { approve: parsed.approve === true, reason: String(parsed.reason ?? "").slice(0, 300) || "inget skäl" };
}

async function review(s: Strategy, sig: StrategySignalRecord, ind: Record<string, number | null>): Promise<StrategySignalRecord["review"]> {
  const t0 = Date.now();
  if (sig.side === "SELL") return { final: "ok", reason: "Sälj granskas inte — utgångar ska aldrig blockeras", totalMs: 0 };
  if (s.review === "off") return { final: "ok", reason: "Bara regler (ingen granskning vald)", totalMs: 0 };

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
    const veto = jevVeto(jev);
    out.jev = { available: jev.available, route: jev.mode, note: jev.note, latencyMs: jev.latencyMs, veto };
    if (veto) { agentDone("jev", `stoppade ${sig.coin}: ${veto}`); return { ...out, final: "stoppad", reason: veto, totalMs: Date.now() - t0 }; }
    if (jev.available) agentDone("jev", `godkände ${sig.coin}`); else agentSkip("jev", `svarade inte: ${jev.note ?? "rules_only"}`);
  } catch (err) {
    out.jev = { available: false, route: "rules_only", note: err instanceof Error ? err.message : String(err) };
    agentFail("jev", out.jev.note ?? "fel");
  }

  if (s.review === "jev_ai") {
    const pick = pickReviewModel(s, jev);
    if (!pick.model) {
      out.ai = { model: "-", approve: true, reason: pick.why, ms: 0, skipped: pick.why };
    } else {
      const a0 = Date.now();
      agentStart("review-ai", `${pick.model} granskar ${sig.coin}`, { from: "jev", coin: sig.coin });
      try {
        const r = await aiReview(pick.model, s, sig, ind);
        out.ai = { model: pick.model, approve: r.approve, reason: r.reason, ms: Date.now() - a0 };
        agentDone("review-ai", `${r.approve ? "godkände" : "stoppade"} ${sig.coin}: ${r.reason}`.slice(0, 160));
        if (!r.approve) return { ...out, final: "stoppad", reason: `${pick.model}: ${r.reason}`, totalMs: Date.now() - t0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        agentFail("review-ai", msg.slice(0, 140));
        out.ai = { model: pick.model, approve: s.venue !== "live", reason: `Granskning misslyckades: ${msg}`, ms: Date.now() - a0 };
        // LIVE stängs vid fel (samma princip som positionsövervakningen). TEST släpps igenom, tydligt märkt.
        if (s.venue === "live") return { ...out, final: "stoppad", reason: `AI-granskning misslyckades i LIVE: ${msg}`, totalMs: Date.now() - t0 };
      }
    }
  }

  out.reason = out.jev?.available ? `Godkänd av JEV${out.ai && !out.ai.skipped ? " + " + out.ai.model : ""}` : "JEV svarade inte — reglerna gäller (rules_only)";
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
    pair: pairOf(coin) ?? coin,
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

/** dealId för strategins senaste KÖP som IG faktiskt accepterade (via den godkända väntande ordern). */
async function strategyDealId(strategyId: string, pair: string, epic: string): Promise<string | null> {
  const { getPendingOrder } = await import("./orderGate.js");
  const buys = signals.filter((x) => x.strategyId === strategyId && x.side === "BUY" && (x.pair === pair || x.pair === epic) && x.queued?.pendingId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const b of buys) {
    const po = await getPendingOrder(b.queued!.pendingId!);
    const dealId = po?.status === "done" ? (po.result as { dealId?: string } | undefined)?.dealId : undefined;
    if (dealId) return dealId;
  }
  return null;
}

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
  brokerName = venue === "live" ? "ig" : "ig-demo";
  const broker = brokersRef[brokerName];
  if (!broker) return fail(venue === "live" ? "IG Live är inte kopplat" : "IG Demo är inte kopplat");
  const live = broker.mode === "live";

  // IG: signalen blir en väntande IG-order (EPIC, insats i % av IG-saldot, TP/SL).
  // SÄLJ-signal stänger strategins öppna KÖP-position (dealId hos IG), öppnar aldrig kort här.
  const epic = sig.pair && sig.pair.includes(".") ? sig.pair : pairOf(sig.coin);
  if (!epic) return fail(`${sig.coin} finns inte som IG-EPIC i bevakningslistan`);
  const { createIgPendingOrder } = await import("./api.js");
  let p: { id: string };
  if (sig.side === "SELL") {
    // Stäng bara STRATEGINS EGEN position: dealId från strategins senaste godkända KÖP (aldrig en manuell/agentposition)
    const ownDealId = await strategyDealId(sig.strategyId, sig.pair ?? epic, epic);
    if (!ownDealId) return fail(`Strategin har ingen egen öppen position i ${sig.coin} (köpet godkändes aldrig, eller är redan stängt)`);
    let held;
    try { held = (await (broker as import("../brokers/ig.js").IgBroker).getPositions({ fresh: true })).find((x) => x.dealId === ownDealId); }
    catch (err) { return fail(`Kunde inte läsa positioner hos ${brokerName}: ${err instanceof Error ? err.message : String(err)}`); }
    if (!held?.dealId) return fail(`Strategins position ${ownDealId} i ${sig.coin} finns inte längre hos ${live ? "IG Live" : "IG Demo"}`);
    const gate = await checkOrderGate({ live, side: "SELL", unitsOrder: true, opening: false, source: `strategi:${sig.strategyName}` });
    if (!gate.ok) return fail(gate.error);
    p = await addPendingOrder({
      source: `strategi:${sig.strategyName}`.slice(0, 60), venue: `broker:${brokerName}`, live, symbol: epic, name: held.name,
      side: "SELL", quantity: held.quantity, closeDealId: held.dealId, refPrice: held.currentPrice,
      reason: `${sig.strategyName}: ${sig.why} (stänger position)`.slice(0, 200),
    });
  } else {
    const r = await createIgPendingOrder({
      symbol: epic, side: "BUY", source: `strategi:${sig.strategyName}`.slice(0, 60), reason: `${sig.strategyName}: ${sig.why}`.slice(0, 200),
      ...(sig.stopLoss ? { stopLoss: sig.stopLoss } : {}), ...(sig.target ? { takeProfit: sig.target } : {}),
    }, broker as import("../brokers/ig.js").IgBroker);
    if (!r.ok) return fail(r.error);
    p = r.pendingOrder;
  }
  sig.queued = { pendingId: p.id, at: new Date().toISOString() };
  agentStart("orders", `${sig.side} ${sig.coin}`, { from: "paper", coin: sig.coin });
  agentDone("orders", `${sig.side} ${sig.coin} väntar på ditt OK (${live ? "IG Live" : "IG Demo"})`);
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
  const pinned: Array<{ epic: string; iv: string }> = [];
  for (const s of lib.filter((x) => x.enabled)) {
    for (const coin of s.coins) {
      const epic = pairOf(coin);
      if (!epic) { log.warn(`[strategi] ${s.name}: ${coin} finns inte som IG-EPIC i bevakningslistan, bevakas inte`); continue; }
      const key = `${epic}:${s.interval}`;
      pinned.push({ epic, iv: s.interval });
      if (watched.has(key)) continue;
      watched.add(key);
      const env = igMarketData.getActiveEnv();
      jobs.push(igMarketData.ensureSeries(env, epic, s.interval).then(() => undefined).catch((err) => {
        watched.delete(key);
        log.warn(`[strategi] kan inte bevaka ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }));
    }
  }
  // Påslagna strategiers serier följs så länge strategin är på (inte bara 150 s)
  igMarketData.pinSeries("strategies", igMarketData.getActiveEnv(), pinned);
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

  // Bara STÄNGDA ljus från aktiv IG-miljö (Demo eller Live, aldrig blandat).
  igMarketData.events.on("closed", (env: string, pair: string, interval: string, _c: Candle, history: Candle[]) => {
    if (env !== igMarketData.getActiveEnv()) return;
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

  const resync = () => { watched.clear(); void syncStrategies().catch(() => {}); };
  igMarketData.events.on("env", resync);
  igMarketData.events.on("watchlist", resync);
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
    if ((k.startsWith(`demo:${strategyId}:`) || k.startsWith(`live:${strategyId}:`)) && (!coin || k === posKey(strategyId, coin, "demo") || k === posKey(strategyId, coin, "live"))) delete positions[k];
  }
  resetPaper(strategyId, coin);
  scheduleSave();
}

export function getRunnerStatus(): { started: boolean; streams: string[]; evaluations: number; lastEvalAt: number; lastSignalAt: number } {
  return { started, streams: [...watched], ...stats };
}

export function getRunnerCandles(coin: string, interval: string): Candle[] {
  const epic = pairOf(coin);
  return epic ? igMarketData.closed(epic, interval) : [];
}
