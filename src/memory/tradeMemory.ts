// ═══════════════════════════════════════════════════════════════════════════
// Tradingminne: vad agenterna såg, vad de beslöt och hur det gick.
//
// Varje analys sparas som en rad i data/trade-memory.jsonl (par, signaler,
// JEV, Hannas beslut, föreslagna ordrar). Resultatet (vinst/förlust) hämtas
// från TEST-kontots stängda affärer (data/bybit-paper.json) och kopplas till
// analysen som föreslog köpet. Före nästa analys får Hanna en kort
// sammanfattning (några hundra tecken, så det kostar nästan inga tokens).
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const MEMORY_FILE = path.join(DATA_DIR, "trade-memory.jsonl");
const PAPER_FILE = path.join(DATA_DIR, "bybit-paper.json");

export interface MemorySignal { symbol: string; direction: string; score: number; reasons: string[] }
export interface MemoryProposal { symbol: string; side: "BUY" | "SELL"; usd?: number; takeProfit?: number; stopLoss?: number; refPrice?: number }

export interface AnalysisMemory {
  at: number;
  trigger: "manual" | "scheduled";
  instruction?: string;
  symbols: string[];
  note: string;
  signals: MemorySignal[];
  jevStopped: { symbol: string; why: string }[];
  decision: string;
  summary: string;
  proposals: MemoryProposal[];
}

interface PaperFill { base: string; side: string; qty: number; price: number; at: number; kind: string; pnl?: number }

export interface ClosedTrade {
  base: string;
  openedAt: number;
  closedAt: number;
  pnl: number;
  exitKind: string;
  /** Signalen när analysen föreslog köpet (saknas om köpet inte kom från en analys) */
  signal?: MemorySignal;
  analysisAt?: number;
}

const baseOf = (s: string) => s.toUpperCase().replace(/(USDT|USDC|USD|BUSD|FDUSD)$/, "");

