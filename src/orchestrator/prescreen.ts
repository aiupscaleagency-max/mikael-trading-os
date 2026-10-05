// ═══════════════════════════════════════════════════════════════════════════
// FÖRSÅLLNING — signalmotorn + JEV väljer vilka par AI-teamet ska titta på
// ═══════════════════════════════════════════════════════════════════════════
// Signalmotorn räknar på varje stängt ljus för ALLA par (gratis, inga
// AI-anrop) och JEV granskar varje signal (kan bara tona ned till NEUTRAL).
// Här väljs bara de par där det faktiskt finns en signal. Då körs
// specialisterna och Head Trader på färre par, och en schemalagd tur utan
// någon signal hoppas över helt (inga AI-kostnader).
//
// Av: AI_PRESCREEN=false → endast det bindande urvalet analyseras.
// Tröskel: PRESCREEN_MIN_SCORE (standard 50). Högst PRESCREEN_MAX_PAIRS par
// per tur (standard 3, de starkaste), så att en bred rörelse där nästan alla
// par har signal inte väcker teamet för alla par.
// ═══════════════════════════════════════════════════════════════════════════

import { validateAnalysisRequest, type AnalysisRequest } from "./analysisRequest.js";
import { getSignals, type Signal } from "../server/signalEngine.js";

export interface PrescreenPick {
  symbol: string;
  direction: Signal["direction"];
  score: number;
  jevDowngraded: boolean;
}

export interface PrescreenResult {
  /** Är försållningen påslagen? */
  enabled: boolean;
  /** Paren AI-teamet ska analysera den här turen. */
  symbols: string[];
  /** Par med signal (för loggen och gränssnittet). */
  flagged: PrescreenPick[];
  /** true = schemalagd tur utan signal: hoppa över, inga AI-anrop. */
  skip: boolean;
  /** Kort förklaring på svenska. */
  note: string;
}

const IV_MS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000, "12h": 43_200_000,
  "1d": 86_400_000, "1w": 604_800_000,
};

let last: (PrescreenResult & { at: number }) | null = null;
/** Senaste försållningen (för /api/live/watchlist och sidan). */
export function getLastPrescreen(): (PrescreenResult & { at: number }) | null { return last; }
export function rememberPrescreen(r: PrescreenResult): void { last = { ...r, at: Date.now() }; }

export function prescreenEnabled(): boolean {
  return process.env.AI_PRESCREEN !== "false";
}

const baseOf = (s: string) => s.toUpperCase().replace(/(USDT|USDC|USD|BUSD|FDUSD)$/, "");

/** Par som nämns i en instruktion, t.ex. "Analysera bara dessa par: BTC, SOL". */
export function symbolsInInstruction(instruction: string, symbols: string[]): string[] {
  const text = instruction.toUpperCase();
  return symbols.filter((s) => {
    const b = baseOf(s);
    return b.length > 0 && new RegExp(`(^|[^A-Z0-9])${b}(USDT|USDC|USD)?([^A-Z0-9]|$)`).test(text);
  });
}

/** Färska signaler med riktning (JEV har inte tonat ned dem till NEUTRAL). */
export function flaggedPairs(symbols: string[], now = Date.now()): { flagged: PrescreenPick[]; haveSignals: boolean } {
  const minScore = Number(process.env.PRESCREEN_MIN_SCORE ?? 50) || 50;
  const wanted = new Set(symbols.map((s) => s.toUpperCase()));
  const signals = getSignals().filter((s) => wanted.has(s.symbol.toUpperCase()));
  const flagged: PrescreenPick[] = [];
  for (const s of signals) {
    const ivMs = IV_MS[s.interval] ?? 60_000;
    // Bara signaler från de senaste ljusen (minst 10 min), inte gamla som blivit kvar
    const fresh = now - s.candleCloseTime <= Math.max(3 * ivMs, 10 * 60_000);
    if (!fresh || s.direction === "NEUTRAL" || Math.abs(s.score) < minScore) continue;
    flagged.push({ symbol: s.symbol, direction: s.direction, score: s.score, jevDowngraded: Boolean(s.jevDowngraded) });
  }
  flagged.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  return { flagged, haveSignals: signals.length > 0 };
}

