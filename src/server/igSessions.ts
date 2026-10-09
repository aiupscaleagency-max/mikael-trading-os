// ═══════════════════════════════════════════════════════════════════════════
// Urval, agentsessioner och schema för IG (krav E). Idé och regler från Codex
// igSchedules/igWorkspace (wt-ig), anpassade till vår orkestrering:
//
//  - Urvalet (EPICs) sparas på servern per miljö, inte bara i webbläsaren.
//  - Direktanalys: högst 10 instrument (spärras i /api/run-agent).
//  - Agentsession: upp till 500 instrument i omgångar om högst 5 per minut.
//    EPIC-lista, konto/miljö (IG-inloggning), strategi och analysintervall FRYSES vid start.
//    Köstatus per instrument: väntar / analyseras / analyserad / misslyckad / hoppad.
//  - Pipeline per omgång: JEV-förkontroll → teknisk analytiker → Hanna (befintlig
//    orkestrering, routing, minne och kostnadstak oförändrade).
//  - Högst 5 nya orderförsök per session (avvisade/okända räknas; bara agenternas
//    försök under sessionens omgångar). Sessionen får avstå från trades.
//  - Schema: Morgon 08:00, Lunch 12:00, Eftermiddag 15:00, Kväll 19:00 (Europe/Stockholm),
//    1 h fönster, analys varje minut, redigerbara tider. Kapacitet 60 min × 5/min = 300;
//    större urval kräver nytt tidsval. Schemalagd analys slår ALDRIG på orderexekvering och
//    tvingar godkännande även i AUTO-läge.
// ═══════════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IgEnvironment } from "../integrations/igConnection.js";
import { dataPath } from "../dataDir.js";

export const SESSION_MAX_EPICS = 500;
export const SESSION_PER_MINUTE = 5;
export const SESSION_MAX_ORDER_ATTEMPTS = 5;
export const DIRECT_ANALYSIS_MAX = 10;
const EPIC_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

export type ItemStatus = "väntar" | "analyseras" | "analyserad" | "misslyckad" | "hoppad";
export interface IgSessionItem { epic: string; status: ItemStatus; action: string | null; result: string | null; at: number | null }
export interface IgAgentSession {
  id: string; env: IgEnvironment; binding: string; trigger: "manuell" | "schema"; slot: string | null;
  epics: string[]; strategy: string | null; analysisInterval: string; durationMinutes: number; perMinute: number;
  startedAt: number; endsAt: number; nextRunAt: number;
  status: "running" | "stopped" | "completed" | "interrupted"; reason: string | null;
  items: IgSessionItem[]; orderAttempts: number; maxOrderAttempts: number; batches: number; batchInFlight: boolean;
}
export interface IgScheduleSlot { id: "morning" | "lunch" | "afternoon" | "evening"; label: string; time: string; enabled: boolean; lastOccurrence: string | null; lastResult: string | null }
interface EnvState { selection: { epics: string[]; updatedAt: number | null }; schedule: IgScheduleSlot[]; session: IgAgentSession | null; history: Array<Pick<IgAgentSession, "id" | "trigger" | "slot" | "startedAt" | "status" | "reason" | "orderAttempts"> & { analysed: number; total: number }> }

export const DEFAULT_SCHEDULE: IgScheduleSlot[] = [
  { id: "morning", label: "Morgon", time: "08:00", enabled: false, lastOccurrence: null, lastResult: null },
  { id: "lunch", label: "Lunch", time: "12:00", enabled: false, lastOccurrence: null, lastResult: null },
  { id: "afternoon", label: "Eftermiddag", time: "15:00", enabled: false, lastOccurrence: null, lastResult: null },
  { id: "evening", label: "Kväll", time: "19:00", enabled: false, lastOccurrence: null, lastResult: null },
];
export const SCHEDULE_WINDOW_MIN = 60;

