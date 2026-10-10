// ═══════════════════════════════════════════════════════════════════════════
//  Tiingo-intradag för minidiagrammen på Alla par — ENDAST VISNING.
//
//  Används bara när IG:s historikkvot är slut (eller IG saknar ljus) för en EPIC.
//  Tiingos priser är INTE IG:s priser: de får aldrig nå signalmotorn, strategierna,
//  agenterna eller orderprissättningen. Modulen importeras därför bara av igSparklines.ts
//  (kontrolleras i testerna) och skriver aldrig in något i igMarketData.
//
//  Endpoints (verifierade mot Tiingos dokumentation, 2026-10-10):
//   - Krypto: GET https://api.tiingo.com/tiingo/crypto/prices?tickers=btcusd,ethusd&startDate=YYYY-MM-DD&resampleFreq=5min
//             → [{ ticker, baseCurrency, quoteCurrency, priceData: [{ date, open, high, low, close, ... }] }]
//             Flera tickers kommaseparerade i ETT anrop (dokumenterat).
//   - Forex:  GET https://api.tiingo.com/tiingo/fx/<ticker>/prices?startDate=YYYY-MM-DD&resampleFreq=5min
//             → [{ date, ticker, open, high, low, close }]  (en ticker per anrop; bara /fx/top tar tickers=)
//  Nyckeln skickas som header (Authorization: Token …), aldrig i URL:en, så den inte hamnar i loggar/fel.
//  Nyckeln läses ENDAST från process.env.TIINGO_API_KEY.
// ═══════════════════════════════════════════════════════════════════════════

export const TIINGO_SPARK_LABEL = "Tiingo-diagram (ej IG-pris)";
export const TIINGO_TTL_MS = 45 * 60_000;        // lyckad hämtning återanvänds i 45 min per ticker (delas Demo/Live: inte kontodata)
export const TIINGO_FAIL_TTL_MS = 15 * 60_000;   // fel/saknat par: samma ticker provas inte om på 15 min
export const TIINGO_MAX_PER_HOUR = 30;           // gratisnivån tillåter ca 50/timme; vi tar högst 30
export const TIINGO_COOLDOWN_MS = 10 * 60_000;   // efter HTTP 429: paus
export const TIINGO_POINTS = 72;                 // 72 × 5 min = 6 timmar, samma som IG-minidiagrammen
export const TIINGO_BATCH_MAX = 20;              // högst så många kryptotickers per anrop
export const TIINGO_NO_KEY = "Tiingo-nyckel saknas";

export type TiingoKind = "crypto" | "fx";
export interface TiingoTicker { ticker: string; kind: TiingoKind }
export interface TiingoSeries {
  ticker: string | null; closes: number[]; from: number | null; to: number | null; at: number;
  /** Förklaring när inget diagram finns (null = diagram finns) */
  note: string | null; cached?: boolean;
}

// Kryptonamn i IG:s katalog → Tiingos bassymbol. Exakt namnmatchning (inte prefix),
// så "Bitcoin Cash" aldrig blir "Bitcoin".
const CRYPTO_BY_NAME: Record<string, string> = {
  "bitcoin": "btc", "bitcoin cash": "bch", "ether": "eth", "ethereum": "eth", "cardano": "ada", "litecoin": "ltc",
  "ripple": "xrp", "xrp": "xrp", "solana": "sol", "stellar": "xlm", "dogecoin": "doge", "polkadot": "dot",
  "chainlink": "link", "uniswap": "uni", "polygon": "pol", "toncoin": "ton", "tron": "trx", "cosmos": "atom",
  "near": "near", "sui": "sui", "arbitrum": "arb", "shiba inu": "shib", "aave": "aave", "avalanche": "avax",
};
// IG:s EPIC-förkortningar för krypto (när namnet inte är känt) → Tiingos bassymbol
const CRYPTO_BY_EPIC: Record<string, string> = {
  BITCOIN: "btc", BCH: "bch", ETH: "eth", ADA: "ada", LTC: "ltc", XRP: "xrp", SOL: "sol", XLM: "xlm", DOG: "doge",
  DOT: "dot", LNK: "link", UNI: "uni", POL: "pol", TON: "ton", TRX: "trx", ATOM: "atom", NEA: "near", SUI: "sui",
  ARB: "arb", SHI: "shib", AAVE: "aave", AVX: "avax", XBT: "btc",
};
const FIAT = new Set(["AUD", "CAD", "CHF", "CNH", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "ILS", "INR", "JPY", "KRW", "MXN", "NOK", "NZD", "PHP", "PLN", "SEK", "SGD", "TRY", "TWD", "USD", "ZAR"]);

/** Kvotvaluta ur IG:s kontraktsangivelse: "(E1)" = euro, "($1)" = dollar, "(£1)" = pund. */
function quoteFromContract(name: string): string {
  const m = /\(([^)]*)\)/.exec(name);
  const c = (m?.[1] ?? "").trim();
  if (/^E\d/.test(c) || c.startsWith("€")) return "eur";
  if (c.startsWith("£")) return "gbp";
  return "usd";
}

