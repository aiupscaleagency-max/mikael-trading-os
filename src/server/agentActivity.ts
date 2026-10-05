import { modelFor } from "../llm/gateway.js";
import { treeEvent } from "./treeLog.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Arbetsträdet i Trading-OS: vem jobbar, var i processen
//
//  Varje agent (Lars, Markus, Tomas … Hanna), JEV, AI-granskaren och varje
//  strategi får en nod. Koden anropar agentStart/agentDone exakt där arbetet
//  börjar och slutar, så att trädet bara visar det som verkligen händer.
//  Inget här påverkar besluten: det är bara en spegel, och fel sväljs.
//
//  GET /api/agent-tree (liveRoutes.ts) läser snapshot().
// ═══════════════════════════════════════════════════════════════════════════

export type AgentStatus = "idle" | "working" | "done" | "failed" | "skipped";

export interface AgentNode {
  id: string;
  name: string;
  role: string;
  model: string;
  group: "team" | "strategi";
  status: AgentStatus;
  startedAt: number | null;
  endedAt: number | null;
  note: string;
  runs: number;
  lastMs: number | null;
  coin: string | null;
  /** Hur många gånger noden har skannat ett nytt ljus (strategier), och senast vilket coin. */
  scans: number;
  lastScanAt: number | null;
  lastScanCoin: string | null;
  /** Strategier: vilken agent i teamet som äger strategin (t.ex. "technical"). */
  owner: string | null;
}

export interface ActivityEvent {
  ts: number;
  id: string;
  kind: "start" | "done" | "fail" | "skip" | "flow" | "phase" | "info";
  note: string;
  from?: string;
  coin?: string | null;
}

const MAX_EVENTS = 400;
const agents = new Map<string, AgentNode>();
const events: ActivityEvent[] = [];
let turn: { id: number; phase: string; startedAt: number | null; endedAt: number | null } = { id: 0, phase: "väntar på nästa tur", startedAt: null, endedAt: null };

const specialist = () => modelFor("specialist", "claude-haiku-4-5-20251001");

/** Teamet i samma ordning som turen kör dem (orchestrator.ts). */
const TEAM: Array<{ id: string; name: string; role: string; model: () => string }> = [
  { id: "orchestrator", name: "Orkestrator", role: "startar turen", model: () => "kod" },
  { id: "research", name: "Lars", role: "Research", model: () => "perplexity sonar-pro" },
  { id: "jev", name: "JEV", role: "grind: advisor eller inte, veto på signaler", model: () => "typesafe jev" },
  { id: "macro", name: "Markus", role: "Makro", model: specialist },
  { id: "technical", name: "Tomas", role: "Teknisk", model: specialist },
  { id: "sentiment", name: "Sara", role: "Sentiment", model: specialist },
  { id: "risk", name: "Rasmus", role: "Risk", model: specialist },
  { id: "quant", name: "Karin", role: "Kvant", model: specialist },
  { id: "portfolio", name: "Petra", role: "Portfölj", model: specialist },
  { id: "advisor", name: "Albert", role: "Advisor", model: () => modelFor("advisor", "claude-opus-4-7") },
  { id: "execution", name: "Emma", role: "Exekvering", model: specialist },
  { id: "head", name: "Hanna", role: "Head Trader", model: () => modelFor("head", "claude-sonnet-4-6") },
  { id: "broker", name: "Order", role: "lägger ordern hos brokern", model: () => "kod" },
  { id: "signal", name: "Signalmotor", role: "räknar signaler per coin", model: () => "kod" },
  { id: "review-ai", name: "AI-granskare", role: "granskar strategins köp", model: () => "väljs per signal" },
  { id: "paper", name: "Poängtavla", role: "låtsasaffärer (TEST)", model: () => "kod" },
  { id: "orders", name: "Väntande order", role: "väntar på ditt OK", model: () => "kod" },
  { id: "mike", name: "Mike", role: "dina handlingar i Trading OS", model: () => "du" },
];

function blank(id: string, name: string, role: string, model: string, group: AgentNode["group"]): AgentNode {
  return { id, name, role, model, group, status: "idle", startedAt: null, endedAt: null, note: "", runs: 0, lastMs: null, coin: null, scans: 0, lastScanAt: null, lastScanCoin: null, owner: null };
}

