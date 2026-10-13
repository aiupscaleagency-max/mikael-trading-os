import { computeIndicators } from "../indicators/ta.js";
import { agentStart, agentDone, agentSkip } from "./agentActivity.js";
import { subscribeClosedCandles, getClosedCandles, msUntilClose, type Candle } from "./klineStream.js";
import { log } from "../logger.js";
import { askJev, type JevVerdict } from "./jevClient.js";
import { treeEvent } from "./treeLog.js";

// ═══════════════════════════════════════════════════════════════════════════
// Signal-motor — gör indikatorer till LONG/SHORT-förslag
//
// Räknar ENDAST på stängda ljus. Ett ohalvfärdigt ljus ändrar värden flera
// gånger per sekund, och en signal som bygger på det uppstår och försvinner
// inom samma ljus.
//
// Varje signal MÅSTE ha en stop-loss. Saknas den förkastas signalen i stället
// för att skickas vidare utan skydd. Stoppen räknas ur ATR, så den anpassar
// sig till hur mycket paret faktiskt rör sig — en fast procentsats är för
// snäv i hög volatilitet och för vid i låg.
//
// Motorn LÄGGER INGA ORDRAR. Den producerar förslag med skäl. Beslutet, och
// knapptryckningen, är Mikes.
// ═══════════════════════════════════════════════════════════════════════════

export type Direction = "LONG" | "SHORT" | "NEUTRAL";

export interface Signal {
  symbol: string;
  interval: string;
  direction: Direction;
  /** -100 (starkt short) … +100 (starkt long). Summan av delskälen. */
  score: number;
  entry: number;
  stopLoss: number;
  target: number;
  /** Risk/reward. Under MIN_RISK_REWARD förkastas signalen. */
  riskReward: number;
  /** Avstånd till stop i procent — visar hur mycket som riskeras per enhet. */
  riskPct: number;
  reasons: string[];
  indicators: ReturnType<typeof computeIndicators>;
  candleCloseTime: number;
  /** Millisekunder kvar till nästa ljusstängning. Nedräkningen i gränssnittet. */
  msUntilNextClose: number | null;
  generatedAt: number;
  /**
   * JEV:s bedömning. Finns alltid — är JEV nere står mode "rules_only" och
   * available false, och signalen gäller ändå. Ett bedömningslager som kan
   * stoppa hela systemet när det är nere är farligare än inget alls.
   */
  jev?: JevVerdict;
  /** Sattes riktningen ned av JEV? Skälet står i reasons. */
  jevDowngraded?: boolean;
}

/** Under detta förhållande är trejden inte värd risken. */
const MIN_RISK_REWARD = 1.5;
/** Hur många ATR stoppen läggs ifrån entry. */
const ATR_STOP_MULTIPLIER = 1.5;
/** Hur många ATR targeten läggs ifrån entry. Ger R:R = 3.0 / 1.5 = 2.0. */
const ATR_TARGET_MULTIPLIER = 3.0;
/** Under detta |score| är signalen för svag för att visa som actionable. */
const MIN_SCORE = 30;

const latest = new Map<string, Signal>();
const subscribers = new Set<(s: Signal) => void>();

function key(symbol: string, interval: string): string {
  return `${symbol}:${interval}`;
}

/**
 * Väger ihop indikatorerna till ett score.
 *
 * Varje delskäl bidrar med poäng och en förklaring på svenska. Summan blir
 * riktningen. Poängen är medvetet enkla och läsbara — en svart låda går inte
 * att felsöka när den har fel, och den går inte att lita på när den har rätt.
 */
