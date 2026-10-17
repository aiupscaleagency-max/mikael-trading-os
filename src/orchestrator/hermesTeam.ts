import type Anthropic from "@anthropic-ai/sdk";
import { extractJson, type LlmRole } from "../llm/gateway.js";
import { HermesError, HERMES_BODIES, type HermesBody, type HermesBodyId, type HermesRoute, type HermesUsage } from "../llm/hermesRoute.js";
import type { JevTurnDecision } from "../llm/jev.js";
import type { Signal } from "../server/signalEngine.js";
import type { AgentTip } from "./headTips.js";
import { markUnverified } from "./headTips.js";
import { computeIndicators } from "../indicators/ta.js";
import type { Kline } from "../types.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Hermes-kedjan (plan §12, med §8–§11): två prenumerationskroppar samarbetar.
//
//   1. Claude (trading-claude): Teknisk + Risk i ETT anrop → JSON per instrument
//   2. ChatGPT (trading-chatgpt): Advisor, får Claudes JSON + JEV, får BARA skärpa
//   3. Claude: Hanna, slutlig TIPS_JSON (egen verktygsfri gren i headTrader.ts)
//
//  Den här filen innehåller de rena delarna (underlag, promptar, validering,
//  reservmotor och efterbehandling). Den importerar ALDRIG agent/tools.js:
//  inget i kedjan kan lägga en order.
// ═══════════════════════════════════════════════════════════════════════════

export type HermesRoleId = "technical" | "risk" | "advisor" | "head";
export type RoleStatusKind = "lyckad" | "misslyckad" | "överhoppad" | "avbruten";
const ROLE_NAME: Record<HermesRoleId, string> = { technical: "Teknisk", risk: "Risk", advisor: "Advisor", head: "Hanna" };
export const roleName = (r: HermesRoleId) => ROLE_NAME[r];

export interface RoleStatus {
  role: HermesRoleId;
  status: RoleStatusKind;
  reason: string | null;
  /** Kroppen som till slut svarade (eller senast provades) */
  body: HermesBodyId | "paid" | null;
  profile: string | null;
  model: string | null;
  /** Förstavalets profil när reserven tog över */
  fallbackFrom: string | null;
  attempts: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
}

/** Tidsgränser (§9.3, §10.4). Taket för hela analysen är 300 s. */
export const HERMES_TIMEOUTS = { technical: 120_000, advisor: 90_000, head: 90_000, total: 300_000 };

// ── JEV-status (§8.6) ──────────────────────────────────────────────────────

export interface JevSignalInfo { available: boolean; at: string | null; veto: boolean; why: string | null; regime: string | null; direction: string | null; confidence: number | null; signal: string | null }
export interface JevStatus {
  preflight: { status: "ok" | "saknas"; at: string; detail: string; depth: string | null; review: number | null; runAdvisor: boolean };
  signal: { status: "ok" | "saknas"; perEpic: Record<string, JevSignalInfo> };
  level: "fullständig" | "delvis" | "utan";
  /** "JEV fullständig" | "JEV delvis (preflight saknas)" | "JEV delvis (signal-JEV saknas)" | "utan JEV" */
  label: string;
}

/**
 * Två separata JEV-resultat följer med: preflight (djup/granskning) och signalmotorns
 * applyJevVerdict per instrument (regim/riktning/veto). Instrument utan riktad signal har
 * ingen signal-JEV (signalmotorn granskar aldrig NEUTRAL); signal-JEV räknas som "ok" när
 * minst ett valt instrument har ett JEV-svar och inget instrument med signal saknar svar.
 */
export function jevStatusFor(pre: JevTurnDecision, preAt: number, epics: string[], signals: Signal[]): JevStatus {
  const perEpic: Record<string, JevSignalInfo> = {};
  for (const epic of epics) {
    // Riktade signaler OCH JEV-stoppade (applyJevVerdict sätter dem till NEUTRAL + jevDowngraded).
    // getSignals ger den senaste signalen per tidsram = det aktuella läget per tidsram.
    const mine = signals.filter((x) => x.symbol.toUpperCase() === epic.toUpperCase() && (x.direction !== "NEUTRAL" || x.jevDowngraded))
      .sort((a, b) => b.candleCloseTime - a.candleCloseTime);
    // Veto på NÅGON tidsram för instrumentet = veto för instrumentet
    const vetoed = mine.filter((x) => x.jevDowngraded);
    const s = vetoed[0] ?? mine[0];
    const j = s?.jev;
    perEpic[epic] = {
      available: Boolean(j?.available),
      at: s ? new Date(s.generatedAt).toISOString() : null,
      veto: vetoed.length > 0,
      why: vetoed.length ? vetoed.map((v) => `${v.reasons[v.reasons.length - 1] ?? "JEV-veto"} (${v.interval})`).join("; ") : null,
      regime: j?.answers?.regime?.choice ?? null,
      direction: j?.answers?.direction?.choice ?? null,
      confidence: typeof j?.answers?.direction?.confidence === "number" ? j.answers.direction.confidence : null,
      signal: s ? `${s.direction} ${s.score > 0 ? "+" : ""}${s.score} (${s.interval})` : null,
    };
  }
  const withSignal = epics.filter((e) => perEpic[e]!.signal !== null);
  const signalOk = withSignal.length > 0 && withSignal.every((e) => perEpic[e]!.available);
  const preOk = pre.status === "ready";
  const level = preOk && signalOk ? "fullständig" : preOk || signalOk ? "delvis" : "utan";
  const label = level === "fullständig" ? "JEV fullständig" : level === "utan" ? "utan JEV" : `JEV delvis (${preOk ? "signal-JEV saknas" : "preflight saknas"})`;
  return {
    preflight: { status: preOk ? "ok" : "saknas", at: new Date(preAt).toISOString(), detail: pre.detail, depth: pre.depth ?? null, review: pre.reviewProbability ?? null, runAdvisor: pre.runAdvisor },
    signal: { status: signalOk ? "ok" : "saknas", perEpic },
    level, label,
  };
}

