import { backtest, type BacktestResult, type Strategy } from "./library.js";
import { computeSeries, ruleText, type Bar, type IndicatorKey, type Rule, type Series } from "./ruleEngine.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Träning av en strategi (parameter-optimering med kontroll)
//
//  Boten provar hundratals varianter av strategin på historiken: andra
//  gränsvärden (t.ex. RSI 25 istället för 30), andra medellinjer (EMA20
//  istället för EMA9), olika stop och target. Varje variant backtestas.
//
//  För att inte "lära sig historien utantill" delas historiken i två:
//    träning  = de första 70 % av ljusen → här väljs de bästa varianterna
//    kontroll = de sista 30 % → här testas de, på data de aldrig sett
//  Ett förslag godkänns bara om det också är bättre på kontrolldelen.
//
//  Träningen ändrar INGENTING själv. Den ger ett förslag som Mike kan
//  använda med en knapp, och strategin ligger kvar i TEST tills han flyttar den.
// ═══════════════════════════════════════════════════════════════════════════

export type HistBar = Bar & { openTime: number; closeTime: number };

type Params = Pick<Strategy, "entry" | "exit" | "stopAtr" | "targetAtr">;

export interface TrainScore {
  returnPct: number;
  maxDrawdownPct: number;
  trades: number;
  winRatePct: number;
  buyAndHoldPct: number;
  score: number;
}

export interface TrainCandidate {
  params: Params;
  rulesText: { entry: string[]; exit: string[] };
  train: TrainScore;
  check: TrainScore;
}

export interface TrainResult {
  ok: true;
  strategyId: string;
  strategyName: string;
  interval: string;
  coins: string[];
  candlesPerCoin: Record<string, number>;
  splitPct: number;
  variantsTested: number;
  current: TrainCandidate;
  best: TrainCandidate;
  top: TrainCandidate[];
  verdict: "bättre" | "behåll" | "för-lite-data";
  verdictText: string;
  trainedAt: string;
  ms: number;
}

const MA: IndicatorKey[] = ["ema9", "ema20", "ema50", "ema200", "sma20", "sma50", "sma200"];
const RSI: IndicatorKey[] = ["rsi14", "rsi7"];
const STOPS = [0, 1, 1.5, 2, 3];
const TARGETS = [0, 2, 3, 4, 6];

/** Liten deterministisk slump så att samma träning ger samma svar. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uniq = <T>(xs: T[]): T[] => {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; });
};

/** Alla rimliga varianter av en regel (inklusive den ursprungliga först). */
function ruleVariants(r: Rule): Rule[] {
  const out: Rule[] = [r];
  const lefts: IndicatorKey[] = MA.includes(r.left) ? MA : RSI.includes(r.left) ? RSI : [r.left];
  for (const left of lefts) {
    if (typeof r.right === "number") {
      const n = r.right;
      let nums: number[];
      if (left.startsWith("rsi")) nums = [-10, -5, 0, 5, 10].map((d) => Math.min(95, Math.max(5, n + d)));
      else if (n === 0) nums = [0];
      else nums = [0.8, 0.9, 1, 1.1, 1.2].map((f) => +(n * f).toPrecision(4));
      for (const right of nums) out.push({ ...r, left, right });
    } else {
      const rights: IndicatorKey[] = MA.includes(r.right) ? MA : [r.right];
      const factors = r.left === "volume" || r.right === "vol_sma20"
        ? [1, 1.2, 1.5, 2]
        : [r.factor ?? 1];
      for (const right of rights) {
        if (right === left) continue;
        for (const f of factors) {
          const rule: Rule = { ...r, left, right };
          if (f !== 1) rule.factor = f; else delete rule.factor;
          out.push(rule);
        }
      }
    }
  }
  return uniq(out);
}

