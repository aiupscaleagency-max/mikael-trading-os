// Strategy tester. A strategy is plain JSON so the UI, alerts and your AI agent can all write one.
//
// {
//   name: 'EMA cross',
//   indicators: { fast: { id: 'ema', params: { length: 9 } }, slow: { id: 'ema', params: { length: 21 } } },
//   entryLong:  [ { left: 'fast', op: 'crossesAbove', right: 'slow' } ],   // all must be true
//   exitLong:   [ { left: 'fast', op: 'crossesBelow', right: 'slow' } ],
//   entryShort: [], exitShort: [],
//   exitMatch: 'all',        // 'any': exit on whichever exit condition fires first
//   maxBarsInTrade: 0,       // time exit: close after this many bars if nothing else has (0 = off)
//   stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 0,
//   initialCapital: 10000, positionPct: 100, feePct: 0.1, slippagePct: 0.05,
//   spreadPct: 0,            // bid to ask: buys fill at the ask, sells at the bid, stops trigger on that side
//   intrabar: 'worst',       // how stops and targets fill inside a bar, see FILLS below
// }
//
// Operands: a number, a price field (open/high/low/close/volume/hl2/hlc3/ohlc4), an indicator key
// ('fast'), or an indicator output ('macd.signal'). Signals are read on a bar's close and filled at
// the NEXT bar's open, so the test never trades on information it could not have had.

import { compute, source, BY_ID } from "./indicators.js";

const PRICE_FIELDS = [
  "open",
  "high",
  "low",
  "close",
  "volume",
  "hl2",
  "hlc3",
  "ohlc4",
  "hlcc4",
];
export const OPS = [
  ">",
  "<",
  ">=",
  "<=",
  "crossesAbove",
  "crossesBelow",
  "crosses",
];

// A drawn line as an operand: { line: { t1, p1, t2, p2, extend: 'none' | 'right' | 'both' } }.
// Its price at time t, or NaN where the line doesn't reach (a trend line outside its two points,
// a ray behind its start).
export function linePrice({ t1, p1, t2, p2, extend = "none" }) {
  const slope = t2 !== t1 ? (p2 - p1) / (t2 - t1) : 0;
  const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
  return (t) => {
    if (extend === "none" && (t < lo || t > hi)) return NaN;
    if (extend === "right" && t2 !== t1 && (t - t1) * (t2 - t1) < 0) return NaN;
    return p1 + slope * (t - t1);
  };
}

export function resolveSeries(bars, indicators = {}, cache = {}) {
  return (operand) => {
    if (operand && typeof operand === "object" && operand.line) {
      const at = linePrice(operand.line);
      return (i) => (bars[i] ? at(bars[i].time) : NaN);
    }
    if (typeof operand === "number") return () => operand;
    if (
      typeof operand === "string" &&
      operand.trim() !== "" &&
      !Number.isNaN(Number(operand))
    ) {
      const n = Number(operand);
      return () => n;
    }
    if (PRICE_FIELDS.includes(operand)) {
      cache[operand] ??= source(bars, operand);
      const s = cache[operand];
      return (i) => s[i];
    }
    const [key, out] = String(operand).split(".");
    const spec = indicators[key];
    if (!spec)
      throw new Error(
        `Unknown operand "${operand}". Define it under indicators or use a price field or number.`,
      );
    cache[`@${key}`] ??= compute(spec.id, bars, spec.params || {});
    const res = cache[`@${key}`];
    const outKey =
      out || spec.output || BY_ID[spec.id].outputs[0]?.key || "value";
    const s = res[outKey];
    if (!Array.isArray(s))
      throw new Error(
        `Indicator "${key}" (${spec.id}) has no output "${outKey}"`,
      );
    return (i) => s[i];
  };
}