// ── Kompakt underlag (§12) med tidsstämpel per del (§10.5) ─────────────────

export interface IvRow { iv: string; ivMs: number; rsi: number | null; ema20: number | null; atr: number | null; trend: string; lastCloseAt: number | null; source: string }
export interface InstrumentBlock {
  epic: string;
  name: string | null;
  /** IG-livepris när underlaget byggdes (null = bara Tiingo/inget) */
  price: number | null;
  priceAgeSec: number | null;
  priceSource: string;
  /** ATR på den kortaste tidsramen (prisrörelse-kontrollen) */
  atr: number | null;
  ivs: IvRow[];
}
export interface MarketBlock {
  runId: string;
  env: "demo" | "live";
  builtAt: number;
  instruments: InstrumentBlock[];
  positions: { count: number | null; text: string; ageSec: number | null; source: string };
  account: { balance: number | null; available: number | null; currency: string | null; ageSec: number | null; source: string };
}

const IV_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const ageFromSource = (src: string): number | null => { const m = src.match(/(\d+) s gammal/); return m ? Number(m[1]) : /^saknas/.test(src) ? null : 0; };
const r4 = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? +v.toPrecision(6) : null);

export interface MarketBlockDeps {
  klines: (epic: string, iv: string) => Promise<{ klines: Kline[]; source: string; igLive: { price: number; ageSec: number | null; source: string } | null }>;
  positions: () => Promise<{ positions: Array<{ symbol: string; quantity: number; avgEntryPrice: number; currentPrice: number; unrealizedPnlUsdt: number }> | null; source: string }>;
  account: () => Promise<{ account: { totalValueUsdt: number; available?: number | null; currency?: string | null; balance?: number | null } | null; source: string }>;
  nameOf: (epic: string) => string | null;
  intervals: string[];
  now?: () => number;
}

export async function buildMarketBlock(runId: string, env: "demo" | "live", epics: string[], deps: MarketBlockDeps): Promise<MarketBlock> {
  const now = deps.now ?? Date.now;
  const instruments = await Promise.all(epics.map(async (epic): Promise<InstrumentBlock> => {
    let live: { price: number; ageSec: number | null; source: string } | null = null;
    const ivs = await Promise.all(deps.intervals.map(async (iv): Promise<IvRow> => {
      const r = await deps.klines(epic, iv).catch(() => ({ klines: [] as Kline[], source: "ingen", igLive: null }));
      if (r.igLive && !live) live = r.igLive;
      if (!r.klines.length) return { iv, ivMs: IV_MS[iv] ?? 60_000, rsi: null, ema20: null, atr: null, trend: "okänd", lastCloseAt: null, source: r.source };
      const ind = computeIndicators(r.klines);
      const up = ind.ema20 !== null && ind.lastClose > ind.ema20 && (ind.sma20 ?? 0) >= (ind.sma50 ?? 0);
      const down = ind.ema20 !== null && ind.lastClose < ind.ema20 && (ind.sma20 ?? 0) <= (ind.sma50 ?? Infinity);
      return { iv, ivMs: IV_MS[iv] ?? 60_000, rsi: r4(ind.rsi14), ema20: r4(ind.ema20), atr: r4(ind.atr14), trend: up ? "upp" : down ? "ned" : "sido", lastCloseAt: r.klines[r.klines.length - 1]!.closeTime, source: r.source };
    }));
    const l = live as { price: number; ageSec: number | null; source: string } | null;
    return { epic, name: deps.nameOf(epic), price: l ? r4(l.price) : null, priceAgeSec: l?.ageSec ?? null, priceSource: l?.source ?? "ingen IG-livekurs", atr: ivs[0]?.atr ?? null, ivs };
  }));
  const [p, a] = await Promise.all([
    deps.positions().catch((e) => ({ positions: null, source: `saknas: ${e instanceof Error ? e.message : String(e)}` })),
    deps.account().catch((e) => ({ account: null, source: `saknas: ${e instanceof Error ? e.message : String(e)}` })),
  ]);
  const ptext = p.positions === null ? "okänt (räkna försiktigt)"
    : p.positions.length === 0 ? "inga öppna"
    : p.positions.slice(0, 8).map((x) => `${x.symbol} ${x.quantity > 0 ? "lång" : "kort"} ${Math.abs(x.quantity)} @ ${r4(x.avgEntryPrice)} (P&L ${r4(x.unrealizedPnlUsdt)})`).join("; ");
  return {
    runId, env, builtAt: now(), instruments,
    positions: { count: p.positions?.length ?? null, text: ptext, ageSec: ageFromSource(p.source), source: p.source },
    account: { balance: a.account?.balance ?? a.account?.totalValueUsdt ?? null, available: a.account?.available ?? null, currency: a.account?.currency ?? null, ageSec: ageFromSource(a.source), source: a.source },
  };
}

