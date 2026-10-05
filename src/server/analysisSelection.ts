import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ANALYSIS_TIMEFRAMES, type AnalysisTimeframe } from "../orchestrator/analysisRequest.js";

export interface AnalysisSelection { selectedSymbols: string[]; timeframe: AnalysisTimeframe }
const FILE = path.resolve("data/analysis-selection.json");
const choices: readonly string[] = ANALYSIS_TIMEFRAMES;
let saved: Partial<Record<"TEST" | "LIVE", AnalysisSelection>> = {};
try { saved = JSON.parse(readFileSync(FILE, "utf8")); } catch { /* Inget sparat val. */ }

export function validateAnalysisSelection(value: unknown): AnalysisSelection {
  const v = value as Partial<AnalysisSelection> | null;
  if (!v || !Array.isArray(v.selectedSymbols) || v.selectedSymbols.length === 0 || v.selectedSymbols.length > 30
    || v.selectedSymbols.some((s) => typeof s !== "string" || !/^[A-Z0-9]{2,20}USDC$/.test(s))) {
    throw new Error("Välj 1–30 Bybit EU USDC-par för analysen");
  }
  const timeframe = v.timeframe ?? "5m";
  if (!choices.includes(timeframe)) throw new Error("Ogiltigt analysintervall");
  return { selectedSymbols: [...new Set(v.selectedSymbols)], timeframe };
}

export function getAnalysisSelection(mode: "TEST" | "LIVE"): AnalysisSelection {
  try { return validateAnalysisSelection(saved[mode]); }
  catch { return { selectedSymbols: [], timeframe: "5m" }; }
}

export function setAnalysisSelection(mode: "TEST" | "LIVE", value: unknown): AnalysisSelection {
  const selection = validateAnalysisSelection(value);
  const next = { ...saved, [mode]: selection };
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE + ".tmp", JSON.stringify(next));
  renameSync(FILE + ".tmp", FILE);
  saved = next;
  return { ...selection, selectedSymbols: [...selection.selectedSymbols] };
}