export async function recordAnalysis(entry: AnalysisMemory): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const slim: AnalysisMemory = {
      ...entry,
      summary: entry.summary.slice(0, 600),
      signals: entry.signals.map((s) => ({ ...s, reasons: s.reasons.slice(0, 4).map((r) => r.slice(0, 100)) })),
    };
    await fs.appendFile(MEMORY_FILE, JSON.stringify(slim) + "\n", "utf8");
    log.info(`[minne] analys sparad: ${entry.symbols.length} par, beslut ${entry.decision}, ${entry.proposals.length} förslag`);
    // Egna kategorier utanför boten: Obsidian "Trading-minne" + Supabase trading_memory
    const { writeObsidian, writeSupabase } = await import("./memorySinks.js");
    const summary = await memorySummary(entry.symbols).catch(() => "");
    await Promise.allSettled([writeObsidian(slim, summary), writeSupabase(slim)]);
  } catch (err) {
    log.warn(`[minne] kunde inte spara analysen: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function loadAnalyses(limit = 300): Promise<AnalysisMemory[]> {
  try {
    const raw = await fs.readFile(MEMORY_FILE, "utf8");
    const out: AnalysisMemory[] = [];
    for (const line of raw.trim().split("\n").slice(-limit)) {
      try { out.push(JSON.parse(line) as AnalysisMemory); } catch { /* trasig rad */ }
    }
    return out;
  } catch { return []; }
}

async function loadPaperFills(): Promise<PaperFill[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(PAPER_FILE, "utf8")) as { fills?: PaperFill[] };
    return Array.isArray(parsed.fills) ? parsed.fills : [];
  } catch { return []; }
}

/** Stängda TEST-affärer, var och en kopplad till analysen som föreslog köpet. */
export async function closedTrades(): Promise<ClosedTrade[]> {
  const [fills, analyses] = await Promise.all([loadPaperFills(), loadAnalyses()]);
  const lastBuy = new Map<string, number>();
  const trades: ClosedTrade[] = [];
  for (const f of [...fills].sort((a, b) => a.at - b.at)) {
    const base = f.base.toUpperCase();
    if (f.side === "BUY") { if (!lastBuy.has(base)) lastBuy.set(base, f.at); continue; }
    if (f.side !== "SELL" || typeof f.pnl !== "number") continue;
    const openedAt = lastBuy.get(base) ?? f.at;
    lastBuy.delete(base);
    // Senaste analysen före köpet som föreslog att köpa just det här myntet
    const source = analyses
      .filter((a) => a.at <= openedAt && a.proposals.some((p) => p.side === "BUY" && baseOf(p.symbol) === base))
      .sort((a, b) => b.at - a.at)[0];
    const signal = source?.signals.find((s) => baseOf(s.symbol) === base);
    trades.push({ base, openedAt, closedAt: f.at, pnl: f.pnl, exitKind: f.kind, signal, analysisAt: source?.at });
  }
  return trades;
}

const usd = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
const day = (ms: number) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * Kort minne till Hanna och specialisterna: hur TEST-affärerna gått, vilka
 * signaltyper som vunnit, och tidigare beslut för paren i den här analysen.
 */
export async function memorySummary(symbols: string[] = []): Promise<string> {
  const [trades, analyses] = await Promise.all([closedTrades(), loadAnalyses(100)]);
  const lines: string[] = ["TRADINGMINNE (TEST-kontot, dina tidigare analyser):"];

  if (trades.length) {
    const wins = trades.filter((t) => t.pnl > 0).length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    lines.push(`- ${trades.length} stängda affärer, ${wins} vinster (${Math.round((wins / trades.length) * 100)} %), totalt ${usd(total)}.`);

    // Vilka signaltyper har lönat sig? (riktning + styrka)
    const groups = new Map<string, { n: number; wins: number; pnl: number }>();
    for (const t of trades) {
      if (!t.signal) continue;
      const strength = Math.abs(t.signal.score) >= 70 ? "stark" : "medel";
      const k = `${t.signal.direction} ${strength}`;
      const g = groups.get(k) ?? { n: 0, wins: 0, pnl: 0 };
      g.n++; if (t.pnl > 0) g.wins++; g.pnl += t.pnl;
      groups.set(k, g);
    }
    if (groups.size) {
      lines.push(`- Per signaltyp: ${[...groups].map(([k, g]) => `${k}: ${g.wins}/${g.n} vinst, ${usd(g.pnl)}`).join("; ")}.`);
    }
    const last = trades.slice(-3).map((t) => `${t.base} ${usd(t.pnl)} (${t.exitKind})`).join(", ");
    lines.push(`- Senaste: ${last}.`);
  } else {
    lines.push("- Inga stängda TEST-affärer än, så inget facit. Var försiktig och följ stegen.");
  }

  const wanted = new Set(symbols.map(baseOf));
  for (const base of wanted) {
    const past = analyses.filter((a) => a.signals.some((s) => baseOf(s.symbol) === base) || a.proposals.some((p) => baseOf(p.symbol) === base)).slice(-2);
    const done = trades.filter((t) => t.base === base);
    if (!past.length && !done.length) continue;
    const parts: string[] = [];
    for (const a of past) {
      const s = a.signals.find((x) => baseOf(x.symbol) === base);
      const p = a.proposals.find((x) => baseOf(x.symbol) === base);
      parts.push(`${day(a.at)}: signal ${s ? `${s.direction} ${s.score}` : "–"}, beslut ${p ? p.side : "avvakta"}`);
    }
    if (done.length) {
      const pnl = done.reduce((x, t) => x + t.pnl, 0);
      parts.push(`${done.length} affärer ${usd(pnl)}`);
    }
    lines.push(`- ${base}: ${parts.join("; ")}.`);
  }

  lines.push("Använd minnet: upprepa det som gett vinst, var extra kritisk mot signaltyper som förlorat.");
  return lines.join("\n").slice(0, 1500);
}