// ── Promptar: gemensam prefix (system → JEV → underlag), rollinstruktion sist ──

export interface PromptContext { block: MarketBlock; jev: JevStatus; maxStakePct: number; currency: string | null; horizonMin: number; mode: "paper" | "live"; userInstruction?: string }

// Bevisregeln (docs/BEVISREGELN.md): arbetssättet från REA (github.com/morluto/rea, MIT),
// omskrivet för trading. Gäller alla tre rollerna eftersom den ligger i den gemensamma prefixen.
export const BEVISREGELN = `Bevisregeln (gäller ALLTID, med eller utan JEV):
1. Bygg bara på underlaget och JEV ovan. Hitta aldrig på priser, nyheter eller nivåer.
2. Skilj på det du ser i datan, det du tolkar och det du inte vet. Är något gammalt, saknas eller säger emot annat underlag: välj hellre AVVAKTA än att gissa.
3. Är JEV-läget "utan JEV" eller "JEV delvis", eller står det "JEV saknas" för ett instrument: var extra sträng. Kräv att flera tidsramar pekar åt samma håll och välj hellre mindre sizePct.
4. "why" nämner det som bär beslutet (till exempel "1h och 4h ned, RSI 28") eller det som saknas.
5. KÖP eller SÄLJ bara när regel 1–4 är följda och chansen att vinna är hög: bevisen pekar åt samma håll och inget talar emot. Minsta tvekan: AVVAKTA. Hellre få affärer med hög träffsäkerhet än många.`;

const HERMES_COMMON_SYSTEM = `Du ingår i Mikes AI-tradingteam på IG (CFD; KÖP = lång, SÄLJ = kort). Ingen i kedjan lägger order: ni ger bara analys och tips som Mike själv granskar och godkänner. Inga verktyg finns i denna körning.
Svara ENDAST med JSON enligt rollinstruktionen sist, utan resonemang i fritext. Siffror som JSON-siffror. "why" är högst en mening.
${BEVISREGELN}`;

export function sharedPrefix(c: PromptContext): string {
  const b = c.block;
  const t = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  const jevLines = [
    `JEV-läge: ${c.jev.label}`,
    `Preflight: ${c.jev.preflight.status === "ok" ? `djup ${c.jev.preflight.depth ?? "?"}, granskning ${c.jev.preflight.review ?? "?"}` : `saknas (${c.jev.preflight.detail})`} [${c.jev.preflight.at.slice(11, 19)}]`,
    ...Object.entries(c.jev.signal.perEpic).map(([e, j]) => `${e}: ${j.signal ? `signal ${j.signal}` : "ingen riktad signal"}${j.available ? ` · JEV regim ${j.regime ?? "?"}, riktning ${j.direction ?? "?"}${j.confidence !== null ? ` ${j.confidence.toFixed(2)}` : ""}` : j.signal ? " · JEV saknas" : ""}${j.veto ? ` · VETO (${j.why})` : ""}`),
  ];
  const inst = b.instruments.map((i) => {
    const ivs = i.ivs.map((v) => v.rsi === null ? `${v.iv}: data saknas` : `${v.iv}: RSI ${v.rsi.toFixed(0)} EMA20 ${v.ema20} ATR ${v.atr} ${v.trend}`).join(" | ");
    return `${i.epic}${i.name ? ` (${i.name})` : ""} | IG-pris ${i.price ?? "saknas"}${i.priceAgeSec !== null ? ` (${i.priceAgeSec} s)` : ""} | ${ivs}`;
  });
  return `${HERMES_COMMON_SYSTEM}
Läge: ${c.mode === "live" ? "LIVE (riktiga pengar)" : "TEST (IG Demo)"} · horisont ${c.horizonMin} min · insats högst ${c.maxStakePct} % av saldot (sizePct) · avgift ca 0,5 % tur och retur.

──── JEV (hjärnan) ────
${jevLines.join("\n")}

──── UNDERLAG (byggt ${t(b.builtAt)} UTC) ────
${inst.join("\n")}
Positioner: ${b.positions.text} · Konto: saldo ${b.account.balance ?? "?"} ${b.account.currency ?? ""}, tillgängligt ${b.account.available ?? "?"}${c.userInstruction ? `\nMikes instruktion: ${c.userInstruction.replace(/\s+/g, " ").slice(0, 400)}` : ""}
`;
}

export function technicalRiskTail(c: PromptContext): string {
  return `
──── DIN ROLL: TEKNISK ANALYTIKER + RISK (ett svar) ────
Exakt en rad per EPIC ovan. KÖP: sl < entry < tp. SÄLJ: tp < entry < sl. AVVAKTA: entry = bevakad nivå, tp och sl null.
risk: låg|medel|hög|kritisk (kritisk = ingen ny position). sizePct högst ${c.maxStakePct} (null för AVVAKTA). score -5..5. JEV-veto ⇒ AVVAKTA.
{"instruments":[{"epic":"…","action":"KÖP|SÄLJ|AVVAKTA","entry":0,"tp":0,"sl":0,"score":0,"risk":"medel","sizePct":1,"why":"…"}]}`;
}

