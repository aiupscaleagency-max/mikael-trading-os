import { dataDir, dataPath } from "../dataDir.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { computeSeries, evalAll, sanitizeRule, type Bar, type Rule, type RuleResult, type Series } from "./ruleEngine.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Strategibiblioteket — Mikes egna strategibottar
//
//  Varje strategi gäller en eller flera coins (BTC, ETH, SOL …) på ett
//  intervall och har två regellistor:
//    entry → KÖP när alla regler stämmer och strategin inte redan "äger" coinet
//    exit  → SÄLJ när alla regler stämmer, eller när stop/target nås
//
//  Spot har ingen blankning, så strategierna köper och säljer bara.
//  Biblioteket sparas i data/strategies.json och ändras från dashboarden.
//  Strategierna LÄGGER INGA ORDRAR själva: en signal blir en väntande order
//  först när Mike trycker på knappen (eller när autoQueue är på), och även
//  då krävs Godkänn plus order-grindens gränser.
// ═══════════════════════════════════════════════════════════════════════════

export const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
export type StrategyInterval = (typeof INTERVALS)[number];

/** Vilka AI-modeller en strategi kan be om en granskning från. */
export const REVIEW_MODELS: Record<string, string> = {
  auto: "Auto (JEV väljer)",
  "anthropic/claude-haiku-4.5": "Claude Haiku 4.5 (snabb, billig)",
  "anthropic/claude-sonnet-5.5": "Claude Sonnet 5.5 (balanserad)",
  "openai/gpt-6-astra": "GPT-6 Astra (andra åsikt, dyrast)",
};

export interface Strategy {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Bas-coins, t.ex. ["BTC", "ETH"]. Mappas till verifierade IG-EPICs i aktiv miljö. */
  coins: string[];
  interval: StrategyInterval;
  entry: Rule[];
  exit: Rule[];
  /** Stop-loss i ATR från köppriset. 0 = ingen ATR-stop (bara exit-regler). */
  stopAtr: number;
  /** Target i ATR från köppriset. 0 = inget target. */
  targetAtr: number;
  /** Belopp per köp i USD. Order-grinden tar ändå max $5 i LIVE. */
  stakeUsd: number;
  /** Var signalerna köas: test = TEST-mäklaren (Alpaca paper), live = IG Live. */
  venue: "test" | "live";
  /** off = bara reglerna · jev = JEV bedömer · jev_ai = JEV + AI-modell granskar */
  review: "off" | "jev" | "jev_ai";
  /** "auto" eller ett modell-id ur REVIEW_MODELS (eller annat gateway-id). */
  reviewModel: string;
  /** Lägg godkända signaler direkt som väntande order (kräver fortfarande Godkänn). */
  autoQueue: boolean;
  /** Mikes egen text, om strategin skapades med "beskriv med egna ord". */
  sourceText?: string;
  /** Agenten i teamet som äger strategin (t.ex. "technical" = Tomas). Bara för visning och uppföljning. */
  agent?: string;
  /** Fast nyckel för strategier som lagts in av systemet, så att de bara läggs in en gång. */
  seed?: string;
  createdAt: string;
  updatedAt: string;
}

const FILE = dataPath("strategies.json");
let cache: Strategy[] | null = null;

const now = () => new Date().toISOString();

/** Exempel som finns i biblioteket från start. Bara den första är påslagen. */
function starterLibrary(): Strategy[] {
  const base = {
    description: "", stopAtr: 1.5, targetAtr: 3, stakeUsd: 5, venue: "test" as const,
    review: "jev" as const, reviewModel: "auto", autoQueue: false, createdAt: now(), updatedAt: now(),
  };
  return [
    {
      ...base,
      id: crypto.randomUUID(),
      name: "EMA-kors (trend)",
      description: "Köper när snabba EMA9 korsar upp genom EMA20 och priset ligger över SMA50. Säljer när EMA9 korsar ned igen.",
      enabled: true,
      coins: ["BTC", "ETH", "SOL"],
      interval: "5m",
      entry: [
        { left: "ema9", op: "crosses_above", right: "ema20" },
        { left: "close", op: ">", right: "sma50" },
      ],
      exit: [{ left: "ema9", op: "crosses_below", right: "ema20" }],
    },
    {
      ...base,
      id: crypto.randomUUID(),
      name: "RSI-studs (köp dippen i upptrend)",
      description: "Köper när RSI14 är översålt under 30 men priset fortfarande ligger över SMA200. Säljer när RSI passerat 55.",
      enabled: false,
      coins: ["BTC", "ETH"],
      interval: "15m",
      entry: [
        { left: "rsi14", op: "<", right: 30 },
        { left: "close", op: ">", right: "sma200" },
      ],
      exit: [{ left: "rsi14", op: ">", right: 55 }],
    },
    {
      ...base,
      id: crypto.randomUUID(),
      name: "Breakout med volym",
      description: "Köper när priset stänger över de senaste 20 ljusens högsta och volymen är 50 % över snittet.",
      enabled: false,
      coins: ["SOL", "XRP", "DOGE"],
      interval: "1h",
      entry: [
        { left: "close", op: ">", right: "high20" },
        { left: "volume", op: ">", right: "vol_sma20", factor: 1.5 },
      ],
      exit: [{ left: "close", op: "<", right: "ema20" }],
      stopAtr: 2,
      targetAtr: 4,
    },
  ];
}