/** Bygger upp till `max` olika varianter av strategin. Varianten "som nu" är alltid nummer 1. */
export function buildVariants(s: Params, max = 300, seed = 1): Params[] {
  const dims: Array<{ kind: "entry" | "exit"; i: number; opts: Rule[] }> = [
    ...s.entry.map((r, i) => ({ kind: "entry" as const, i, opts: ruleVariants(r) })),
    ...s.exit.map((r, i) => ({ kind: "exit" as const, i, opts: ruleVariants(r) })),
  ];
  const stops = uniq([s.stopAtr, ...STOPS]);
  const targets = uniq([s.targetAtr, ...TARGETS]);
  const pick = (choice: number[]): Params => {
    const entry = s.entry.slice();
    const exit = s.exit.slice();
    dims.forEach((d, k) => { (d.kind === "entry" ? entry : exit)[d.i] = d.opts[choice[k]!]!; });
    return { entry, exit, stopAtr: stops[choice[dims.length]!]!, targetAtr: targets[choice[dims.length + 1]!]! };
  };
  const sizes = [...dims.map((d) => d.opts.length), stops.length, targets.length];
  const total = sizes.reduce((a, b) => a * b, 1);
  const out: Params[] = [pick(sizes.map(() => 0))];
  const seen = new Set<string>([JSON.stringify(out[0])]);
  const add = (choice: number[]) => {
    const p = pick(choice);
    const k = JSON.stringify(p);
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  };
  if (total <= max) {
    // Få kombinationer: prova alla.
    for (let n = 0; n < total; n++) {
      let rest = n;
      add(sizes.map((sz) => { const c = rest % sz; rest = Math.floor(rest / sz); return c; }));
    }
  } else {
    // Först: ändra en sak i taget (lätt att förstå), sedan slumpade kombinationer.
    sizes.forEach((sz, k) => { for (let c = 1; c < sz && out.length < max; c++) add(sizes.map((_, j) => (j === k ? c : 0))); });
    const rand = rng(seed);
    for (let tries = 0; out.length < max && tries < max * 20; tries++) add(sizes.map((sz) => Math.floor(rand() * sz)));
  }
  return out.slice(0, max);
}