export function advisorTail(claudeJson: string): string {
  return `
──── CLAUDES ANALYS (Teknisk + Risk) ────
${claudeJson}

──── DIN ROLL: ADVISOR (granskare) ────
Bekräfta (agree) eller invänd (object) per instrument. Du får BARA skärpa: AVVAKTA, mindre sizePct eller ett snävare sl (närmare entry). Aldrig öka risk, byta riktning eller vidga sl.
{"reviews":[{"epic":"…","verdict":"agree|object","action":null,"sizePct":null,"sl":null,"why":"…"}]}`;
}

// ── Validering per roll (§8.3) ─────────────────────────────────────────────

export type TrAction = "KÖP" | "SÄLJ" | "AVVAKTA";
export interface TrRow { epic: string; action: TrAction; entry: number | null; tp: number | null; sl: number | null; score: number; risk: string | null; sizePct: number | null; why: string }
export interface AdvReview { epic: string; verdict: "agree" | "object"; action: string | null; sizePct: number | null; sl: number | null; why: string }

const isN = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const RISKS = new Set(["låg", "medel", "hög", "kritisk"]);

function parseJson(text: string): unknown {
  try { return JSON.parse(extractJson(text)); } catch { return null; }
}

/** Steg 1: teknisk del (riktning/nivåer) och riskdel (risk/insats) valideras var för sig. */
export function validateTechRisk(text: string, epics: string[]): { techOk: boolean; riskOk: boolean; reason: string | null; rows: TrRow[] } {
  const j = parseJson(text) as { instruments?: unknown } | null;
  if (!j || !Array.isArray(j.instruments)) return { techOk: false, riskOk: false, reason: "trasig JSON (instruments saknas)", rows: [] };
  const seen = new Set<string>();
  const rows: TrRow[] = [];
  let riskReason: string | null = null;
  for (const r of j.instruments as Array<Record<string, unknown>>) {
    const epic = typeof r?.epic === "string" ? r.epic.trim() : "";
    if (!epics.includes(epic)) return { techOk: false, riskOk: false, reason: `okänt EPIC ${epic || "(tomt)"}`, rows: [] };
    if (seen.has(epic)) return { techOk: false, riskOk: false, reason: `dubblett ${epic}`, rows: [] };
    seen.add(epic);
    const action = String(r.action ?? "").trim().toUpperCase() as TrAction;
    if (!["KÖP", "SÄLJ", "AVVAKTA"].includes(action)) return { techOk: false, riskOk: false, reason: `${epic}: action ${String(r.action)}`, rows: [] };
    const e = isN(r.entry) ? r.entry : null, tp = isN(r.tp) ? r.tp : null, sl = isN(r.sl) ? r.sl : null;
    if (action === "KÖP" && !(e !== null && tp !== null && sl !== null && sl < e && e < tp)) return { techOk: false, riskOk: false, reason: `${epic}: KÖP kräver sl < entry < tp`, rows: [] };
    if (action === "SÄLJ" && !(e !== null && tp !== null && sl !== null && tp < e && e < sl)) return { techOk: false, riskOk: false, reason: `${epic}: SÄLJ kräver tp < entry < sl`, rows: [] };
    const risk = typeof r.risk === "string" && RISKS.has(r.risk.trim().toLowerCase()) ? r.risk.trim().toLowerCase() : null;
    const sizePct = isN(r.sizePct) && r.sizePct >= 0 ? r.sizePct : null;
    if (!risk) riskReason ??= `${epic}: risk saknas`;
    else if (action !== "AVVAKTA" && sizePct === null) riskReason ??= `${epic}: sizePct saknas`;
    rows.push({ epic, action, entry: e, tp: action === "AVVAKTA" ? null : tp, sl: action === "AVVAKTA" ? null : sl, score: isN(r.score) ? r.score : 0, risk, sizePct: action === "AVVAKTA" ? null : sizePct, why: String(r.why ?? "").replace(/\s+/g, " ").slice(0, 200) });
  }
  const missing = epics.filter((e) => !seen.has(e));
  if (missing.length) return { techOk: false, riskOk: false, reason: `saknar ${missing.join(", ")}`, rows: [] };
  return { techOk: true, riskOk: riskReason === null, reason: riskReason, rows };
}

export function validateAdvisor(text: string, epics: string[]): { ok: boolean; reason: string | null; reviews: AdvReview[] } {
  const j = parseJson(text) as { reviews?: unknown } | null;
  if (!j || !Array.isArray(j.reviews)) return { ok: false, reason: "trasig JSON (reviews saknas)", reviews: [] };
  const seen = new Set<string>();
  const reviews: AdvReview[] = [];
  for (const r of j.reviews as Array<Record<string, unknown>>) {
    const epic = typeof r?.epic === "string" ? r.epic.trim() : "";
    if (!epics.includes(epic) || seen.has(epic)) return { ok: false, reason: `okänt/dubblett EPIC ${epic || "(tomt)"}`, reviews: [] };
    seen.add(epic);
    const verdict = String(r.verdict ?? "").trim().toLowerCase();
    if (verdict !== "agree" && verdict !== "object") return { ok: false, reason: `${epic}: verdict ${String(r.verdict)}`, reviews: [] };
    reviews.push({ epic, verdict, action: typeof r.action === "string" ? r.action.trim().toUpperCase() : null, sizePct: isN(r.sizePct) ? r.sizePct : null, sl: isN(r.sl) ? r.sl : null, why: String(r.why ?? "").replace(/\s+/g, " ").slice(0, 200) });
  }
  const missing = epics.filter((e) => !seen.has(e));
  if (missing.length) return { ok: false, reason: `saknar ${missing.join(", ")}`, reviews: [] };
  return { ok: true, reason: null, reviews };
}