/** Försållningen får minska ett uttryckligt urval, aldrig skapa ett större reservurval. */
export function prescreenPairs(params: {
  cryptoSymbols: string[];
  otherSymbols: string[];
  request: AnalysisRequest;
  instruction?: string;
  scheduled: boolean;
}): PrescreenResult {
  const { cryptoSymbols, otherSymbols, instruction, scheduled } = params;
  const all = validateAnalysisRequest(params.request, [...cryptoSymbols, ...otherSymbols]).selectedSymbols;

  if (!prescreenEnabled()) {
    return { enabled: false, symbols: all, flagged: [], skip: false, note: "försållning av (AI_PRESCREEN=false), endast valda par" };
  }

  const { flagged, haveSignals } = flaggedPairs(all);
  if (!scheduled) {
    return { enabled: true, symbols: all, flagged, skip: false, note: `manuell analys av exakt valda par: ${all.join(", ")}` };
  }
  if (!haveSignals) {
    return { enabled: true, symbols: [], flagged, skip: true, note: "signalmotorn värms upp, schemat väntar på verifierade signaler för valda par" };
  }
  if (flagged.length) {
    const maxPairs = Math.max(1, Number(process.env.PRESCREEN_MAX_PAIRS ?? 3) || 3);
    const top = flagged.slice(0, maxPairs);
    const list = top.map((f) => `${f.symbol} ${f.direction === "LONG" ? "upp" : "ned"} ${f.score > 0 ? "+" : ""}${f.score}`).join(", ");
    const head = flagged.length > top.length
      ? `${flagged.length} av ${all.length} par har signal, AI-teamet tar de ${top.length} starkaste: ${list}`
      : `${flagged.length} av ${all.length} par har signal: ${list}`;
    return { enabled: true, symbols: top.map((f) => f.symbol), flagged, skip: false, note: head };
  }
  if (scheduled && !instruction) {
    return { enabled: true, symbols: [], flagged, skip: true, note: `inget av ${all.length} par har signal just nu, AI-teamet vilar` };
  }
  return { enabled: true, symbols: all, flagged, skip: false, note: "ingen signal just nu, men du bad om analys: endast valda par" };
}

/** Testbar JEV-granskning. Fel behåller det redan valda urvalet; avslag får aldrig skapa en bred reservlista. */
export async function reviewPrescreenScope(
  input: PrescreenResult,
  request: AnalysisRequest,
  scheduled: boolean,
  review: (symbols: string[], wanted: number) => Promise<{ kept: string[]; stopped: { symbol: string; why: string }[] }>,
): Promise<{ screen: PrescreenResult; stopped: { symbol: string; why: string }[]; error?: string }> {
  const selected = new Set(request.selectedSymbols);
  const screen = { ...input, symbols: input.symbols.filter((s) => selected.has(s)) };
  if (!screen.enabled || !screen.flagged.length || screen.skip) return { screen, stopped: [] };
  const wanted = scheduled ? Math.max(1, Number(process.env.PRESCREEN_MAX_PAIRS ?? 3) || 3) : request.selectedSymbols.length;
  const candidates = scheduled ? screen.flagged.slice(0, wanted * 2).map((f) => f.symbol).filter((s) => selected.has(s)) : [...request.selectedSymbols];
  try {
    const result = await review(candidates, wanted);
    const stopped = result.stopped.filter((s) => selected.has(s.symbol));
    if (stopped.length) {
      screen.symbols = [...new Set(result.kept.filter((s) => selected.has(s)))].slice(0, wanted);
      screen.skip = screen.symbols.length === 0;
      screen.note = `JEV stoppade ${stopped.map((s) => s.symbol).join(", ")}; ${screen.skip ? "inget valt par kvar, AI-teamet vilar" : `analys av ${screen.symbols.join(", ")}`}`;
    }
    return { screen, stopped };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    screen.note += "; JEV otillgänglig, bindande urval behålls";
    return { screen, stopped: [], error };
  }
}
