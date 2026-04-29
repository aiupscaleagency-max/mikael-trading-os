import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Trade State Manager — SINGLE SOURCE OF TRUTH för all trade-state
//
// Ersätter frontend localStorage som primär källa. Frontend skickar bara
// actions (POST), server räknar/uppdaterar state och broadcastar via SSE.
//
// Detta löser race-condition mellan flikar/devices som tidigare orsakade
// inkonsistenta siffror (54 vs 80 trades, $5560 vs $6090 PnL).
//
// Persistens: JSON i /app/data/state/{clientId}.json (atomic writes via tmp+rename)
// Concurrency: per-client mutex via Promise-chain
// ═══════════════════════════════════════════════════════════════════════════

const STATE_DIR = path.resolve(process.cwd(), "data", "state");
const PAPER_START_BALANCE = 10000;

// ─── Type-definitioner ───────────────────────────────────────────────────
export interface TradePosition {
  id: string;
  sym: string;
  side: "BUY" | "SELL";
  amount: number;          // stake i USD
  entry: number;
  qty: number;
  openedAt: number;
  expiresAt?: number;
  timeframeSec: number;
  payoutMultiplier: number;
  payoutPct: number;
  score?: number;
  setupType?: string;
  setupLabel?: string;
  inSession?: boolean;
  sessionNum?: number;
  confirmed?: boolean;
  status: "open" | "closed";
  type: "scalp" | "spot" | "swing";
  source: string;
}

export interface ClosedTrade extends TradePosition {
  exit: number;
  pnl: number;
  won: boolean;
  closedAt: number;
  balanceAfter?: number;
  equityAfter?: number;
}

export interface PaperAccount {
  startBalance: number;
  cash: number;
  realizedPnl: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  createdAt: number;
}

export interface SessionState {
  sessionNum: number;
  totalSessions: number;
  tradeNum: number;
  totalTrades: number;
  wins: number;
  losses: number;
  scoreThreshold: number;
  startedAt: number;
  trades: Array<{ score: number; won: boolean; pnl: number; sym: string; side: string; at: number }>;
  skipped: number;
  autoConfirm?: boolean;
}

export interface SessionReport {
  sessionNum: number;
  startedAt: number;
  endedAt: number;
  aborted: boolean;
  totalTrades: number;
  wins: number;
  losses: number;
  winrate: number;
  totalPnl: number;
  avgScore: number;
  skipped: number;
  targetMet: boolean;
  trades: SessionState["trades"];
}

export interface PendingWatch {
  id: string;
  sym: string;
  side: "BUY" | "SELL";
  amount: number;
  timeframeSec: number;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  lastScore: number | null;
  lastCheck: number | null;
  sessionNum: number | null;
  threshold: number;
  fromAutoFill?: boolean;
}

export interface PendingConfirm {
  id: string;
  watchId: string;
  sym: string;
  side: "BUY" | "SELL";
  amount: number;
  timeframeSec: number;
  score: number;
  setupType: string;
  setupLabel: string;
  factors?: Array<{ label: string; points: number; detail: string; positive: boolean | null }>;
  expectedWinrate?: number;
  historicalMatch?: { total: number; wins: number; winrate: number } | null;
  entry: number;
  suggestedSL: number;
  suggestedTP: number;
  attemptCount: number;
  createdAt: number;
  expiresAt: number;
  sessionNum: number | null;
}

export interface FullTradeState {
  paperAccount: PaperAccount;
  positions: TradePosition[];
  history: ClosedTrade[];
  decisions: Array<{ timestamp: number; action: string; sym?: string; amount?: number; reasoning: string; source: string; score?: number; setupType?: string }>;
  session: SessionState | null;
  sessionReports: SessionReport[];
  pendingWatches: PendingWatch[];
  pendingConfirms: PendingConfirm[];
  schemaVersion: number;
  updatedAt: number;
}

// ─── Default-state ────────────────────────────────────────────────────────
function createDefaultState(): FullTradeState {
  return {
    paperAccount: {
      startBalance: PAPER_START_BALANCE,
      cash: PAPER_START_BALANCE,
      realizedPnl: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      createdAt: Date.now(),
    },
    positions: [],
    history: [],
    decisions: [],
    session: null,
    sessionReports: [],
    pendingWatches: [],
    pendingConfirms: [],
    schemaVersion: 1,
    updatedAt: Date.now(),
  };
}

// ─── Persistens (atomic writes) ───────────────────────────────────────────
function clientStateFile(clientId: string): string {
  const safe = clientId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return path.join(STATE_DIR, `${safe}.json`);
}

async function readState(clientId: string): Promise<FullTradeState> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const file = clientStateFile(clientId);
    const data = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(data) as FullTradeState;
    // Migration: säkerställ alla fält finns
    return { ...createDefaultState(), ...parsed };
  } catch {
    return createDefaultState();
  }
}

