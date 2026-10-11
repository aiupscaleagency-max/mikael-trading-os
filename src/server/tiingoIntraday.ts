// ═══════════════════════════════════════════════════════════════════════════
//  Tiingo-intradag för minidiagrammen på Alla par — ENDAST VISNING.
//
//  Används bara när IG:s historikkvot är slut (eller IG saknar ljus) för en EPIC.
//  Tiingos priser är INTE IG:s priser: de får aldrig nå signalmotorn, strategierna,
//  huvuddiagrammet eller orderprissättningen. Modulen importeras därför bara av
//  igSparklines.ts (minidiagram) och igAgentData.ts (agenternas analys/research, märkt
//  "ej IG-pris"; ordrar prissätts alltid av IG). Kontrolleras i testerna. Skriver aldrig in
//  något i igMarketData.
//
//  Endpoints (verifierade mot Tiingos dokumentation, 2026-10-10):
//   - Krypto: GET https://api.tiingo.com/tiingo/crypto/prices?tickers=btcusd,ethusd&startDate=YYYY-MM-DD&resampleFreq=5min
//             → [{ ticker, baseCurrency, quoteCurrency, priceData: [{ date, open, high, low, close, ... }] }]
//             Flera tickers kommaseparerade i ETT anrop (dokumenterat).
//   - Forex:  GET https://api.tiingo.com/tiingo/fx/<ticker>/prices?startDate=YYYY-MM-DD&resampleFreq=5min
//             → [{ date, ticker, open, high, low, close }]  (en ticker per anrop; bara /fx/top tar tickers=)
//  Nyckeln skickas som header (Authorization: Token …), aldrig i URL:en, så den inte hamnar i loggar/fel.
//  Nyckeln läses som för dagshistoriken: TIINGO_API_KEY i .env, annars kursens keys.json (tiingoKey).
// ═══════════════════════════════════════════════════════════════════════════

import { tiingoKey } from "../data/tiingoHistory.js";
export const TIINGO_SPARK_LABEL = "Tiingo-diagram (ej IG-pris)";
export const TIINGO_TTL_MS = 45 * 60_000;        // lyckad hämtning återanvänds i 45 min per ticker (delas Demo/Live: inte kontodata)
export const TIINGO_FAIL_TTL_MS = 15 * 60_000;   // fel/saknat par: samma ticker provas inte om på 15 min
export const TIINGO_MAX_PER_HOUR = 30;           // gratisnivån tillåter ca 50/timme; vi tar högst 30
export const TIINGO_COOLDOWN_MS = 10 * 60_000;   // efter HTTP 429: paus
export const TIINGO_POINTS = 72;                 // 72 × 5 min = 6 timmar, samma som IG-minidiagrammen
// Tiingo tar högst 5 kryptotickers per anrop. Fler ger HTTP 400 för HELA anropet
// ("Error: A limit of 5 tickers may be requested at a time", verifierat mot Tiingo 2026-10-11).
// Det var orsaken till att slumpvisa par (Cosmos, Dogecoin, Litecoin, Near, Polkadot …) fick "HTTP 400".
export const TIINGO_BATCH_MAX = 5;               // högst så många kryptotickers per anrop
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
const FIAT = new Set(["AUD", "BRL", "CAD", "CHF", "CNH", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "JPY", "KRW", "MXN", "NOK", "NZD", "PHP", "PLN", "SEK", "SGD", "THB", "TRY", "TWD", "USD", "ZAR"]);

/** Kvotvaluta för PRISET ur IG:s kontraktsangivelse. IG:s krypto-kontrakt "(E1)"/"(E0.1)" och "(£1)" anger bara
 *  valutan per punkt (vinst/förlust i euro/pund); själva priset är samma USD-kurs som "($1)" (kontrollerat i drift
 *  2026-10-11: Bitcoin (E1) = Bitcoin ($1), Ether (E1) = Ether ($1)). Därför jämförs alltid mot USD-tickern. */
function quoteFromContract(_name: string): string {
  return "usd";
}

/**
 * EPIC + instrumentnamn → Tiingo-ticker. null = ingen säker motsvarighet (t.ex. index),
 * och då visas IG:s vanliga kvottext i stället för ett gissat diagram.
 */
