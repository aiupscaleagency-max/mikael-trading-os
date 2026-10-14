// Alerts run on the server, so they keep firing while the browser tab is closed (as long as the
// app is running). An alert is a condition in the same format the strategy tester uses:
//
// { symbol: 'BINANCE:BTCUSDT', tf: '1h', left: 'close', op: 'crossesAbove', right: 100000,
//   indicators: {}, trigger: 'once' | 'oncePerBar' | 'oncePerBarClose', webhook: 'https://...',
//   message: 'BTC broke 100k' }

import crypto from "node:crypto";
import { getCandles } from "./providers.js";
import { conditionFn } from "../public/lib/backtest.js";
import * as store from "./store.js";

let alerts = store.read("alerts", []);
let log = store.read("alert-log", []);
let listeners = new Set();
let timer = null;

export const list = () => alerts;
export const history = () => log;
export function onFire(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const save = () => store.write("alerts", alerts);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const OPS = [">", "<", ">=", "<=", "crossesAbove", "crossesBelow", "crosses"];
// A short synthetic series is enough to check that every operand and indicator in a rule exists.
const PROBE = Array.from({ length: 300 }, (_, t) => {
  const c = 100 + 10 * Math.sin(t / 7);
  return { time: t * 60, open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1000 + t };
});

// Up to five conditions (TradingView's multi-condition alerts); `match` says whether all or any
// must hold. Older alerts with a single left/op/right still work.
export const conditionsOf = (a) =>
  Array.isArray(a.conditions) && a.conditions.length ? a.conditions : [{ left: a.left, op: a.op, right: a.right }];

function validate(a) {
  if (!a.symbol || typeof a.symbol !== "string") throw bad("An alert needs a symbol");
  const conds = conditionsOf(a);
  if (conds.length > 5) throw bad("An alert can have up to 5 conditions");
  if (!["all", "any"].includes(a.match || "all")) throw bad('match must be "all" or "any"');
  if (a.webhook && !/^https?:\/\/\S+$/i.test(a.webhook)) throw bad("Webhook must be an http(s) URL");
  for (const c of conds) {
    if (c.right === undefined || c.right === null || c.right === "")
      throw bad("An alert needs something to compare against");
    if (!OPS.includes(c.op)) throw bad(`Unknown operator "${c.op}". Use one of ${OPS.join(", ")}`);
    try {
      conditionFn(PROBE, a.indicators || {})(c)(299);
    } catch (e) {
      throw bad(e.message);
    }
  }
}

export function add(input) {
  if (!input || typeof input !== "object") throw bad("Send the alert as a JSON object");
  const a = {
    id: crypto.randomUUID(),
    symbol: input.symbol,
    tf: input.tf || "1m",
    left: input.left ?? input.conditions?.[0]?.left ?? "close",
    op: input.op || input.conditions?.[0]?.op || "crossesAbove",
    right: input.right ?? input.conditions?.[0]?.right,
    conditions: Array.isArray(input.conditions) ? input.conditions : undefined,
    match: input.match || "all",
    indicators: input.indicators || {},
    trigger: input.trigger || "once",
    webhook: input.webhook || "",
    message: input.message || "",
    active: true,
    createdAt: new Date().toISOString(),
    lastBar: null,
    fired: 0,
  };
  validate(a);
  alerts.push(a);
  save();
  return a;
}

export function update(id, patch) {
  const a = alerts.find((x) => x.id === id);
  if (!a) throw bad("No such alert", 404);
  validate({ ...a, ...patch });
  Object.assign(a, patch, { id });
  save();
  return a;
}

export function remove(id) {
  alerts = alerts.filter((a) => a.id !== id);
  save();
}

export function describe(a) {
  const ops = {
    ">": "is above",
    "<": "is below",
    ">=": "is at or above",
    "<=": "is at or below",
    crossesAbove: "crosses above",
    crossesBelow: "crosses below",
    crosses: "crosses",
  };
  const name = (o) => (o && typeof o === "object" && o.line ? "your drawn line" : o);
  const parts = conditionsOf(a).map((c) => `${name(c.left)} ${ops[c.op] || c.op} ${name(c.right)}`);
  return a.message || `${a.symbol} ${a.tf}: ${parts.join(a.match === "any" ? " or " : " and ")}`;
}

async function sendWebhook(url, text, payload) {
  let body;
  const host = new URL(url).host;
  if (host.includes("discord")) body = { content: text };
  else if (host.includes("slack.com")) body = { text };
  else if (host.includes("telegram.org")) body = { text };
  else body = { text, content: text, ...payload };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
}

async function fire(a, bar, price) {
  const text = `Alert: ${describe(a)} (price ${price})`;
  const event = {
    id: crypto.randomUUID(),
    alertId: a.id,
    symbol: a.symbol,
    tf: a.tf,
    text,
    price,
    barTime: bar.time,
    at: new Date().toISOString(),
  };
  a.fired += 1;
  a.lastFiredAt = event.at;
  if (a.trigger === "once") a.active = false;
  if (a.webhook) {
    try {
      await sendWebhook(a.webhook, text, { alert: a, event });
      event.webhook = "sent";
    } catch (e) {
      event.webhook = `failed: ${e.message}`;
    }
  }
  log.unshift(event);
  log = log.slice(0, 500);
  store.write("alert-log", log);
  for (const fn of listeners) fn(event);
}

// One evaluation at a time: the timer and a manual "check now" must not both fire a "once" alert.
let running = null;
export function evaluate() {
  running ||= evaluateOnce().finally(() => {
    running = null;
  });
  return running;
}

async function evaluateOnce() {
  const active = alerts.filter((a) => a.active);
  const groups = new Map();
  for (const a of active) {
    const k = `${a.symbol}|${a.tf}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  for (const [k, group] of groups) {
    const [symbol, tf] = k.split("|");
    let bars;
    try {
      ({ candles: bars } = await getCandles(symbol, tf, 400));
    } catch {
      continue;
    }
    if (bars.length < 3) continue;
    for (const a of group) {
      try {
        const make = conditionFn(bars, a.indicators);
        const tests = conditionsOf(a).map((c) => make(c));
        const test = (k) => (a.match === "any" ? tests.some((t) => t(k)) : tests.every((t) => t(k)));
        const i =
          a.trigger === "oncePerBarClose" ? bars.length - 2 : bars.length - 1;
        const bar = bars[i];
        if (a.trigger !== "once" && a.lastBar === bar.time) continue;
        if (test(i)) {
          a.lastBar = bar.time;
          await fire(a, bar, bar.close);
        }
      } catch (e) {
        a.error = e.message;
      }
    }
  }
  save();
}

export function start(intervalMs = 15000) {
  if (timer) return;
  const tick = () =>
    evaluate()
      .catch(() => {})
      .finally(() => {
        timer = setTimeout(tick, intervalMs);
      });
  timer = setTimeout(tick, 2000);
}

export function stop() {
  clearTimeout(timer);
  timer = null;
}
