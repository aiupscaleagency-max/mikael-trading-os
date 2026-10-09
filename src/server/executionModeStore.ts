// Auto eller manuellt för agenternas ordrar, valt på Trade-sidan.
// Sparas i data/execution-mode.json så att valet finns kvar efter omstart.
// AUTO går bara i TEST. I LIVE kräver varje order alltid Godkänn.

import { dataDir, dataPath } from "../dataDir.js";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";

export type ExecMode = "auto" | "approve";

const FILE = dataPath("execution-mode.json");

/** Kan AUTO väljas just nu? Bara i TEST (låtsaspengar). */
export function autoAllowed(): boolean {
  return config.mode !== "live";
}

export function setExecutionMode(mode: ExecMode): void {
  (config as { executionMode: ExecMode }).executionMode = mode;
}

export async function saveExecutionMode(mode: ExecMode): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ executionMode: mode, savedAt: new Date().toISOString() }, null, 2));
}

/** Vid start: använd det du valde senast. AUTO ignoreras i LIVE. */
export async function restoreExecutionMode(): Promise<void> {
  try {
    const d = JSON.parse(await fs.readFile(FILE, "utf8")) as { executionMode?: string };
    if (d.executionMode === "approve") setExecutionMode("approve");
    else if (d.executionMode === "auto") {
      if (autoAllowed()) setExecutionMode("auto");
      else { setExecutionMode("approve"); log.warn("Sparat AUTO-läge ignoreras i LIVE: varje order kräver Godkänn."); }
    }
  } catch {
    // Ingen fil än: behåll EXECUTION_MODE från .env
  }
  if (config.mode === "live" && config.executionMode !== "approve") {
    setExecutionMode("approve");
    log.warn("LIVE: godkännande-läge tvingas på, varje order kräver Godkänn.");
  }
}