/** Vilken agent som äger de tre startstrategierna (matchas på namn). */
const STARTER_OWNER: Record<string, string> = {
  "EMA-kors (trend)": "technical",
  "RSI-studs (köp dippen i upptrend)": "quant",
  "Breakout med volym": "sentiment",
};

/**
 * En egen strategi per agent som inte hade någon. De läggs in AVSTÄNGDA i TEST,
 * bara en gång (seed), och Mike slår på dem själv. Inget befintligt ändras.
 */
function agentSeeds(): Strategy[] {
  const base = {
    stakeUsd: 5, venue: "test" as const, review: "jev" as const, reviewModel: "auto",
    autoQueue: false, enabled: false, createdAt: now(), updatedAt: now(),
  };
  return [
    {
      ...base,
      id: crypto.randomUUID(),
      seed: "agent-macro-trend-4h",
      agent: "macro",
      name: "Markus · långsam trend (4h)",
      description: "Köper när EMA20 korsar upp genom EMA50 och priset ligger över SMA200 på 4-timmarsljus. Säljer när EMA20 korsar ned igen.",
      coins: ["BTC", "ETH"],
      interval: "4h",
      entry: [
        { left: "ema20", op: "crosses_above", right: "ema50" },
        { left: "close", op: ">", right: "sma200" },
      ],
      exit: [{ left: "ema20", op: "crosses_below", right: "ema50" }],
      stopAtr: 2,
      targetAtr: 5,
    },
    {
      ...base,
      id: crypto.randomUUID(),
      seed: "agent-risk-bollinger-15m",
      agent: "risk",
      name: "Rasmus · Bollinger-studs (15m)",
      description: "Köper när priset stänger under det undre Bollingerbandet och RSI14 är under 35. Säljer vid mittbandet. Stop 1,5 ATR.",
      coins: ["AVAX", "LINK"],
      interval: "15m",
      entry: [
        { left: "close", op: "<", right: "bb_lower" },
        { left: "rsi14", op: "<", right: 35 },
      ],
      exit: [{ left: "close", op: ">", right: "bb_mid" }],
      stopAtr: 1.5,
      targetAtr: 2.5,
    },
    {
      ...base,
      id: crypto.randomUUID(),
      seed: "agent-portfolio-macd-1h",
      agent: "portfolio",
      name: "Petra · MACD-vändning (1h)",
      description: "Köper när MACD-linjen korsar upp genom signallinjen och priset ligger över EMA50. Säljer när MACD korsar ned.",
      coins: ["ADA", "DOT", "LTC"],
      interval: "1h",
      entry: [
        { left: "macd", op: "crosses_above", right: "macd_signal" },
        { left: "close", op: ">", right: "ema50" },
      ],
      exit: [{ left: "macd", op: "crosses_below", right: "macd_signal" }],
      stopAtr: 1.5,
      targetAtr: 3,
    },
  ];
}

/** Lägger till agent-ägare och saknade agentstrategier. Returnerar true om något ändrades. */
function addAgentStrategies(list: Strategy[]): boolean {
  let changed = false;
  for (const s of list) {
    if (!s.agent && STARTER_OWNER[s.name]) { s.agent = STARTER_OWNER[s.name]; changed = true; }
  }
  for (const seed of agentSeeds()) {
    if (!list.some((s) => s.seed === seed.seed)) { list.push(seed); changed = true; }
  }
  return changed;
}