export function conditionFn(bars, indicators, cache = {}) {
  const get = resolveSeries(bars, indicators, cache);
  return (rule) => {
    const L = get(rule.left),
      R = get(rule.right);
    const op = rule.op;
    return (i) => {
      const l = L(i),
        r = R(i);
      if (
        Number.isNaN(l) ||
        Number.isNaN(r) ||
        l === undefined ||
        r === undefined
      )
        return false;
      switch (op) {
        case ">":
          return l > r;
        case "<":
          return l < r;
        case ">=":
          return l >= r;
        case "<=":
          return l <= r;
        case "crossesAbove":
          return i > 0 && l > r && L(i - 1) <= R(i - 1);
        case "crossesBelow":
          return i > 0 && l < r && L(i - 1) >= R(i - 1);
        case "crosses":
          return (
            i > 0 &&
            ((l > r && L(i - 1) <= R(i - 1)) || (l < r && L(i - 1) >= R(i - 1)))
          );
        default:
          throw new Error(`Unknown operator "${op}"`);
      }
    };
  };
}

// FILLS: a bar only gives open, high, low and close, so where a stop or target filled inside it is a guess.
//   'worst'      stop first whenever a bar touches both (cautious)
//   'ohlc'       TradingView's broker emulator: open, then whichever of high or low is nearer the open, then the
//                other, then close
//   'magnifier'  TradingView's bar magnifier: walk the real lower-timeframe bars inside each bar, each on the
//                'ohlc' path. Pass them as backtest(bars, strategy, { subBars }); bars without any use 'ohlc'.
export const INTRABAR = ["worst", "ohlc", "magnifier"];
const pathOf = (x) =>
  Math.abs(x.open - x.high) < Math.abs(x.open - x.low)
    ? [x.open, x.high, x.low, x.close]
    : [x.open, x.low, x.high, x.close];

// The lower timeframe the magnifier uses: the finest that covers the whole test in at most `max` bars.
export function magnifierTf(tfSeconds, spanSeconds, max = 20000) {
  for (const [tf, sec] of [["1m", 60], ["5m", 300], ["15m", 900], ["1h", 3600], ["4h", 14400]])
    if (sec < tfSeconds && spanSeconds / sec <= max) return { tf, seconds: sec };
  return null;
}

function allOf(fns) {
  return (i) => fns.length > 0 && fns.every((f) => f(i));
}
function anyOf(fns) {
  return (i) => fns.some((f) => f(i));
}

const periodsPerYear = (bars) => {
  if (bars.length < 2) return 252;
  const step = (bars.at(-1).time - bars[0].time) / (bars.length - 1);
  return (365 * 86400) / step;
};