const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function stockholmSlot(at: number): { date: string; time: string } {
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export function sessionCapacity(durationMinutes: number, perMinute = SESSION_PER_MINUTE): number { return Math.max(0, Math.floor(durationMinutes)) * perMinute; }
export function capacityError(count: number, durationMinutes: number): string | null {
  const cap = sessionCapacity(durationMinutes);
  return count > cap ? `Urvalet (${count}) ryms inte: ${durationMinutes} min × ${SESSION_PER_MINUTE}/min = ${cap} instrument. Välj ny tid (längre session) eller ett mindre urval.` : null;
}

export interface BatchResult { picks: Array<{ symbol: string; action: string; reasoning?: string }>; stopped?: Array<{ symbol: string; why: string }>; status?: string; reason?: string }
export interface IgSessionDeps {
  /** IG-inloggningens identitet per miljö (null = inte ansluten) */
  binding: (env: IgEnvironment) => string | null;
  activeEnv: () => IgEnvironment;
  /** Kör en omgång (≤5 EPICs) i sessionens miljö: JEV → teknisk analytiker → Hanna */
  runBatch: (env: IgEnvironment, epics: string[], ctx: { scheduled: boolean; strategy: string | null; analysisInterval: string; sessionId: string }) => Promise<BatchResult>;
  /** Kill switch / kostnadstak: null = OK, annars skäl */
  guard: () => Promise<string | null>;
  /** Pågår en annan analys just nu? (då väntar omgången en minut) */
  busy?: () => boolean;
  now?: () => number;
  directory?: string;
  onChange?: (env: IgEnvironment) => void;
}

export function createIgSessions(deps: IgSessionDeps) {
  const now = deps.now ?? Date.now;
  const dir = () => deps.directory ?? dataPath("ig-sessions");
  const cache = new Map<IgEnvironment, EnvState>();
  let ticking = false;

  function load(env: IgEnvironment): EnvState {
    if (env !== "demo" && env !== "live") throw new Error("Ogiltig IG-miljö");
    const c = cache.get(env); if (c) return c;
    let s: EnvState;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir(), `${env}.json`), "utf8")) as EnvState;
      s = {
        selection: { epics: Array.isArray(v.selection?.epics) ? v.selection.epics.filter((e) => EPIC_RE.test(e)).slice(0, SESSION_MAX_EPICS) : [], updatedAt: v.selection?.updatedAt ?? null },
        schedule: DEFAULT_SCHEDULE.map((d) => { const o = (v.schedule ?? []).find((x) => x.id === d.id); return o ? { ...d, ...o, id: d.id, label: d.label } : { ...d }; }),
        // Efter omstart körs ingen session vidare av sig själv
        session: v.session ? (v.session.status === "running" ? { ...v.session, status: "interrupted", reason: "Servern startades om; starta sessionen igen", batchInFlight: false } : v.session) : null,
        history: Array.isArray(v.history) ? v.history.slice(0, 10) : [],
      };
    } catch { s = { selection: { epics: [], updatedAt: null }, schedule: DEFAULT_SCHEDULE.map((d) => ({ ...d })), session: null, history: [] }; }
    cache.set(env, s);
    return s;
  }
  function save(env: IgEnvironment): void {
    const s = load(env);
    fs.mkdirSync(dir(), { recursive: true });
    const file = path.join(dir(), `${env}.json`), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, file);
    deps.onChange?.(env);
  }
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const cleanEpics = (list: unknown): string[] => {
    if (!Array.isArray(list)) throw new Error("Urvalet måste vara en lista med IG-EPICs");
    const out = [...new Set(list.map(String))];
    if (out.some((e) => !EPIC_RE.test(e))) throw new Error("Bara IG-EPICs (t.ex. CS.D.EURUSD.MINI.IP) — inga påhittade symboler");
    if (out.length > SESSION_MAX_EPICS) throw new Error(`Högst ${SESSION_MAX_EPICS} instrument i ett urval`);
    return out;
  };

  function state(env: IgEnvironment) {
    const s = load(env);
    return clone({ env, ...s, capacity: { perMinute: SESSION_PER_MINUTE, scheduleWindowMinutes: SCHEDULE_WINDOW_MIN, scheduleCapacity: sessionCapacity(SCHEDULE_WINDOW_MIN), selectionError: capacityError(s.selection.epics.length, SCHEDULE_WINDOW_MIN) }, limits: { directAnalysisMax: DIRECT_ANALYSIS_MAX, sessionMaxEpics: SESSION_MAX_EPICS, maxOrderAttempts: SESSION_MAX_ORDER_ATTEMPTS } });
  }

  function setSelection(env: IgEnvironment, epics: unknown) {
    const s = load(env);
    s.selection = { epics: cleanEpics(epics), updatedAt: now() };
    save(env);
    return clone(s.selection);
  }

  function setSchedule(env: IgEnvironment, slots: unknown) {
    if (!Array.isArray(slots)) throw new Error("Schemat måste vara en lista");
    const s = load(env);
    for (const raw of slots as Array<Partial<IgScheduleSlot>>) {
      const slot = s.schedule.find((x) => x.id === raw.id);
      if (!slot) throw new Error(`Okänd schemaplats ${String(raw.id)}`);
      if (raw.time !== undefined) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.time))) throw new Error("Ange tid som HH:MM (Europe/Stockholm)");
        slot.time = String(raw.time);
      }
      if (raw.enabled !== undefined) {
        if (raw.enabled === true) {
          const cap = capacityError(s.selection.epics.length, SCHEDULE_WINDOW_MIN);
          if (cap) throw new Error(cap);
          if (!s.selection.epics.length) throw new Error("Välj instrument (urvalet) innan schemat aktiveras");
        }
        slot.enabled = raw.enabled === true;
        slot.lastResult = slot.enabled ? "Aktiverat · bara analys, inga ordrar skickas utan Godkänn" : "Pausat";
      }
    }
    save(env);
    return clone(s.schedule);
  }

  function start(env: IgEnvironment, input: { epics?: unknown; durationMinutes?: unknown; analysisInterval?: unknown; strategy?: unknown; trigger?: "manuell" | "schema"; slot?: string | null }) {
    const s = load(env);
    if (s.session?.status === "running") throw new Error("En agentsession pågår redan i den här miljön. Stoppa den först.");
    const binding = deps.binding(env);
    if (!binding) throw new Error(`IG ${env === "live" ? "Live" : "Demo"} är inte anslutet`);
    if (deps.activeEnv() !== env) throw new Error("Sessionen måste startas i den aktiva miljön");
    const epics = input.epics !== undefined ? cleanEpics(input.epics) : [...s.selection.epics];
    if (!epics.length) throw new Error("Välj minst ett instrument");
    const durationMinutes = Number(input.durationMinutes ?? 60);
    if (![15, 30, 60, 120].includes(durationMinutes)) throw new Error("Sessionslängd: 15, 30, 60 eller 120 min");
    const cap = capacityError(epics.length, durationMinutes);
    if (cap) throw new Error(cap);
    const analysisInterval = String(input.analysisInterval ?? "1m");
    if (!["1m", "5m", "15m", "1h"].includes(analysisInterval)) throw new Error("Analysintervall: 1m, 5m, 15m eller 1h");
    const strategy = input.strategy == null || input.strategy === "" ? null : String(input.strategy).slice(0, 80);
    const t = now();
    const session: IgAgentSession = {
      id: randomUUID(), env, binding, trigger: input.trigger ?? "manuell", slot: input.slot ?? null,
      epics: Object.freeze([...epics]) as string[], strategy, analysisInterval, durationMinutes, perMinute: SESSION_PER_MINUTE,
      startedAt: t, endsAt: t + durationMinutes * 60_000, nextRunAt: t,
      status: "running", reason: null,
      items: epics.map((epic) => ({ epic, status: "väntar", action: null, result: null, at: null })),
      orderAttempts: 0, maxOrderAttempts: SESSION_MAX_ORDER_ATTEMPTS, batches: 0, batchInFlight: false,
    };
    s.session = session;
    save(env);
    return clone(session);
  }

  function finish(env: IgEnvironment, status: IgAgentSession["status"], reason: string | null): void {
    const s = load(env), x = s.session;
    if (!x || x.status !== "running") return;
    x.status = status; x.reason = reason;
    for (const it of x.items) if (it.status === "väntar") { it.status = "hoppad"; it.result = reason ?? "Sessionen slutade innan instrumentet hann analyseras"; }
    s.history = [{ id: x.id, trigger: x.trigger, slot: x.slot, startedAt: x.startedAt, status: x.status, reason: x.reason, orderAttempts: x.orderAttempts, analysed: x.items.filter((i) => i.status === "analyserad").length, total: x.items.length }, ...s.history].slice(0, 10);
    save(env);
  }

  function stop(env: IgEnvironment, reason = "Stoppad av Mike") {
    const s = load(env);
    if (s.session?.status !== "running") throw new Error("Ingen session pågår");
    finish(env, "stopped", reason);
    return clone(load(env).session);
  }

  async function runNext(env: IgEnvironment): Promise<void> {
    const s = load(env), x = s.session;
    if (!x || x.status !== "running" || x.batchInFlight) return;
    const t = now();
    if (t >= x.endsAt) { finish(env, "completed", x.items.some((i) => i.status === "väntar") ? "Tiden tog slut" : null); return; }
    if (deps.binding(env) !== x.binding) { finish(env, "interrupted", "IG-inloggningen ändrades — sessionen fortsätter inte på ett annat konto"); return; }
    if (deps.activeEnv() !== env) { finish(env, "interrupted", "Aktiv miljö byttes — sessionen kör aldrig i fel miljö"); return; }
    if (t < x.nextRunAt) return;
    const batch = x.items.filter((i) => i.status === "väntar").slice(0, x.perMinute);
    if (!batch.length) { finish(env, "completed", null); return; }
    if (deps.busy?.()) return; // en annan analys pågår: försök nästa varv
    const why = await deps.guard();
    if (why) { finish(env, "stopped", why); return; }
    x.batchInFlight = true; x.nextRunAt = t + 60_000; x.batches++;
    for (const it of batch) { it.status = "analyseras"; it.at = t; }
    save(env);
    try {
      const r = await deps.runBatch(env, batch.map((i) => i.epic), { scheduled: x.trigger === "schema", strategy: x.strategy, analysisInterval: x.analysisInterval, sessionId: x.id });
      const cur = load(env).session;
      if (!cur || cur.id !== x.id) return;
      const failed = r.status === "failed" || r.status === "stopped";
      for (const it of cur.items.filter((i) => batch.some((b) => b.epic === i.epic))) {
        const stop = r.stopped?.find((y) => y.symbol === it.epic);
        const pick = r.picks.find((p) => p.symbol === it.epic);
        it.at = now();
        if (failed) { it.status = "misslyckad"; it.result = r.reason ?? "Omgången misslyckades"; continue; }
        it.status = "analyserad";
        if (stop) { it.action = "avstå"; it.result = `JEV stoppade: ${stop.why}`; }
        else if (pick) { it.action = pick.action; it.result = (pick.reasoning ?? "").slice(0, 300) || null; }
        else { it.action = "avstå"; it.result = "Inget förslag — sessionen avstod"; }
      }
    } catch (e) {
      const cur = load(env).session;
      if (cur && cur.id === x.id) for (const it of cur.items.filter((i) => batch.some((b) => b.epic === i.epic))) { it.status = "misslyckad"; it.result = e instanceof Error ? e.message.slice(0, 200) : String(e); it.at = now(); }
    } finally {
      const cur = load(env).session;
      if (cur && cur.id === x.id) { cur.batchInFlight = false; save(env); }
    }
  }

  async function tickSchedule(env: IgEnvironment): Promise<void> {
    const s = load(env), slot = stockholmSlot(now());
    for (const sch of s.schedule) {
      if (!sch.enabled || sch.time !== slot.time) continue;
      const occ = `${slot.date} ${sch.time}`;
      if (sch.lastOccurrence === occ) continue;
      // Gör anspråk FÖRE start: ingen återspelning efter krasch eller dubbel hösttimme
      sch.lastOccurrence = occ; sch.lastResult = "Start begärd"; save(env);
      try {
        const cap = capacityError(s.selection.epics.length, SCHEDULE_WINDOW_MIN);
        if (cap) throw new Error(cap);
        const why = await deps.guard(); if (why) throw new Error(why);
        start(env, { trigger: "schema", slot: sch.id, durationMinutes: SCHEDULE_WINDOW_MIN });
        sch.lastResult = `Session startad ${sch.time} · ${s.selection.epics.length} instrument · bara analys, ordrar kräver Godkänn`;
      } catch (e) { sch.lastResult = `Startade inte: ${e instanceof Error ? e.message : String(e)}`; }
      save(env);
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return; ticking = true;
    try {
      for (const env of ["demo", "live"] as const) {
        try { await tickSchedule(env); } catch { /* visas i lastResult */ }
        try { await runNext(env); } catch { /* visas per instrument */ }
      }
    } finally { ticking = false; }
  }

  /** Orderhook (orderGate): räknar agenternas nya orderförsök under en omgång; spärrar efter 5. */
  function orderGateHook(input: { live: boolean; opening?: boolean; side: string; source: string }): string | null {
    if (input.source.startsWith("godkänd:")) return null;
    // M1: bara agenternas/strategiernas NYA positioner räknas. Stängningar, Sälj allt och Mikes egna
    // manuella ordrar under en omgång är inga orderförsök från sessionen.
    if (input.opening !== true) return null;
    if (!/^(agent|strategi|session)/i.test(input.source)) return null;
    const env: IgEnvironment = input.live ? "live" : "demo";
    const x = load(env).session;
    if (!x || x.status !== "running" || !x.batchInFlight) return null;
    if (x.orderAttempts >= x.maxOrderAttempts) return `Agentsessionen har redan gjort ${x.maxOrderAttempts} orderförsök (avvisade och okända räknas). Inga fler nya ordrar i den här sessionen.`;
    x.orderAttempts++;
    save(env);
    return null;
  }
  /** Schemalagd omgång pågår → ordrar kräver alltid Godkänn (även i AUTO-läge). */
  function forcesApproval(): boolean {
    return (["demo", "live"] as const).some((e) => { const x = load(e).session; return !!x && x.status === "running" && x.trigger === "schema" && x.batchInFlight; });
  }

  return { state, setSelection, setSchedule, start, stop, tick, runNext, orderGateHook, forcesApproval };
}
