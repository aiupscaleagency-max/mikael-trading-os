// ═════════════════════════════════════════════════════════════════════
// Strategy Library (krav F1–F3)
//
// Gemensamma definitioner/versioner kommer från igStrategies.ts +
// igStrategyFactory.ts (portade från Codex). Kontospecifika resultat hålls
// SEPARAT per miljö (demo / live) i strategy-results.json och blandas aldrig.
// Inga resultat hittas på: en strategi blir "backtestad"/"framåttestad" först
// när ett verifierat resultat finns registrerat för just den miljön.
// ═════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../dataDir.js";
import { listIgStrategies } from "../integrations/igStrategies.js";

export type LibraryEnv = "demo" | "live";
export type LibraryStatus = "utkast" | "forskningskandidat" | "regelmotor" | "backtestad" | "framåttestad";
export interface VerifiedStrategyResult {
  kind: "backtest" | "forward";
  period: { from: string; to: string };
  trades: number;
  netPercent: number | null;
  profitFactor: number | null;
  maxDrawdownPercent: number | null;
  costModel: string;
  source: string;
  recordedAt: number;
}

const resultsFile = () => dataPath("strategy-results.json");

/** PDF-underlag som nämns i kravlistan. Inga av dem finns i repot (F3) – de listas som saknade, aldrig som implementerade. */
export const PDF_SOURCES_EXPECTED = 5;
export function findPdfSources(root = path.resolve("reference")): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && /\.pdf$/i.test(e.name)) out.push(path.relative(path.dirname(root), p));
    }
  };
  walk(root, 0);
  return out.sort();
}

function readResults(): Record<LibraryEnv, Record<string, VerifiedStrategyResult[]>> {
  try {
    const v = JSON.parse(fs.readFileSync(resultsFile(), "utf8"));
    return { demo: v && typeof v.demo === "object" ? v.demo : {}, live: v && typeof v.live === "object" ? v.live : {} };
  } catch { return { demo: {}, live: {} }; }
}

/** Registrera ett VERIFIERAT resultat för en strategi i en miljö. Ofullständiga resultat avvisas. */
export function recordStrategyResult(env: LibraryEnv, strategyId: string, r: Omit<VerifiedStrategyResult, "recordedAt">, now = Date.now()): { ok: true } | { ok: false; error: string } {
  if (env !== "demo" && env !== "live") return { ok: false, error: "Miljö måste vara demo eller live" };
  if (!listIgStrategies().some((s) => s.id === strategyId)) return { ok: false, error: "Okänd strategi" };
  if (r.kind !== "backtest" && r.kind !== "forward") return { ok: false, error: "Typ måste vara backtest eller forward" };
  if (!r.period?.from || !r.period?.to || !Number.isInteger(r.trades) || r.trades < 1) return { ok: false, error: "Testperiod och antal affärer krävs" };
  if (!r.costModel || !r.source) return { ok: false, error: "Kostnadsmodell och källa krävs" };
  const all = readResults();
  (all[env][strategyId] ||= []).push({ ...r, recordedAt: now });
  fs.mkdirSync(path.dirname(resultsFile()), { recursive: true });
  const tmp = resultsFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, resultsFile());
  return { ok: true };
}