export function backtest(bars, strategy, { subBars = null } = {}) {
  const s = {
    initialCapital: 10000,
    positionPct: 100,
    feePct: 0.1,
    slippagePct: 0.05,
    spreadPct: 0,
    intrabar: "worst",
    stopLossPct: 0,
    takeProfitPct: 0,
    trailingStopPct: 0,
    exitMatch: "all",
    maxBarsInTrade: 0,
    entryLong: [],
    exitLong: [],
    entryShort: [],
    exitShort: [],
    ...strategy,
  };
  const cond = conditionFn(bars, s.indicators || {});
  const exits = s.exitMatch === "any" ? anyOf : allOf;
  const eL = allOf(s.entryLong.map(cond)),
    xL = exits(s.exitLong.map(cond));
  const eS = allOf(s.entryShort.map(cond)),
    xS = exits(s.exitShort.map(cond));
  const fee = s.feePct / 100,
    slip = s.slippagePct / 100,
    half = s.spreadPct / 200;
  // Sub-bars inside each bar, for the magnifier: subAt[i] = [from, to) into subBars.
  const subAt = [];
  let covered = 0;
  if (s.intrabar === "magnifier" && subBars?.length) {
    let j = 0;
    for (let i = 0; i < bars.length; i++) {
      const end = i + 1 < bars.length ? bars[i + 1].time : bars[i].time + (i ? bars[i].time - bars[i - 1].time : 86400);
      while (j < subBars.length && subBars[j].time < bars[i].time) j++;
      const from = j;
      while (j < subBars.length && subBars[j].time < end) j++;
      subAt.push([from, j]);
      if (j > from) covered++;
    }
  }

  let cash = s.initialCapital;
  let pos = null; // { side: 1|-1, qty, entry, entryTime, entryIndex, stop, target, peak }
  const trades = [],
    equity = [];
  let pending = null; // order to fill at next open: { side, reason } or { close: true, reason }

  // What the position would really fill at: the ask to buy, the bid to sell (price is the mid).
  const exitQuote = (price) => price * (1 - pos.side * half);
  const openPos = (i, side, price, reason) => {
    const fill = price * (1 + side * half) * (1 + side * slip);
    const alloc = (cash * s.positionPct) / 100;
    const qty = alloc / (fill * (1 + fee));
    if (qty <= 0) return;
    cash -= qty * fill * (1 + fee);
    pos = {
      side,
      qty,
      entry: fill,
      entryTime: bars[i].time,
      entryIndex: i,
      reason,
      peak: fill,
      stop: s.stopLossPct ? fill * (1 - (side * s.stopLossPct) / 100) : null,
      target: s.takeProfitPct
        ? fill * (1 + (side * s.takeProfitPct) / 100)
        : null,
    };
  };

  const closePos = (i, price, reason) => {
    const fill = price * (1 - pos.side * slip);
    const proceeds =
      pos.side === 1 ? pos.qty * fill : pos.qty * (2 * pos.entry - fill);
    const net = proceeds * (1 - fee);
    const cost = pos.qty * pos.entry * (1 + fee);
    cash += net;
    trades.push({
      side: pos.side === 1 ? "long" : "short",
      entryTime: pos.entryTime,
      exitTime: bars[i].time,
      entryPrice: pos.entry,
      exitPrice: fill,
      qty: pos.qty,
      pnl: net - cost,
      pnlPct: ((net - cost) / cost) * 100,
      bars: i - pos.entryIndex,
      entryReason: pos.reason,
      exitReason: reason,
    });
    pos = null;
  };

  const trail = (p) => {
    pos.peak = pos.side === 1 ? Math.max(pos.peak, p) : Math.min(pos.peak, p);
    const t = pos.peak * (1 - (pos.side * s.trailingStopPct) / 100);
    pos.stop = pos.stop == null ? t : pos.side === 1 ? Math.max(pos.stop, t) : Math.min(pos.stop, t);
  };
  const beyond = (p, level, favour) =>
    level != null && ((pos.side === 1) === favour ? p >= level : p <= level);
  // 'worst': one look at the bar, stop first when both are touched.
  const worstExit = (i, b) => {
    const hi = exitQuote(b.high),
      lo = exitQuote(b.low),
      op = exitQuote(b.open);
    if (s.trailingStopPct) trail(pos.side === 1 ? hi : lo);
    if (beyond(pos.side === 1 ? lo : hi, pos.stop, false))
      closePos(i, pos.side === 1 ? Math.min(pos.stop, op) : Math.max(pos.stop, op), "Stop");
    else if (beyond(pos.side === 1 ? hi : lo, pos.target, true))
      closePos(i, pos.side === 1 ? Math.max(pos.target, op) : Math.min(pos.target, op), "Target");
  };
  // 'ohlc' and 'magnifier': walk each segment's open, near extreme, far extreme, close in order.
  const walkExit = (i, segs) => {
    for (const seg of segs) {
      const pts = pathOf(seg).map(exitQuote);
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        if (k === 0) {
          // A segment that opens past a level gapped through it: filled at the open.
          if (s.trailingStopPct) trail(p);
          if (beyond(p, pos.stop, false)) return closePos(i, p, "Stop");
          if (beyond(p, pos.target, true)) return closePos(i, p, "Target");
          continue;
        }
        const favour = pos.side === 1 ? p > pts[k - 1] : p < pts[k - 1];
        if (favour) {
          if (beyond(p, pos.target, true)) return closePos(i, pos.target, "Target");
          if (s.trailingStopPct) trail(p);
        } else if (beyond(p, pos.stop, false)) return closePos(i, pos.stop, "Stop");
      }
    }
  };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // 1. fill orders decided on the previous close
    if (pending) {
      if (pending.close && pos) closePos(i, exitQuote(b.open), pending.reason);
      if (pending.side && !pos)
        openPos(i, pending.side, b.open, pending.reason);
      pending = null;
    }
    // 2. stops and targets inside this bar (see FILLS)
    if (pos && (pos.stop != null || pos.target != null || s.trailingStopPct)) {
      if (s.intrabar === "ohlc" || s.intrabar === "magnifier") {
        const [from, to] = subAt[i] || [0, 0];
        walkExit(i, to > from ? subBars.slice(from, to) : [b]);
      } else worstExit(i, b);
    }
    // 3. signals on this close -> orders for the next open
    if (i < bars.length - 1) {
      if (pos?.side === 1 && (xL(i) || eS(i)))
        pending = {
          close: true,
          reason: xL(i) ? "Exit long" : "Reverse",
          side: eS(i) ? -1 : 0,
        };
      else if (pos?.side === -1 && (xS(i) || eL(i)))
        pending = {
          close: true,
          reason: xS(i) ? "Exit short" : "Reverse",
          side: eL(i) ? 1 : 0,
        };
      // Time exit: the position has been open maxBarsInTrade bars at this close, so it goes at the next open.
      else if (pos && s.maxBarsInTrade > 0 && i - pos.entryIndex + 1 >= s.maxBarsInTrade)
        pending = { close: true, reason: "Time exit", side: 0 };
      else if (!pos && eL(i)) pending = { side: 1, reason: "Long entry" };
      else if (!pos && eS(i)) pending = { side: -1, reason: "Short entry" };
    }
    // 4. mark to market
    const mtm = pos
      ? pos.side === 1
        ? pos.qty * b.close
        : pos.qty * (2 * pos.entry - b.close)
      : 0;
    equity.push({ time: b.time, value: cash + mtm });
  }
  if (pos) closePos(bars.length - 1, exitQuote(bars.at(-1).close), "End of data");
  if (equity.length) equity[equity.length - 1].value = cash;

  const st = stats(bars, trades, equity, s);
  st.fills =
    s.intrabar === "magnifier"
      ? `Bar magnifier: lower-timeframe bars inside ${covered} of ${bars.length} bars${covered < bars.length ? ", the rest on the OHLC path" : ""}`
      : s.intrabar === "ohlc"
        ? "OHLC path: open, nearer extreme, far extreme, close"
        : "Stop first when a bar touches both";
  st.intrabarCovered = covered;
  return { trades, equity, stats: st };
}

