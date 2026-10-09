// ═══════════════════════════════════════════════════════════════════════════
// "Marknaden just nu" — från IG (aktiv miljö: IG Demo eller IG Live).
//
// Källa: IG:s marknadskatalog för kontot (Forex + Krypto, Codex igMarketDirectory)
// med IG:s egna fält: bid/offer, percentageChange (IG:s sessionsförändring),
// high/low (dagens spann). IG har ingen omsättning/volym för CFD:er, så
// "Mest handlade" saknas och visas som saknas — inget hittas på.
// "Mest rörelse" på vald tid (1/5/15/30 min) räknas BARA från stängda IG-ljus
// som servern redan har (bevakningslistan); finns de inte blir värdet null.
// Inga extra historikanrop görs här (IG:s historikkvot sparas till diagram/signaler).
// ═══════════════════════════════════════════════════════════════════════════

import { getIgMarketDirectory } from "../integrations/igMarketDirectory.js";
import { igMarketData } from "./igMarketData.js";
import type { IgEnvironment } from "../integrations/igConnection.js";

export interface Mover {
  base: string;            // IG-instrumentets namn
  epic: string;
  category: "forex" | "crypto";
  price: number | null;    // mitt (bid+offer)/2
  change24hPct: number | null;  // IG percentageChange (sessionsförändring, inte rullande 24h)
  range24hPct: number | null;   // (high−low)/low i dag enligt IG
  turnover24hUsd: null;         // IG redovisar ingen omsättning för CFD
  spread: number | null;
  avgMovePct?: number | null;   // snitt (hög−låg)/stäng per stängt ljus på vald tid
  afterFeePct?: null;           // IG tar spread i stället för fast avgift: se spread
  interval?: string;
  marketStatus: string | null;
}

export const CATEGORIES = {
  move: "Mest rörelse",
  gainers: "Mest upp (IG idag)",
  losers: "Mest ner (IG idag)",
  trending: "Trendar",
  volume: "Mest handlade",
  cheapest: "Billigast",
  priciest: "Dyrast",
} as const;
export type Category = keyof typeof CATEGORIES;

const UNAVAILABLE: Partial<Record<Category, string>> = {
  volume: "IG redovisar ingen handelsvolym för CFD:er. Saknas.",
};

type Dir = (env: IgEnvironment, cat: "forex" | "crypto") => Promise<{ markets: any[]; status?: string; note?: string; error?: string | null }>;

async function allMarkets(env: IgEnvironment, dir: Dir): Promise<{ rows: Mover[]; note: string | null }> {
  const notes: string[] = [];
  const rows: Mover[] = [];
  for (const cat of ["forex", "crypto"] as const) {
    try {
      const d = await dir(env, cat);
      if (d.status === "partial") notes.push(`${cat === "forex" ? "Forex" : "Krypto"}: katalogen är inte komplett än`);
      for (const m of d.markets) {
        const bid = typeof m.bid === "number" ? m.bid : null, offer = typeof m.offer === "number" ? m.offer : null;
        const hi = typeof m.high === "number" ? m.high : null, lo = typeof m.low === "number" ? m.low : null;
        rows.push({
          base: m.name ?? m.epic, epic: m.epic, category: cat,
          price: bid !== null && offer !== null ? (bid + offer) / 2 : null,
          change24hPct: typeof m.changePercent === "number" ? m.changePercent : typeof m.percentageChange === "number" ? m.percentageChange : null,
          range24hPct: hi !== null && lo !== null && lo > 0 ? ((hi - lo) / lo) * 100 : null,
          turnover24hUsd: null, spread: bid !== null && offer !== null && offer >= bid ? offer - bid : null,
          marketStatus: m.marketStatus ?? null,
        });
      }
    } catch (err) { notes.push(`${cat === "forex" ? "Forex" : "Krypto"}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { rows, note: notes.length ? notes.join(" · ") : null };
}

function avgMove(epic: string, interval: string, env: IgEnvironment): number | null {
  const bars = igMarketData.closed(epic, interval, env).slice(-30);
  if (bars.length < 10) return null;
  return bars.reduce((s, b) => s + (b.close > 0 ? ((b.high - b.low) / b.close) * 100 : 0), 0) / bars.length;
}

const nullsLast = (f: (m: Mover) => number | null, dir: 1 | -1) => (a: Mover, b: Mover) => {
  const x = f(a), y = f(b);
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return dir * (x - y);
};

export async function getCategory(cat: Category, intervalMin: number, limit = 10, deps: { dir?: Dir; env?: IgEnvironment } = {}): Promise<Mover[] & { note?: string | null }> {
  const env = deps.env ?? igMarketData.getActiveEnv();
  const iv = [1, 5, 15, 30].includes(intervalMin) ? `${intervalMin}m` : "5m";
  const result = [] as unknown as Mover[] & { note?: string | null };
  if (UNAVAILABLE[cat]) { result.note = UNAVAILABLE[cat]!; return result; }
  const { rows, note } = await allMarkets(env, deps.dir ?? (getIgMarketDirectory as Dir));
  result.note = note;
  let list: Mover[];
  if (cat === "move") {
    list = rows.map((m) => ({ ...m, avgMovePct: avgMove(m.epic, iv, env), afterFeePct: null, interval: String(intervalMin) }))
      .sort(nullsLast((m) => m.avgMovePct ?? m.range24hPct, -1));
    if (!list.some((m) => m.avgMovePct != null)) result.note = [note, `Rörelse per ${intervalMin}-minutersljus finns bara för instrument i bevakningslistan; sorterat på IG:s dagsspann (hög−låg).`].filter(Boolean).join(" · ");
  } else if (cat === "gainers") list = rows.filter((m) => m.change24hPct !== null).sort(nullsLast((m) => m.change24hPct, -1));
  else if (cat === "losers") list = rows.filter((m) => m.change24hPct !== null).sort(nullsLast((m) => m.change24hPct, 1));
  else if (cat === "trending") list = rows.filter((m) => (m.change24hPct ?? 0) > 0).sort(nullsLast((m) => m.change24hPct, -1));
  else if (cat === "cheapest") list = rows.sort(nullsLast((m) => m.price, 1));
  else list = rows.sort(nullsLast((m) => m.price, -1));
  result.push(...list.slice(0, limit));
  // Miljön bytt medan katalogen lästes: lämna inget svar med fel miljös data
  if (!deps.env && env !== igMarketData.getActiveEnv()) { result.length = 0; result.note = "Kontot byttes under hämtningen; uppdatera igen."; }
  return result;
}

export async function getMovers(intervalMin: number, limit = 10): Promise<Mover[]> {
  return getCategory("move", intervalMin, limit);
}
