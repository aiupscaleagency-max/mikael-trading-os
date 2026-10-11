// ═══════════════════════════════════════════════════════════════════════════
//  Hannas konkreta tips per instrument (Mike 2026-10-11): "vilka ska jag köra och hur".
//
//  Hanna (Head Trader) avslutar sitt svar med TIPS_JSON: en rad per analyserat
//  instrument, även när helhetsbeslutet är HOLD: rang (1..N), KÖP/SÄLJ/AVVAKTA,
//  varför (en rad), entry, TP, SL, föreslagen storlek (insats-% inom risktrappan),
//  horisont (1/5/15/30 min) och säkerhet. Här tolkas och kontrolleras blocket.
//  Ett tips är aldrig en order: ordrar skapas bara via place_order/Godkänn och
//  prissätts av IG.
// ═══════════════════════════════════════════════════════════════════════════

export type TipAction = "buy" | "sell" | "hold";
export type TipConfidence = "low" | "medium" | "high";
export interface AgentTip {
  epic: string;
  /** 1 = bäst i analysen */
  rank: number;
  action: TipAction;
  why: string;
  entry: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  /** Insats i % av saldot (marginal), begränsad till nuvarande insats-steg. null för AVVAKTA. */
  sizePct: number | null;
  sizeText: string | null;
  horizonMin: number;
  confidence: TipConfidence;
  /** Förklaring när nivåer togs bort eller instrumentet saknade tips */
  note: string | null;
}

export const TIP_HORIZONS = [1, 5, 15, 30];
export const TIPS_MARKER = "TIPS_JSON";

/** Prompt-tillägg till Hanna (additivt; modell och provider ändras inte). */
export function tipsPromptBlock(): string {
  return `

═══ TIPS PER INSTRUMENT (KRAV, även vid HOLD) ═══
Mike vill veta VILKA instrument han ska köra och HUR. Efter Rule of 3 avslutar du ALLTID med raden ${TIPS_MARKER}: följd av
en JSON-array med ETT objekt per analyserat instrument (alla, även de du avstår), rangordnade bäst först:
${TIPS_MARKER}:
[{"epic":"CS.D.XXXUSD.CFD.IP","rank":1,"action":"KÖP","why":"en kort rad","entry":0,"tp":0,"sl":0,"sizePct":1,"horizonMin":5,"confidence":"medel"}]
Regler:
- action: KÖP, SÄLJ eller AVVAKTA. rank 1..N utan luckor (1 = bästa möjligheten just nu).
- entry/tp/sl i instrumentets IG-pris; utgå från IG-livepriset (senastePrisIgLive / ticker) även när indikatorerna kommer från Tiingo.
  KÖP: sl < entry < tp. SÄLJ: tp < entry < sl. AVVAKTA: ange nivån du bevakar som entry och vad som skulle ändra beslutet i why.
- sizePct: insats i % av saldot, högst nuvarande insats-steg (se INSATS). horizonMin: 1, 5, 15 eller 30.
- confidence: låg, medel eller hög. Håll varje objekt kort. Ett tips är INTE en order: order bara via place_order enligt reglerna ovan.`;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(",", ".").replace(/[^0-9.+-eE]/g, "")) : v;
  return finite(n) && n > 0 ? n : null;
};
const ACTION: Record<string, TipAction> = {
  "köp": "buy", "kop": "buy", buy: "buy", long: "buy", "lång": "buy",
  "sälj": "sell", "salj": "sell", sell: "sell", short: "sell", kort: "sell",
  avvakta: "hold", "avstå": "hold", hold: "hold", wait: "hold", vänta: "hold",
};
const CONF: Record<string, TipConfidence> = { "låg": "low", low: "low", medel: "medium", medium: "medium", "hög": "high", high: "high" };
const CONF_SCORE: Record<TipConfidence, number> = { low: 1, medium: 2, high: 3 };

/** Hittar JSON-arrayen efter TIPS_JSON (strängmedveten parentesmatchning). null = inget block. */
function findTipsBlock(text: string): { json: string; start: number } | null {
  const at = text.lastIndexOf(TIPS_MARKER);
  if (at < 0) return null;
  const from = text.indexOf("[", at);
  const obj = text.indexOf("{", at);
  const open = from < 0 ? obj : obj < 0 ? from : Math.min(from, obj);
  if (open < 0) return null;
  const close = text[open] === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === text[open]) depth++;
    else if (c === close && --depth === 0) return { json: text.slice(open, i + 1), start: at };
  }
  return null;
}

function nearestHorizon(v: unknown, fallback: number): number {
  const n = num(v);
  if (n === null) return TIP_HORIZONS.reduce((a, b) => Math.abs(b - fallback) < Math.abs(a - fallback) ? b : a);
  return TIP_HORIZONS.reduce((a, b) => Math.abs(b - n) < Math.abs(a - n) ? b : a);
}

