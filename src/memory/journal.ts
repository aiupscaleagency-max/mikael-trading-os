// ═══════════════════════════════════════════════════════════════════════════
// Agenternas gemensamma trading-minne (Supabase-tabellen trading_journal).
//
// Boten pratar med minnet via kommandot trading-memory (tools/trading-memory i
// ai_upscale_work), så att boten själv aldrig behöver några Supabase-nycklar.
//   - journalSummary(): senaste lärdomar + avvisade förslag, kort text till agenterna
//   - recordJevRejections(): sparar varje instrument JEV stoppade som "avvisad"
// Felar något loggas det och analysen fortsätter som förut (minnet blir bara tomt).
// Av: TRADING_MEMORY_OFF=true.
// ═══════════════════════════════════════════════════════════════════════════

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.js";

export interface JournalRow {
  kind: string;
  agent: string;
  symbol: string | null;
  strategy: string | null;
  title: string;
  body: string | null;
  created_at: string;
}

const DEFAULT_CLI = path.join(os.homedir(), "ai_upscale_work/tools/trading-memory/trading_memory.py");
const READ_TIMEOUT_MS = 6_000;
const WRITE_TIMEOUT_MS = 15_000;

function cliPath(): string | null {
  if (process.env.TRADING_MEMORY_OFF === "true") return null;
  const p = process.env.TRADING_MEMORY_CLI?.trim() || DEFAULT_CLI;
  return existsSync(p) ? p : null;
}

function runCli(args: string[], timeoutMs: number): Promise<string> {
  const cli = cliPath();
  if (!cli) return Promise.reject(new Error("trading-memory saknas eller är avstängt"));
  const python = process.env.TRADING_MEMORY_PYTHON?.trim() || "/usr/bin/python3";
  return new Promise((resolve, reject) => {
    // Botens egna Supabase-variabler (om de någon gång sätts) får inte styra journalen: CLI:t läser sin egen fil
    const env = { ...process.env, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" };
    execFile(python, [cli, ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.killed ? `tidsgräns ${timeoutMs} ms` : (stderr || err.message).trim().slice(-200)));
      else resolve(stdout);
    });
  });
}

// Journaltext skrivs av agenter och människor: radbrytningar, rubrikstreck och JSON-klamrar tas bort
// så att den inte kan se ut som en ny promptdel eller ett färdigt svar.
const oneLine = (s: string | null | undefined, max: number) =>
  (s ?? "").replace(/[─━═{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Kort text av journalens rader: lärdomar först, sedan avvisade, sedan test/strategi. */
export function formatJournal(rows: JournalRow[], max = 600): string {
  const order = ["lardom", "avvisad", "strategi", "test"];
  const label: Record<string, string> = { lardom: "Lärdom", avvisad: "Avvisad", strategi: "Strategi", test: "Test" };
  const lines = rows
    .filter((r) => order.includes(r.kind) && r.agent !== "claude-setup")
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.created_at.localeCompare(a.created_at))
    .map((r) => `- ${label[r.kind]} ${r.created_at.slice(0, 10)}${r.symbol ? ` ${r.symbol}` : ""}: ${oneLine(r.title, 120)}${r.body ? ` (${oneLine(r.body, 140)})` : ""}`);
  if (!lines.length) return "";
  let out = "AGENTERNAS JOURNAL (gemensamt minne, IG Demo):";
  for (const l of lines) {
    if (out.length + l.length + 1 > max) break;
    out += `\n${l}`;
  }
  return out;
}

/** Lärdomar och de senaste avvisade ur trading_journal som kort text. Tom sträng om minnet inte nås. */
export async function journalSummary(): Promise<string> {
  if (process.env.TRADING_MEMORY_OFF === "true") return "";
  try {
    // Två läsningar, så att automatiska avvisningar aldrig tränger undan lärdomarna
    const read = async (kind: string, n: number) => {
      const rows = JSON.parse(await runCli(["las", "--json", "--typ", kind, "--antal", String(n)], READ_TIMEOUT_MS)) as JournalRow[];
      return Array.isArray(rows) ? rows : [];
    };
    const [lessons, rejected] = await Promise.all([read("lardom", 8), read("avvisad", 3)]);
    return formatJournal([...lessons, ...rejected]);
  } catch (err) {
    log.warn(`[minne] journalen kunde inte läsas: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

// Samma instrument + orsak sparas högst en gång per dygn (minne i processen)
const DEDUP_MS = 24 * 60 * 60 * 1000;
const lastSaved = new Map<string, number>();

/** Sparar varje instrument som JEV stoppade som "avvisad", en i taget, och skriver om Journal.md en gång. */
export async function recordJevRejections(stopped: { symbol: string; why: string }[], now = Date.now()): Promise<number> {
  if (process.env.TRADING_MEMORY_OFF === "true") return 0;
  let saved = 0;
  for (const s of stopped.slice(0, 10)) {
    const why = oneLine(s.why, 500) || "ingen orsak angiven";
    // Siffror (t.ex. "säkerhet 0.64") ändras varje omgång och räknas inte som en ny orsak
    const key = `${s.symbol}|${why.replace(/\d+([.,]\d+)?/g, "#")}`;
    const before = lastSaved.get(key);
    if (now - (before ?? -Infinity) < DEDUP_MS) continue;
    lastSaved.set(key, now); // före skrivningen, så att två samtidiga omgångar inte skriver samma stopp
    try {
      await runCli(["skriv", "--utan-sammanfattning", "--typ", "avvisad", "--agent", "jev", "--symbol", s.symbol.slice(0, 60),
        "--titel", `JEV stoppade ${s.symbol}`.slice(0, 200), "--text", why, "--taggar", "jev,auto"], WRITE_TIMEOUT_MS);
      saved++;
    } catch (err) {
      if (before === undefined) lastSaved.delete(key); else lastSaved.set(key, before);
      log.warn(`[minne] avvisning kunde inte sparas (${s.symbol}): ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }
  if (saved) await runCli(["sammanfatta"], WRITE_TIMEOUT_MS).catch((err) => log.warn(`[minne] Journal.md: ${err instanceof Error ? err.message : String(err)}`));
  return saved;
}

/** Senaste raderna ur journalen (för bron). Kastar om minnet inte nås. */
export async function readJournalRows(kind?: string, n = 20): Promise<JournalRow[]> {
  const args = ["las", "--json", "--antal", String(Math.min(50, Math.max(1, n)))];
  if (kind) args.push("--typ", kind);
  const rows = JSON.parse(await runCli(args, READ_TIMEOUT_MS)) as JournalRow[];
  return Array.isArray(rows) ? rows : [];
}

/** En ny rad i journalen (för bron). Journal.md skrivs om efteråt. Kastar vid fel. */
export async function writeJournalRow(r: { typ: "test" | "strategi" | "lardom"; agent: string; titel: string; text?: string; symbol?: string; strategi?: string; konto: "ig-demo" | "ig-live" }): Promise<void> {
  const args = ["skriv", "--typ", r.typ, "--agent", r.agent.slice(0, 40), "--titel", r.titel.slice(0, 200), "--konto", r.konto, "--taggar", "grok,bron"];
  if (r.text) args.push("--text", r.text);
  if (r.symbol) args.push("--symbol", r.symbol);
  if (r.strategi) args.push("--strategi", r.strategi);
  await runCli(args, WRITE_TIMEOUT_MS);
}