/**
 * EPIC + instrumentnamn → Tiingo-ticker. null = ingen säker motsvarighet (t.ex. index),
 * och då visas IG:s vanliga kvottext i stället för ett gissat diagram.
 */
export function tiingoTickerFor(epic: string, name?: string | null): TiingoTicker | null {
  const raw = String(name ?? "").trim();
  if (raw) {
    if (/index/i.test(raw)) return null;
    const plain = raw.replace(/\([^)]*\)/g, "").replace(/\bmini\b/ig, "").trim().toLowerCase();
    const [basePart, quotePart] = plain.split("/").map((s) => s.trim());
    const base = CRYPTO_BY_NAME[basePart ?? ""];
    if (base) {
      if (quotePart) {
        const q = CRYPTO_BY_NAME[quotePart] ?? (FIAT.has(quotePart.toUpperCase()) ? quotePart : null);
        return q ? { ticker: base + q, kind: "crypto" } : null;
      }
      return { ticker: base + quoteFromContract(raw), kind: "crypto" };
    }
    // Forex: "EUR/USD Mini", "EMFX USD/INR ($1 Mini Contract)"
    const fx = /\b([A-Z]{3})\/([A-Z]{3})\b/.exec(raw);
    if (fx && FIAT.has(fx[1]!) && FIAT.has(fx[2]!)) return { ticker: (fx[1]! + fx[2]!).toLowerCase(), kind: "fx" };
  }
  // Inget användbart namn: försök med EPIC:ens instrumentdel (CS.D.EURUSD.MINI.IP, CS.D.ETHUSD.CFD.IP, CS.D.BITCOIN.CEE.IP)
  const seg = /^[A-Z]{2}\.D\.([A-Z0-9]+)\./.exec(epic)?.[1] ?? "";
  if (CRYPTO_BY_EPIC[seg]) return { ticker: CRYPTO_BY_EPIC[seg] + "usd", kind: "crypto" };
  const m = /^([A-Z]+?)(USD|EUR|XBT)$/.exec(seg);
  if (m && CRYPTO_BY_EPIC[m[1]!] && !FIAT.has(m[1]!)) return { ticker: CRYPTO_BY_EPIC[m[1]!] + (m[2] === "XBT" ? "btc" : m[2]!.toLowerCase()), kind: "crypto" };
  if (/^[A-Z]{6}$/.test(seg) && FIAT.has(seg.slice(0, 3)) && FIAT.has(seg.slice(3))) return { ticker: seg.toLowerCase(), kind: "fx" };
  return null;
}

type FetchFn = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Giltiga 5-minutersstängningar, sorterade, de senaste TIINGO_POINTS. Felaktiga rader hoppas över (fylls aldrig ut). */
function toSeries(ticker: string, rows: unknown, at: number): TiingoSeries {
  const bars: Array<{ t: number; c: number }> = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = typeof r?.date === "string" ? Date.parse(r.date) : NaN, c = Number(r?.close);
    if (Number.isFinite(t) && Number.isFinite(c) && c > 0) bars.push({ t, c });
  }
  bars.sort((a, b) => a.t - b.t);
  const use = bars.slice(-TIINGO_POINTS);
  if (use.length < 2) return { ticker, closes: [], from: null, to: null, at, note: "Tiingo saknar intradagsdata för paret" };
  return { ticker, closes: use.map((b) => b.c), from: use[0]!.t, to: use[use.length - 1]!.t, at, note: null };
}

