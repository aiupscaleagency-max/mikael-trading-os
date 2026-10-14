// PTQ connector. If you run PTQ (part-timequant.com) on this computer, Quant Terminal talks to it
// directly: it sends a strategy tester strategy to PTQ for its own backtest and luck checks, and
// shows what PTQ holds and has armed. PTQ keeps the licence, the engine and your exchange keys.
// The terminal never places a live order, never arms a strategy and never sees a key: arming
// happens inside PTQ, behind PTQ's own consent and risk checks. The terminal can only make PTQ
// do LESS (engage its stop, disarm a strategy).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { BY_ID, defaults } from "../public/lib/indicators.js";

export const PTQ_URL = (process.env.PTQ_URL || "http://127.0.0.1:8787").replace(
  /\/+$/,
  "",
);
export const PTQ_SITE =
  "https://www.part-timequant.com/?utm_source=quant-terminal&utm_medium=app&utm_campaign=ptq-connector";

// ---------- licence lease (written by `ptq activate` on this machine) ----------
export function leaseInfo() {
  const homes = [
    process.env.PTQ_HOME,
    path.join(os.homedir(), ".ptq"),
    path.join(os.homedir(), ".trading-os"),
  ].filter(Boolean);
  for (const home of homes) {
    try {
      const f = JSON.parse(
        fs.readFileSync(path.join(home, "license.json"), "utf8"),
      );
      return {
        lease: typeof f.lease === "string" ? f.lease : null,
        exp: Number(f.exp) || null,
        activated: Boolean(f.key),
      };
    } catch {
      /* try the next home */
    }
  }
  return { lease: null, exp: null, activated: false };
}

function fail(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

export async function call(method, p, body, timeoutMs = 20000) {
  const { lease } = leaseInfo();
  let res;
  try {
    res = await fetch(`${PTQ_URL}/api${p}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(lease ? { authorization: `Bearer ${lease}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.name === "TimeoutError")
      throw fail(
        "PTQ took too long to answer. It may still be working: check PTQ itself.",
        504,
        "timeout",
      );
    throw fail(
      "PTQ isn't running on this computer. Start it with `ptq serve`, then try again.",
      503,
      "not_running",
    );
  }
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw /expired/.test(j.error || "")
      ? fail(
          "Your PTQ licence lease has run out. Open PTQ or run `ptq status` to refresh it, then try again.",
          401,
          "licence",
        )
      : fail(
          "PTQ needs your licence on this computer. Run `ptq activate <your key>`, then try again.",
          401,
          "licence",
        );
  }
  if (
    res.status === 402 &&
    !/refused|not found|unavailable/i.test(j.error || "")
  )
    throw fail(
      `PTQ couldn't charge this run: ${j.error || "out of credits"}`,
      402,
      "credits",
    );
  if (res.status === 402)
    throw fail(
      String(j.error).replace(
        /engine 422: .*/s,
        "its engine can't run these settings.",
      ),
      400,
      "ptq",
    );
  if (!res.ok)
    throw fail(
      j.error || `PTQ answered HTTP ${res.status}`,
      res.status >= 500 ? 502 : 400,
      "ptq",
    );
  return j;
}

export async function status() {
  const lic = leaseInfo();
  const base = {
    url: PTQ_URL,
    site: PTQ_SITE,
    licensed: Boolean(lic.lease),
    leaseExpires: lic.exp,
  };
  try {
    const h = await call("GET", "/health", undefined, 2500);
    return { ...base, connected: true, version: h.version, engine: h.engine };
  } catch (e) {
    return { ...base, connected: false, reason: e.message };
  }
}

// ---------- strategy translation: tester JSON -> PTQ composer manifest ----------
const OPS = {
  ">": ">",
  "<": "<",
  ">=": ">=",
  "<=": "<=",
  crossesAbove: "crosses_above",
  crossesBelow: "crosses_below",
};
const PRICE = ["close", "open", "high", "low", "volume"];
const TF = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1D": "1d",
};
const BOUNDS = {
  length: [2, 400],
  fast: [2, 200],
  slow: [3, 400],
  signal: [2, 100],
  mult: [0.1, 10],
};
const SUPPORTED =
  "SMA, EMA, RSI, ATR, ROC, standard deviation, Bollinger Bands, MACD, Donchian highs and lows, MA Cross and volume";

