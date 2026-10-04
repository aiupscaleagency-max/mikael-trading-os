/**
 * När AI-teamet får köra (det är det som kostar pengar).
 *
 * Standard: MANUELL. AI och JEV körs bara när du trycker "Kör analys".
 * Signalmotorn (indikatorerna, gratis) räknar ändå hela tiden, så paren
 * med signal är klara när du trycker.
 *
 * Valfritt i .env:
 *   ANALYSIS_SCHEDULE=09:00,15:00,21:00   fasta tider (svensk tid)
 *   AI_AUTO_LOOP=true                      gamla läget: var LOOP_INTERVAL_SECONDS
 *   PRESCREEN_TRIGGER=true                 starta tidigt vid ny signal
 */
const TZ = "Europe/Stockholm";

export type AnalysisMode = "manual" | "times" | "loop";

export function scheduleTimes(): string[] {
  return (process.env.ANALYSIS_SCHEDULE ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t))
    .map((t) => t.padStart(5, "0"))
    .sort();
}

export function autoLoopEnabled(): boolean {
  return process.env.AI_AUTO_LOOP === "true";
}

export function signalTriggerEnabled(): boolean {
  return process.env.PRESCREEN_TRIGGER === "true";
}

export function analysisMode(): AnalysisMode {
  if (autoLoopEnabled()) return "loop";
  return scheduleTimes().length ? "times" : "manual";
}

/** "HH:MM" och datum i svensk tid. */
export function stockholmNow(d = new Date()): { hhmm: string; day: string } {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { hhmm: `${get("hour")}:${get("minute")}`, day: `${get("year")}-${get("month")}-${get("day")}` };
}

export function nextScheduledTime(d = new Date()): string | null {
  const times = scheduleTimes();
  if (!times.length) return null;
  const now = stockholmNow(d).hhmm;
  return times.find((t) => t > now) ?? times[0] ?? null;
}

export function analysisModeInfo(): { mode: AnalysisMode; times: string[]; next: string | null; signalTrigger: boolean; text: string } {
  const mode = analysisMode();
  const times = scheduleTimes();
  const next = nextScheduledTime();
  const text = mode === "manual"
    ? "AI körs bara när du trycker Kör analys"
    : mode === "times"
      ? `AI körs kl ${times.join(", ")} och när du trycker Kör analys (nästa ${next})`
      : "AI körs automatiskt med jämna mellanrum (AI_AUTO_LOOP=true)";
  return { mode, times, next, signalTrigger: signalTriggerEnabled(), text };
}

/**
 * Kör `fn` vid varje fast tid (en gång per tid och dag). Kollar var 20:e s.
 * Returnerar en stop-funktion.
 */
export function startFixedTimes(fn: (time: string) => void): () => void {
  const done = new Set<string>();
  const timer = setInterval(() => {
    const { hhmm, day } = stockholmNow();
    if (!scheduleTimes().includes(hhmm)) return;
    const k = `${day} ${hhmm}`;
    if (done.has(k)) return;
    done.add(k);
    fn(hhmm);
  }, 20_000);
  return () => clearInterval(timer);
}