function scoreIndicators(ind: ReturnType<typeof computeIndicators>): { score: number; reasons: string[] } {
  const reasons: string[] = [];

  // ── Trend (max ±40) ───────────────────────────────────────────────────
  // Beräknas separat och FÖRE allt annat, så att "finns en trend?" är ett
  // oberoende svar. Tidigare byggde den bedömningen på ett löpande score
  // som redan innehöll momentum och RSI — då blev resultatet beroende av i
  // vilken ordning delarna råkade räknas.
  let trendScore = 0;

  if (ind.sma20 !== null && ind.sma50 !== null) {
    if (ind.sma20 > ind.sma50) {
      trendScore += 25;
      reasons.push(`SMA20 över SMA50 — stigande trend (+25)`);
    } else if (ind.sma20 < ind.sma50) {
      trendScore -= 25;
      reasons.push(`SMA20 under SMA50 — fallande trend (−25)`);
    }
  }

  if (ind.ema20 !== null && ind.lastClose > 0) {
    if (ind.lastClose > ind.ema20) {
      trendScore += 15;
      reasons.push(`Pris över EMA20 (+15)`);
    } else {
      trendScore -= 15;
      reasons.push(`Pris under EMA20 (−15)`);
    }
  }

  const trendStrong = Math.abs(trendScore) >= 35;
  let score = trendScore;

  // ── Momentum (max ±25) ────────────────────────────────────────────────
  // MACD-LINJEN bär riktningen: under noll = fallande, över = stigande.
  //
  // Histogrammet gör det INTE. I en stadig nedgång blir histogrammet
  // positivt, eftersom nedgången bromsar in i absoluta tal medan priset
  // närmar sig noll. Testet mot genererade ljus visade det: en ren nedgång
  // fick +20 för "momentum uppåt" och landade i NEUTRAL där SHORT var rätt.
  //
  // Histogrammet är alltså en acceleration, inte en riktning, och väger
  // därefter — en femtedel av linjens vikt.
  if (ind.macd) {
    if (ind.macd.macd < 0) {
      score -= 20;
      reasons.push(`MACD-linjen under noll — fallande momentum (−20)`);
    } else if (ind.macd.macd > 0) {
      score += 20;
      reasons.push(`MACD-linjen över noll — stigande momentum (+20)`);
    }
    if (ind.macd.histogram > 0) {
      score += 5;
      reasons.push(`MACD-histogram positivt — accelererar uppåt (+5)`);
    } else if (ind.macd.histogram < 0) {
      score -= 5;
      reasons.push(`MACD-histogram negativt — accelererar nedåt (−5)`);
    }
  }

  // ── RSI (max ±15) ─────────────────────────────────────────────────────
  // I en STARK trend är extremer bekräftelse, inte varning. Priset kan
  // ligga överköpt i veckor medan trenden håller, och att shorta för att
  // RSI är 75 i en stigande marknad är en klassisk förlustkälla.
  //
  // Utan stark trend är extremen däremot en rekylvarning.
  if (ind.rsi14 !== null) {
    if (ind.rsi14 > 70) {
      if (trendStrong && trendScore > 0) {
        reasons.push(`RSI ${ind.rsi14.toFixed(1)} — överköpt, men trenden bekräftar (0)`);
      } else {
        score -= 15;
        reasons.push(`RSI ${ind.rsi14.toFixed(1)} — överköpt utan stark trend, rekylrisk (−15)`);
      }
    } else if (ind.rsi14 < 30) {
      if (trendStrong && trendScore < 0) {
        reasons.push(`RSI ${ind.rsi14.toFixed(1)} — översålt, men trenden bekräftar (0)`);
      } else {
        score += 15;
        reasons.push(`RSI ${ind.rsi14.toFixed(1)} — översålt utan stark trend, studsläge (+15)`);
      }
    } else if (ind.rsi14 > 55) {
      score += 10;
      reasons.push(`RSI ${ind.rsi14.toFixed(1)} — styrka utan överköp (+10)`);
    } else if (ind.rsi14 < 45) {
      score -= 10;
      reasons.push(`RSI ${ind.rsi14.toFixed(1)} — svaghet utan översålt (−10)`);
    }
  }

  return { score: Math.max(-100, Math.min(100, score)), reasons };
}

