import type { IgEnvironment } from "./igConnection.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Analys har förtur framför bakgrundsläsningar (Mike 2026-10-11).
//
//  Medan en analys eller en agentsessions omgång pågår i en miljö pausas
//  bakgrundens IG-läsningar för just den miljön: katalogkrypningen, minidiagrammens
//  IG-hämtningar (och deras nya Tiingo-anrop) och bevakningslistans REST-reserv.
//  Då får agenterna läsbudgeten. Orderavstämning, tidsstängningar och TP/SL pausas ALDRIG.
//  Demo-simuleringen pausas medvetet inte: dess varv är TP/SL för öppna simulerade positioner,
//  läser strömpriset först och REST bara utan strömpris (och alltid utan orderns förtur).
//
//  Flaggan släpps i finally av den som tog den; som extra skydd löper den ut av sig själv
//  efter ANALYSIS_GATE_MAX_MS, så en hängd tur aldrig fryser katalogen för gott.
// ═══════════════════════════════════════════════════════════════════════════

export const ANALYSIS_GATE_MAX_MS = 10 * 60_000;

export function createIgAnalysisGate(deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const holders = new Map<IgEnvironment, Map<number, number>>(); // miljö → id → starttid
  let seq = 0;
  function live(env: IgEnvironment): Map<number, number> {
    let m = holders.get(env);
    if (!m) { m = new Map(); holders.set(env, m); }
    for (const [id, at] of m) if (now() - at >= ANALYSIS_GATE_MAX_MS) m.delete(id); // självutlösning
    return m;
  }
  /** Tar förturen för miljön. Returnerar en släpp-funktion (anropas i finally; flera anrop är ofarliga). */
  function begin(env: IgEnvironment): () => void {
    const id = ++seq;
    live(env).set(id, now());
    return () => { holders.get(env)?.delete(id); };
  }
  /** Pågår en analys i miljön just nu? */
  function active(env: IgEnvironment): boolean { return live(env).size > 0; }
  /** Kör fn med förturen tagen och släpper den alltid efteråt. */
  async function run<T>(env: IgEnvironment, fn: () => Promise<T>): Promise<T> {
    const release = begin(env);
    try { return await fn(); } finally { release(); }
  }
  return { begin, active, run };
}

const gate = createIgAnalysisGate();
export const beginIgAnalysis = gate.begin;
export const igAnalysisActive = gate.active;
export const withIgAnalysis = gate.run;
/** Text som bakgrundsläsningarna visar när de väntar på analysen. */
export const IG_ANALYSIS_PAUSE_TEXT = "väntar (agenterna analyserar)";