export function tiingoTickerFor(epic: string, name?: string | null): TiingoTicker | null {
  const raw = String(name ?? "").trim();
  if (raw) {
    // Index och IG:s helgmarknader (Weekend EUR/USD m.fl., egen IG-prissättning) har ingen Tiingo-motsvarighet
    if (/index|weekend/i.test(raw)) return null;
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
  const parts = /^[A-Z]{2}\.D\.([A-Z0-9]+)\.([A-Z0-9]+)\./.exec(epic);
  const seg = parts?.[1] ?? "";
  // IG:s euro-kontrakt för krypto (CFE, CNE, CNEM = "(E1)"/"(E0.1)") har euro per punkt men prissätts i USD → USD-ticker
  if (CRYPTO_BY_EPIC[seg]) return { ticker: CRYPTO_BY_EPIC[seg] + "usd", kind: "crypto" }; // euro-kontrakt prissätts i USD (se quoteFromContract)
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
  const key = deps.key ?? tiingoKey;
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

// ═══════════════════════════════════════════════════════════════════════════
//  Agenternas research-reserv (Mike 2026-10-11): hela OHLC-ljus från Tiingo när IG
//  varken har ljus i minnet eller kan lämna historik (veckokvoten slut / läsgränsen nådd).
//  Bara analys: igAgentData.ts märker allt "källa: Tiingo (ej IG-pris)". Egen instans med
//  eget anropstak (TIINGO_AGENT_MAX_PER_HOUR, standard 20) så att minidiagrammens 30/h
//  och agenternas tillsammans håller sig inom Tiingos gratisnivå (ca 50/h).
//   - 1min-hämtningen räcker för 1m, 5m och 15m (slås ihop lokalt), 1hour för 1h/4h, 1day för 1d.
//   - Kryptotickers samlas i ETT anrop per upplösning (högst 20). Svarar Tiingo HTTP 400 på
//     ett samlat anrop provas tickers en och en, så att ett okänt par inte förgiftar resten.
//   - Bara stängda ljus. Felaktiga rader hoppas över (fylls aldrig ut).
//   - Kan Tiingo inte nås (tak, paus, fel) används äldre cache, märkt "cachad".
// ═══════════════════════════════════════════════════════════════════════════

export type TiingoFreq = "1min" | "1hour" | "1day";
export interface TiingoBar { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number }
export interface TiingoBarsResult {
  ticker: string | null; freq: TiingoFreq; bars: TiingoBar[]; at: number;
  /** Förklaring när inga ljus finns (null = ljus finns) */
  note: string | null;
  /** Svaret kom ur cachen; stale = äldre än den vanliga livslängden (Tiingo kunde inte nås nu) */
  cached?: boolean; stale?: boolean;
}
export const TIINGO_AGENT_LABEL = "Tiingo (ej IG-pris)";
export const TIINGO_FREQ_MS: Record<TiingoFreq, number> = { "1min": 60_000, "1hour": 3_600_000, "1day": 86_400_000 };
/** Hur länge ett lyckat svar räknas som färskt, per upplösning */
export const TIINGO_BARS_TTL_MS: Record<TiingoFreq, number> = { "1min": 2 * 60_000, "1hour": 20 * 60_000, "1day": 6 * 3_600_000 };
/** Hur gammal cache som får användas (märkt cachad) när Tiingo inte kan nås */
export const TIINGO_BARS_STALE_MS: Record<TiingoFreq, number> = { "1min": 30 * 60_000, "1hour": 3 * 3_600_000, "1day": 2 * 86_400_000 };
/** Hur långt bakåt varje upplösning hämtas (räcker för ca 150 ljus i de sammanslagna tidsramarna) */
const TIINGO_BARS_LOOKBACK_MS: Record<TiingoFreq, number> = { "1min": 40 * 3_600_000, "1hour": 26 * 86_400_000, "1day": 320 * 86_400_000 };
export const TIINGO_HINT_TTL_MS = 5 * 60_000;
/** Högst så många förhandshämtade tickers per samlat anrop (håller svaret litet inom tidsgränsen) */
export const TIINGO_HINT_MAX = 8;
export const tiingoAgentMaxPerHour = () => Math.max(1, Number(process.env.TIINGO_AGENT_MAX_PER_HOUR) || 20);

function toBars(rows: unknown, freq: TiingoFreq, now: number): TiingoBar[] {
  const ms = TIINGO_FREQ_MS[freq], out: TiingoBar[] = [], seen = new Set<number>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = typeof (r as any)?.date === "string" ? Date.parse((r as any).date) : NaN;
    const o = Number((r as any)?.open), h = Number((r as any)?.high), l = Number((r as any)?.low), c = Number((r as any)?.close);
    const v = Number((r as any)?.volume);
    if (![t, o, h, l, c].every(Number.isFinite) || o <= 0 || c <= 0 || h < Math.max(o, c) || l > Math.min(o, c) || seen.has(t)) continue;
    if (t + ms > now) continue; // ljuset bildas fortfarande: bara stängda ljus
    seen.add(t);
    out.push({ openTime: t, closeTime: t + ms, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) && v >= 0 ? v : 0 });
  }
  return out.sort((a, b) => a.openTime - b.openTime);
}