// ─── F1: resultat från dina egna IG-affärer, per strategi och miljö ───
// Bara affärer vars order bar ett strategi-id från biblioteket räknas. En affär (dealId) räknas en gång.
// Demo och Live ligger i var sin del av filen och blandas aldrig.
export interface StrategyIgTrade { dealId: string; pnl: number; currency: string | null; win: boolean; at: number; epic: string | null; recordedAt: number }
const igTradesFile = () => dataPath("strategy-ig-trades.json");
function readIgTrades(): Record<LibraryEnv, Record<string, StrategyIgTrade[]>> {
  try {
    const v = JSON.parse(fs.readFileSync(igTradesFile(), "utf8"));
    return { demo: v && typeof v.demo === "object" ? v.demo : {}, live: v && typeof v.live === "object" ? v.live : {} };
  } catch { return { demo: {}, live: {} }; }
}
export function isLibraryStrategy(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && listIgStrategies().some((s) => s.id === id);
}
/** Registrera en stängd IG-affär för en strategi i EN miljö. Samma dealId räknas aldrig två gånger. */
export function recordStrategyTrade(env: LibraryEnv, strategyId: string, t: { dealId: string; pnl: number; currency: string | null; at: number; epic?: string | null }, now = Date.now()): { ok: true; duplicate: boolean } | { ok: false; error: string } {
  if (env !== "demo" && env !== "live") return { ok: false, error: "Miljö måste vara demo eller live" };
  if (!isLibraryStrategy(strategyId)) return { ok: false, error: "Okänd strategi" };
  if (!t.dealId || typeof t.dealId !== "string") return { ok: false, error: "dealId saknas" };
  if (!Number.isFinite(t.pnl) || !Number.isFinite(t.at)) return { ok: false, error: "Resultat och tid krävs" };
  const all = readIgTrades();
  if (Object.values(all[env]).some((rows) => rows.some((r) => r.dealId === t.dealId))) return { ok: true, duplicate: true };
  (all[env][strategyId] ||= []).push({ dealId: t.dealId, pnl: t.pnl, currency: t.currency ?? null, win: t.pnl > 0, at: t.at, epic: t.epic ?? null, recordedAt: now });
  fs.mkdirSync(path.dirname(igTradesFile()), { recursive: true });
  const tmp = igTradesFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, igTradesFile());
  return { ok: true, duplicate: false };
}
export interface StrategyIgSummary { label: string; trades: number; wins: number; winRate: number | null; pnl: Record<string, number>; lastAt: number | null }
export function strategyIgSummary(env: LibraryEnv, strategyId: string, all = readIgTrades()): StrategyIgSummary {
  const rows = all[env]?.[strategyId] ?? [];
  const pnl: Record<string, number> = {};
  for (const r of rows) { const c = r.currency || "kontovaluta"; pnl[c] = Math.round(((pnl[c] ?? 0) + r.pnl) * 100) / 100; }
  const wins = rows.filter((r) => r.win).length;
  return {
    label: `från dina IG-affärer (${env === "live" ? "Live" : "Demo"})`,
    trades: rows.length, wins, winRate: rows.length ? Math.round((wins / rows.length) * 1000) / 10 : null,
    pnl, lastAt: rows.length ? Math.max(...rows.map((r) => r.at)) : null,
  };
}

type Raw = ReturnType<typeof listIgStrategies>[number] & Record<string, any>;

function baseStatus(s: Raw): LibraryStatus {
  if (s.kind === "research_candidate") return "forskningskandidat";
  if (s.entry && s.exit) return "regelmotor";
  return "utkast";
}

export function strategyLibrary(opts: { pdfRoot?: string } = {}) {
  const results = readResults();
  const igTrades = readIgTrades();
  const pdfs = findPdfSources(opts.pdfRoot);
  const strategies = (listIgStrategies() as Raw[]).map((s) => {
    const perEnv = (env: LibraryEnv) => {
      const rows = results[env][s.id] ?? [];
      const status: LibraryStatus = rows.some((r) => r.kind === "forward") ? "framåttestad" : rows.some((r) => r.kind === "backtest") ? "backtestad" : baseStatus(s);
      return { status, results: rows, igTrades: strategyIgSummary(env, s.id, igTrades) };
    };
    const legacyVolume = s.id === "ig-volume-breakout-1h";
    return {
      id: s.id,
      version: s.version,
      name: s.name,
      status: baseStatus(s),
      executable: s.kind === "research_candidate" ? false : true,
      // Ingen strategi lägger ordrar härifrån; regelmotorn utvärderar bara (analysis_only).
      ordersEnabled: false as const,
      blocked: legacyVolume ? "spärr utan verifierad volym" : s.kind === "research_candidate" ? "källa saknas – ej körbar" : null,
      source: s.source ?? null,
      rules: { entry: s.entry ?? null, exit: s.exit ?? null },
      parameters: { warmupBars: s.warmupBars ?? null, stop: s.stop ?? null, sizing: s.sizing ?? null },
      instrument: s.instrument ?? null,
      interval: s.timeframe ?? null,
      direction: s.direction ?? null,
      dataRequirements: s.kind === "research_candidate" ? "Originalkod och exakta inputs saknas"
        : `${s.warmupBars ?? "?"} stängda ${s.timeframe}-ljus${legacyVolume ? " + verifierad volym (saknas på IG)" : ""}`,
      riskExit: { stop: s.stop ?? null, exit: s.exit ?? null },
      testPeriod: s.reportedResults?.period ?? null,
      costModel: s.costs ?? null,
      reportedExternal: s.reportedResults ?? null,
      notes: s.notes ?? [],
      // Kontospecifika resultat: separata per miljö, blandas aldrig.
      accounts: { demo: perEnv("demo"), live: perEnv("live") },
    };
  });
  return {
    strategies,
    sources: {
      documents: [{ path: "reference/strategyfactory/tradingstrategier-granskning.md", present: fs.existsSync(path.resolve("reference/strategyfactory/tradingstrategier-granskning.md")) }],
      pdfs: { expected: PDF_SOURCES_EXPECTED, found: pdfs, note: pdfs.length ? "Länkade som källor – inte implementerade." : "PDF-underlagen finns inte i repot/reference. Inget påstås vara implementerat från dem." },
    },
    note: "Definitioner delas mellan Demo och Live. Resultat visas per miljö och blandas aldrig. Inga strategier aktiverar ordrar härifrån.",
  };
}
