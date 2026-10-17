import type { Config } from "../config.js";
import type { AgentState } from "../memory/store.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import type { RiskManager } from "../risk/riskManager.js";
import type { StrategyEngine } from "../strategies/types.js";
import type { JevTurnDecision } from "../llm/jev.js";
import type { Signal } from "../server/signalEngine.js";
import { hermesRoute, HERMES_BODIES, HermesError, waitStop, type HermesRoute } from "../llm/hermesRoute.js";
import { track, agentSkip, turnPhase, turnEnd, analysisEnd, getAnalysis } from "../server/agentActivity.js";
import { runHeadTrader } from "./headTrader.js";
import {
  jevStatusFor, buildMarketBlock, sharedPrefix, technicalRiskTail, advisorTail, validateTechRisk, validateAdvisor,
  applyAdvisorTightening, applyLateVetoes, runRole, skippedStatus, roleLine, roleName, messageText, HERMES_TIMEOUTS,
  type ChainCtx, type MarketBlockDeps, type PaidDeps, type RoleStatus, type TrRow, type AdvReview, type JevStatus, type MarketBlock,
} from "./hermesTeam.js";
import { setBrainLabel, setFailedAttempt } from "./hermesLabel.js";
import type { OrchestratorResult, AllReports } from "./orchestrator.js";
import type { TechnicalReport, RiskReport, AdvisorReport, MacroReport } from "./types.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Hermes-turen (LLM_ROUTE=hermes, bara IG). Ersätter specialist-fasen och Hannas
//  verktygsloop i den här analysen med kedjan i §12:
//    Claude (Teknisk + Risk) → ChatGPT (Advisor, bara skärpa) → Claude (Hanna, TIPS_JSON)
//  JEV körs som förut (preflight i orchestrator.ts, signal-JEV i signalmotorn) och följer med.
//  Ingen order skapas här: Hanna-grenen i headTrader.ts har inga verktyg.
// ═══════════════════════════════════════════════════════════════════════════

export interface HermesTurnParams {
  config: Config;
  state: AgentState;
  broker: BrokerAdapter;
  brokers: Record<string, BrokerAdapter>;
  risk: RiskManager;
  engines: StrategyEngine[];
  userInstruction?: string;
  symbols: string[];
  env: "demo" | "live";
  /** JEV-preflight redan körd (tester). I drift används preflight nedan i stället. */
  jev?: JevTurnDecision;
  jevAt?: number;
  /** Förberedelsen (positioner + JEV-preflight) körs INNE i Hermes-turen, så att avbrott och
   *  tidsgräns gäller redan från första asynkrona steget (Codex 1). */
  preflight?: () => Promise<{ jev: JevTurnDecision; jevAt: number }>;
  /** canSpend före analysen: false = API-taket nått (Hermes får fortsätta, betald reserv spärrad) */
  spendAllowed: boolean;
  totalStart: number;
}

export interface HermesTurnDeps {
  hermes?: HermesRoute;
  signals?: () => Signal[];
  market?: MarketBlockDeps;
  paid?: Partial<PaidDeps>;
  track?: ChainCtx["track"];
  /** Kontobyte/ny IG-session (igTurnStale): null = turen gäller */
  isStale?: () => string | null;
  /** IG-livepriset nu (färskhetskontrollen) */
  livePrice?: (epic: string) => number | null;
  totalMs?: number;
  stake?: { pct: number; amount: number | null; currency: string | null; minPct: number; horizonMin: number };
}

export interface HermesAnalysisMeta {
  outcome: "full" | "delvis" | "ofullständig" | "avbruten";
  outcomeText: string;
  /** null = analysen stoppades innan JEV-statusen fanns */
  jev: JevStatus | null;
  roles: RoleStatus[];
  brain: string;
  totalMs: number;
  runId: string;
}

