// ═══════════════════════════════════════════════════════════════════════════
//  Regelmotor för strategibiblioteket
//
//  En strategi är en lista regler som "RSI14 < 30" eller "EMA9 korsar över
//  EMA20". Alla regler i en lista måste stämma (OCH). Reglerna räknas på
//  STÄNGDA ljus, samma regel som signalmotorn, så att en signal inte kan
//  dyka upp och försvinna inom samma ljus.
//
//  Indikatorerna räknas som hela serier en gång per utvärdering. Då kan
//  samma kod användas både live (sista ljuset) och i backtest (varje ljus),
//  och "korsar över" jämför exakt samma värden som diagrammet visar.
// ═══════════════════════════════════════════════════════════════════════════

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const INDICATORS = {
  close: "Pris (stängning)",
  open: "Öppning",
  high: "Högsta i ljuset",
  low: "Lägsta i ljuset",
  volume: "Volym",
  vol_sma20: "Snittvolym 20",
  rsi14: "RSI 14",
  rsi7: "RSI 7",
  sma20: "SMA 20",
  sma50: "SMA 50",
  sma200: "SMA 200",
  ema9: "EMA 9",
  ema20: "EMA 20",
  ema50: "EMA 50",
  ema200: "EMA 200",
  macd: "MACD-linje",
  macd_signal: "MACD-signal",
  macd_hist: "MACD-histogram",
  bb_upper: "Bollinger övre",
  bb_mid: "Bollinger mitt",
  bb_lower: "Bollinger undre",
  atr14: "ATR 14",
  atr_pct: "ATR i % av pris",
  change_pct: "Ändring senaste ljus %",
  high20: "Högsta 20 ljus (före detta)",
  low20: "Lägsta 20 ljus (före detta)",
} as const;

export type IndicatorKey = keyof typeof INDICATORS;
export const INDICATOR_KEYS = Object.keys(INDICATORS) as IndicatorKey[];

export const OPERATORS = {
  ">": "över",
  "<": "under",
  ">=": "minst",
  "<=": "högst",
  crosses_above: "korsar över",
  crosses_below: "korsar under",
} as const;

export type Operator = keyof typeof OPERATORS;

export interface Rule {
  left: IndicatorKey;
  op: Operator;
  /** Ett tal (t.ex. 30) eller en annan indikator (t.ex. "sma50"). */
  right: IndicatorKey | number;
  /** Multiplikator för höger sida när den är en indikator, t.ex. 1.02 = 2 % över. */
  factor?: number;
}

export type Series = Record<IndicatorKey, Array<number | null>>;

// ─── Serier ───────────────────────────────────────────────────────────────

function smaSeries(v: number[], p: number): Array<number | null> {
  const out: Array<number | null> = new Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i]!;
    if (i >= p) sum -= v[i - p]!;
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

function emaSeries(v: Array<number | null>, p: number): Array<number | null> {
  const out: Array<number | null> = new Array(v.length).fill(null);
  const k = 2 / (p + 1);
  let start = v.findIndex((x) => x !== null);
  if (start < 0) return out;
  if (v.length - start < p) return out;
  // Startar på SMA över de första p värdena, samma konvention som ta.ts.
  let acc = 0;
  for (let i = start; i < start + p; i++) acc += v[i]!;
  let e = acc / p;
  out[start + p - 1] = e;
  for (let i = start + p; i < v.length; i++) {
    e = v[i]! * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function rsiSeries(v: number[], p: number): Array<number | null> {
  const out: Array<number | null> = new Array(v.length).fill(null);
  if (v.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = v[i]! - v[i - 1]!;
    if (d >= 0) g += d; else l -= d;
  }
  let ag = g / p, al = l / p;
  const val = () => (al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  out[p] = val();
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i]! - v[i - 1]!;
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = val();
  }
  return out;
}

function atrSeries(b: Bar[], p: number): Array<number | null> {
  const out: Array<number | null> = new Array(b.length).fill(null);
  if (b.length <= p) return out;
  const tr: number[] = [0];
  for (let i = 1; i < b.length; i++) {
    const c = b[i]!, pc = b[i - 1]!.close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  let a = 0;
  for (let i = 1; i <= p; i++) a += tr[i]!;
  a /= p;
  out[p] = a;
  for (let i = p + 1; i < b.length; i++) {
    a = (a * (p - 1) + tr[i]!) / p;
    out[i] = a;
  }
  return out;
}

function rolling(v: number[], p: number, fn: (xs: number[]) => number, excludeCurrent: boolean): Array<number | null> {
  return v.map((_, i) => {
    const end = excludeCurrent ? i : i + 1;
    const start = end - p;
    if (start < 0) return null;
    return fn(v.slice(start, end));
  });
}

export function computeSeries(bars: Bar[]): Series {
  const close = bars.map((b) => b.close);
  const volume = bars.map((b) => b.volume);
  const ema12 = emaSeries(close, 12);
  const ema26 = emaSeries(close, 26);
  const macdLine = close.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null));
  const macdSig = emaSeries(macdLine, 9);
  const sma20 = smaSeries(close, 20);
  const std20 = rolling(close, 20, (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  }, false);
  const atr14 = atrSeries(bars, 14);
  return {
    close,
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    volume,
    vol_sma20: smaSeries(volume, 20),
    rsi14: rsiSeries(close, 14),
    rsi7: rsiSeries(close, 7),
    sma20,
    sma50: smaSeries(close, 50),
    sma200: smaSeries(close, 200),
    ema9: emaSeries(close, 9),
    ema20: emaSeries(close, 20),
    ema50: emaSeries(close, 50),
    ema200: emaSeries(close, 200),
    macd: macdLine,
    macd_signal: macdSig,
    macd_hist: macdLine.map((m, i) => (m != null && macdSig[i] != null ? m - macdSig[i]! : null)),
    bb_upper: sma20.map((m, i) => (m != null && std20[i] != null ? m + 2 * std20[i]! : null)),
    bb_mid: sma20,
    bb_lower: sma20.map((m, i) => (m != null && std20[i] != null ? m - 2 * std20[i]! : null)),
    atr14,
    atr_pct: atr14.map((a, i) => (a != null && close[i]! > 0 ? (a / close[i]!) * 100 : null)),
    change_pct: close.map((c, i) => (i > 0 && close[i - 1]! > 0 ? ((c - close[i - 1]!) / close[i - 1]!) * 100 : null)),
    high20: rolling(bars.map((b) => b.high), 20, (xs) => Math.max(...xs), true),
    low20: rolling(bars.map((b) => b.low), 20, (xs) => Math.min(...xs), true),
  };
}