export function stats(bars, trades, equity, s) {
  const start = s.initialCapital,
    end = equity.at(-1)?.value ?? start;
  let peak = -Infinity,
    maxDd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.value);
    maxDd = Math.max(maxDd, (peak - e.value) / peak);
  }
  const rets = equity.slice(1).map((e, i) => e.value / equity[i].value - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(
    rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1),
  );
  const downside = Math.sqrt(
    rets.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / (rets.length || 1),
  );
  const ppy = periodsPerYear(bars);
  const wins = trades.filter((t) => t.pnl > 0),
    losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0),
    grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const years =
    bars.length > 1 ? (bars.at(-1).time - bars[0].time) / (365 * 86400) : 0;
  const inMarket = trades.reduce((a, t) => a + t.bars, 0);
  const round = (v, d = 2) =>
    Number.isFinite(v) ? Number(v.toFixed(d)) : null;
  return {
    netProfit: round(end - start),
    netProfitPct: round(((end - start) / start) * 100),
    buyHoldPct: bars.length
      ? round(((bars.at(-1).close - bars[0].close) / bars[0].close) * 100)
      : null,
    cagrPct:
      years > 0 && end > 0
        ? round(((end / start) ** (1 / years) - 1) * 100)
        : null,
    totalTrades: trades.length,
    winRatePct: trades.length
      ? round((wins.length / trades.length) * 100)
      : null,
    profitFactor:
      grossLoss > 0 ? round(grossWin / grossLoss) : wins.length ? null : 0,
    maxDrawdownPct: round(maxDd * 100),
    avgTradePct: trades.length
      ? round(trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length)
      : null,
    avgWinPct: wins.length
      ? round(wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length)
      : null,
    avgLossPct: losses.length
      ? round(losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length)
      : null,
    largestWin: wins.length ? round(Math.max(...wins.map((t) => t.pnl))) : null,
    largestLoss: losses.length
      ? round(Math.min(...losses.map((t) => t.pnl)))
      : null,
    sharpe: sd > 0 ? round((mean / sd) * Math.sqrt(ppy)) : null,
    sortino: downside > 0 ? round((mean / downside) * Math.sqrt(ppy)) : null,
    exposurePct: bars.length ? round((inMarket / bars.length) * 100) : null,
    feesAndSlippage: `${s.feePct}% fee + ${s.slippagePct}% slippage per side${s.spreadPct ? ` + ${s.spreadPct}% spread` : ""}`,
  };
}