// Högst en Hermes-analys per miljö åt gången (§8.7). Avbrott tömmer kedjan (§10.4).
const active = new Set<string>();
const controllers = new Set<AbortController>();
export const HERMES_BUSY_TEXT = "analys pågår";
export function hermesAnalysisBusy(env?: "demo" | "live"): boolean { return env ? active.has(env) : active.size > 0; }
/** Avbryter pågående Hermes-analyser (användaravbrott/kontobyte): inga nya försök, ingen reserv. */
export function abortHermesAnalysis(reason = "avbruten av användaren"): void { for (const c of controllers) c.abort(reason); }

const STUB_MACRO: MacroReport = { role: "macro_analyst", regime: "uncertain", keyFactors: ["Hoppas över (Hermes-läget)"], oilSummary: "–", vixLevel: "–", dollarTrend: "–", cryptoFearGreed: "–", recommendation: "–", confidence: "low", rawText: "" };

function reportsFrom(rows: TrRow[] | null, techText: string, riskStatus: RoleStatus, reviews: AdvReview[] | null, advStatus: RoleStatus): AllReports {
  const bias = (a: string) => (a === "KÖP" ? "bullish" : a === "SÄLJ" ? "bearish" : "neutral") as "bullish" | "bearish" | "neutral";
  const technical: TechnicalReport = {
    role: "technical_analyst",
    analyses: (rows ?? []).map((r) => ({
      symbol: r.epic, bias: bias(r.action), score: r.score, keySignals: [r.why].filter(Boolean),
      ...(r.entry !== null && r.sl !== null ? { entryZone: { price: r.entry, stopLoss: r.sl } } : {}),
      ...(r.tp !== null ? { targetZone: { tp1: r.tp, tp2: r.tp, tp3: r.tp } } : {}),
    })),
    topPick: [...(rows ?? [])].filter((r) => r.action !== "AVVAKTA").sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0]?.epic ?? null,
    rawText: techText,
  };
  const worst = (rows ?? []).map((r) => r.risk).find((r) => r === "kritisk") ? "critical" : (rows ?? []).some((r) => r.risk === "hög") ? "high" : (rows ?? []).some((r) => r.risk === "medel") ? "medium" : "low";
  const risk: RiskReport = {
    role: "risk_analyst", portfolioHeatPct: 0, correlationRisk: "medium", correlationDetails: "Hermes-läget: risk per instrument",
    maxDrawdownScenario: { description: "–", estimatedLossUsd: 0, estimatedLossPct: 0 },
    suggestedPositionSizing: { maxNewPositionUsd: 0, reasoning: "insats i % av saldot per instrument (sizePct)" },
    riskLevel: riskStatus.status === "lyckad" && !riskStatus.reason ? worst as RiskReport["riskLevel"] : "high",
    warnings: riskStatus.status === "lyckad" && !riskStatus.reason ? [] : [`Risk saknas: ${riskStatus.reason ?? riskStatus.status}`],
    recommendation: riskStatus.status === "lyckad" && !riskStatus.reason ? "Se insats per instrument." : "Risk saknas – inga köp/sälj-tips.", rawText: "",
  };
  const advisor: AdvisorReport = {
    role: "claude_advisor", strategicOutlook: "neutral", marketCyclePhase: "accumulation",
    keyInsights: reviews ? reviews.map((r) => `${r.epic}: ${r.verdict === "agree" ? "bekräftar" : "invänder"}${r.why ? ` – ${r.why}` : ""}`) : [`Advisor ${advStatus.status}${advStatus.reason ? ` (${advStatus.reason})` : ""}`],
    blindSpots: [], behavioralWarnings: [], contrarian: "–", portfolioAdvice: "–", confidence: reviews ? "medium" : "low", rawText: "",
  };
  return {
    research: { role: "researcher", available: false, marketSummary: "Research avstängd (Hermes-läget).", cryptoNews: [], macroEvents: [], geopolitical: [], riskAlerts: [], sources: [], rawText: "" } as unknown as AllReports["research"],
    macro: STUB_MACRO, technical,
    sentiment: { role: "sentiment_analyst", overallSentiment: "neutral", topNarratives: [], politicianActivity: "–", contrarySignal: false, rawText: "" },
    risk, quant: { role: "quant_analyst", volatilityRegime: "medium", sharpeEstimate: 0, winRateFromHistory: 0, symbolScores: [], recommendation: "–", confidence: "low", rawText: "" },
    options: { role: "options_strategist", ivAssessments: [], rollOpportunities: [], overallIvEnvironment: "normal", recommendation: "–", applicable: false, rawText: "" },
    execution: { role: "execution_optimizer", tradeOptimizations: [], generalAdvice: "–", urgency: "low", rawText: "" },
    portfolio: { role: "portfolio_strategist", diversificationScore: 0, sectorConcentration: [], rebalancingNeeded: false, rebalancingActions: [], cashAllocationPct: 100, recommendation: "–", confidence: "low", rawText: "" },
    advisor,
  };
}

