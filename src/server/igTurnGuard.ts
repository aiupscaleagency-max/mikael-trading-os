// ═══════════════════════════════════════════════════════════════════════════
// B3/M5: en agenttur är bunden till den IG-miljö och IG-session den startade i.
//
// Byter Mike konto (Demo ↔ Live) eller byggs IG-sessionen om medan analysen körs,
// så stoppas turens förslag: inga order köas, inget kvitto/popup visas och inget
// sparas i tradingminnet som om det gällde det nya kontot.
// ═══════════════════════════════════════════════════════════════════════════

import type { IgEnvironment } from "../integrations/igConnection.js";

export interface IgTurn { env: IgEnvironment; gen: string | null; startedAt: number }

let current: IgTurn | null = null;
let deps: { activeEnv: () => IgEnvironment; generation: (env: IgEnvironment) => string | null } | null = null;

/** Kopplas en gång vid start (igMarketData + igConnection), injiceras i tester. */
export function configureIgTurnGuard(d: { activeEnv: () => IgEnvironment; generation: (env: IgEnvironment) => string | null }): void { deps = d; }

export function beginIgTurn(env: IgEnvironment): IgTurn {
  current = { env, gen: deps ? deps.generation(env) : null, startedAt: Date.now() };
  return current;
}
export function endIgTurn(t: IgTurn): void { if (current === t) current = null; }
export function currentIgTurn(): IgTurn | null { return current; }

/** null = turen gäller fortfarande; annars förklaring varför resultatet ska kastas. */
export function igTurnStale(t: IgTurn | null = current): string | null {
  if (!t || !deps) return null;
  const now = deps.activeEnv();
  const label = (e: IgEnvironment) => (e === "live" ? "IG Live" : "IG Demo");
  if (now !== t.env) return `Kontot byttes från ${label(t.env)} till ${label(now)} under analysen. Analysens förslag stoppades.`;
  const gen = deps.generation(t.env);
  if (t.gen && gen !== t.gen) return `IG-sessionen för ${label(t.env)} byggdes om under analysen. Analysens förslag stoppades; kör analysen igen.`;
  return null;
}