function ok(params) {
  for (const [k, v] of Object.entries(params)) {
    const b = BOUNDS[k];
    if (b && !(v >= b[0] && v <= b[1]))
      return `${k} ${v} is outside PTQ's range (${b[0]} to ${b[1]})`;
  }
  return null;
}

// One operand -> { term } or { error }, plus optional notes.
export function toTerm(operand, indicators = {}) {
  if (
    typeof operand === "number" ||
    (typeof operand === "string" &&
      operand.trim() !== "" &&
      !Number.isNaN(Number(operand)))
  ) {
    return { term: { indicator: "constant", value: Number(operand) } };
  }
  if (PRICE.includes(operand)) return { term: { indicator: operand } };
  if (["hl2", "hlc3", "ohlc4", "hlcc4"].includes(operand))
    return {
      error: `PTQ compares close, open, high, low or volume, not ${operand}`,
    };
  const [key, outRaw] = String(operand).split(".");
  const spec = indicators[key];
  if (!spec || !BY_ID[spec.id])
    return { error: `"${operand}" isn't a known indicator` };
  const def = BY_ID[spec.id];
  const p = { ...defaults(spec.id), ...(spec.params || {}) };
  const out = outRaw || spec.output || def.outputs[0]?.key;
  if (p.source && p.source !== "close")
    return {
      error: `${def.name} on ${p.source}: PTQ computes indicators on the close`,
    };
  const t = (indicator, params, notes = []) => {
    const bad = ok(params);
    return bad
      ? { error: `${def.name}: ${bad}` }
      : { term: { indicator, params }, notes };
  };
  switch (spec.id) {
    case "sma":
      return t("sma", { length: p.length });
    case "ema":
      return t("ema", { length: p.length });
    case "rsi":
      return t("rsi", { length: p.length });
    case "atr":
      return t("atr", { length: p.length });
    case "roc":
      return t("roc", { length: p.length });
    case "stdev":
      return t("stdev", { length: p.length });
    case "bb":
      if (out === "upper")
        return t("bb_upper", { length: p.length, mult: p.mult });
      if (out === "lower")
        return t("bb_lower", { length: p.length, mult: p.mult });
      return t("sma", { length: p.length });
    case "macd":
      if (out === "signal")
        return t("macd_signal", {
          fast: p.fast,
          slow: p.slow,
          signal: p.signal,
        });
      if (out === "hist")
        return t("macd_hist", { fast: p.fast, slow: p.slow, signal: p.signal });
      return t("macd", { fast: p.fast, slow: p.slow });
    case "donchian": {
      const note =
        "PTQ's channel uses the bars before the current one, so a breakout means beating the previous high or low.";
      if (out === "upper") return t("highest", { length: p.length }, [note]);
      if (out === "lower") return t("lowest", { length: p.length }, [note]);
      return {
        error: "Donchian middle line isn't in PTQ's strategy builder yet",
      };
    }
    case "macross": {
      const kind = p.type === "SMA" ? "sma" : "ema";
      return t(kind, { length: out === "slow" ? p.slow : p.fast });
    }
    case "volume":
      if (out === "ma") return t("volume_sma", { length: p.maLength || 20 });
      return { term: { indicator: "volume" } };
    default:
      return {
        error: `${def.name} isn't in PTQ's strategy builder yet (it takes ${SUPPORTED})`,
      };
  }
}

function group(rules, indicators, problems, notes, label, op = "AND") {
  const conditions = [];
  rules.forEach((r, i) => {
    const cmp = OPS[r.op];
    if (!cmp) {
      problems.push(
        `${label} condition ${i + 1}: "${r.op}" isn't one PTQ uses (it takes above, below, crosses above, crosses below)`,
      );
      return;
    }
    const L = toTerm(r.left, indicators),
      R = toTerm(r.right, indicators);
    for (const x of [L, R]) {
      if (x.error) problems.push(`${label} condition ${i + 1}: ${x.error}`);
      for (const n of x.notes || []) if (!notes.includes(n)) notes.push(n);
    }
    if (!L.error && !R.error)
      conditions.push({ kind: "comparison", left: L.term, op: cmp, right: R.term });
  });
  return conditions.length ? { kind: "group", op, conditions } : null;
}

