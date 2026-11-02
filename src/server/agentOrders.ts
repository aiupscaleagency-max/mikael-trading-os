// Agenternas ordrar (Mike 2026-11-02): "Manuell – jag godkänner" eller "Automatisk – agenterna godkänner".
// Gäller BARA agenternas ordrar (Hannas tips och Öppningsvakten). Dashboarden, chatten, Double Up,
// strategier och bron kräver alltid Godkänn som förut.
// Automatisk = förslaget godkänns direkt av agenterna, men går genom exakt samma väg som Mikes Godkänn
// (executeApprovedOrder: ordergrinden, kill switch, IG-gränserna 3 %/15 %/5 %). Bara IG Demo.
// IG Live är alltid Manuell; Automatisk i Live byggs först när Mike uttryckligen sagt ja.
// Valet sparas i data-ig/agent-orders-mode.json och står på Manuell om filen saknas.

import fs from "node:fs/promises";
import path from "node:path";
import { dataPath } from "../dataDir.js";
import { log } from "../logger.js";
import { hasPendingFor, type PendingOrder } from "./orderGate.js";
import type { AgentTip } from "../orchestrator/headTips.js";

export type AgentOrdersMode = "manual" | "auto";

const FILE = dataPath("agent-orders-mode.json");
let mode: AgentOrdersMode = "manual";

export function getAgentOrdersMode(): AgentOrdersMode { return mode; }

/** Byter läge. Automatisk går bara för IG Demo; Live svarar med fel och ändrar inget. */
export async function setAgentOrdersMode(next: AgentOrdersMode, env: "demo" | "live"): Promise<{ ok: true } | { ok: false; error: string }> {
  if (next === "auto" && env !== "demo") {
    return { ok: false, error: "IG Live: agenternas ordrar väntar alltid på ditt Godkänn. Automatisk finns bara i Demo." };
  }
  mode = next;
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify({ mode, savedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    log.warn(`Kunde inte spara Manuell/Automatisk: ${(e as Error).message}`);
  }
  log.warn(`Agenternas ordrar: ${mode === "auto" ? "AUTOMATISK (agenterna godkänner, bara IG Demo)" : "MANUELL (varje order väntar på Godkänn)"}`);
  return { ok: true };
}

/** Vid start: senaste valet. Saknas eller trasig fil → Manuell. */
export async function restoreAgentOrdersMode(): Promise<void> {
  try {
    const d = JSON.parse(await fs.readFile(FILE, "utf8")) as { mode?: string };
    mode = d.mode === "auto" ? "auto" : "manual";
  } catch {
    mode = "manual";
  }
}

/** Kommer förslaget från agenterna (inte från Mike själv)? */
export function isAgentSource(source: string | undefined): boolean {
  return source === "agent" || String(source ?? "").startsWith("agent:");
}

/**
 * Ska agenterna godkänna förslaget själva? Bara agentförslag, bara IG Demo, bara i Automatisk.
 * En stängning av en befintlig position (closeDealId) väntar alltid på Mike: den kan vara hans egen affär.
 */
export function shouldAutoApprove(p: Pick<PendingOrder, "source" | "live" | "venue" | "status" | "closeDealId">): boolean {
  return mode === "auto" && p.status === "pending" && !p.live && p.venue === "broker:ig-demo" && isAgentSource(p.source) && !p.closeDealId;
}

// Godkännandet sätts av api.ts (samma funktion som knappen Godkänn använder)
type Approver = (id: string) => Promise<{ ok: boolean; error?: string }>;
let approver: Approver | null = null;
export function setAgentOrderApprover(fn: Approver | null): void { approver = fn; }

/** Efter att ett agentförslag lagts i kön: godkänn direkt om Automatisk gäller, annars väntar det på Mike. */
export async function maybeAutoApprove(p: PendingOrder): Promise<"auto-godkänd" | "auto-fel" | "väntar"> {
  if (!shouldAutoApprove(p) || !approver) return "väntar";
  try {
    const r = await approver(p.id);
    if (r.ok) { log.trade(`[AUTOMATISK] agenterna godkände ${p.side} ${p.name ?? p.symbol} (IG Demo)`); return "auto-godkänd"; }
    log.warn(`[AUTOMATISK] ${p.side} ${p.symbol} stoppades: ${r.error ?? "okänt fel"}`);
    return "auto-fel";
  } catch (e) {
    log.warn(`[AUTOMATISK] ${p.side} ${p.symbol} gick inte att godkänna: ${(e as Error).message}`);
    return "auto-fel";
  }
}

type CreatePending = (b: Record<string, unknown>) => Promise<{ ok: true; pendingOrder: PendingOrder } | { ok: false; error: string }>;

/**
 * Hannas färdiga tips → förslag i Väntande ordrar (bäst rankade först).
 * Bara KÖP/SÄLJ med både stop-loss och målpris och verifierade nivåer (färskt IG-pris).
 * Ordern prissätts av IG när den läggs; tipsets entry är bara underlag.
 */
export async function queueTipsAsOrders(tips: AgentTip[], venue: string, create: CreatePending): Promise<{ queued: number; auto: number; skipped: string[] }> {
  const out = { queued: 0, auto: 0, skipped: [] as string[] };
  const ready = tips
    .filter((t) => t.action === "buy" || t.action === "sell")
    .sort((a, b) => a.rank - b.rank);
  for (const t of ready) {
    if (t.unverifiedLevels || t.stopLoss === null || t.takeProfit === null) { out.skipped.push(`${t.epic}: nivåer saknas eller är overifierade`); continue; }
    const side = t.action === "buy" ? "BUY" : "SELL";
    // Samma förslag ligger redan i kön → ingen dubblett
    if (await hasPendingFor(t.epic, side, venue)) { out.skipped.push(`${t.epic}: ligger redan i kön`); continue; }
    try {
      const r = await create({
        symbol: t.epic, side, source: "agent:hanna",
        stopLoss: t.stopLoss, takeProfit: t.takeProfit,
        ...(t.sizePct ? { stakePct: t.sizePct } : {}),
        horizonSec: t.horizonMin * 60,
        reason: `Hanna (säkerhet ${({ low: "låg", medium: "medel", high: "hög" } as const)[t.confidence] ?? t.confidence}): ${t.why}`.slice(0, 200),
      });
      if (!r.ok) { out.skipped.push(`${t.epic}: ${r.error}`); continue; }
      out.queued++;
      if ((await maybeAutoApprove(r.pendingOrder)) === "auto-godkänd") out.auto++;
    } catch (e) {
      out.skipped.push(`${t.epic}: ${(e as Error).message}`);
    }
  }
  return out;
}