export async function loadLibrary(): Promise<Strategy[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, "utf8")) as Strategy[];
  } catch {
    cache = starterLibrary();
    await saveLibrary();
  }
  if (addAgentStrategies(cache)) await saveLibrary();
  return cache;
}

async function saveLibrary(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
  await fs.rename(tmp, FILE);
}

const COIN_RE = /^[A-Z0-9]{2,12}$/;
const STABLE_QUOTES = ["USDT", "USDC", "USD", "EUR"];

/** "btcusdt", "BTC/USDC", "btc" → "BTC". */
export function normalizeCoin(raw: string): string | null {
  let s = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const q of STABLE_QUOTES) if (s.endsWith(q) && s.length > q.length) { s = s.slice(0, -q.length); break; }
  return COIN_RE.test(s) ? s : null;
}

/** Kontrollerar och fyller i en strategi som kommer från formulär eller AI. */
export function sanitizeStrategy(raw: Record<string, unknown>, prev?: Strategy): { ok: true; strategy: Strategy } | { ok: false; error: string } {
  const pick = <T>(k: string, fallback: T): T => (raw[k] === undefined ? fallback : (raw[k] as T));
  const name = String(pick("name", prev?.name ?? "")).trim().slice(0, 80);
  if (!name) return { ok: false, error: "Strategin behöver ett namn." };

  const coinsRaw = pick<unknown>("coins", prev?.coins ?? []);
  const coinsList = Array.isArray(coinsRaw) ? coinsRaw : String(coinsRaw).split(/[\s,;]+/);
  const coins = [...new Set(coinsList.map((c) => normalizeCoin(String(c))).filter((c): c is string => !!c))].slice(0, 30);
  if (!coins.length) return { ok: false, error: "Ange minst en coin, t.ex. BTC." };

  const interval = String(pick("interval", prev?.interval ?? "15m")) as StrategyInterval;
  if (!INTERVALS.includes(interval)) return { ok: false, error: `Intervallet måste vara ett av ${INTERVALS.join(", ")}.` };

  const rules = (k: "entry" | "exit"): Rule[] => {
    const arr = pick<unknown>(k, prev?.[k] ?? []);
    return Array.isArray(arr) ? arr.map(sanitizeRule).filter((r): r is Rule => !!r).slice(0, 12) : [];
  };
  const entry = rules("entry");
  const exit = rules("exit");
  if (!entry.length) return { ok: false, error: "Strategin behöver minst en köpregel." };

  const num = (k: string, fallback: number, min: number, max: number) => {
    const v = Number(pick(k, fallback));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  const review = String(pick("review", prev?.review ?? "jev"));
  const reviewModel = String(pick("reviewModel", prev?.reviewModel ?? "auto")).trim().slice(0, 80) || "auto";

  const t = now();
  return {
    ok: true,
    strategy: {
      id: prev?.id ?? crypto.randomUUID(),
      name,
      description: String(pick("description", prev?.description ?? "")).slice(0, 500),
      enabled: Boolean(pick("enabled", prev?.enabled ?? true)),
      coins,
      interval,
      entry,
      exit,
      stopAtr: num("stopAtr", prev?.stopAtr ?? 1.5, 0, 20),
      targetAtr: num("targetAtr", prev?.targetAtr ?? 3, 0, 50),
      stakeUsd: num("stakeUsd", prev?.stakeUsd ?? 5, 1, 100_000),
      venue: pick("venue", prev?.venue ?? "test") === "live" ? "live" : "test",
      review: review === "off" || review === "jev_ai" ? review : "jev",
      reviewModel: /^[a-z0-9._\-/]+$/i.test(reviewModel) ? reviewModel : "auto",
      autoQueue: Boolean(pick("autoQueue", prev?.autoQueue ?? false)),
      sourceText: raw.sourceText !== undefined ? String(raw.sourceText).slice(0, 2000) : prev?.sourceText,
      agent: raw.agent !== undefined ? String(raw.agent).slice(0, 40) || undefined : prev?.agent,
      seed: prev?.seed,
      createdAt: prev?.createdAt ?? t,
      updatedAt: t,
    },
  };
}

export async function upsertStrategy(raw: Record<string, unknown>, id?: string): Promise<{ ok: true; strategy: Strategy } | { ok: false; error: string }> {
  const list = await loadLibrary();
  const prev = id ? list.find((s) => s.id === id) : undefined;
  if (id && !prev) return { ok: false, error: "Strategin finns inte." };
  const res = sanitizeStrategy(raw, prev);
  if (!res.ok) return res;
  if (prev) list[list.indexOf(prev)] = res.strategy;
  else list.push(res.strategy);
  await saveLibrary();
  return res;
}

export async function deleteStrategy(id: string): Promise<boolean> {
  const list = await loadLibrary();
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  await saveLibrary();
  return true;
}

// ─── Backtest ─────────────────────────────────────────────────────────────

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  pnlPct: number;
  why: "exit-regel" | "stop" | "target" | "öppen";
}