export function createTiingoBars(deps: {
  fetch?: FetchFn;
  key?: () => string | null | undefined;
  now?: () => number;
  batchMs?: number;
  maxPerHour?: () => number;
} = {}) {
  const doFetch: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchFn>);
  const key = deps.key ?? tiingoKey;
  const now = deps.now ?? Date.now;
  const batchMs = deps.batchMs ?? 150;
  const maxPerHour = deps.maxPerHour ?? tiingoAgentMaxPerHour;
  const cache = new Map<string, TiingoBarsResult>(); // "ticker|freq"
  const calls: number[] = [];
  let cooldownUntil = 0;
  const stats = { requests: 0 };
  const queues = new Map<TiingoFreq, Map<string, Array<(r: TiingoBarsResult) => void>>>();
  const timers = new Map<TiingoFreq, ReturnType<typeof setTimeout>>();
  const inflight = new Map<string, Promise<TiingoBarsResult>>();
  const hints = new Map<string, number>(); // kryptoticker → giltig till (tas med i nästa samlade anrop)
  const ck = (t: string, f: TiingoFreq) => `${t}|${f}`;

  function lookup(t: string, f: TiingoFreq, maxAge: number): TiingoBarsResult | null {
    const hit = cache.get(ck(t, f));
    if (!hit) return null;
    const age = now() - hit.at;
    const ttl = hit.bars.length ? maxAge : TIINGO_FAIL_TTL_MS;
    return age < ttl ? { ...hit, cached: true, stale: hit.bars.length > 0 && age >= TIINGO_BARS_TTL_MS[f] } : null;
  }
  function capReason(): string | null {
    if (now() < cooldownUntil) return "Tiingo pausat efter anropsbegränsning";
    while (calls.length && now() - calls[0]! >= 3_600_000) calls.shift();
    if (calls.length >= maxPerHour()) return `Tiingo-gräns för agenterna nådd (${maxPerHour()} anrop/timme)`;
    return null;
  }
  async function request(url: string, token: string): Promise<{ data: unknown; status: number; note: string | null }> {
    calls.push(now()); stats.requests++;
    try {
      const r = await doFetch(url, { headers: { Authorization: `Token ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) {
        if (r.status === 429) cooldownUntil = now() + TIINGO_COOLDOWN_MS;
        return { data: null, status: r.status, note: r.status === 401 || r.status === 403 ? "Tiingo nekade nyckeln" : r.status === 429 ? "Tiingo begränsade antal anrop" : `Tiingo svarade HTTP ${r.status}` };
      }
      return { data: await r.json(), status: r.status, note: null };
    } catch { return { data: null, status: 0, note: "Tiingo kunde inte nås" }; }
  }
  const startDate = (f: TiingoFreq) => new Date(now() - TIINGO_BARS_LOOKBACK_MS[f]).toISOString().slice(0, 10);
  /** Tillfälligt hinder (tak, paus, nätfel): äldre cache om den finns, annars förklaringen. Cachas inte. */
  function fallback(t: string, f: TiingoFreq, note: string): TiingoBarsResult {
    return lookup(t, f, TIINGO_BARS_STALE_MS[f]) ?? { ticker: t, freq: f, bars: [], at: now(), note };
  }
  function store(t: string, f: TiingoFreq, r: TiingoBarsResult): TiingoBarsResult { cache.set(ck(t, f), r); return r; }

  /** own = tickers som någon väntar på; övriga i part är förhandshämtningar (släpps vid fel, kostar aldrig extra anrop). */
  async function fetchCryptoPart(f: TiingoFreq, part: string[], token: string, own: string[] = part): Promise<Map<string, TiingoBarsResult>> {
    const out = new Map<string, TiingoBarsResult>();
    const qs = new URLSearchParams({ tickers: part.join(","), startDate: startDate(f), resampleFreq: f }).toString();
    const { data, status, note } = await request(`https://api.tiingo.com/tiingo/crypto/prices?${qs}`, token);
    if (note) {
      // Ett okänt par kan få Tiingo att avvisa hela det samlade anropet: prova då en och en (inom taket)
      if (status === 400 && part.length > 1) {
        // Bara de efterfrågade tickers provas en och en; förhandshämtningarna släpps så att taket inte äts upp
        for (const t of own) {
          const why = capReason();
          if (why) { out.set(t, fallback(t, f, why)); continue; }
          for (const [k, v] of await fetchCryptoPart(f, [t], token)) out.set(k, v);
        }
        return out;
      }
      const temporary = status === 0 || status === 429 || status >= 500;
      for (const t of part) out.set(t, temporary ? fallback(t, f, note) : store(t, f, { ticker: t, freq: f, bars: [], at: now(), note }));
      return out;
    }
    for (const t of part) {
      const entry = Array.isArray(data) ? data.find((d: any) => d?.ticker === t) : null;
      const bars = entry ? toBars((entry as any).priceData, f, now()) : [];
      out.set(t, store(t, f, { ticker: t, freq: f, bars, at: now(), note: bars.length ? null : entry ? "Tiingo saknar ljus för paret" : "Tiingo saknar paret" }));
    }
    return out;
  }

  async function flush(f: TiingoFreq): Promise<void> {
    timers.delete(f);
    const batch = queues.get(f) ?? new Map(); queues.set(f, new Map());
    const wanted = [...batch.keys()];
    // Kommande instrument (t.ex. sessionens nästa omgångar) följer med i samma anrop, så länge det finns plats
    for (const [t, until] of hints) {
      if (until < now()) { hints.delete(t); continue; }
      if (!wanted.includes(t) && !lookup(t, f, TIINGO_BARS_TTL_MS[f])) wanted.push(t);
    }
    const resolve = (t: string, r: TiingoBarsResult) => { for (const fn of batch.get(t) ?? []) fn(r); };
    const must = [...batch.keys()];
    for (let i = 0; i < must.length; i += TIINGO_BATCH_MAX) {
      const own = must.slice(i, i + TIINGO_BATCH_MAX);
      const extra = i === 0 ? wanted.filter((t) => !batch.has(t)).slice(0, Math.max(0, Math.min(TIINGO_HINT_MAX, TIINGO_BATCH_MAX - own.length))) : [];
      const part = [...own, ...extra];
      const token = key();
      const why = token ? capReason() : TIINGO_NO_KEY;
      if (why || !token) { for (const t of own) resolve(t, fallback(t, f, why ?? TIINGO_NO_KEY)); continue; }
      const res = await fetchCryptoPart(f, part, token, own);
      for (const t of own) resolve(t, res.get(t) ?? fallback(t, f, "Tiingo svarade inte för paret"));
    }
  }

  async function fetchFx(t: string, f: TiingoFreq): Promise<TiingoBarsResult> {
    const token = key();
    const why = token ? capReason() : TIINGO_NO_KEY;
    if (why || !token) return fallback(t, f, why ?? TIINGO_NO_KEY);
    const qs = new URLSearchParams({ startDate: startDate(f), resampleFreq: f }).toString();
    const { data, status, note } = await request(`https://api.tiingo.com/tiingo/fx/${encodeURIComponent(t)}/prices?${qs}`, token);
    if (note) return status === 0 || status === 429 || status >= 500 ? fallback(t, f, note) : store(t, f, { ticker: t, freq: f, bars: [], at: now(), note });
    const bars = toBars(data, f, now());
    return store(t, f, { ticker: t, freq: f, bars, at: now(), note: bars.length ? null : "Tiingo saknar intradagsdata för paret" });
  }

  /** OHLC-ljus för en EPIC i given upplösning. */
  async function bars(epic: string, name: string | null | undefined, f: TiingoFreq): Promise<TiingoBarsResult> {
    const m = tiingoTickerFor(epic, name);
    if (!m) return { ticker: null, freq: f, bars: [], at: now(), note: "ingen Tiingo-motsvarighet" };
    const hit = lookup(m.ticker, f, TIINGO_BARS_TTL_MS[f]);
    if (hit) return hit;
    if (!key()) return fallback(m.ticker, f, TIINGO_NO_KEY);
    const k = ck(m.ticker, f);
    const running = inflight.get(k);
    if (running) return running;
    const job = m.kind === "fx" ? fetchFx(m.ticker, f) : new Promise<TiingoBarsResult>((res) => {
      let q = queues.get(f);
      if (!q) { q = new Map(); queues.set(f, q); }
      const list = q.get(m.ticker) ?? [];
      list.push(res); q.set(m.ticker, list);
      if (!timers.has(f)) timers.set(f, setTimeout(() => { void flush(f); }, batchMs));
    });
    inflight.set(k, job);
    try { return await job; } finally { inflight.delete(k); }
  }
  /** Kommande instrument (kryptotickers) som får följa med i nästa samlade anrop. Inget anrop görs här. */
  function hint(list: Array<{ epic: string; name?: string | null }>): void {
    for (const x of list.slice(0, 200)) {
      const m = tiingoTickerFor(x.epic, x.name);
      if (m?.kind === "crypto") hints.set(m.ticker, now() + TIINGO_HINT_TTL_MS);
    }
  }
  return { bars, hint, stats: () => ({ ...stats, callsLastHour: calls.filter((t) => now() - t < 3_600_000).length }) };
}

// En gemensam instans för agenternas analys OCH huvuddiagrammets Tiingo-bakgrund (igChartBackdrop.ts), så att
// de delar samma anropstak (TIINGO_AGENT_MAX_PER_HOUR, standard 20/h) och samma cache. Totalt mot Tiingo blir
// det då oförändrat: minidiagram 30/h + agenter/huvuddiagram 20/h.
export const tiingoBarsShared = createTiingoBars();
