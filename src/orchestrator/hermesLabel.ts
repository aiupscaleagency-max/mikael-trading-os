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
  runId: string;
}

const last = new Map<"demo" | "live", BrainLabel>();
export function setBrainLabel(env: "demo" | "live", label: BrainLabel): void { last.set(env, label); }
export function getBrainLabel(env: "demo" | "live"): BrainLabel | null { return last.get(env) ?? null; }