export function tradesCsv(trades) {
  const head =
    "side,entry_time,exit_time,entry_price,exit_price,qty,pnl,pnl_pct,bars,entry_reason,exit_reason";
  const iso = (t) => new Date(t * 1000).toISOString();
  return [
    head,
    ...trades.map((t) =>
      [
        t.side,
        iso(t.entryTime),
        iso(t.exitTime),
        t.entryPrice,
        t.exitPrice,
        t.qty,
        t.pnl.toFixed(2),
        t.pnlPct.toFixed(2),
        t.bars,
        t.entryReason,
        t.exitReason,
      ].join(","),
    ),
  ].join("\n");
}

export const EXAMPLE_STRATEGIES = {
  "EMA cross (9/21)": {
    indicators: {
      fast: { id: "ema", params: { length: 9 } },
      slow: { id: "ema", params: { length: 21 } },
    },
    entryLong: [{ left: "fast", op: "crossesAbove", right: "slow" }],
    exitLong: [{ left: "fast", op: "crossesBelow", right: "slow" }],
  },
  "RSI mean reversion (30/55)": {
    indicators: { rsi: { id: "rsi", params: { length: 14 } } },
    entryLong: [{ left: "rsi", op: "crossesAbove", right: 30 }],
    exitLong: [{ left: "rsi", op: "crossesAbove", right: 55 }],
    stopLossPct: 8,
  },
  "Supertrend follow": {
    indicators: {
      st: {
        id: "supertrend",
        params: { atrLength: 10, factor: 3 },
        output: "direction",
      },
    },
    entryLong: [{ left: "st", op: "<", right: 0 }],
    exitLong: [{ left: "st", op: ">", right: 0 }],
  },
  "MACD + 200 EMA trend filter": {
    indicators: {
      macd: { id: "macd", params: {} },
      trend: { id: "ema", params: { length: 200 } },
    },
    entryLong: [
      { left: "macd.macd", op: "crossesAbove", right: "macd.signal" },
      { left: "close", op: ">", right: "trend" },
    ],
    exitLong: [{ left: "macd.macd", op: "crossesBelow", right: "macd.signal" }],
  },
  "Bollinger breakout": {
    indicators: { bb: { id: "bb", params: { length: 20, mult: 2 } } },
    entryLong: [{ left: "close", op: "crossesAbove", right: "bb.upper" }],
    exitLong: [{ left: "close", op: "crossesBelow", right: "bb.basis" }],
    trailingStopPct: 10,
  },
};