export async function runHermesTurn(p: HermesTurnParams, deps: HermesTurnDeps = {}): Promise<OrchestratorResult> {
  if (active.has(p.env)) throw new Error(HERMES_BUSY_TEXT);
  active.add(p.env);
  const ac = new AbortController();
  controllers.add(ac);
  const hermes = deps.hermes ?? hermesRoute();
  const t0 = Date.now();
  // EN tidsgräns för hela analysen, räknad från analysens start (orkestreraren), gäller alla steg
  const deadlineAt = Math.min(t0, p.totalStart) + (deps.totalMs ?? HERMES_TIMEOUTS.total);
  const startedAt = getAnalysis()?.startedAt ?? null;
  const costRunId = `hermes-${p.env}-${t0.toString(36)}`;
  // Anteckningarnas runId (agentsession eller analysens start): tips och etikett knyts till samma id
  const { notesRunId } = await import("../server/igAgentNotes.js");
  const notesRun = notesRunId() ?? `analys-${startedAt ?? t0}`;
  const isStale = deps.isStale ?? (await import("../server/igTurnGuard.js")).igTurnStale.bind(null, undefined);
  // Kontobyte/ny session eller en annan analys som tagit över: avbryt direkt (sena svar publiceras aldrig)
  const staleWhy = (): string | null => isStale() ?? (startedAt !== null && getAnalysis()?.startedAt !== startedAt ? "en ny analys startades" : null);
  const poll = setInterval(() => { const w = staleWhy(); if (w && !ac.signal.aborted) ac.abort(w); }, 500);
  poll.unref?.();
  const roles: RoleStatus[] = [];
  let jev: JevStatus | null = null;
  let lastLabel: import("./hermesLabel.js").BrainLabel | null = null;
  const finish = (outcome: HermesAnalysisMeta["outcome"], outcomeText: string): HermesAnalysisMeta => {
    const brain = `Hjärna: ${jev?.label ?? "utan JEV"} · Kropp: ${HERMES_BODIES.claude.label} + ${HERMES_BODIES.chatgpt.label}`;
    const meta: HermesAnalysisMeta = { outcome, outcomeText, jev, roles, brain, totalMs: Date.now() - t0, runId: costRunId };
    // runId = omgångens eget id (costRunId); sessionId = anteckningarnas gruppering (agentsession)
    const label = { text: brain, roles: roles.map(roleLine), jev: jev?.level ?? "utan", outcome: outcomeText, at: new Date().toISOString(), runId: costRunId, sessionId: notesRun };
    lastLabel = label;
    // Bara en lyckad körning får etikett ihop med sina tips; misslyckade/avbrutna visas separat
    if (outcome === "full" || outcome === "delvis") setBrainLabel(p.env, label); else setFailedAttempt(p.env, label);
    log.info(`[Hermes] ${outcomeText} på ${((Date.now() - t0) / 1000).toFixed(1)} s · ${brain} · ${roles.map(roleLine).join(" · ")}`);
    return meta;
  };
  const stop = (why: string, meta: HermesAnalysisMeta): never => {
    analysisEnd({ status: "stopped", reason: `Analysen avbröts: ${why}`, hermes: meta });
    throw new Error(`Hermes-analysen avbröts: ${why}`);
  };
  const incomplete = (role: RoleStatus): never => {
    const reason = role.status === "avbruten" ? `avbruten` : `analys ofullständig: ${roleName(role.role)} ${role.status === "överhoppad" ? "hann inte" : "misslyckades"} (${role.reason ?? role.status})`;
    const meta = finish(role.status === "avbruten" ? "avbruten" : "ofullständig", reason);
    if (role.status === "avbruten") return stop(String(ac.signal.reason ?? "avbruten"), meta);
    analysisEnd({ status: "failed", reason, hermes: meta });
    throw new Error(reason);
  };
  // Förberedande steg (version, inloggning, underlag) är bundna till samma avbrott och tidsgräns
  const stopOpts = { signal: ac.signal, deadlineAt };
  const guard = async <T,>(what: string, work: Promise<T>): Promise<T> => {
    try { return await waitStop(work, stopOpts); }
    catch (e) {
      if (e instanceof HermesError && e.kind === "aborted") return stop(String(ac.signal.reason ?? "avbruten"), finish("avbruten", `avbruten under ${what}`));
      if (e instanceof HermesError && e.kind === "deadline") {
        const reason = `analys ofullständig: ${what} hann inte (tidsgräns)`;
        roles.push(skippedStatus("technical", "tidsgräns"), skippedStatus("advisor", "tidsgräns"), skippedStatus("head", "tidsgräns"));
        analysisEnd({ status: "failed", reason, hermes: finish("ofullständig", reason) });
        throw new Error(reason);
      }
      throw e;
    }
  };
  try {
    const signals = deps.signals ?? (await import("../server/signalEngine.js")).getSignals;
    // Positioner + JEV-preflight under samma avbrott/tidsgräns som resten av analysen
    const pre = p.preflight ? await guard("JEV-förkontrollen", p.preflight()) : { jev: p.jev!, jevAt: p.jevAt ?? Date.now() };
    const jevNow: JevStatus = jevStatusFor(pre.jev, pre.jevAt, p.symbols, signals());
    jev = jevNow;
    // Låst Hermes-version (§8.4). Annan version → vägra med tydlig text.
    // Inloggningskontrollen (oauth-only per profil) körs om för VARJE analys.
    hermes.beginAnalysis();
    const ready = await guard("versionskontrollen", hermes.ready(stopOpts));
    // Inloggningskontrollen körs bara när versionen är godkänd (annars vägras läget ändå nedan)
    if (ready.ok) await guard("inloggningskontrollen", hermes.credentials(stopOpts));
    if (!ready.ok) {
      const meta = finish("ofullständig", `Hermes-läget vägrar: ${ready.reason}`);
      analysisEnd({ status: "failed", reason: `Hermes-läget vägrar: ${ready.reason}`, hermes: meta });
      throw new Error(`Hermes-läget vägrar: ${ready.reason}`);
    }

    // Underlag (kompakt, en rad per instrument) med tidsstämpel per del
    const { igAgentData } = await import("../server/igAgentData.js");
    const { igMarketData } = await import("../server/igMarketData.js");
    const { shortIntervals, getHorizonMin } = await import("../server/tradeHorizon.js");
    const { currentStake, stakeStartPct } = await import("../risk/stakeLadder.js");
    const broker = p.broker as BrokerAdapter & { lastKnownPositions?: () => { at: number; positions: never[] } | null };
    const market: MarketBlockDeps = deps.market ?? {
      klines: (epic, iv) => igAgentData.klines(p.env, epic, iv, 150, () => broker.getKlines(epic, iv, 150)),
      // Positioner läses UTAN förtur (orderreserven, regel 7); saldot som Risk gör i dag
      positions: () => igAgentData.positions(() => broker.getPositions(), broker.lastKnownPositions ? () => broker.lastKnownPositions!() : null, p.env),
      account: () => igAgentData.account(p.env, () => broker.getAccount()),
      nameOf: (e) => igMarketData.nameOf(e, p.env),
      intervals: shortIntervals(),
    };
    const block: MarketBlock = await guard("underlaget", buildMarketBlock(costRunId, p.env, p.symbols, market));
    const s = currentStake();
    const stake = deps.stake ?? { pct: s?.pct ?? 1, amount: s?.amount ?? null, currency: s?.currency ?? null, minPct: stakeStartPct(), horizonMin: getHorizonMin() };
    // Live = IG Live-kontot ELLER MODE=live (aldrig bara config.mode: Demo får inte märkas live, och IG Live får aldrig behandlas som papper)
    const live = p.env === "live" || p.config.mode === "live";
    const mode: "paper" | "live" = live ? "live" : "paper";
    const pctx = { block, jev: jevNow, maxStakePct: stake.pct, currency: stake.currency, horizonMin: stake.horizonMin, mode, userInstruction: p.userInstruction };
    const prefix = sharedPrefix(pctx);

    // Kostnad: Hermes 0 USD (räknas inte mot taket); betald reserv registreras med sin väg
    const { trackClaudeCall } = await import("../cost/tracker.js");
    const { usingGateway } = await import("../llm/gateway.js");
    const trackFn: ChainCtx["track"] = deps.track ?? (async (agent, model, usage, o) => {
      await trackClaudeCall(agent, model, usage, costRunId, { route: o.route === "gateway" && !usingGateway() ? "anthropic" : o.route, ...(o.costUsd !== undefined ? { costUsd: o.costUsd } : {}), durationMs: o.durationMs }).then(() => {}, () => {});
    });
    const paid: PaidDeps = {
      flag: deps.paid?.flag ?? (() => process.env.LLM_HERMES_PAID_FALLBACK === "true"),
      budgetLeft: deps.paid?.budgetLeft ?? (async () => {
        const { canSpend } = await import("../cost/tracker.js");
        return (await canSpend({ dailyCapUsd: p.config.costCap.dailyUsd, weeklyCapUsd: p.config.costCap.weeklyUsd })).allowed;
      }),
      call: deps.paid?.call ?? (async (q) => {
        const { createLlmClient, modelFor } = await import("../llm/gateway.js");
        const client = createLlmClient(p.config.anthropicApiKey);
        const model = modelFor(q.modelRole, q.directDefault);
        const t = Date.now();
        // Egen tidsgräns per anrop (rollens gräns, högst kvarvarande del av 300 s) och avbrott via kedjans signal
        // Gatewayens interna försök (vägar + reservmodeller) delar EN signal: kedjans avbrott eller
        // återstående tid (q.timeoutMs ≤ kvar av 300 s). Ett avbrutet anrop har ingen status → kedjan stannar direkt.
        const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(Math.max(1, q.timeoutMs))]);
        const r = await client.messages.create({ model, max_tokens: q.maxTokens, system: q.system, messages: [{ role: "user", content: q.user }] }, { signal, timeout: q.timeoutMs, maxRetries: 0 });
        return { text: messageText(r), model: r.model || model, usage: r.usage, ms: Date.now() - t };
      }),
    };
    if (!p.spendAllowed) log.warn("[Hermes] API-taket är nått: Hermes-läget fortsätter (prenumeration), betald reserv spärrad");
    const ctx: ChainCtx = { hermes, runId: costRunId, signal: ac.signal, deadlineAt, paid, track: trackFn };

    // ── Steg 1: Claude, Teknisk + Risk i ett anrop ──
    turnPhase("Hermes 1/3 · Claude: teknisk + risk");
    const epics = p.symbols;
    const tr = await track("technical", `Claude: teknisk + risk ${epics.length} instrument`, () => runRole<{ rows: TrRow[]; riskOk: boolean; riskReason: string | null }>({
      role: "technical", agent: "technical", order: ["claude", "chatgpt"], prompt: prefix + technicalRiskTail(pctx), timeoutMs: HERMES_TIMEOUTS.technical,
      validate: (text) => {
        const v = validateTechRisk(text, epics);
        if (!v.techOk) return { ok: false, reason: v.reason, value: null };
        return { ok: v.riskOk, partial: !v.riskOk, reason: v.reason, value: { rows: v.rows, riskOk: v.riskOk, riskReason: v.reason } };
      },
      paid: { modelRole: "specialist", directDefault: "claude-haiku-4-5-20251001", system: prefix, user: technicalRiskTail(pctx), maxTokens: 1500 },
    }, ctx), { from: "jev", done: (r) => r.status.status });
    const techStatus = { ...tr.status };
    const riskStatus: RoleStatus = tr.value?.riskOk
      ? { ...tr.status, role: "risk" }
      : tr.value ? { ...tr.status, role: "risk", status: "misslyckad", reason: tr.value.riskReason ?? "riskfält saknas" }
      : { ...tr.status, role: "risk" };
    if (techStatus.status === "lyckad") techStatus.reason = null;
    roles.push(techStatus, riskStatus);
    agentSkip("risk", riskStatus.status === "lyckad" ? "ingår i Claudes anrop (Teknisk + Risk)" : `Risk saknas: ${riskStatus.reason ?? riskStatus.status}`);
    if (techStatus.status !== "lyckad" || !tr.value) {
      roles.push(skippedStatus("advisor", "Teknisk saknas"), skippedStatus("head", "Teknisk saknas"));
      return incomplete(techStatus);
    }
    const rows = tr.value.rows;
    const claudeJson = JSON.stringify({ instruments: rows });

    // ── Steg 2: ChatGPT, Advisor (bara skärpa). Live kör alltid Advisorn (jev.ts). ──
    let reviews: AdvReview[] | null = null;
    let advStatus: RoleStatus;
    if (!pre.jev.runAdvisor && !live) {
      advStatus = skippedStatus("advisor", `JEV: rutinturn (${pre.jev.detail})`);
      agentSkip("advisor", advStatus.reason!);
    } else {
      turnPhase("Hermes 2/3 · ChatGPT: advisor");
      const adv = await track("advisor", "ChatGPT granskar Claudes analys", () => runRole<AdvReview[]>({
        role: "advisor", agent: "advisor", order: ["chatgpt", "claude"], prompt: prefix + advisorTail(claudeJson), timeoutMs: HERMES_TIMEOUTS.advisor,
        validate: (text) => { const v = validateAdvisor(text, epics); return { ok: v.ok, reason: v.reason, value: v.ok ? v.reviews : null }; },
        paid: { modelRole: "advisor", directDefault: "claude-opus-4-7", system: prefix, user: advisorTail(claudeJson), maxTokens: 1200 },
      }, ctx), { from: "technical", done: (r) => r.status.status });
      advStatus = adv.status;
      reviews = adv.value;
    }
    roles.push(advStatus);
    if (advStatus.status === "avbruten") { roles.push(skippedStatus("head", "avbruten", "avbruten")); return incomplete(advStatus); }
    const tightened = reviews ? applyAdvisorTightening(rows, reviews).rows : rows;

    // ── Steg 3: Claude, Hanna (verktygsfri gren i headTrader.ts) ──
    turnPhase("Hermes 3/3 · Hanna: slutbeslut");
    const { igAgentData: liveData, IG_QUOTE_FRESH_MS } = await import("../server/igAgentData.js");
    const head = await track("head", "Hanna väger ihop Claude + ChatGPT + JEV", () => runHeadTrader({
      apiKey: p.config.anthropicApiKey, config: p.config, state: p.state, broker: p.broker, brokers: p.brokers, risk: p.risk, engines: p.engines,
      reports: reportsFrom(rows, tr.text ?? "", riskStatus, reviews, advStatus), userInstruction: p.userInstruction, symbols: epics,
      hermes: {
        ctx, prefix, epics, claudeJson,
        advisorJson: reviews ? JSON.stringify({ reviews }) : null,
        advisorNote: `Advisor ${advStatus.status}${advStatus.reason ? ` (${advStatus.reason})` : ""}`,
        preflightLine: jevNow.preflight.status === "ok" ? `djup ${jevNow.preflight.depth ?? "?"}, granskning ${jevNow.preflight.review ?? "?"} (${jevNow.preflight.detail}) [${jevNow.preflight.at}]` : `saknas: ${jevNow.preflight.detail} [${jevNow.preflight.at}]`,
        stake: { maxStakePct: stake.pct, minStakePct: stake.minPct, amount: stake.amount, currency: stake.currency, horizonMin: stake.horizonMin },
        finalize: {
          riskRows: rows, tightened, advisorReviews: reviews, riskOk: riskStatus.status === "lyckad", advisorStatus: advStatus.status, mode, jev: jevNow, block,
          // Bara ett färskt IG-pris (≤ 60 s) räknas som "nu"; annars null → nivåerna märks overifierade
          maxStakePct: stake.pct,
          livePrice: deps.livePrice ?? ((e) => liveData.igLive(p.env, e, IG_QUOTE_FRESH_MS)?.price ?? null),
        },
      },
    }), { from: "advisor", done: (r) => r.hermesHead?.status ?? "?" });
    const headStatus = head.hermesHead ?? skippedStatus("head", "ingen status", "misslyckad");
    roles.push(headStatus);
    if (headStatus.status !== "lyckad" || !head.tips) return incomplete(headStatus);

    // Före publicering: signalerna läses om, nya JEV-veton gäller (tidigare behålls)
    applyLateVetoes(head.tips, jevNow, jevStatusFor(pre.jev, pre.jevAt, p.symbols, signals()));

    // Före visning: konto/miljö/körning ändrad → kasta analysen (§10.5)
    const why = ac.signal.aborted ? String(ac.signal.reason ?? "avbruten") : staleWhy();
    if (why) return stop(why, finish("avbruten", `avbruten: ${why}`));

    const missing = [riskStatus.status !== "lyckad" ? "Risk saknas" : null, advStatus.status !== "lyckad" && advStatus.status !== "överhoppad" ? "Advisor saknas" : null].filter(Boolean) as string[];
    const outcomeText = missing.length ? `delvis (${missing.join(", ")})` : "full";
    const meta = finish(missing.length ? "delvis" : "full", outcomeText);
    // Varje tips bär metadata från SIN omgång, så att topplistan/korten aldrig visar en annan omgångs etikett
    if (lastLabel) {
      const l = lastLabel as import("./hermesLabel.js").BrainLabel;
      for (const t of head.tips) t.brain = { text: l.text, roles: l.roles, jev: l.jev, outcome: l.outcome, roundId: l.runId, sessionId: notesRun, at: l.at };
    }
    const reports = reportsFrom(rows, tr.text ?? "", riskStatus, reviews, advStatus);
    const summary = `${missing.length ? `⚠ ${outcomeText}. ` : ""}${meta.brain}\n${head.decision.briefingSummary}`;
    let notes;
    try {
      const { buildAgentNotes, agentNotes } = await import("../server/igAgentNotes.js");
      notes = buildAgentNotes({
        env: p.env, symbols: epics, picks: [], technical: reports.technical.analyses, summary,
        trigger: getAnalysis()?.trigger ?? null, nameOf: (e) => igMarketData.nameOf(e, p.env),
        tips: head.tips, runId: notesRun,
      });
      agentNotes.record(notes);
    } catch { /* anteckningarna är bara en spegel */ }
    turnEnd(`Hermes-turen klar på ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    analysisEnd({ status: "done", regime: "uncertain", summary: summary.slice(0, 1500), picks: [], orders: [], ...(notes ? { notes } : {}), hermes: meta });
    const totalMs = Date.now() - p.totalStart;
    return {
      headTrader: { ...head, decision: { ...head.decision, briefingSummary: summary } },
      reports,
      timingMs: { specialists: roles.filter((r) => r.role !== "head").reduce((a, r) => a + r.ms, 0), execution: 0, headTrader: headStatus.ms, total: totalMs },
    };
  } finally {
    clearInterval(poll);
    controllers.delete(ac);
    active.delete(p.env);
  }
}