export function createTiingoIntraday(deps: {
  fetch?: FetchFn;
  key?: () => string | null | undefined;
  now?: () => number;
  /** Väntetid (ms) för att samla flera kryptotickers i ett anrop */
  batchMs?: number;
} = {}) {
  const doFetch: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchFn>);
  const key = deps.key ?? (() => process.env.TIINGO_API_KEY?.trim() || null);
  const now = deps.now ?? Date.now;
  const batchMs = deps.batchMs ?? 150;
  const cache = new Map<string, TiingoSeries>();
  const calls: number[] = [];
  let cooldownUntil = 0;
  const stats = { requests: 0 };
  // Väntande kryptotickers som samlas till ett gemensamt anrop
  let queue = new Map<string, Array<(s: TiingoSeries) => void>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const inflight = new Map<string, Promise<TiingoSeries>>();

  function fresh(t: string): TiingoSeries | null {
    const hit = cache.get(t);
    if (!hit) return null;
    const ttl = hit.closes.length ? TIINGO_TTL_MS : TIINGO_FAIL_TTL_MS;
    return now() - hit.at < ttl ? { ...hit, cached: true } : null;
  }
  /** null = får anropa Tiingo nu; annars förklaringen (inget anrop görs). */
  function capReason(): string | null {
    if (now() < cooldownUntil) return "Tiingo pausat efter anropsbegränsning";
    while (calls.length && now() - calls[0]! >= 3_600_000) calls.shift();
    if (calls.length >= TIINGO_MAX_PER_HOUR) return `Tiingo-gräns nådd (${TIINGO_MAX_PER_HOUR} anrop/timme)`;
    return null;
  }
  function day(msAgo: number): string { return new Date(now() - msAgo).toISOString().slice(0, 10); }
  async function request(url: string, token: string): Promise<{ data: unknown; note: string | null }> {
    calls.push(now()); stats.requests++;
    try {
      const r = await doFetch(url, { headers: { Authorization: `Token ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) {
        if (r.status === 429) cooldownUntil = now() + TIINGO_COOLDOWN_MS;
        return { data: null, note: r.status === 401 || r.status === 403 ? "Tiingo nekade nyckeln" : r.status === 429 ? "Tiingo begränsade antal anrop" : `Tiingo svarade HTTP ${r.status}` };
      }
      return { data: await r.json(), note: null };
    } catch { return { data: null, note: "Tiingo kunde inte nås" }; }
  }
  function settle(t: string, s: TiingoSeries, permanent: boolean): TiingoSeries {
    // Tillfälliga hinder (gräns/paus) cachas inte; riktiga svar och fel cachas
    if (permanent) cache.set(t, s);
    return s;
  }

  async function flushCrypto(): Promise<void> {
    timer = null;
    const batch = queue; queue = new Map();
    const tickers = [...batch.keys()];
    for (let i = 0; i < tickers.length; i += TIINGO_BATCH_MAX) {
      const part = tickers.slice(i, i + TIINGO_BATCH_MAX);
      const resolve = (t: string, s: TiingoSeries) => { for (const fn of batch.get(t) ?? []) fn(s); };
      const token = key();
      const why = token ? capReason() : TIINGO_NO_KEY;
      if (why || !token) { for (const t of part) resolve(t, { ticker: t, closes: [], from: null, to: null, at: now(), note: why }); continue; }
      const qs = new URLSearchParams({ tickers: part.join(","), startDate: day(86_400_000), resampleFreq: "5min" }).toString();
      const { data, note } = await request(`https://api.tiingo.com/tiingo/crypto/prices?${qs}`, token);
      for (const t of part) {
        if (note) { resolve(t, settle(t, { ticker: t, closes: [], from: null, to: null, at: now(), note }, !/begränsade/.test(note))); continue; }
        const entry = Array.isArray(data) ? data.find((d: any) => d?.ticker === t) : null;
        resolve(t, settle(t, entry ? toSeries(t, (entry as any).priceData, now()) : { ticker: t, closes: [], from: null, to: null, at: now(), note: "Tiingo saknar paret" }, true));
      }
    }
  }

  async function fetchFx(t: string): Promise<TiingoSeries> {
    const token = key();
    const why = token ? capReason() : TIINGO_NO_KEY;
    if (why || !token) return { ticker: t, closes: [], from: null, to: null, at: now(), note: why };
    // 4 dygn bakåt: över en helg finns fredagens ljus kvar (forex stänger fre–sön)
    const qs = new URLSearchParams({ startDate: day(4 * 86_400_000), resampleFreq: "5min" }).toString();
    const { data, note } = await request(`https://api.tiingo.com/tiingo/fx/${encodeURIComponent(t)}/prices?${qs}`, token);
    if (note) return settle(t, { ticker: t, closes: [], from: null, to: null, at: now(), note }, !/begränsade/.test(note));
    return settle(t, toSeries(t, data, now()), true);
  }

  /** Minidiagram från Tiingo för en EPIC. cacheOnly = bara cachen, inget anrop. */
  async function get(epic: string, name: string | null | undefined, opts: { cacheOnly?: boolean } = {}): Promise<TiingoSeries> {
    const m = tiingoTickerFor(epic, name);
    if (!m) return { ticker: null, closes: [], from: null, to: null, at: now(), note: "ingen Tiingo-motsvarighet" };
    const hit = fresh(m.ticker);
    if (hit) return hit;
    if (opts.cacheOnly) return { ticker: m.ticker, closes: [], from: null, to: null, at: now(), note: "Tiingo-diagram ej hämtat" };
    if (!key()) return { ticker: m.ticker, closes: [], from: null, to: null, at: now(), note: TIINGO_NO_KEY };
    const running = inflight.get(m.ticker);
    if (running) return running;
    const job = m.kind === "fx" ? fetchFx(m.ticker) : new Promise<TiingoSeries>((res) => {
      const list = queue.get(m.ticker) ?? [];
      list.push(res); queue.set(m.ticker, list);
      if (!timer) timer = setTimeout(() => { void flushCrypto(); }, batchMs);
    });
    inflight.set(m.ticker, job);
    try { return await job; } finally { inflight.delete(m.ticker); }
  }
  return { get, stats: () => ({ ...stats, callsLastHour: calls.filter((t) => now() - t < 3_600_000).length }) };
}

// En gemensam instans för Demo och Live (Tiingo är inte IG-kontodata)
export const tiingoIntraday = createTiingoIntraday();
