// ═══════════════════════════════════════════════════════════════════════════
//  Etiketten vid agenternas topplista i Hermes-läget (plan §12, K5):
//    "Hjärna: JEV fullständig/delvis/utan · Kropp: Claude Sonnet 5.5 + ChatGPT gpt-6-sol"
//  plus faktisk kropp/modell per roll efter reserv. Bara minne; en ny analys skriver över.
//  Liten fil utan beroenden, så att igRoutes kan läsa den utan att ladda Hermes-kedjan.
// ═══════════════════════════════════════════════════════════════════════════

export interface BrainLabel {
  /** Huvudraden vid topplistan */
  text: string;
  /** Faktisk kropp per roll, t.ex. "Advisor: ChatGPT gpt-6-sol (trading-chatgpt → reserv Claude)" */
  roles: string[];
  /** fullständig | delvis | utan */
  jev: string;
  /** "full" | "delvis (Risk saknas)" | "ofullständig" | "avbruten" */
  outcome: string;
  at: string;
  /** Omgångens egna id (en agentsession har flera omgångar med samma sessionId) */
  runId: string;
  /** Anteckningarnas gruppering (agentsessionens id eller analysens start) */
  sessionId?: string;
}

// Etiketten sparas TILLSAMMANS med tipsens körning (anteckningarnas runId), så att topplistan aldrig
// visar tips från en körning med etiketten från en annan. Misslyckade/avbrutna försök sparas separat.
const byRun = new Map<string, BrainLabel>();
const failed = new Map<"demo" | "live", BrainLabel>();
const key = (env: string, runId: string) => `${env}|${runId}`;
/** Lyckad (full/delvis) körning: etiketten hör till körningens tips (runId = anteckningarnas runId). */
export function setBrainLabel(env: "demo" | "live", label: BrainLabel): void {
  byRun.set(key(env, label.runId), label);
  while (byRun.size > 50) byRun.delete(byRun.keys().next().value!);
}
/** Etiketten för just den körning vars tips visas (null = ingen etikett för den körningen). */
export function getBrainLabel(env: "demo" | "live", runId: string | null): BrainLabel | null {
  return runId ? byRun.get(key(env, runId)) ?? null : null;
}
/** Senaste misslyckade eller avbrutna försöket (visas separat, påverkar aldrig tipsens etikett). */
export function setFailedAttempt(env: "demo" | "live", label: BrainLabel): void { failed.set(env, label); }
export function getFailedAttempt(env: "demo" | "live"): BrainLabel | null { return failed.get(env) ?? null; }