/** Bygger en signal, eller null om den inte går att skydda med en stop. */
export function buildSignal(symbol: string, interval: string, candles: Candle[]): Signal | null {
  if (candles.length < 50) return null; // för lite historik för SMA50

  const ind = computeIndicators(candles);
  const { score, reasons } = scoreIndicators(ind);
  const entry = ind.lastClose;

  // Utan ATR går ingen vettig stop att räkna — och utan stop skickas ingen
  // signal. Det är regeln, inte en rekommendation.
  if (!ind.atr14 || ind.atr14 <= 0 || entry <= 0) {
    log.warn(`[signal] ${symbol}: ingen ATR — signal förkastad (stop-loss kan inte beräknas)`);
    return null;
  }

  // ── Brus-spärr ──────────────────────────────────────────────────────
  // Indikatorer ger utslag även i en marknad som står stilla: några ljus
  // upp i rad räcker för att SMA, EMA och MACD ska peka åt samma håll,
  // och scoret blir högt utan att något faktiskt hänt.
  //
  // Testet mot genererade ljus visade det svart på vitt: en helt sidledes
  // marknad gav LONG med score +60. En stark köpsignal där ingen edge finns
  // är precis vad som förlorar pengar.
  //
  // Kravet: nettorörelsen över lookback-fönstret måste överstiga en ATR.
  // Rör sig priset mindre än sin egen normala svängning finns ingen riktning
  // att handla på, oavsett vad indikatorerna säger.
  const LOOKBACK = 20;
  const past = candles[candles.length - 1 - LOOKBACK]?.close ?? entry;
  const netMove = Math.abs(entry - past);
  const isNoise = netMove < ind.atr14;

  let direction: Direction =
    score >= MIN_SCORE ? "LONG" : score <= -MIN_SCORE ? "SHORT" : "NEUTRAL";

  if (isNoise && direction !== "NEUTRAL") {
    reasons.push(
      `Nettorörelse ${netMove.toFixed(2)} understiger ATR ${ind.atr14.toFixed(2)} — `
      + `riktningen är brus, inte trend`,
    );
    direction = "NEUTRAL";
  }

  const stopDistance = ind.atr14 * ATR_STOP_MULTIPLIER;
  const targetDistance = ind.atr14 * ATR_TARGET_MULTIPLIER;

  const stopLoss = direction === "SHORT" ? entry + stopDistance : entry - stopDistance;
  const target = direction === "SHORT" ? entry - targetDistance : entry + targetDistance;

  const riskReward = targetDistance / stopDistance;
  const riskPct = (stopDistance / entry) * 100;

  if (direction !== "NEUTRAL" && riskReward < MIN_RISK_REWARD) {
    log.info(`[signal] ${symbol}: R:R ${riskReward.toFixed(2)} under ${MIN_RISK_REWARD} — förkastad`);
    return null;
  }

  return {
    symbol, interval, direction, score,
    entry, stopLoss, target, riskReward, riskPct,
    reasons,
    indicators: ind,
    candleCloseTime: candles[candles.length - 1]!.closeTime,
    msUntilNextClose: msUntilClose(symbol, interval),
    generatedAt: Date.now(),
  };
}

/**
 * Låter JEV bedöma en färdig signal.
 *
 * ── REGELN: JEV KAN BARA SÄNKA ──────────────────────────────────────────
 * En LONG kan bli AVVAKTA. En AVVAKTA kan ALDRIG bli LONG.
 *
 * Siffrorna kommer från kod som går att testa och upprepa. Ett
 * probabilistiskt lager som kunde skapa signaler skulle kunna hallucinera
 * fram en trade som ingen beräkning stöder. Som veto är det bara skyddande.
 *
 * Tre saker sänker en signal:
 *   crisis-regim          marknaden är i kris — stå utanför
 *   toxiskt flöde > 0.7   flödet är informerat, vi handlar mot någon som vet mer
 *   JEV pekar tvärtom     med hög confidence mot vår riktning
 */
// JEV-kostnad (Mike 2026-10-04): JEV frågades för VARJE par vid VARJE stängt
// 1m-ljus (~850 anrop/timme). Nu: aldrig för NEUTRAL (inget att granska), och
// samma par + riktning återanvänder svaret: ett STOPP i 15 min, ett OK bara i
// JEV_CACHE_MIN minuter (5), så att ett nytt läge (t.ex. kris) hinner stoppa.
const jevCache = new Map<string, { at: number; jev: JevVerdict; veto: boolean }>();
function jevCacheMs(veto: boolean): number {
  return veto ? 15 * 60_000 : (Number(process.env.JEV_CACHE_MIN ?? 5) || 5) * 60_000;
}

