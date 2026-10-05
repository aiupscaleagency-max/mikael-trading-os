// ═══════════════════════════════════════════════════════════════════════════
// Mest rörelse just nu (Mike 2026-10-04): små vinster på BTC/ETH, så hitta
// mynten som rör sig mest på den valda tiden (1/5/15/30 min).
//
// 1. Alla spot-par på Bybit EU som går att handla i USDC (dit ordrarna går).
// 2. De 25 med störst 24h-spann (hög−låg) och tillräcklig omsättning.
// 3. För dem: snittrörelse per ljus på vald tid (senaste 30 ljusen, USDT-paret
//    på Bybit för mer data). Det är ungefär hur mycket en trade kan röra sig.
// 4. "Efter avgift" = snittrörelse − 0,5 % (0,25 % in + 0,25 % ut).
// Bara publik marknadsdata, inga nycklar. Cache 60 s.
// ═══════════════════════════════════════════════════════════════════════════

import { log } from "../logger.js";

const EU = "https://api.bybit.eu";
import { getTradeFeeRate } from "../risk/tradeSizing.js";
const FEE_ROUND_TRIP_PCT = (1 - (1 - getTradeFeeRate()) / (1 + getTradeFeeRate())) * 100;
const MIN_TURNOVER_USD = Number(process.env.MOVERS_MIN_TURNOVER_USD || 250_000);
const STABLE = new Set(["USDC", "USDT", "USD", "DAI", "FDUSD", "BUSD", "TUSD", "PYUSD", "EUR", "USDE", "EURI"]);

export interface Mover {
  base: string;
  price: number;
  change24hPct: number;
  range24hPct: number;
  turnover24hUsd: number;
  avgMovePct: number;     // snitt (hög−låg)/stäng per ljus på vald tid
  afterFeePct: number;    // avgMovePct − 0,5
  interval: string;       // "1" | "5" | "15" | "30"
}

interface Ticker { symbol: string; lastPrice: string; highPrice24h: string; lowPrice24h: string; price24hPcnt: string; turnover24h: string }

const cache = new Map<string, { at: number; list: Mover[] }>();

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const d = (await r.json()) as { retCode?: number; result?: T };
    return d.retCode === 0 && d.result ? d.result : null;
  } catch { return null; }
}

async function avgMove(base: string, interval: string): Promise<number | null> {
  for (const [host, pair] of [[EU, `${base}USDC`]] as const) {
    const res = await getJson<{ list?: string[][] }>(`${host}/v5/market/kline?category=spot&symbol=${pair}&interval=${interval}&limit=31`);
    const rows = (res?.list ?? []).slice(1); // första raden är det pågående ljuset
    if (rows.length < 10) continue;
    const moves = rows.map((k) => { const h = Number(k[2]), l = Number(k[3]), c = Number(k[4]); return c > 0 ? ((h - l) / c) * 100 : 0; });
    return moves.reduce((s, x) => s + x, 0) / moves.length;
  }
  return null;
}

interface Base { base: string; price: number; change24hPct: number; range24hPct: number; turnover24hUsd: number }

let tickCache: { at: number; list: Base[] } | null = null;

/** Alla USDC-par på Bybit EU (dit ordrarna går), med USDT-parets siffror när de finns. */
async function tradeable(): Promise<Base[]> {
  if (tickCache && Date.now() - tickCache.at < 30_000) return tickCache.list;
  const eu = await getJson<{ list?: Ticker[] }>(`${EU}/v5/market/tickers?category=spot`);
  if (!eu?.list) throw new Error("Bybit EU svarar inte just nu");
  const list = eu.list
    .filter((t) => t.symbol.endsWith("USDC"))
    .map((t) => {
      const base = t.symbol.slice(0, -4);
      const g = t; // USDT-paret har mer handel och ärligare spann
      const hi = Number(g.highPrice24h), lo = Number(g.lowPrice24h);
      return {
        base,
        price: Number(g.lastPrice),
        change24hPct: Number(g.price24hPcnt) * 100,
        range24hPct: lo > 0 ? ((hi - lo) / lo) * 100 : 0,
        turnover24hUsd: Number(g.turnover24h),
      };
    })
    .filter((c) => !STABLE.has(c.base) && c.price > 0 && c.turnover24hUsd >= MIN_TURNOVER_USD);
  tickCache = { at: Date.now(), list };
  return list;
}

export async function getMovers(intervalMin: number, limit = 10): Promise<Mover[]> {
  const interval = [1, 5, 15, 30].includes(intervalMin) ? String(intervalMin) : "5";
  const hit = cache.get(interval);
  if (hit && Date.now() - hit.at < 60_000) return hit.list.slice(0, limit);

  const candidates = [...(await tradeable())].sort((a, b) => b.range24hPct - a.range24hPct).slice(0, 25);

  const out: Mover[] = [];
  await Promise.all(candidates.map(async (c) => {
    const m = await avgMove(c.base, interval);
    if (m === null) return;
    out.push({ ...c, avgMovePct: m, afterFeePct: m - FEE_ROUND_TRIP_PCT, interval });
  }));
  out.sort((a, b) => b.avgMovePct - a.avgMovePct);
  cache.set(interval, { at: Date.now(), list: out });
  log.info(`[rörelse] ${interval} min: ${out.slice(0, 3).map((m) => `${m.base} ${m.avgMovePct.toFixed(2)}%`).join(", ")}`);
  return out.slice(0, limit);
}

// Kategorier (Mike 2026-10-04): mest rörelse, mest upp, mest ner, trendar,
// mest handlade, billigast, dyrast. Allt utom "rörelse" räknas från tickers.
export const CATEGORIES = {
  move: "Mest rörelse",
  gainers: "Mest upp (24h)",
  losers: "Mest ner (24h)",
  trending: "Trendar",
  volume: "Mest handlade",
  cheapest: "Billigast",
  priciest: "Dyrast",
} as const;
export type Category = keyof typeof CATEGORIES;

export async function getCategory(cat: Category, intervalMin: number, limit = 10): Promise<Array<Base & Partial<Mover>>> {
  if (cat === "move") return getMovers(intervalMin, limit);
  const all = [...(await tradeable())];
  const sorters: Record<Exclude<Category, "move">, (a: Base, b: Base) => number> = {
    gainers: (a, b) => b.change24hPct - a.change24hPct,
    losers: (a, b) => a.change24hPct - b.change24hPct,
    // Trendar = stiger och handlas mycket: uppgång viktad med omsättning
    trending: (a, b) => b.change24hPct * Math.log10(b.turnover24hUsd) - a.change24hPct * Math.log10(a.turnover24hUsd),
    volume: (a, b) => b.turnover24hUsd - a.turnover24hUsd,
    cheapest: (a, b) => a.price - b.price,
    priciest: (a, b) => b.price - a.price,
  };
  const list = all.sort(sorters[cat]);
  return (cat === "trending" ? list.filter((x) => x.change24hPct > 0) : list).slice(0, limit);
}