/**
 * Advisorn får BARA skärpa (§12). Invändningar översätts i koden: AVVAKTA, mindre insats eller
 * snävare SL (närmare entry, fortfarande på rätt sida). Allt som skulle öka risken ignoreras och loggas.
 */
export function applyAdvisorTightening(rows: TrRow[], reviews: AdvReview[]): { rows: TrRow[]; ignored: string[] } {
  const ignored: string[] = [];
  const out = rows.map((r0) => {
    const r = { ...r0 };
    const v = reviews.find((x) => x.epic === r.epic);
    if (!v || v.verdict !== "object") return r;
    if (v.action === "AVVAKTA") { r.action = "AVVAKTA"; r.sizePct = null; r.tp = null; r.sl = null; return r; }
    if (v.action && v.action !== r.action) ignored.push(`${r.epic}: Advisorn försökte byta till ${v.action} (ignorerat)`);
    if (r.action === "AVVAKTA") return r;
    // Insats 0 (eller mindre) från Advisorn = ingen position: AVVAKTA
    if (v.sizePct !== null && v.sizePct <= 0) { r.action = "AVVAKTA"; r.sizePct = null; r.tp = null; r.sl = null; return r; }
    if (v.sizePct !== null) {
      if (r.sizePct === null || v.sizePct < r.sizePct) r.sizePct = v.sizePct;
      else if (v.sizePct > r.sizePct) ignored.push(`${r.epic}: Advisorn försökte höja insatsen (ignorerat)`);
    }
    if (v.sl !== null && r.entry !== null && r.sl !== null) {
      const tighter = r.action === "KÖP" ? v.sl > r.sl && v.sl < r.entry : v.sl < r.sl && v.sl > r.entry;
      if (tighter) r.sl = v.sl; else if (v.sl !== r.sl) ignored.push(`${r.epic}: Advisorn försökte vidga SL (ignorerat)`);
    }
    return r;
  });
  for (const i of ignored) log.warn(`[Hermes] ${i}`);
  return { rows: out, ignored };
}

// ── Reservmotor per roll (§8.5, §10.3, §10.4, §10.6) ──────────────────────

export interface PaidDeps {
  /** LLM_HERMES_PAID_FALLBACK=true */
  flag: () => boolean;
  /** canSpend mot API-taket; kontrolleras före VARJE betalt försök */
  budgetLeft: () => Promise<boolean>;
  /** Befintliga betalda kedjan (Anthropic → Vercel → OpenRouter) med rollens befintliga modell */
  /** timeoutMs = rollens tidsgräns, begränsad av analysens 300 s-tak */
  call: (p: { modelRole: LlmRole; directDefault: string; system: string; user: string; maxTokens: number; timeoutMs: number }) => Promise<{ text: string; model: string; usage: { input_tokens: number; output_tokens: number }; ms: number }>;
}

export interface ChainCtx {
  hermes: HermesRoute;
  runId: string;
  signal: AbortSignal;
  deadlineAt: number;
  paid: PaidDeps;
  /** Registrerar ett anrop (trackClaudeCall). Hermes: costUsd 0, route hermes. */
  track: (agent: string, model: string, usage: { input_tokens: number; output_tokens: number }, opts: { route: "hermes" | "gateway"; costUsd?: number; durationMs: number }) => Promise<void> | void;
}

export interface RoleRun<T> { status: RoleStatus; value: T | null; text: string | null }

