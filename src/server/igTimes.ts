// ═══════════════════════════════════════════════════════════════════════════
// Fyra SEPARATA tidsval (D3). De blandas aldrig ihop:
//   1. Innehavstid      → hur länge en position hålls (tradeHorizon / orderns horizonSec)
//   2. Diagramintervall → vad du tittar på (bara i webbläsaren, per diagram)
//   3. Analysintervall  → ljusen agenterna analyserar (här)
//   4. Sessionslängd    → hur länge en agentsession pågår (här)
// ═══════════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../dataDir.js";

export const ANALYSIS_INTERVALS = ["1m", "5m", "15m", "1h"] as const;
export const SESSION_MINUTES = [15, 30, 60, 120] as const;
export type AnalysisInterval = typeof ANALYSIS_INTERVALS[number];
export interface IgTimes { analysisInterval: AnalysisInterval; sessionMinutes: number; updatedAt: number | null }

const file = () => dataPath("ig-times.json");
const DEFAULTS: IgTimes = { analysisInterval: "1m", sessionMinutes: 60, updatedAt: null };

export function getIgTimes(): IgTimes {
  try {
    const v = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<IgTimes>;
    return {
      analysisInterval: (ANALYSIS_INTERVALS as readonly string[]).includes(String(v.analysisInterval)) ? v.analysisInterval as AnalysisInterval : DEFAULTS.analysisInterval,
      sessionMinutes: (SESSION_MINUTES as readonly number[]).includes(Number(v.sessionMinutes)) ? Number(v.sessionMinutes) : DEFAULTS.sessionMinutes,
      updatedAt: Number(v.updatedAt) || null,
    };
  } catch { return { ...DEFAULTS }; }
}

export function setIgTimes(patch: { analysisInterval?: unknown; sessionMinutes?: unknown }, now = Date.now()): { ok: true; times: IgTimes } | { ok: false; error: string } {
  const cur = getIgTimes();
  if (patch.analysisInterval !== undefined && !(ANALYSIS_INTERVALS as readonly string[]).includes(String(patch.analysisInterval))) return { ok: false, error: `Analysintervall: välj ${ANALYSIS_INTERVALS.join(", ")}` };
  if (patch.sessionMinutes !== undefined && !(SESSION_MINUTES as readonly number[]).includes(Number(patch.sessionMinutes))) return { ok: false, error: `Sessionslängd: välj ${SESSION_MINUTES.join(", ")} min` };
  const next: IgTimes = {
    analysisInterval: (patch.analysisInterval as AnalysisInterval | undefined) ?? cur.analysisInterval,
    sessionMinutes: patch.sessionMinutes !== undefined ? Number(patch.sessionMinutes) : cur.sessionMinutes,
    updatedAt: now,
  };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return { ok: true, times: next };
}