export async function applyJevVerdict(signal: Signal): Promise<Signal> {
  if (signal.direction === "NEUTRAL") return signal;
  const state = {
    symbol: signal.symbol,
    interval: signal.interval,
    close: signal.entry,
    rsi14: signal.indicators.rsi14,
    sma20: signal.indicators.sma20,
    sma50: signal.indicators.sma50,
    ema20: signal.indicators.ema20,
    atr14: signal.indicators.atr14,
    macd: signal.indicators.macd,
    score: signal.score,
    proposed_direction: signal.direction,
  };

  agentStart("signal", `${signal.direction} ${signal.symbol}`, { coin: signal.symbol });
  agentDone("signal", `${signal.direction} ${signal.symbol} (score ${signal.score})`);
  agentStart("jev", `granskar signal ${signal.symbol}`, { from: "signal", coin: signal.symbol });
  const cacheKey = `${signal.symbol}:${signal.direction}`;
  const hit = jevCache.get(cacheKey);
  let jev: JevVerdict;
  if (hit && Date.now() - hit.at < jevCacheMs(hit.veto)) {
    jev = hit.jev;
  } else {
    jev = await askJev(state);
    if (jev.available) {
      const a = jev.answers;
      const veto = a.regime?.choice === "crisis" || (a.toxic_flow?.noul ?? 0) > 0.7
        || ((a.direction?.confidence ?? 0) > 0.6 && a.direction?.choice === (signal.direction === "LONG" ? "down" : "up"));
      jevCache.set(cacheKey, { at: Date.now(), jev, veto });
    }
  }
  const out: Signal = { ...signal, jev };
  const jevInfo = { available: jev.available, route: jev.mode, latencyMs: jev.latencyMs };

  // Utan JEV gäller signalen som den är — rules_only, tydligt märkt.
  if (!jev.available) {
    if (jev.available) agentDone("jev", `${signal.symbol}: ${signal.direction}`); else agentSkip("jev", `svarade inte: ${jev.note}`);
    treeEvent({ branch: "signal", subject: signal.symbol, jev: jevInfo, outcome: jev.available ? "ok" : "bara regler", why: jev.available ? `${signal.direction}` : jev.note });
    return out;
  }

  const regime = jev.answers.regime?.choice;
  const toxic = jev.answers.toxic_flow?.noul ?? 0;
  const bias = jev.answers.direction?.choice;
  const biasConf = jev.answers.direction?.confidence ?? 0;

  const vetoes: string[] = [];
  if (regime === "crisis") vetoes.push("JEV: krisregim — ingen ny position");
  if (toxic > 0.7) vetoes.push(`JEV: toxiskt flöde ${toxic.toFixed(2)} — informerad motpart`);

  const opposes =
    (signal.direction === "LONG" && bias === "down") ||
    (signal.direction === "SHORT" && bias === "up");
  if (opposes && biasConf > 0.6) {
    vetoes.push(`JEV: bedömer riktningen som ${bias} (säkerhet ${biasConf.toFixed(2)})`);
  }

  if (!vetoes.length) {
    agentDone("jev", `godkände ${signal.direction} ${signal.symbol}`);
    treeEvent({ branch: "signal", subject: signal.symbol, jev: jevInfo, outcome: "ok", why: `${signal.direction} godkänd av JEV` });
    return out;
  }
  treeEvent({ branch: "signal", subject: signal.symbol, jev: jevInfo, outcome: "stoppad", why: vetoes[0] });
  agentDone("jev", `stoppade ${signal.symbol}: ${vetoes[0]}`);

  log.info(`[signal] ${signal.symbol}: ${signal.direction} sänkt till AVVAKTA — ${vetoes[0]}`);
  return {
    ...out,
    direction: "NEUTRAL",
    jevDowngraded: true,
    reasons: [...signal.reasons, ...vetoes],
  };
}

/** Startar motorn. Räknar om vid varje stängt ljus. */
export function startSignalEngine(): () => void {
  log.info("[signal] motorn startad — räknar vid varje ljusstängning");
  return subscribeClosedCandles((symbol, interval, _candle, history) => {
    const base = buildSignal(symbol, interval, history);
    if (!base) return;
    // Signalerna är ren matte och gratis. JEV (via Vercel) ser tidiga tecken:
    // den granskar ett par när det får en ny riktning (eller var
    // JEV_REFRESH_MIN minut, 60), inte vid varje 1m-ljus. Däremellan används
    // JEV:s senaste bedömning för paret.
    //   JEV_ON_SIGNALS=change (standard) · every (gamla, varje ljus) · off
    const modeJ = jevOnSignals();
    if (modeJ === "off") { publish(base); return; }
    if (modeJ === "change" && base.direction !== "NEUTRAL") {
      const last = lastJev.get(key(symbol, interval));
      const refreshMs = (Number(process.env.JEV_REFRESH_MIN ?? 60) || 60) * 60_000;
      if (last && last.direction === base.direction && Date.now() - last.at < refreshMs) {
        publish(reuseVerdict(base, last)); return;
      }
    }
    if (base.direction === "NEUTRAL") { publish(base); return; }
    void applyJevVerdict(base).then((signal) => {
      // Bara riktiga JEV-svar sparas: svarade JEV inte frågar vi igen nästa ljus.
      if (signal.jev?.available) lastJev.set(key(symbol, interval), {
        direction: base.direction, at: Date.now(), jev: signal.jev,
        downgraded: Boolean(signal.jevDowngraded), vetoes: signal.reasons.slice(base.reasons.length),
      });
      publish(signal);
    });
  });
}

