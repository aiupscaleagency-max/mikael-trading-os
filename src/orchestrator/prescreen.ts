// ═══════════════════════════════════════════════════════════════════════════
// FÖRSÅLLNING — signalmotorn + JEV väljer vilka par AI-teamet ska titta på
// ═══════════════════════════════════════════════════════════════════════════
// Signalmotorn räknar på varje stängt ljus för ALLA par (gratis, inga
// AI-anrop) och JEV granskar varje signal (kan bara tona ned till NEUTRAL).
// Här väljs bara de par där det faktiskt finns en signal. Då körs
// specialisterna och Head Trader på färre par, och en schemalagd tur utan
// någon signal hoppas över helt (inga AI-kostnader).
//
// Av:  AI_PRESCREEN=false  → som förut, alla par varje tur.
// Tröskel: PRESCREEN_MIN_SCORE (standard 30 = signalmotorns egen gräns).
// ═══════════════════════════════════════════════════════════════════════════

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
  const minScore = Number(process.env.PRESCREEN_MIN_SCORE ?? 30) || 30;
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

/**
 * Väljer par för en tur.
 * - Instruktion som nämner par → bara de paren (t.ex. "Analysera valda" på Alla par).
 * - Annars: par med signal. Schemalagd tur utan signal → skip.
 * - Manuell "Kör analys" utan signal → alla par (du bad om en analys).
 * - Signalmotorn har inte hunnit fylla på än → alla par, som förut.
 */
export function prescreenPairs(params: {
  cryptoSymbols: string[];
  otherSymbols: string[];
  instruction?: string;
  scheduled: boolean;
}): PrescreenResult {
  const { cryptoSymbols, otherSymbols, instruction, scheduled } = params;
  const all = [...cryptoSymbols, ...otherSymbols];

  if (!prescreenEnabled()) {
    return { enabled: false, symbols: all, flagged: [], skip: false, note: "försållning av (AI_PRESCREEN=false), alla par" };
  }

  if (instruction) {
    const named = symbolsInInstruction(instruction, all);
    if (named.length) {
      return { enabled: true, symbols: named, flagged: [], skip: false, note: `paren du valde: ${named.join(", ")}` };
    }
  }

  const { flagged, haveSignals } = flaggedPairs(cryptoSymbols);
  if (!haveSignals) {
    return { enabled: true, symbols: all, flagged, skip: false, note: "signalmotorn värms upp, alla par den här gången" };
  }
  if (flagged.length) {
    const list = flagged.map((f) => `${f.symbol} ${f.direction === "LONG" ? "upp" : "ned"} ${f.score > 0 ? "+" : ""}${f.score}`).join(", ");
    return { enabled: true, symbols: flagged.map((f) => f.symbol), flagged, skip: false, note: `${flagged.length} av ${cryptoSymbols.length} par har signal: ${list}` };
  }
  if (scheduled && !instruction) {
    return { enabled: true, symbols: [], flagged, skip: true, note: `inget av ${cryptoSymbols.length} par har signal just nu, AI-teamet vilar` };
  }
  return { enabled: true, symbols: all, flagged, skip: false, note: "ingen signal just nu, men du bad om analys: alla par" };
}
