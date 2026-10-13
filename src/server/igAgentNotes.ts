import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../dataDir.js";
import { sortTips, type AgentTip } from "../orchestrator/headTips.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Agenternas senaste besked per instrument (Alla par + Agentsessioner).
//
//  "Senaste analysen" (agentActivity) är EN global post utan miljö och har inga
//  rader när Hanna avstår (HOLD). Här sparas därför, per miljö och EPIC, det
//  senaste beskedet: Hannas beslut (köp/sälj/avvakta + motivering) och den
//  tekniska analytikerns sammanfattning. En ny analys av ETH raderar aldrig BTC:s
//  besked, och Demo-text visas aldrig under Live. Bara läsbar text, ingen order.
// ═══════════════════════════════════════════════════════════════════════════

export type NoteEnv = "demo" | "live";
export interface AgentNote {
  epic: string;
  env: NoteEnv;
  at: string;
  /** buy | sell | hold (hold = Hanna avstod / inget förslag) */
  action: string;
  confidence: string | null;
  /** Hannas besked (Head Trader), kort */
  verdict: string;
  /** Teknisk analytiker: riktning, poäng och nyckelsignaler, kort */
  technical: string | null;
  trigger: string | null;
  /** Hannas konkreta tips (rang, KÖP/SÄLJ/AVVAKTA, entry/TP/SL, storlek, horisont, säkerhet). Saknas i äldre anteckningar. */
  tip?: AgentTip | null;
  /** Analysomgången anteckningen hör till (agentsessionens id eller analysens start), för "Bästa först" över omgångar */
  runId?: string | null;
}

// Pågående agentsession sätter sitt id här, så att alla dess omgångar räknas som EN analys i topplistan.
let currentRunId: string | null = null;
export function setNotesRunId(id: string | null): void { currentRunId = id; }
export function notesRunId(): string | null { return currentRunId; }

export interface TechnicalLike { symbol: string; bias?: string; score?: number; keySignals?: string[] }
export interface PickLike { symbol: string; action: string; confidence?: string; reasoning?: string }

const MAX_PER_ENV = 1000;
const BIAS: Record<string, string> = { bullish: "uppåt", bearish: "nedåt", neutral: "neutral" };

/** Kort utdrag ur Hannas sammanfattning när hon avstod utan rad per instrument. */
export function holdExcerpt(summary: string | undefined, epic: string, name?: string | null): string {
  const s = String(summary ?? "").replace(/\*\*/g, "").trim();
  if (!s) return "Hanna avstod (inget förslag för instrumentet).";
  const lines = s.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  // Rad som nämner instrumentet först, sedan "[2] Action"-raden, annars första meningen
  const about = lines.find((l) => l.includes(epic) || (!!name && l.toLowerCase().includes(String(name).toLowerCase())));
  const action = lines.find((l) => /^\[2\]/.test(l) || /^action\b/i.test(l));
  const first = lines[0] ?? "";
  const parts = [first, about && about !== first ? about : null, action && action !== first && action !== about ? action : null].filter(Boolean) as string[];
  return parts.join(" ").slice(0, 320);
}

export function technicalText(t: TechnicalLike | undefined): string | null {
  if (!t) return null;
  const sig = (t.keySignals ?? []).filter(Boolean).slice(0, 3).join("; ");
  return [`riktning ${BIAS[String(t.bias)] ?? t.bias ?? "–"}`, Number.isFinite(t.score) ? `poäng ${t.score}` : null, sig || null].filter(Boolean).join(" · ").slice(0, 240);
}

/** Bygger en anteckning per analyserat instrument, även när Hanna avstod (HOLD utan rad). */
export function buildAgentNotes(p: {
  env: NoteEnv; symbols: string[]; picks: PickLike[]; technical: TechnicalLike[]; summary?: string; trigger?: string | null;
  nameOf?: (epic: string) => string | null; at?: string;
  tips?: AgentTip[]; runId?: string | null;
}): AgentNote[] {
  const at = p.at ?? new Date().toISOString();
  return [...new Set(p.symbols)].filter((e) => typeof e === "string" && e).map((epic) => {
    const pick = p.picks.find((x) => x.symbol === epic);
    const tech = p.technical.find((x) => x.symbol === epic);
    return {
      epic, env: p.env, at,
      action: pick ? String(pick.action) : "hold",
      confidence: pick?.confidence ?? null,
      verdict: pick?.reasoning ? String(pick.reasoning).slice(0, 320) : holdExcerpt(p.summary, epic, p.nameOf?.(epic) ?? null),
      technical: technicalText(tech),
      trigger: p.trigger ?? null,
      ...(p.tips ? { tip: p.tips.find((t) => t.epic === epic) ?? null } : {}),
      ...(p.runId ? { runId: p.runId } : {}),
    };
  });
}

export function createAgentNotes(deps: { file?: (env: NoteEnv) => string; persist?: boolean } = {}) {
  const file = deps.file ?? ((env: NoteEnv) => dataPath(`ig-agent-notes-${env}.json`));
  const persist = deps.persist !== false;
  const mem = new Map<NoteEnv, Map<string, AgentNote>>();
  function load(env: NoteEnv): Map<string, AgentNote> {
    let m = mem.get(env);
    if (m) return m;
    m = new Map();
    if (persist) {
      try {
        const d = JSON.parse(fs.readFileSync(file(env), "utf8"));
        for (const n of Array.isArray(d?.notes) ? d.notes : []) if (n && typeof n.epic === "string" && n.env === env) m.set(n.epic, n);
      } catch { /* ingen fil än */ }
    }
    mem.set(env, m);
    return m;
  }
  function save(env: NoteEnv): void {
    if (!persist) return;
    try {
      fs.mkdirSync(path.dirname(file(env)), { recursive: true });
      fs.writeFileSync(file(env), JSON.stringify({ savedAt: new Date().toISOString(), notes: [...load(env).values()] }));
    } catch { /* bara en spegel */ }
  }
  function record(notes: AgentNote[]): void {
    const touched = new Set<NoteEnv>();
    for (const n of notes) {
      if (n.env !== "demo" && n.env !== "live") continue;
      const m = load(n.env);
      m.delete(n.epic); m.set(n.epic, n); // senast först i slutet
      while (m.size > MAX_PER_ENV) m.delete(m.keys().next().value!);
      touched.add(n.env);
    }
    for (const e of touched) save(e);
  }
  function get(env: NoteEnv, epics?: string[]): Record<string, AgentNote> {
    const m = load(env), out: Record<string, AgentNote> = {};
    for (const [k, v] of m) if (!epics || epics.includes(k)) out[k] = v;
    return out;
  }
  /** Agenternas topplista: senaste analysomgången (alla dess omgångar), bästa först. Bara anteckningar med tips. */
  function top(env: NoteEnv): { runId: string | null; at: string | null; items: AgentNote[] } {
    const withTip = [...load(env).values()].filter((n) => n.tip);
    if (!withTip.length) return { runId: null, at: null, items: [] };
    const latest = withTip.reduce((a, b) => (a.at >= b.at ? a : b));
    const run = latest.runId ?? null;
    const items = withTip.filter((n) => (run ? n.runId === run : n.at === latest.at));
    const ranked = sortTips(items.map((n) => ({ ...n.tip!, note: n }))).map((x) => x.note);
    return { runId: run, at: latest.at, items: ranked };
  }
  return { record, get, top };
}

export const agentNotes = createAgentNotes();