for (const t of TEAM) agents.set(t.id, blank(t.id, t.name, t.role, "", t.id === "review-ai" || t.id === "paper" || t.id === "orders" ? "strategi" : "team"));

function push(e: ActivityEvent): void {
  events.push(e);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  try {
    treeEvent({ branch: "agent", subject: e.coin ? `${e.id} · ${e.coin}` : e.id, outcome: e.kind, why: e.note });
  } catch { /* bara en spegel */ }
}

function node(id: string): AgentNode {
  let a = agents.get(id);
  if (!a) {
    a = blank(id, id, "", "", id.startsWith("strategy:") ? "strategi" : "team");
    agents.set(id, a);
  }
  return a;
}

/** Strategierna blir egna noder med sina coins (anropas när biblioteket läses). */
export function registerStrategies(list: Array<{ id: string; name: string; coins: string[]; enabled: boolean; venue: string; review: string; agent?: string }>): void {
  try {
    for (const s of list) {
      const a = node(`strategy:${s.id}`);
      a.name = s.name;
      a.role = `${s.coins.join(", ")} · ${s.venue.toUpperCase()} · ${s.enabled ? "på" : "av"}`;
      a.model = s.review === "off" ? "bara regler" : s.review === "jev" ? "regler + JEV" : "regler + JEV + AI";
      a.group = "strategi";
      a.owner = s.agent ?? null;
    }
  } catch { /* bara en spegel */ }
}

export function agentStart(id: string, note: string, opts: { from?: string; coin?: string | null } = {}): void {
  try {
    const a = node(id);
    a.status = "working";
    a.startedAt = Date.now();
    a.endedAt = null;
    a.note = note;
    a.coin = opts.coin ?? null;
    if (opts.from) push({ ts: Date.now(), id, kind: "flow", from: opts.from, note, coin: opts.coin ?? null });
    push({ ts: Date.now(), id, kind: "start", note, coin: opts.coin ?? null });
  } catch { /* bara en spegel */ }
}

function finish(id: string, status: AgentStatus, kind: ActivityEvent["kind"], note: string): void {
  try {
    const a = node(id);
    const now = Date.now();
    a.lastMs = a.startedAt && a.status === "working" ? now - a.startedAt : a.lastMs;
    a.status = status;
    a.endedAt = now;
    a.note = note;
    a.runs++;
    push({ ts: now, id, kind, note, coin: a.coin });
  } catch { /* bara en spegel */ }
}

/** Rörelse på ett ljus som räknas som värd att visa i loggen (procent). */
const MOVE_PCT = 0.3;

/**
 * En strategi har läst ett nytt stängt ljus för ett coin. Räknas alltid; om
 * priset rörde sig minst MOVE_PCT % blir det en rad i loggen ("BTC har stigit 0.6 %").
 */
export function agentScan(id: string, coin: string, changePct?: number | null): void {
  try {
    const a = node(id);
    a.scans++;
    a.lastScanAt = Date.now();
    a.lastScanCoin = coin;
    if (changePct != null && Number.isFinite(changePct) && Math.abs(changePct) >= MOVE_PCT) {
      const word = changePct > 0 ? "har stigit" : "har fallit";
      push({ ts: Date.now(), id, kind: "info", note: `${coin} ${word} ${Math.abs(changePct).toFixed(2)} % på senaste ljuset`, coin });
    }
  } catch { /* bara en spegel */ }
}

/** En händelse mitt i ett arbete, t.ex. att Hanna anropar ett verktyg. */
export function agentNote(id: string, note: string, from?: string): void {
  try {
    node(id).note = note;
    push({ ts: Date.now(), id, kind: "flow", from, note });
  } catch { /* bara en spegel */ }
}

export const agentDone = (id: string, note = "klar") => finish(id, "done", "done", note);
export const agentFail = (id: string, note: string) => finish(id, "failed", "fail", note);
export const agentSkip = (id: string, note: string) => finish(id, "skipped", "skip", note);

/** Något Mike gjorde i Trading OS (godkände, avvisade, kill switch, strategi …) — syns i trädet direkt. */
export function userAction(note: string, opts: { to?: string; coin?: string | null } = {}): void {
  agentStart("mike", note, { coin: opts.coin ?? null });
  if (opts.to) agentNote(opts.to, note, "mike");
  agentDone("mike", note);
}