/** Total mängd input-tokens (inkl. cache) för loggen/kostnadssidan. */
export const totalIn = (u: HermesUsage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export async function runRole<T>(spec: {
  role: HermesRoleId;
  /** Kostnadsradens agentnamn */
  agent: string;
  order: HermesBodyId[];
  prompt: string;
  timeoutMs: number;
  /** ok = godkänt; partial = användbart men ofullständigt (sparas som bästa försök) */
  validate: (text: string) => { ok: boolean; partial?: boolean; reason: string | null; value: T | null };
  paid: { modelRole: LlmRole; directDefault: string; system: string; user: string; maxTokens: number };
}, ctx: ChainCtx): Promise<RoleRun<T>> {
  const st: RoleStatus = { role: spec.role, status: "misslyckad", reason: null, body: null, profile: null, model: null, fallbackFrom: null, attempts: 0, ms: 0, inputTokens: 0, outputTokens: 0 };
  let best: { value: T; text: string; reason: string | null; body: HermesBody } | null = null;
  let lastReason = "okänt fel";
  const first = HERMES_BODIES[spec.order[0]!];
  const stopped = (kind: "aborted" | "deadline"): RoleRun<T> => {
    st.status = kind === "aborted" ? "avbruten" : "överhoppad";
    st.reason = kind === "aborted" ? "avbruten" : "tidsgräns";
    return { status: st, value: null, text: null };
  };
  for (const id of spec.order) {
    const body = HERMES_BODIES[id];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (ctx.signal.aborted) return stopped("aborted");
      if (Date.now() >= ctx.deadlineAt) return stopped("deadline");
      st.attempts++;
      st.body = id; st.profile = body.profile; st.model = body.model;
      st.fallbackFrom = body.profile !== first.profile ? first.profile : null;
      try {
        const res = await ctx.hermes.call({ body, prompt: spec.prompt, timeoutMs: spec.timeoutMs, signal: ctx.signal, deadlineAt: ctx.deadlineAt });
        st.ms += res.ms; st.inputTokens += totalIn(res.usage); st.outputTokens += res.usage.outputTokens;
        ctx.track(spec.agent, res.usage.model ?? body.model, { input_tokens: totalIn(res.usage), output_tokens: res.usage.outputTokens }, { route: "hermes", costUsd: 0, durationMs: res.ms });
        log.info(`[Hermes] ${roleName(spec.role)} via ${body.profile}: in ${totalIn(res.usage)} / ut ${res.usage.outputTokens} tokens, ${(res.ms / 1000).toFixed(1)} s`);
        const v = spec.validate(res.text);
        if (v.ok && v.value !== null) { st.status = "lyckad"; st.reason = null; return { status: st, value: v.value, text: res.text }; }
        if (v.partial && v.value !== null && !best) best = { value: v.value, text: res.text, reason: v.reason, body };
        lastReason = `schemafel: ${v.reason ?? "ogiltigt svar"}`;
        // Schemafel: ett omförsök med samma kropp, sedan nästa kropp
        continue;
      } catch (e) {
        const he = e instanceof HermesError ? e : new HermesError("transport", e instanceof Error ? e.message : String(e));
        if (he.usage) { st.inputTokens += totalIn(he.usage); st.outputTokens += he.usage.outputTokens; }
        if (he.kind === "aborted") return stopped("aborted");
        if (he.kind === "deadline") return stopped("deadline");
        lastReason = he.message;
        log.warn(`[Hermes] ${roleName(spec.role)} via ${body.profile}: ${he.kind} – ${he.message}`);
        // Tomt svar eller verktygsbegäran: omförsök med samma kropp. Övrigt (transport, provider,
        // takgräns, tidsgräns per anrop, fel version): byt kropp direkt.
        if ((he.kind === "empty" || he.kind === "content") && attempt === 0) continue;
        break;
      }
    }
  }
  // Bästa ofullständiga svaret (t.ex. teknisk del ok men riskdelen saknas)
  if (best) {
    st.status = "lyckad"; st.reason = best.reason; st.body = best.body.id; st.profile = best.body.profile; st.model = best.body.model;
    st.fallbackFrom = best.body.profile !== first.profile ? first.profile : null;
    return { status: st, value: best.value, text: best.text };
  }
  // Betald reserv: bara med flaggan, och canSpend före VARJE betalt försök (§10.3)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctx.signal.aborted) return stopped("aborted");
    if (Date.now() >= ctx.deadlineAt) return stopped("deadline");
    if (!ctx.paid.flag()) { st.reason = `${lastReason}; betald reserv spärrad: flagga`; return { status: st, value: null, text: null }; }
    if (!(await ctx.paid.budgetLeft())) { st.reason = `${lastReason}; betald reserv spärrad: tak`; return { status: st, value: null, text: null }; }
    st.attempts++;
    try {
      const timeoutMs = Math.min(spec.timeoutMs, ctx.deadlineAt - Date.now());
      if (timeoutMs <= 0) return stopped("deadline");
      const r = await ctx.paid.call({ ...spec.paid, timeoutMs });
      st.body = "paid"; st.profile = null; st.model = r.model; st.fallbackFrom = first.profile;
      st.ms += r.ms; st.inputTokens += r.usage.input_tokens; st.outputTokens += r.usage.output_tokens;
      // Kostnadsraden skrivs klart INNAN nästa canSpend-kontroll
      await ctx.track(spec.agent, r.model, r.usage, { route: "gateway", durationMs: r.ms });
      const v = spec.validate(r.text);
      if (v.ok && v.value !== null) { st.status = "lyckad"; st.reason = null; return { status: st, value: v.value, text: r.text }; }
      if (v.partial && v.value !== null) { st.status = "lyckad"; st.reason = v.reason; return { status: st, value: v.value, text: r.text }; }
      lastReason = `betald reserv: schemafel: ${v.reason ?? "ogiltigt svar"}`;
    } catch (e) {
      if (ctx.signal.aborted) return stopped("aborted");
      if (Date.now() >= ctx.deadlineAt) return stopped("deadline");
      lastReason = `betald reserv: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
  }
  st.reason = lastReason;
  return { status: st, value: null, text: null };
}

/** Status för en roll som aldrig kördes. */
export function skippedStatus(role: HermesRoleId, reason: string, status: RoleStatusKind = "överhoppad"): RoleStatus {
  return { role, status, reason, body: null, profile: null, model: null, fallbackFrom: null, attempts: 0, ms: 0, inputTokens: 0, outputTokens: 0 };
}

/** "Advisor: ChatGPT gpt-6-sol (trading-chatgpt → reserv Claude)" */
export function roleLine(s: RoleStatus): string {
  const n = s.role === "technical" ? "Teknisk+Risk" : roleName(s.role);
  if (s.status !== "lyckad") return `${n}: ${s.status}${s.reason ? ` (${s.reason})` : ""}`;
  if (s.body === "paid") return `${n}: betald reserv ${s.model ?? "?"}`;
  const body = s.body ? HERMES_BODIES[s.body] : null;
  const from = s.fallbackFrom ? Object.values(HERMES_BODIES).find((b) => b.profile === s.fallbackFrom) : null;
  return `${n}: ${body?.label ?? "?"} (${from ? `${from.profile} → reserv ${body?.label.split(" ")[0] ?? "?"}` : s.profile})`;
}

// ── Efterbehandling av Hannas tips (§8.6, §10.1, §10.5, §12) ───────────────

export interface FinalizeCtx {
  rawRows: Array<Record<string, unknown>>;
  /** Claudes rader (Teknisk + Risk) som de kom från Claude: Risks insats och risknivå per instrument */
  riskRows: TrRow[] | null;
  /** Claudes rader EFTER Advisorns skärpning */
  tightened: TrRow[] | null;
  advisorReviews: AdvReview[] | null;
  riskOk: boolean;
  advisorStatus: RoleStatusKind;
  mode: "paper" | "live";
  jev: JevStatus;
  block: MarketBlock;
  /** IG-livepriset NU (null = saknas) */
  livePrice: (epic: string) => number | null;
  /** Nuvarande insats-steg (% av saldot): ingen tips-insats får överstiga det */
  maxStakePct?: number;
  now?: () => number;
}

/** Minsta insats som visas (samma golv som parseHeadTips). Under det blir tipset AVVAKTA. */
export const MIN_TIP_SIZE_PCT = 0.1;

const RISK_MISSING = "Risk saknas – inga köp/sälj-tips";
const ADVISOR_MISSING = "Advisor saknas (live) – inga köp/sälj-tips";
const PRICE_MOVED = "priset har rört sig – kör ny analys";
const STALE_INPUT = "⚠ gammalt underlag";
const STALE_PRICE = "⚠ gammalt pris, kontrollera mot IG";

function addNote(t: AgentTip, n: string): void { if (!t.note?.includes(n)) t.note = t.note ? `${t.note}; ${n}` : n; }
function forceHold(t: AgentTip, why: string): void {
  t.action = "hold"; t.sizePct = null; t.sizeText = null; t.takeProfit = null; t.stopLoss = null;
  addNote(t, why);
}
/** Kläm insatsen till taket: avrundas NEDÅT till en decimal (aldrig över taket). ≤ 0 eller under golvet → AVVAKTA. */
function clampSize(t: AgentTip, cap: number, why: string): void {
  if (t.action === "hold" || t.sizePct === null || t.sizePct <= cap) return;
  const v = Math.floor(cap * 10 + 1e-9) / 10;
  if (!(v >= MIN_TIP_SIZE_PCT)) { forceHold(t, `${why}: ingen insats kvar`); return; }
  t.sizePct = v; t.sizeText = `${v} % av saldot`;
  addNote(t, why);
}

/**
 * Ordningen spelar roll; de sista stegen kan inte ångras av tidigare:
 *   1. Granskad rekommendation (Claude + Advisorns skärpning) bindande: riktning, insats och SL
 *   2. Insatsen kläms till Risks nivå (kritisk risk → AVVAKTA)
 *   3. Färskhet: gammalt underlag/pris → overifierade nivåer; stor prisrörelse → AVVAKTA
 *   4. Risk saknas (eller Advisor saknas i live) → ALLA tips AVVAKTA utan insats
 *   5. JEV-veto → AVVAKTA, alltid
 */
export function finalizeHermesTips(tips: AgentTip[], c: FinalizeCtx): AgentTip[] {
  const now = (c.now ?? Date.now)();
  for (const t of tips) {
    const rev = c.advisorReviews?.find((r) => r.epic === t.epic);
    const tr = c.tightened?.find((r) => r.epic === t.epic);
    const rr = c.riskRows?.find((r) => r.epic === t.epic);
    // 1. Den granskade rekommendationen (Claude efter Advisorns skärpning) är bindande i Live OCH Demo.
    //    Hanna får bara vara lika försiktig eller försiktigare: aldrig byta riktning, aldrig större insats,
    //    aldrig vidare SL. advisorOverride kan aldrig vända eller lätta på en granskning.
    if (t.action !== "hold") {
      const objected = rev?.verdict === "object";
      const reviewedDir = tr ? (tr.action === "KÖP" ? "buy" : tr.action === "SÄLJ" ? "sell" : "hold") : null;
      if (!tr) forceHold(t, "ingen granskad rekommendation");
      else if (reviewedDir === "hold") forceHold(t, objected ? `Advisorn invände: ${rev?.why || "avvakta"}` : "riktningsbyte utan granskning");
      else if (reviewedDir !== t.action) forceHold(t, "riktningsbyte utan granskning");
      else if (tr.sizePct === null || tr.sizePct <= 0) forceHold(t, "ingen granskad insats");
      else {
        clampSize(t, tr.sizePct, objected ? "insatsen sänkt enligt Advisorn" : "insatsen begränsad till granskad nivå");
        if ((t.action as string) !== "hold" && tr.sl !== null) {
          const buy = t.action === "buy";
          // Vidare (eller saknad) SL än den granskade → den granskade gäller
          if (t.stopLoss === null || (buy ? t.stopLoss < tr.sl : t.stopLoss > tr.sl)) { t.stopLoss = tr.sl; addNote(t, objected ? "SL snävare enligt Advisorn" : "SL enligt granskningen"); }
          // Flyttad entry kan göra den granskade SL:en ogiltig → AVVAKTA
          const e = t.entry, sl = t.stopLoss, tp = t.takeProfit;
          const valid = e !== null && sl !== null && (buy ? sl < e && (tp === null || e < tp) : sl > e && (tp === null || e > tp));
          if (!valid) forceHold(t, "granskad SL kan inte tillämpas (entry flyttad)");
          // Flyttad entry med kvar granskad SL kan ge större stoppavstånd = större risk än granskat
          else if (tr.entry !== null && e !== null && sl !== null) {
            const reviewedDist = Math.abs(tr.entry - tr.sl);
            const tooWide = Math.abs(e - sl) > reviewedDist * 1.01;
            const moved = Math.abs(e - tr.entry) > Math.max(0.25 * reviewedDist, 0.001 * tr.entry);
            if (tooWide || moved) forceHold(t, "entry flyttad – större risk än granskat");
          }
        }
      }
    }
    // 2. Risks insats är taket; kritisk risk = ingen ny position
    if (rr && t.action !== "hold") {
      if (rr.risk === "kritisk") forceHold(t, "Risk: kritisk");
      else if (rr.action === "AVVAKTA" || rr.sizePct === null || rr.sizePct <= 0) forceHold(t, "Risk: ingen insats för instrumentet");
      else clampSize(t, rr.sizePct, "insatsen sänkt till Risks nivå");
    }
    // Insats-steget är alltid taket, och KÖP/SÄLJ utan giltig insats blir AVVAKTA
    if (c.maxStakePct !== undefined) clampSize(t, c.maxStakePct, "insatsen sänkt till insats-steget");
    if (t.action !== "hold" && !(t.sizePct !== null && t.sizePct >= MIN_TIP_SIZE_PCT)) forceHold(t, "ingen giltig insats");
    // 3. Färskhet (§10.5, §8.7)
    const inst = c.block.instruments.find((i) => i.epic === t.epic);
    if (inst) {
      // Åldrar räknas vid VISNING: underlagets ålder läggs till delarnas ålder när det byggdes
      const since = Math.max(0, (now - c.block.builtAt) / 1000);
      const age = (a: number | null) => (a === null ? null : a + since);
      const staleCandles = inst.ivs.some((v) => v.lastCloseAt === null || now - v.lastCloseAt > 2 * v.ivMs);
      const pa = age(c.block.positions.ageSec), aa = age(c.block.account.ageSec), qa = age(inst.priceAgeSec);
      const staleState = pa === null || pa > 120 || aa === null || aa > 120;
      if (staleCandles || staleState) { markUnverified(t); addNote(t, STALE_INPUT); }
      if (inst.price === null || qa === null || qa > 60) { markUnverified(t); addNote(t, STALE_PRICE); }
      const cur = c.livePrice(t.epic);
      if (inst.price !== null && cur !== null && t.action !== "hold") {
        const move = Math.abs(cur - inst.price);
        if ((inst.atr !== null && move > 0.5 * inst.atr) || move / inst.price > 0.01) forceHold(t, PRICE_MOVED);
      } else if (cur === null) markUnverified(t);
    } else markUnverified(t);
  }
  // 4. Risk saknas (eller Advisor saknas i live): inga köp/sälj-tips och inga insatser (§10.1)
  if (!c.riskOk) for (const t of tips) forceHold(t, RISK_MISSING);
  if (c.mode === "live" && c.advisorStatus !== "lyckad") for (const t of tips) forceHold(t, ADVISOR_MISSING);
  // 5. JEV-veto bevaras genom parsning och reservbyte (§8.6)
  for (const t of tips) {
    const j = c.jev.signal.perEpic[t.epic];
    if (j?.veto) { forceHold(t, `JEV-veto${j.why ? `: ${j.why}` : ""}`); t.why = `JEV-veto. ${t.why}`.slice(0, 240); }
  }
  return tips;
}

/**
 * JEV-veto som kommit UNDER analysen (Codex 4): signalerna läses om precis före publicering.
 * Nya veton läggs till (tidigare behålls) och tipsen för de instrumenten blir AVVAKTA utan insats.
 * Returnerar instrumenten som fick ett nytt veto.
 */
export function applyLateVetoes(tips: AgentTip[], jev: JevStatus, fresh: JevStatus): string[] {
  const added: string[] = [];
  for (const [epic, f] of Object.entries(fresh.signal.perEpic)) {
    const was = jev.signal.perEpic[epic];
    if (f.veto && !was?.veto) {
      jev.signal.perEpic[epic] = { ...(was ?? f), veto: true, why: `${f.why ?? "JEV-veto"} (kom under analysen)` };
      added.push(epic);
    }
  }
  for (const t of tips) {
    const j = jev.signal.perEpic[t.epic];
    if (j?.veto && added.includes(t.epic)) { forceHold(t, `JEV-veto${j.why ? `: ${j.why}` : ""}`); t.why = `JEV-veto. ${t.why}`.slice(0, 240); }
  }
  if (added.length) {
    // Etiketten ska visa vetot: "JEV fullständig · veto under analysen: X"
    jev.label = `${jev.label.replace(/ · veto under analysen: .*$/, "")} · veto under analysen: ${Object.entries(jev.signal.perEpic).filter(([, v]) => v.why?.includes("kom under analysen")).map(([e]) => e).join(", ")}`;
    log.warn(`[Hermes] JEV-veto under analysen: ${added.join(", ")} → AVVAKTA`);
  }
  return added;
}

/** Svar från Anthropic-formade meddelanden → text (för betald reserv). */
export function messageText(m: Anthropic.Message): string {
  return m.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
}
