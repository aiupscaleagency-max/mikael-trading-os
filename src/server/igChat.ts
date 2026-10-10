// ═══════════════════════════════════════════════════════════════════════════
// Chatten mot IG (ersätter Binance-verktygen i /api/chat).
//
// Samma modell och samma LLM-klient som förut (createLlmClient, claude-haiku-4-5).
// Verktygen lägger bara FÖRSLAG i Väntande ordrar; inget skickas till IG förrän
// Mike godkänner, och bara om orderläget för miljön är påslaget i .env.
// Instrument väljs ur bevakningslistan (riktiga IG EPICs), aldrig påhittade.
// ═══════════════════════════════════════════════════════════════════════════

import type Anthropic from "@anthropic-ai/sdk";
import type { IgBroker } from "../brokers/ig.js";
import { addPendingOrder, checkOrderGate } from "./orderGate.js";
import { igMarketData } from "./igMarketData.js";

type Llm = { messages: { create: (p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message> } };

export interface IgChatDeps {
  /** Kontext från dashboarden (krav F4), redan validerad i igChatContext.ts. */
  contextPrompt?: string;
  llm: Llm;
  createPending: (b: Record<string, unknown>, broker: IgBroker) => Promise<{ ok: boolean; error?: string; pendingOrder?: { id: string; symbol: string; side: string; name?: string; stakeAmount?: number; currency?: string } }>;
  watchlist?: () => { epic: string; name: string | null; category: string | null }[];
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "queue_ig_orders",
    description: "Lägger förslag i Väntande ordrar på IG (inga ordrar skickas förrän Mike godkänner). Välj instrument (EPIC) ur bevakningslistan. side BUY = köp (lång), SELL = sälj (kort). stake_pct = insats i % av saldot, 0.1–3.",
    input_schema: {
      type: "object",
      properties: {
        epics: { type: "array", items: { type: "string" }, description: "IG EPICs ur bevakningslistan (max 10)" },
        side: { type: "string", enum: ["BUY", "SELL"] },
        stake_pct: { type: "number", description: "Insats i % av saldot (0.1–3)" },
        reason: { type: "string" },
        strategy_id: { type: "string", description: "Valfritt: id för strategin i Strategibiblioteket som förslaget bygger på. Ange BARA om förslaget faktiskt följer den strategin; annars utelämna." },
      },
      required: ["epics", "side"],
    },
  },
  {
    name: "close_all_positions",
    description: "Lägger stängning av ALLA öppna IG-positioner i Väntande ordrar (Mike godkänner varje).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_account_status",
    description: "Hämtar IG-kontot: saldo, tillgängligt, valuta, öppna positioner.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export async function executeIgChatTool(name: string, input: Record<string, unknown>, broker: IgBroker, deps: IgChatDeps): Promise<unknown> {
  const watch = (deps.watchlist ?? (() => igMarketData.watchlistDetailed(broker.env)))();
  if (name === "get_account_status") {
    const [acc, pos] = await Promise.all([broker.getAccount(), broker.getPositions().catch(() => [])]);
    return {
      environment: broker.env === "live" ? "IG Live" : "IG Demo", currency: acc.currency, balance: acc.balance, available: acc.available,
      profit_loss: acc.profitLoss,
      open_positions: pos.map((p) => ({ name: p.name ?? p.symbol, epic: p.symbol, direction: p.direction, size: p.quantity, pnl: p.pnlVerified ? p.unrealizedPnlUsdt : null })),
    };
  }
  if (name === "close_all_positions") {
    const pos = await broker.getPositions();
    const out = [];
    for (const p of pos) {
      if (!p.dealId) continue;
      const gate = await checkOrderGate({ live: broker.mode === "live", side: p.direction === "SELL" ? "BUY" : "SELL", unitsOrder: true, opening: false, source: "chat:close_all" });
      if (!gate.ok) { out.push({ epic: p.symbol, ok: false, error: gate.error }); continue; }
      const q = await addPendingOrder({ source: "chat:close_all", venue: `broker:${broker.name}`, live: broker.mode === "live", symbol: p.symbol, side: p.direction === "SELL" ? "BUY" : "SELL", quantity: p.quantity, closeDealId: p.dealId, name: p.name ?? undefined, reason: "Stäng allt (chatten)" });
      out.push({ epic: p.symbol, name: p.name, queued: q.id });
    }
    return { ok: true, executed: false, waiting_for_approval: out.filter((o) => "queued" in o).length, results: out, message: "Inget är stängt än. Stängningarna väntar på ditt godkännande." };
  }
  if (name === "queue_ig_orders") {
    const allowed = new Set(watch.map((w) => w.epic));
    const epics = (Array.isArray(input.epics) ? input.epics : []).map(String).slice(0, 10);
    const side = input.side === "SELL" ? "SELL" : "BUY";
    const pct = Math.min(3, Math.max(0.1, Number(input.stake_pct) || 1));
    const results = [];
    for (const epic of epics) {
      if (!allowed.has(epic)) { results.push({ epic, ok: false, error: "Finns inte i bevakningslistan — inga påhittade EPICs" }); continue; }
      // F1: strategin följer med bara när modellen uttryckligen anger den; servern tar bara med kända id:n.
      const strategyId = typeof input.strategy_id === "string" && input.strategy_id ? input.strategy_id : undefined;
      const r = await deps.createPending({ symbol: epic, side, stakePct: pct, source: "chat", reason: input.reason ? String(input.reason) : "Från chatten", ...(strategyId ? { strategyId } : {}) }, broker);
      results.push(r.ok ? { epic, ok: true, queued: r.pendingOrder?.id, stake: r.pendingOrder?.stakeAmount, currency: r.pendingOrder?.currency } : { epic, ok: false, error: r.error });
    }
    return { ok: true, executed: false, results, message: "Inga ordrar är lagda än. De väntar på Mikes godkännande under Väntande ordrar." };
  }
  return { ok: false, error: `Okänt verktyg ${name}` };
}

export async function igChat(
  message: string, history: Array<{ role: "user" | "assistant"; text: string }>, broker: IgBroker, deps: IgChatDeps,
): Promise<{ ok: true; reply: string; toolCall?: string; executed: Record<string, unknown> | null } | { ok: false; error: string }> {
  const watch = (deps.watchlist ?? (() => igMarketData.watchlistDetailed(broker.env)))();
  let acc: Awaited<ReturnType<IgBroker["getAccount"]>> | null = null;
  try { acc = await broker.getAccount(); } catch { acc = null; }
  const envLabel = broker.env === "live" ? "IG Live — RIKTIGA PENGAR" : "IG Demo — låtsaspengar";
  const system = `Du är Hanna — Mikes AI-trading-agent. Svenska, konkret och mänskligt (ADHD-vänligt).

Konto (${envLabel}): ${acc ? `saldo ${acc.balance ?? "okänt"} ${acc.currency}, tillgängligt ${acc.available ?? "okänt"} ${acc.currency}` : "kunde inte läsas just nu"}.
Orderläge: ${broker.executionEnabled() ? "på (godkända ordrar skickas till IG)" : "AVSTÄNGT — inget skickas till IG ens efter godkännande"}.
Bevakningslista (IG EPIC → namn): ${watch.map((w) => `${w.epic} = ${w.name ?? "namn saknas"}`).join("; ") || "tom"}.

Regler:
- Använd queue_ig_orders för köp (lång) eller sälj (kort). Det blir FÖRSLAG som Mike godkänner. Säg aldrig att en order är lagd.
- Använd bara EPICs ur bevakningslistan. Hitta aldrig på EPICs.
- Insats anges i % av saldot (0.1–3 %), pengar i kontovalutan ${acc?.currency ?? ""}.
- "Stäng allt" → close_all_positions. Status → get_account_status.
- Vill Mike bara prata → svara utan verktyg.
- Påstå aldrig att du läst en länk; länkar hämtas inte.${deps.contextPrompt ?? ""}`;

  const messages: Anthropic.MessageParam[] = history.slice(-8).map((h) => ({ role: h.role, content: h.text }));
  messages.push({ role: "user", content: message });
  let reply = await deps.llm.messages.create({ model: "claude-haiku-4-5", max_tokens: 1024, system, tools: TOOLS, messages });
  let replyText = "";
  const names: string[] = [];
  const executed: Record<string, unknown> = {};
  for (let turn = 0; turn < 5; turn++) {
    const uses = reply.content.filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    replyText = (reply.content.filter((b) => b.type === "text") as Anthropic.TextBlock[]).map((b) => b.text).join("");
    if (!uses.length) break;
    const results = [];
    for (const tu of uses) {
      names.push(tu.name);
      const r = await executeIgChatTool(tu.name, tu.input as Record<string, unknown>, broker, deps).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      executed[tu.id] = r;
      results.push({ type: "tool_result" as const, tool_use_id: tu.id, content: JSON.stringify(r) });
    }
    messages.push({ role: "assistant", content: reply.content });
    messages.push({ role: "user", content: results });
    reply = await deps.llm.messages.create({ model: "claude-haiku-4-5", max_tokens: 1024, system, tools: TOOLS, messages });
  }
  return { ok: true, reply: replyText, toolCall: names.length ? names.join(",") : undefined, executed: names.length ? executed : null };
}
