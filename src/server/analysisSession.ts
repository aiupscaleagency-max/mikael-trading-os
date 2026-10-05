import crypto from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AnalysisSession {
  id: string; broker: "bybit" | "bybit-paper"; startedAt: number; endsAt: number;
  intervalMinutes: number; horizonMinutes: number; percent: number;
  status: "running" | "completed" | "stopped" | "interrupted";
  analyses: number; nextRunAt: number; lastError?: string;
}
const FILE = path.resolve("data/analysis-session.json");
let session: AnalysisSession | null = null;
try {
  session = JSON.parse(readFileSync(FILE, "utf8")) as AnalysisSession;
  // Omstart kräver nytt aktivt startval så att AI-kostnader inte återupptas i smyg.
  if (session?.status === "running") session.status = "interrupted";
} catch { /* Ingen session ännu. */ }
let busy = false;
function save(): void {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE + ".tmp", JSON.stringify(session));
  renameSync(FILE + ".tmp", FILE);
}
export function getAnalysisSession(): AnalysisSession | null {
  if (session?.status === "running" && Date.now() >= session.endsAt) { session.status = "completed"; save(); }
  return session ? { ...session } : null;
}
export function startAnalysisSession(b: Record<string, unknown>): AnalysisSession {
  if (getAnalysisSession()?.status === "running" || busy) throw new Error("En session körs redan");
  const duration = Number(b.durationMinutes), interval = Number(b.intervalMinutes), horizon = Number(b.horizonMinutes), percent = Number(b.percent);
  if (![15,30,60,120].includes(duration) || ![1,5,15,30].includes(interval) || ![1,5,15,30].includes(horizon) || !Number.isFinite(percent) || percent < 0.1 || percent > 5 || !["bybit", "bybit-paper"].includes(String(b.broker))) throw new Error("Ogiltiga sessionsval");
  const now = Date.now();
  session = { id: crypto.randomUUID(), broker: b.broker as AnalysisSession["broker"], startedAt: now, endsAt: now + duration * 60_000,
    intervalMinutes: interval, horizonMinutes: horizon, percent, status: "running", analyses: 0, nextRunAt: now };
  save();
  return { ...session };
}
export function stopAnalysisSession(): void {
  if (session?.status === "running") { session.status = "stopped"; save(); }
}
/** Sessionen kör bara analyser; godkännanden sker alltid manuellt. */
export async function tickAnalysisSession(run: (s: AnalysisSession) => Promise<void>, now = Date.now()): Promise<void> {
  const s = session;
  if (!s || s.status !== "running" || busy) return;
  if (now >= s.endsAt) { s.status = "completed"; save(); return; }
  if (now < s.nextRunAt) return;
  busy = true;
  s.nextRunAt = now + s.intervalMinutes * 60_000;
  try { save(); await run({ ...s }); s.analyses++; delete s.lastError; }
  catch (err) { s.lastError = err instanceof Error ? err.message : String(err); }
  finally { busy = false; if (s.status === "running" && Date.now() >= s.endsAt) s.status = "completed"; save(); }
}