async function writeStateAtomic(clientId: string, state: FullTradeState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const file = clientStateFile(clientId);
  const tmp = `${file}.tmp`;
  state.updatedAt = Date.now();
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, file);
}

// ─── Per-client mutex (förhindrar concurrent writes) ──────────────────────
const mutexes = new Map<string, Promise<unknown>>();

async function withLock<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(clientId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // kör även om föregående misslyckades
  mutexes.set(clientId, next.catch(() => undefined));
  try {
    return await next;
  } finally {
    if (mutexes.get(clientId) === next.catch(() => undefined)) {
      // ingen ny request tagit över → städa
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

export async function getState(clientId: string): Promise<FullTradeState> {
  return readState(clientId);
}

export async function resetPaperAccount(clientId: string): Promise<FullTradeState> {
  return withLock(clientId, async () => {
    const fresh = createDefaultState();
    await writeStateAtomic(clientId, fresh);
    log.info(`[trade-state] Paper-konto resetat för ${clientId}`);
    return fresh;
  });
}

// Konstanter för payout (samma som frontend)
const SCALP_PAYOUT_MIN = 1.6;
const SCALP_PAYOUT_MAX = 1.9;
const SCALP_DEFAULT_SEC = 60;
function randomPayout(): number {
  return SCALP_PAYOUT_MIN + Math.random() * (SCALP_PAYOUT_MAX - SCALP_PAYOUT_MIN);
}

export interface OpenTradeParams {
  sym: string;
  side: "BUY" | "SELL";
  amount: number;
  timeframeSec?: number;
  entry: number;
  score?: number;
  setupType?: string;
  setupLabel?: string;
  source?: string;
  inSession?: boolean;
  confirmed?: boolean;
  reasoning?: string;
}

export async function openTrade(clientId: string, params: OpenTradeParams): Promise<{ ok: boolean; trade?: TradePosition; state: FullTradeState; error?: string }> {
  return withLock(clientId, async () => {
    const state = await readState(clientId);
    if (params.amount > state.paperAccount.cash) {
      return { ok: false, error: `Inte nog cash: $${state.paperAccount.cash.toFixed(2)} < $${params.amount}`, state };
    }
    const tf = params.timeframeSec || SCALP_DEFAULT_SEC;
    const payoutMult = randomPayout();
    const trade: TradePosition = {
      id: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      sym: params.sym,
      side: params.side,
      amount: params.amount,
      entry: params.entry,
      qty: params.amount / params.entry,
      openedAt: Date.now(),
      expiresAt: Date.now() + tf * 1000,
      timeframeSec: tf,
      payoutMultiplier: payoutMult,
      payoutPct: Math.round((payoutMult - 1) * 100),
      score: params.score,
      setupType: params.setupType,
      setupLabel: params.setupLabel,
      inSession: !!params.inSession,
      sessionNum: state.session?.sessionNum,
      confirmed: !!params.confirmed,
      status: "open",
      type: "scalp",
      source: params.source || "api",
    };
    state.positions.push(trade);
    state.decisions.unshift({
      timestamp: Date.now(),
      action: params.side,
      sym: params.sym,
      amount: params.amount,
      score: params.score,
      setupType: params.setupType,
      reasoning: params.reasoning || `Trade öppnad via API · ${params.source || "?"}`,
      source: params.source || "api",
    });
    state.paperAccount.cash -= params.amount;
    state.paperAccount.totalTrades++;
    await writeStateAtomic(clientId, state);
    return { ok: true, trade, state };
  });
}

export interface ResolveTradeParams {
  tradeId: string;
  exit: number;
  won: boolean;
  pnl: number;
}

export async function resolveTrade(clientId: string, params: ResolveTradeParams): Promise<{ ok: boolean; state: FullTradeState; error?: string }> {
  return withLock(clientId, async () => {
    const state = await readState(clientId);
    const idx = state.positions.findIndex((p) => p.id === params.tradeId);
    if (idx === -1) return { ok: false, error: "Trade hittades inte", state };
    const pos = state.positions[idx]!;
    state.positions.splice(idx, 1);
    state.paperAccount.cash += pos.amount + params.pnl;
    state.paperAccount.realizedPnl += params.pnl;
    if (params.won) state.paperAccount.winningTrades++;
    else state.paperAccount.losingTrades++;
    const closed: ClosedTrade = {
      ...pos,
      exit: params.exit,
      pnl: params.pnl,
      won: params.won,
      status: "closed",
      closedAt: Date.now(),
      balanceAfter: state.paperAccount.cash,
      equityAfter: state.paperAccount.cash + state.positions.reduce((s, p) => s + p.amount, 0),
    };
    state.history.unshift(closed);
    state.decisions.unshift({
      timestamp: Date.now(),
      action: params.won ? "WIN" : "LOSS",
      sym: pos.sym,
      amount: pos.amount,
      score: pos.score,
      setupType: pos.setupType,
      reasoning: `${pos.side === "BUY" ? "LONG" : "SHORT"} ${pos.sym} · PnL ${params.pnl >= 0 ? "+" : ""}$${params.pnl.toFixed(2)}${pos.score ? ` · score ${pos.score}/10` : ""}`,
      source: "auto-resolve",
    });
    // Session-tracking
    if (pos.inSession && state.session && state.session.sessionNum === pos.sessionNum) {
      state.session.trades.push({ score: pos.score || 0, won: params.won, pnl: params.pnl, sym: pos.sym, side: pos.side, at: Date.now() });
      if (params.won) state.session.wins++;
      else state.session.losses++;
      state.session.tradeNum = state.session.trades.length;
      // Auto-complete om session full
      if (state.session.tradeNum >= state.session.totalTrades) {
        const total = state.session.trades.length;
        const winrate = total ? state.session.wins / total : 0;
        const totalPnl = state.session.trades.reduce((sum, t) => sum + t.pnl, 0);
        const avgScore = total ? state.session.trades.reduce((sum, t) => sum + t.score, 0) / total : 0;
        const report: SessionReport = {
          sessionNum: state.session.sessionNum,
          startedAt: state.session.startedAt,
          endedAt: Date.now(),
          aborted: false,
          totalTrades: total,
          wins: state.session.wins,
          losses: state.session.losses,
          winrate,
          totalPnl,
          avgScore,
          skipped: state.session.skipped,
          targetMet: winrate >= 0.75,
          trades: state.session.trades.slice(),
        };
        state.sessionReports.unshift(report);
        state.session = null;
      }
    }
    await writeStateAtomic(clientId, state);
    return { ok: true, state };
  });
}

export async function startSession(clientId: string, opts?: { totalSessions?: number; totalTrades?: number; scoreThreshold?: number }): Promise<{ ok: boolean; state: FullTradeState; error?: string }> {
  return withLock(clientId, async () => {
    const state = await readState(clientId);
    if (state.session) return { ok: false, error: "En session pågår redan", state };
    const completed = state.sessionReports.length;
    state.session = {
      sessionNum: completed + 1,
      totalSessions: opts?.totalSessions ?? 6,
      tradeNum: 0,
      totalTrades: opts?.totalTrades ?? 5,
      wins: 0,
      losses: 0,
      scoreThreshold: opts?.scoreThreshold ?? 8,
      startedAt: Date.now(),
      trades: [],
      skipped: 0,
    };
    await writeStateAtomic(clientId, state);
    return { ok: true, state };
  });
}

export async function abortSession(clientId: string): Promise<{ ok: boolean; state: FullTradeState }> {
  return withLock(clientId, async () => {
    const state = await readState(clientId);
    if (!state.session) return { ok: true, state };
    if (state.session.trades.length > 0) {
      const total = state.session.trades.length;
      const winrate = total ? state.session.wins / total : 0;
      const totalPnl = state.session.trades.reduce((sum, t) => sum + t.pnl, 0);
      state.sessionReports.unshift({
        sessionNum: state.session.sessionNum,
        startedAt: state.session.startedAt,
        endedAt: Date.now(),
        aborted: true,
        totalTrades: total,
        wins: state.session.wins,
        losses: state.session.losses,
        winrate,
        totalPnl,
        avgScore: total ? state.session.trades.reduce((sum, t) => sum + t.score, 0) / total : 0,
        skipped: state.session.skipped,
        targetMet: winrate >= 0.75,
        trades: state.session.trades.slice(),
      });
    }
    state.session = null;
    await writeStateAtomic(clientId, state);
    return { ok: true, state };
  });
}

// Reconciliation — räknar igenom history och korrigerar paperAccount-counters
// så att Lifetime stats och header-stats ALLTID stämmer
export async function reconcile(clientId: string): Promise<{ before: PaperAccount; after: PaperAccount; state: FullTradeState }> {
  return withLock(clientId, async () => {
    const state = await readState(clientId);
    const before = { ...state.paperAccount };
    let wins = 0,
      losses = 0,
      realizedPnl = 0;
    for (const h of state.history) {
      if (h.won) wins++;
      else losses++;
      realizedPnl += h.pnl || 0;
    }
    state.paperAccount.winningTrades = wins;
    state.paperAccount.losingTrades = losses;
    state.paperAccount.totalTrades = state.history.length + state.positions.length;
    state.paperAccount.realizedPnl = realizedPnl;
    // Cash-räkning från ground truth: start - öppna stakes + alla pnls
    const openStakes = state.positions.reduce((s, p) => s + p.amount, 0);
    state.paperAccount.cash = state.paperAccount.startBalance + realizedPnl - openStakes;
    await writeStateAtomic(clientId, state);
    return { before, after: { ...state.paperAccount }, state };
  });
}