export function translate(strategy, { tf, name } = {}) {
  const s = {
    entryLong: [],
    exitLong: [],
    entryShort: [],
    exitShort: [],
    indicators: {},
    ...strategy,
  };
  const problems = [],
    notes = [];
  let direction = "long",
    entryRules = s.entryLong,
    exitRules = s.exitLong;
  if (!s.entryLong.length && s.entryShort.length) {
    direction = "short";
    entryRules = s.entryShort;
    exitRules = s.exitShort;
  }
  if (s.entryLong.length && s.entryShort.length)
    notes.push(
      "PTQ runs one direction per strategy, so this sends the long side.",
    );
  if (!entryRules.length) problems.push("Add at least one entry condition.");
  const timeframe = TF[tf];
  if (!timeframe)
    problems.push(`PTQ tests on 1m, 5m, 15m, 1h, 4h or 1D, not ${tf}.`);
  const entry = group(entryRules, s.indicators, problems, notes, "Entry");
  const exit = group(exitRules, s.indicators, problems, notes, "Exit", s.exitMatch === "any" ? "OR" : "AND");
  // PTQ caps a trade by hours, not bars; round up so it never exits earlier than the test did here.
  const hoursPerBar = { "1m": 1 / 60, "5m": 1 / 12, "15m": 0.25, "1h": 1, "4h": 4, "1D": 24 }[tf];
  const maxHoldingHours = s.maxBarsInTrade > 0 && hoursPerBar ? Math.ceil(s.maxBarsInTrade * hoursPerBar) : 0;
  if (maxHoldingHours && maxHoldingHours !== s.maxBarsInTrade * hoursPerBar)
    notes.push(`PTQ holds by whole hours, so the ${s.maxBarsInTrade}-bar time exit is sent as ${maxHoldingHours} hours.`);
  if (s.trailingStopPct)
    notes.push(
      "PTQ sizes and stops each trade by its own risk settings; the trailing stop isn't sent.",
    );
  if (s.stopLossPct)
    notes.push(
      "PTQ stops each trade at 2 ATR under its own risk settings; the stop-loss % isn't sent.",
    );
  if (s.spreadPct)
    notes.push("PTQ applies its own trading costs; the spread isn't sent.");
  if (s.takeProfitPct)
    notes.push(
      "PTQ sets the take-profit from its own risk settings; the take-profit % isn't sent.",
    );
  const manifest = {
    id: `strat_qt_${crypto.randomBytes(5).toString("hex")}`,
    name: `Quant Terminal: ${name || "strategy"}`.slice(0, 80),
    version: "1.0.0",
    status: "research",
    assetClass: null,
    instrument: null,
    direction,
    entryLogic: "composed",
    creationMode: "composer",
    composed: { entry, ...(exit ? { exit } : {}) },
    signalTimeframe: timeframe,
    session: { enabled: false, label: "24/7" },
    newsGuard: false,
    maxHoldingHours,
    risk: {
      riskPerTradePct: 0.5,
      stopAtr: 2,
      maxTradesPerDay: 3,
      requireBracket: true,
    },
    validation: {
      walkForward: true,
      transactionCosts: true,
      overfittingCheck: true,
      minOutOfSampleMonths: 12,
    },
    createdAt: 0,
    updatedAt: 0,
  };
  return { manifest, problems, notes };
}