/** Poäng: avkastning minus halva det största raset, så att en lugn strategi slår en vild. */
function scoreOf(results: BacktestResult[], minTrades: number): TrainScore {
  const n = results.length || 1;
  const returnPct = results.reduce((a, r) => a + r.totalReturnPct, 0) / n;
  const maxDrawdownPct = results.reduce((a, r) => a + r.maxDrawdownPct, 0) / n;
  const trades = results.reduce((a, r) => a + r.trades, 0);
  const wins = results.reduce((a, r) => a + r.wins, 0);
  const buyAndHoldPct = results.reduce((a, r) => a + r.buyAndHoldPct, 0) / n;
  const score = trades < minTrades ? -1e9 + trades : returnPct - 0.5 * maxDrawdownPct;
  return { returnPct, maxDrawdownPct, trades, winRatePct: trades ? (wins / trades) * 100 : 0, buyAndHoldPct, score };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const roundScore = (t: TrainScore): TrainScore => ({
  returnPct: r2(t.returnPct), maxDrawdownPct: r2(t.maxDrawdownPct), trades: t.trades,
  winRatePct: r2(t.winRatePct), buyAndHoldPct: r2(t.buyAndHoldPct), score: r2(t.score),
});

/**
 * Tränar en strategi över historik per coin. `history` = coin → ljus (äldst först).
 * Ren funktion: hämtar ingen data och sparar inget.
 */
export function trainStrategy(
  s: Strategy,
  history: Record<string, HistBar[]>,
  opts: { maxVariants?: number; splitPct?: number; feePctPerSide?: number } = {},
): TrainResult {
  const t0 = Date.now();
  const split = Math.min(0.9, Math.max(0.5, (opts.splitPct ?? 70) / 100));
  const fee = opts.feePctPerSide ?? 0.1;
  const coins = Object.keys(history).filter((c) => (history[c]?.length ?? 0) >= 150);
  const data: Array<{ bars: HistBar[]; series: Series; cut: number }> = coins.map((c) => {
    const bars = history[c]!;
    return { bars, series: computeSeries(bars), cut: Math.floor(bars.length * split) };
  });
  // Minst 2 affärer per coin i träningen, annars räknas varianten inte.
  const minTrain = Math.max(3, coins.length * 2);
  const minCheck = Math.max(1, coins.length);

  const run = (p: Params, part: "train" | "check", min: number) => scoreOf(
    data.map((d) => backtest(p, d.bars, fee, part === "train"
      ? { series: d.series, from: 1, to: d.cut }
      : { series: d.series, from: d.cut, to: d.bars.length })),
    min,
  );
  const describe = (p: Params, train: TrainScore, check: TrainScore): TrainCandidate => ({
    params: p,
    rulesText: { entry: p.entry.map(ruleText), exit: p.exit.map(ruleText) },
    train: roundScore(train),
    check: roundScore(check),
  });

  const variants = buildVariants(s, opts.maxVariants ?? 300);
  const baseTrain = run(variants[0]!, "train", minTrain);
  const baseCheck = run(variants[0]!, "check", minCheck);
  const current = describe(variants[0]!, baseTrain, baseCheck);

  const now = new Date().toISOString();
  const candlesPerCoin = Object.fromEntries(coins.map((c, i) => [c, data[i]!.bars.length]));
  if (!coins.length) {
    return {
      ok: true, strategyId: s.id, strategyName: s.name, interval: s.interval, coins, candlesPerCoin,
      splitPct: split * 100, variantsTested: 0, current, best: current, top: [],
      verdict: "för-lite-data", verdictText: "För lite historik för att träna (minst 150 ljus per coin behövs).",
      trainedAt: now, ms: Date.now() - t0,
    };
  }

  // 1) Rangordna alla varianter på träningsdelen.
  const ranked = variants
    .map((p) => ({ p, train: run(p, "train", minTrain) }))
    .filter((x) => x.train.score > -1e8)
    .sort((a, b) => b.train.score - a.train.score)
    .slice(0, 10);
  // 2) De tio bästa får visa vad de klarar på kontrolldelen. Vinnaren är den
  //    som är stabilast: bäst på sin SÄMSTA del, så att en variant som bara
  //    hade tur på en av delarna inte vinner.
  const steady = (c: TrainCandidate) => Math.min(c.train.score, c.check.score);
  const top = ranked
    .map((x) => describe(x.p, x.train, run(x.p, "check", minCheck)))
    .sort((a, b) => steady(b) - steady(a) || b.train.score - a.train.score);

  const best = top[0] ?? current;
  const sameAsNow = JSON.stringify(best.params) === JSON.stringify(current.params);
  let verdict: TrainResult["verdict"];
  let verdictText: string;
  if (!top.length) {
    verdict = "för-lite-data";
    verdictText = `Ingen variant gjorde minst ${minTrain} affärer i träningsdelen. Prova ett kortare intervall eller fler coins.`;
  } else if (!sameAsNow && best.check.score > current.check.score + 0.25 && best.check.returnPct > 0 && best.check.trades >= minCheck) {
    verdict = "bättre";
    verdictText = `Förslaget gav ${best.check.returnPct}% på kontrolldata (som nu: ${current.check.returnPct}%), med ${best.check.trades} affärer. Det har inte sett den datan under träningen.`;
  } else {
    verdict = "behåll";
    verdictText = best.check.returnPct <= 0
      ? `Ingen variant tjänade pengar på kontrolldata. Låt strategin köra i TEST innan något ändras.`
      : `Inget förslag var tydligt bättre än strategin som den är på kontrolldata. Behåll den.`;
  }

  return {
    ok: true, strategyId: s.id, strategyName: s.name, interval: s.interval, coins, candlesPerCoin,
    splitPct: split * 100, variantsTested: variants.length, current, best, top: top.slice(0, 5),
    verdict, verdictText, trainedAt: now, ms: Date.now() - t0,
  };
}