/** Sorteringsnyckel över flera omgångar: handlingsbara först, sedan säkerhet, sedan Hannas rang. */
export function tipScore(t: Pick<AgentTip, "action" | "confidence" | "rank">): number {
  return (t.action === "hold" ? 0 : 1000) + CONF_SCORE[t.confidence] * 100 - Math.min(99, t.rank);
}
export function sortTips<T extends Pick<AgentTip, "action" | "confidence" | "rank">>(list: T[]): T[] {
  return [...list].sort((a, b) => tipScore(b) - tipScore(a));
}

/**
 * Tolkar Hannas TIPS_JSON. Varje analyserat instrument får exakt ett tips (saknas det: AVVAKTA med förklaring).
 * Nivåer som inte är logiska för riktningen tas bort (inga gissade nivåer). Storleken begränsas till insats-steget.
 */
export function parseHeadTips(text: string, symbols: string[], opts: { maxStakePct: number; stakeAmount?: number | null; currency?: string | null; defaultHorizonMin?: number }): { tips: AgentTip[]; cleanedText: string; found: boolean } {
  const block = findTipsBlock(String(text ?? ""));
  let rows: unknown[] = [];
  if (block) {
    try {
      const parsed = JSON.parse(block.json);
      rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { tips?: unknown })?.tips) ? (parsed as { tips: unknown[] }).tips : [];
    } catch { rows = []; }
  }
  const cleanedText = block ? String(text).slice(0, block.start).replace(/[`\s]+$/, "").trim() : String(text ?? "").trim();
  const wanted = [...new Set(symbols.filter((s) => typeof s === "string" && s))];
  const maxPct = Math.max(0.1, opts.maxStakePct || 1);
  const defH = opts.defaultHorizonMin ?? 5;
  const seen = new Set<string>();
  const tips: AgentTip[] = [];
  for (const r of rows) {
    const o = (r ?? {}) as Record<string, unknown>;
    const epic = String(o.epic ?? o.symbol ?? "").trim();
    if (!epic || seen.has(epic) || (wanted.length && !wanted.includes(epic))) continue;
    seen.add(epic);
    const action = ACTION[String(o.action ?? o.side ?? "").trim().toLowerCase()] ?? "hold";
    let entry = num(o.entry), tp = num(o.tp ?? o.takeProfit), sl = num(o.sl ?? o.stopLoss);
    let note: string | null = null;
    const okBuy = entry !== null && tp !== null && sl !== null && sl < entry && entry < tp;
    const okSell = entry !== null && tp !== null && sl !== null && tp < entry && entry < sl;
    if ((action === "buy" && !okBuy) || (action === "sell" && !okSell)) {
      if (entry !== null || tp !== null || sl !== null) note = "Nivåerna var inte logiska för riktningen och visas inte (IG räknar standard-SL/TP vid ordern)";
      tp = null; sl = null; // entry behålls som riktpris
    }
    if (action === "hold" && !(okBuy || okSell)) { tp = null; sl = null; }
    const rawPct = num(o.sizePct ?? o.size);
    const sizePct = action === "hold" ? null : +Math.min(maxPct, Math.max(0.1, rawPct ?? maxPct)).toFixed(1);
    const amount = sizePct !== null && finite(opts.stakeAmount) && opts.stakeAmount > 0 ? opts.stakeAmount * sizePct / maxPct : null;
    tips.push({
      epic, rank: Math.max(1, Math.round(num(o.rank) ?? 99)), action,
      why: String(o.why ?? o.reason ?? o.reasoning ?? "").replace(/\s+/g, " ").trim().slice(0, 240) || (action === "hold" ? "Avvaktar" : "–"),
      entry, takeProfit: tp, stopLoss: sl, sizePct,
      sizeText: sizePct === null ? null : `${sizePct} % av saldot${amount !== null ? ` ≈ ${amount.toFixed(0)} ${opts.currency ?? ""}`.trimEnd() : ""}`,
      horizonMin: nearestHorizon(o.horizonMin ?? o.horizon, defH),
      confidence: CONF[String(o.confidence ?? "").trim().toLowerCase()] ?? "low",
      note,
    });
  }
  // Hannas ordning först (rang, sedan som hon skrev), därefter instrument hon inte tog med
  tips.sort((a, b) => a.rank - b.rank);
  for (const epic of wanted) if (!seen.has(epic)) tips.push({ epic, rank: 99, action: "hold", why: "Hanna gav inget tips för instrumentet", entry: null, takeProfit: null, stopLoss: null, sizePct: null, sizeText: null, horizonMin: nearestHorizon(null, defH), confidence: "low", note: block ? "saknades i Hannas tipslista" : "Hanna skickade ingen tipslista" });
  tips.forEach((t, i) => { t.rank = i + 1; });
  return { tips, cleanedText, found: !!block && rows.length > 0 };
}