// ─── Utvärdering ──────────────────────────────────────────────────────────

function sideValue(s: Series, side: IndicatorKey | number, i: number, factor = 1): number | null {
  if (typeof side === "number") return side;
  const v = s[side]?.[i];
  return v == null ? null : v * factor;
}

export interface RuleResult {
  rule: Rule;
  text: string;
  pass: boolean;
  /** null när indikatorn saknar data (för få ljus). */
  left: number | null;
  right: number | null;
}

export function ruleText(r: Rule): string {
  const l = INDICATORS[r.left] ?? r.left;
  const rt = typeof r.right === "number"
    ? String(r.right)
    : `${INDICATORS[r.right] ?? r.right}${r.factor && r.factor !== 1 ? ` × ${r.factor}` : ""}`;
  return `${l} ${OPERATORS[r.op] ?? r.op} ${rt}`;
}

export function evalRule(s: Series, r: Rule, i: number): RuleResult {
  const left = sideValue(s, r.left, i);
  const right = sideValue(s, r.right, i, typeof r.right === "number" ? 1 : r.factor ?? 1);
  const base = { rule: r, text: ruleText(r), left, right };
  if (left == null || right == null) return { ...base, pass: false };
  switch (r.op) {
    case ">": return { ...base, pass: left > right };
    case "<": return { ...base, pass: left < right };
    case ">=": return { ...base, pass: left >= right };
    case "<=": return { ...base, pass: left <= right };
    case "crosses_above":
    case "crosses_below": {
      if (i < 1) return { ...base, pass: false };
      const pl = sideValue(s, r.left, i - 1);
      const pr = sideValue(s, r.right, i - 1, typeof r.right === "number" ? 1 : r.factor ?? 1);
      if (pl == null || pr == null) return { ...base, pass: false };
      const pass = r.op === "crosses_above" ? pl <= pr && left > right : pl >= pr && left < right;
      return { ...base, pass };
    }
    default:
      return { ...base, pass: false };
  }
}

/** Alla regler måste stämma. En tom lista stämmer aldrig (annars köps varje ljus). */
export function evalAll(s: Series, rules: Rule[], i: number): { pass: boolean; results: RuleResult[] } {
  const results = rules.map((r) => evalRule(s, r, i));
  return { pass: results.length > 0 && results.every((r) => r.pass), results };
}

/** Kontrollerar och städar en regel som kommer utifrån (formulär eller AI). */
export function sanitizeRule(raw: unknown): Rule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const left = String(r.left ?? "") as IndicatorKey;
  const op = String(r.op ?? "") as Operator;
  if (!INDICATOR_KEYS.includes(left) || !(op in OPERATORS)) return null;
  let right: IndicatorKey | number;
  if (typeof r.right === "number" && Number.isFinite(r.right)) right = r.right;
  else if (typeof r.right === "string" && INDICATOR_KEYS.includes(r.right as IndicatorKey)) right = r.right as IndicatorKey;
  else if (typeof r.right === "string" && r.right.trim() !== "" && Number.isFinite(Number(r.right))) right = Number(r.right);
  else return null;
  const out: Rule = { left, op, right };
  const f = Number(r.factor);
  if (typeof right !== "number" && Number.isFinite(f) && f > 0 && f !== 1) out.factor = f;
  return out;
}
