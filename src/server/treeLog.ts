import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
//  Arbetsträdet: tradingens grenar
//
//  Varje gång tradingen frågar JEV eller en AI-modell skrivs en rad hit, så
//  att arbetsträdet (ai_upscale_work/tools/agent-tree, terminal och Agent-OS)
//  kan visa vad JEV gör i tradingen bredvid businessens Claude Code-arbete.
//
//  Bara beslut och siffror: vilken gren, vad JEV svarade, vilken modell som
//  granskade och utfallet. Inga nycklar, inga prompter, inga belopp.
//  Fel här får aldrig störa tradingen, därför sväljs de tyst.
// ═══════════════════════════════════════════════════════════════════════════

const FILE = process.env.AGENT_TREE_TRADING_EVENTS
  || path.join(os.homedir(), ".claude", "agent-tree", "trading-events.jsonl");
const MAX_BYTES = 5 * 1024 * 1024;

export interface TreeEvent {
  /** signal = signalmotorn · strategi = strategibiblioteket · tur = Head-turen (advisor eller inte) */
  branch: "signal" | "strategi" | "tur" | "agent";
  /** Vad det gällde, t.ex. "BTCUSDT" eller strategins namn. */
  subject?: string;
  jev?: { available: boolean; route?: string; latencyMs?: number | null; depth?: string; review?: number };
  /** Modellen som granskade/valdes, om någon. */
  model?: string | null;
  /** Kort utfall: "ok", "stoppad", "advisor körs", "advisor hoppas över" … */
  outcome: string;
  /** Kort förklaring på svenska. */
  why?: string;
}

let dirReady = false;

export function treeEvent(e: TreeEvent): void {
  if (process.env.AGENT_TREE_TRADING_EVENTS === "off") return;
  try {
    if (!dirReady) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); dirReady = true; }
    try {
      if (fs.statSync(FILE).size > MAX_BYTES) fs.renameSync(FILE, `${FILE}.1`);
    } catch { /* filen finns inte än */ }
    const line = JSON.stringify({ ts: new Date().toISOString(), source: "trading", ...e, why: e.why?.slice(0, 160) });
    fs.appendFile(FILE, line + "\n", () => {});
  } catch { /* arbetsträdet är bara en vy */ }
}