export interface BacktestResult {
  candles: number;
  from: number;
  to: number;
  trades: number;
  wins: number;
  winRatePct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  buyAndHoldPct: number;
  feePctPerSide: number;
  lastTrades: BacktestTrade[];
}

/**
 * Kör strategin över historiska ljus med samma regler och samma
 * köp/sälj-logik som live. Köper och säljer på stängningspriset,
 * stop/target räknas mot ljusets lägsta/högsta. Avgift dras per sida.
 */
export function backtest(
  s: Pick<Strategy, "entry" | "exit" | "stopAtr" | "targetAtr">,
  bars: Array<Bar & { openTime: number; closeTime: number }>,
  feePctPerSide = 0.1,
  /** Träningen räknar serierna en gång och testar bara en del av ljusen (from..to). */
  opts: { series?: Series; from?: number; to?: number } = {},
): BacktestResult {
  const series = opts.series ?? computeSeries(bars);
  const startIdx = Math.max(1, opts.from ?? 1);
  const endIdx = Math.min(bars.length, opts.to ?? bars.length);
  const trades: BacktestTrade[] = [];
  let pos: { entry: number; time: number; stop: number | null; target: number | null } | null = null;
  let equity = 1, peak = 1, maxDd = 0;
  const fee = feePctPerSide / 100;

  const close = (exit: number, time: number, why: BacktestTrade["why"]) => {
    const gross = exit / pos!.entry;
    const net = gross * (1 - fee) * (1 - fee);
    equity *= net;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
    trades.push({ entryTime: pos!.time, exitTime: time, entry: pos!.entry, exit, pnlPct: (net - 1) * 100, why });
    pos = null;
  };

  for (let i = startIdx; i < endIdx; i++) {
    const b = bars[i]!;
    if (pos) {
      // Stop före target: når ljuset båda räknas det försiktigt som stop.
      if (pos.stop != null && b.low <= pos.stop) { close(pos.stop, b.closeTime, "stop"); continue; }
      if (pos.target != null && b.high >= pos.target) { close(pos.target, b.closeTime, "target"); continue; }
      if (s.exit.length && evalAll(series, s.exit, i).pass) { close(b.close, b.closeTime, "exit-regel"); continue; }
    } else if (evalAll(series, s.entry, i).pass) {
      const atr = series.atr14[i];
      pos = {
        entry: b.close,
        time: b.closeTime,
        stop: s.stopAtr > 0 && atr ? b.close - atr * s.stopAtr : null,
        target: s.targetAtr > 0 && atr ? b.close + atr * s.targetAtr : null,
      };
    }
  }
  const lastBar = bars[endIdx - 1];
  if (pos && lastBar) close(lastBar.close, lastBar.closeTime, "öppen");

  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const firstBar = bars[startIdx - 1];
  const first = firstBar?.close ?? 0;
  const last = lastBar?.close ?? 0;
  return {
    candles: Math.max(0, endIdx - startIdx + 1),
    from: firstBar?.openTime ?? 0,
    to: lastBar?.closeTime ?? 0,
    trades: trades.length,
    wins,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    totalReturnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    buyAndHoldPct: first > 0 ? ((last - first) / first) * 100 : 0,
    feePctPerSide,
    lastTrades: trades.slice(-10).reverse(),
  };
}

/** Vilka regler stämmer på sista stängda ljuset? Används av "Testa nu". */
export function evaluateNow(s: Pick<Strategy, "entry" | "exit">, bars: Bar[]): {
  entry: { pass: boolean; results: RuleResult[] };
  exit: { pass: boolean; results: RuleResult[] };
  close: number | null;
  atr14: number | null;
} {
  const series = computeSeries(bars);
  const i = bars.length - 1;
  return {
    entry: evalAll(series, s.entry, i),
    exit: evalAll(series, s.exit, i),
    close: i >= 0 ? bars[i]!.close : null,
    atr14: i >= 0 ? series.atr14[i] ?? null : null,
  };
}