function jevOnSignals(): "change" | "every" | "off" {
  const v = (process.env.JEV_ON_SIGNALS ?? "change").toLowerCase();
  if (v === "every" || v === "true") return "every";
  if (v === "off" || v === "false") return "off";
  return "change";
}

/** JEV:s senaste bedömning per par (för att slippa fråga varje minut). */
const lastJev = new Map<string, { direction: Direction; at: number; jev?: JevVerdict; downgraded: boolean; vetoes: string[] }>();

function reuseVerdict(base: Signal, last: { jev?: JevVerdict; downgraded: boolean; vetoes: string[] }): Signal {
  if (!last.downgraded) return { ...base, jev: last.jev };
  return { ...base, jev: last.jev, direction: "NEUTRAL", jevDowngraded: true, reasons: [...base.reasons, ...last.vetoes] };
}

function publish(signal: Signal): void {
  // Ett sent JEV-svar får aldrig skriva över en nyare signal (annars visas gammal riktning).
  const prev = latest.get(key(signal.symbol, signal.interval));
  if (prev && prev.candleCloseTime > signal.candleCloseTime) return;
  latest.set(key(signal.symbol, signal.interval), signal);
  for (const cb of subscribers) {
    try { cb(signal); } catch (err) {
      log.warn(`[signal] subscriber kastade: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * JEV granskar bara de par som en analys ska titta på (högst några anrop per
 * analys). Returnerar de par JEV släpper igenom och de som stoppades.
 */
export async function jevReviewSymbols(symbols: string[], wanted = Infinity): Promise<{ kept: string[]; stopped: { symbol: string; why: string }[] }> {
  const kept: string[] = [];
  const stopped: { symbol: string; why: string }[] = [];
  for (const sym of symbols) {
    if (kept.length >= wanted) break;
    const sig = [...latest.values()]
      .filter((s) => s.symbol.toUpperCase() === sym.toUpperCase() && s.direction !== "NEUTRAL")
      .sort((a, b) => b.candleCloseTime - a.candleCloseTime)[0];
    if (!sig) { kept.push(sym); continue; }
    const reviewed = sig.jev ? sig : await applyJevVerdict(sig);
    if (reviewed !== sig) publish(reviewed);
    if (reviewed.jevDowngraded) stopped.push({ symbol: sym, why: reviewed.reasons[reviewed.reasons.length - 1] ?? "JEV stoppade" });
    else kept.push(sym);
  }
  return { kept, stopped };
}

/** Prenumerera på nya signaler — används av Telegram-utskicket. */
export function subscribeSignals(cb: (s: Signal) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Senaste signalen per par, med färsk nedräkning. */
export function getSignals(): Signal[] {
  return Array.from(latest.values()).map((s) => ({
    ...s,
    msUntilNextClose: msUntilClose(s.symbol, s.interval),
  }));
}

/** Räknar om direkt ur bufferten — för när gränssnittet laddas mitt i ett ljus. */
export function refreshSignal(symbol: string, interval: string): Signal | null {
  const s = buildSignal(symbol, interval, getClosedCandles(symbol, interval));
  if (s) latest.set(key(symbol, interval), s);
  return s;
}

// Samma EPIC finns i IG Demo och IG Live. Signaler och JEV-svar från den ena miljön får inte
// följa med när kontot byts, så de glöms vid byte (nya räknas på nästa stängda ljus).
void import("./igMarketData.js").then(({ igMarketData }) => {
  igMarketData.events.on("env", () => { latest.clear(); jevCache.clear(); lastJev.clear(); });
}).catch(() => { /* utan IG finns inget att byta */ });
