// ═══════════════════════════════════════════════════════════════════════════
// Tradingminnet sparas också utanför boten, i egna kategorier:
//   - Obsidian: mappen "Trading-minne" i Mikes valv (en anteckning per dag
//     + "Facit.md" med sammanfattningen Hanna får).
//   - Supabase: tabellen trading_memory (om SUPABASE_URL + service-nyckel
//     finns och tabellen är skapad, se supabase/migrations).
// Felar något loggas det och boten fortsätter (filen i data/ är alltid kvar).
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.js";
import { getSupabase } from "../auth/supabase.js";
import type { AnalysisMemory } from "./tradeMemory.js";

const DEFAULT_VAULT = path.join(os.homedir(), "ai_upscale_work/_shared-brain/Obsidian-Vaults/AI-Upscale-Brain");

export function obsidianDir(): string | null {
  const explicit = process.env.OBSIDIAN_TRADING_DIR?.trim();
  if (explicit) return explicit;
  return existsSync(DEFAULT_VAULT) ? path.join(DEFAULT_VAULT, "Trading-minne") : null;
}

const fmt = (ms: number, opts: Intl.DateTimeFormatOptions) =>
  new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", ...opts });

export async function writeObsidian(entry: AnalysisMemory, summary: string): Promise<void> {
  const dir = obsidianDir();
  if (!dir) return;
  try {
    await fs.mkdir(dir, { recursive: true });
    const day = fmt(entry.at, { year: "numeric", month: "2-digit", day: "2-digit" });
    const time = fmt(entry.at, { hour: "2-digit", minute: "2-digit" });
    const file = path.join(dir, `${day}.md`);
    const head = existsSync(file) ? "" : `---\ntags: [trading, trading-minne]\ndatum: ${day}\n---\n# Trading-minne ${day}\n\n`;
    const sig = entry.signals.map((s) => `${s.symbol} ${s.direction} ${s.score}`).join(", ") || "inga";
    const props = entry.proposals.map((p) => `${p.side} ${p.symbol}${p.usd ? ` $${p.usd}` : ""}${p.takeProfit ? ` TP ${p.takeProfit}` : ""}${p.stopLoss ? ` SL ${p.stopLoss}` : ""}`).join(", ") || "inga";
    const body = [
      `## ${time} · ${entry.trigger === "manual" ? "Kör analys" : "fast tid"} · ${entry.decision}`,
      `- Par: ${entry.symbols.join(", ")}`,
      `- Signaler: ${sig}`,
      entry.jevStopped.length ? `- JEV stoppade: ${entry.jevStopped.map((j) => `${j.symbol} (${j.why})`).join("; ")}` : "",
      `- Förslag: ${props}`,
      entry.summary ? `- Hanna: ${entry.summary.replace(/\s+/g, " ").slice(0, 400)}` : "",
      "",
    ].filter(Boolean).join("\n");
    await fs.appendFile(file, head + body + "\n", "utf8");
    await fs.writeFile(path.join(dir, "Facit.md"),
      `---\ntags: [trading, trading-minne]\n---\n# Facit (uppdateras efter varje analys)\n\n${summary}\n`, "utf8");
  } catch (err) {
    log.warn(`[minne] Obsidian: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let supabaseWarned = false;
export async function writeSupabase(entry: AnalysisMemory): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from("trading_memory").insert({
    at: new Date(entry.at).toISOString(),
    trigger: entry.trigger,
    symbols: entry.symbols,
    decision: entry.decision,
    note: entry.note,
    signals: entry.signals,
    jev_stopped: entry.jevStopped,
    proposals: entry.proposals,
    summary: entry.summary,
  });
  if (error && !supabaseWarned) {
    supabaseWarned = true;
    log.warn(`[minne] Supabase: ${error.message} (kör supabase/migrations/*_trading_memory.sql en gång)`);
  }
}