/** Kör fn och markerar noden som jobbar/klar/fel. Felet kastas vidare oförändrat. */
export async function track<T>(id: string, note: string, fn: () => Promise<T>, opts: { from?: string; coin?: string | null; done?: (r: T) => string; stopped?: (r: T) => string | null } = {}): Promise<T> {
  agentStart(id, note, opts);
  try {
    const r = await fn();
    // Ett svar som säger nej (t.ex. riskkontrollen stoppade ordern) visas som fel, inte som klart.
    let stop: string | null = null;
    try { stop = opts.stopped ? opts.stopped(r) : null; } catch { /* bara text */ }
    if (stop) { agentFail(id, stop); return r; }
    let summary = "klar";
    try { summary = opts.done ? opts.done(r) : "klar"; } catch { /* sammanfattningen är bara text */ }
    agentDone(id, summary);
    return r;
  } catch (err) {
    agentFail(id, err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140));
    throw err;
  }
}

export function turnPhase(phase: string): void {
  try {
    if (phase.startsWith("Fas 0")) { turn = { id: turn.id + 1, phase, startedAt: Date.now(), endedAt: null }; }
    else turn.phase = phase;
    push({ ts: Date.now(), id: "orchestrator", kind: "phase", note: phase });
  } catch { /* bara en spegel */ }
}

export function turnEnd(note: string): void {
  try {
    turn.phase = note;
    turn.endedAt = Date.now();
    push({ ts: Date.now(), id: "orchestrator", kind: "phase", note });
  } catch { /* bara en spegel */ }
}

export interface AgentTreeSnapshot {
  now: number;
  turn: typeof turn;
  agents: AgentNode[];
  events: ActivityEvent[];
}

export function snapshot(limit = 120): AgentTreeSnapshot {
  for (const t of TEAM) {
    try { node(t.id).model = t.model(); } catch { /* modellnamnet är bara text */ }
  }
  return { now: Date.now(), turn: { ...turn }, agents: [...agents.values()].map((a) => ({ ...a })), events: events.slice(-limit) };
}

/** Bara för tester. */
export function _resetActivity(): void {
  events.length = 0;
  for (const a of agents.values()) Object.assign(a, { status: "idle", startedAt: null, endedAt: null, note: "", runs: 0, lastMs: null, coin: null, scans: 0, lastScanAt: null, lastScanCoin: null });
  turn = { id: 0, phase: "väntar på nästa tur", startedAt: null, endedAt: null };
}

// ── Senaste analysen ────────────────────────────────────────────────────────
// Vad en analys-tur kom fram till, i klartext för Trading-sidan: vilka par Hanna
// valde, köp eller sälj, belopp och vad som hände med ordern. Stoppas turen
// (t.ex. dagens AI-tak) står orsaken här i stället för att inget syns.
export interface AnalysisPick { symbol: string; action: string; sizeUsd: number; confidence: string; reasoning: string }
export interface AnalysisOrder { symbol: string; side: string; usd: number | null; status: string }
export interface AnalysisResult {
  broker?: string;
  requestId?: string;
  selectedSymbols?: string[];
  timeframe?: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "done" | "stopped" | "failed";
  trigger: "manuell" | "schema";
  instruction?: string;
  reason?: string;
  regime?: string;
  summary?: string;
  picks: AnalysisPick[];
  orders: AnalysisOrder[];
}

let lastAnalysis: AnalysisResult | null = null;

export function analysisStart(trigger: AnalysisResult["trigger"], instruction?: string, context: Pick<AnalysisResult, "broker" | "requestId" | "selectedSymbols" | "timeframe"> = {}): void {
  lastAnalysis = { ...context, startedAt: new Date().toISOString(), endedAt: null, status: "running", trigger, instruction, picks: [], orders: [] };
}

export function analysisEnd(patch: Partial<AnalysisResult> & { status: AnalysisResult["status"] }): void {
  try {
    if (!lastAnalysis) analysisStart("schema");
    lastAnalysis = { ...lastAnalysis!, ...patch, endedAt: new Date().toISOString() };
    if (patch.status === "stopped" || patch.status === "failed") agentFail("orchestrator", patch.reason ?? "analysen stoppades");
  } catch { /* bara en spegel */ }
}

export function getAnalysis(): AnalysisResult | null {
  return lastAnalysis;
}