// Terminal symbol -> PTQ market id, checked against PTQ's own catalogue.
export async function resolveInstrument(symbolId) {
  const [ex, ticker] = String(symbolId).split(":");
  let assetClass, candidate, q;
  if (["BINANCE", "COINBASE", "KRAKEN"].includes(ex)) {
    const base = ticker
      .replace(/-/g, "")
      .replace(/(USDT|USDC|FDUSD|USD)$/, "")
      .replace(/^XBT$/, "BTC");
    assetClass = "crypto";
    q = `${base}USDT`;
    candidate = `BITGET:SPOT:${base}USDT`;
  } else if (ex === "US") {
    assetClass = "equities";
    q = ticker;
    candidate = `YAHOO:STOCKS:${ticker}`;
  } else if (ex === "FX") {
    assetClass = "fx";
    q = ticker;
    candidate = `YAHOO:FX:${ticker}=X`;
  } else {
    throw fail(
      `PTQ can't test ${symbolId} from here. Use a crypto pair, a US stock or a forex pair.`,
      422,
      "instrument",
    );
  }
  const found = await call(
    "GET",
    `/markets?q=${encodeURIComponent(q)}&assetClass=${assetClass}&limit=50`,
  );
  const item = (found.items || []).find((x) => x.id === candidate);
  if (!item)
    throw fail(
      `PTQ's market list has no ${candidate}, so it can't test this symbol.`,
      422,
      "instrument",
    );
  if ((item.history || {}).status !== "available")
    throw fail(
      `PTQ has no price history for ${candidate} (${(item.history || {}).reason || "unavailable"}).`,
      422,
      "instrument",
    );
  return { id: candidate, assetClass };
}

// ---------- the actions the terminal offers ----------
export async function check({ strategy, symbol, tf, name }) {
  const { manifest, problems, notes } = translate(strategy, { tf, name });
  if (problems.length)
    throw Object.assign(
      fail("PTQ can't test this strategy as written.", 422, "translate"),
      { problems, notes },
    );
  const inst = await resolveInstrument(symbol);
  manifest.instrument = inst.id;
  manifest.assetClass = inst.assetClass;
  const saved = await call("POST", "/strategies", manifest);
  const run = await call(
    "POST",
    "/backtest/run",
    { strategyId: saved.id },
    240000,
  );
  let validation = null,
    validationError = null;
  try {
    validation = await call(
      "POST",
      `/backtest/${run.id}/validate`,
      undefined,
      240000,
    );
  } catch (e) {
    validationError = e.message;
  }
  return {
    strategyId: saved.id,
    strategyName: saved.name,
    instrument: inst.id,
    timeframe: manifest.signalTimeframe,
    provenance: run.provenance,
    metrics: run.metrics || {},
    validation: validation && {
      verdict: validation.verdict,
      gates: (validation.gates || []).map((g) => ({
        key: g.key,
        label: g.label,
        value: g.value,
        pass: g.pass,
      })),
      pboPct: validation.pboPct,
      deflatedSharpe: validation.deflatedSharpe,
    },
    validationError,
    notes,
    links: {
      strategy: `${PTQ_URL}/strategy?strategyId=${encodeURIComponent(saved.id)}`,
      autopilot: `${PTQ_URL}/autopilot`,
      integrations: `${PTQ_URL}/integrations`,
    },
  };
}

export async function overview() {
  const get = (p) =>
    call("GET", p).catch((e) => ({ error: e.message, code: e.code }));
  const [portfolio, arms, autopilot, killSwitch, journal] = await Promise.all([
    get("/portfolio"),
    get("/execution/strategy-arms"),
    get("/autopilot"),
    get("/execution/kill-switch"),
    get("/journal"),
  ]);
  return {
    portfolio,
    arms,
    autopilot,
    killSwitch,
    journal: Array.isArray(journal) ? journal.slice(0, 50) : journal,
    links: {
      app: PTQ_URL,
      autopilot: `${PTQ_URL}/autopilot`,
      integrations: `${PTQ_URL}/integrations`,
      journal: `${PTQ_URL}/journal`,
    },
  };
}

// Only ever reduces what PTQ does: engage the stop, or disarm one strategy.
export const engageKillSwitch = () =>
  call("POST", "/execution/kill-switch", { engaged: true });
export const disarm = (id) =>
  call("POST", `/execution/strategy-arms/${encodeURIComponent(id)}/disarm`, {});
