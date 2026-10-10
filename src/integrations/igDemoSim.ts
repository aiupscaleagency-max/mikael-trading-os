import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { igAccountLimits, igPositionLimitReason } from "./igRiskLimits.js";

// ═══════════════════════════════════════════════════════════════════════════
// DEMO-SIMULERING — samma instrument i Demo som i Live (Mike 2026-10-10:
// "Jag måste kunna öva med EXAKT SAMMA valutor, system osv i DEMO som jag kan i LIVE").
//
// IG:s Demo-konto saknar en del Live-instrument (t.ex. Bitcoin ($0.1), Ether ($1)).
// För dem fylls order HÄR, med låtsaspengar, mot Live-kontots riktiga pris:
//   KÖP fylls på Live-offer, SÄLJ på Live-bid (stängning omvänt).
//   P/L i SEK med Live-instrumentets verifierade punktvärde (IG:s egna regler + befintlig FX-väg).
//   Saknas färskt Live-pris eller verifierad valutakurs → ordern nekas med klartext. Inget gissas.
//
// SÄKERHET: modulen har INGA IG-anrop. Den importerar inget från igConnection/igOrders och skriver
// aldrig till IG (varken Demo eller Live). All Live-data kommer in via injicerade läsfunktioner.
// Tillståndet sparas i data/ig-demo-sim.json. Startsaldo 100 000 SEK (IG_DEMO_SIM_START_SEK).
// ═══════════════════════════════════════════════════════════════════════════

export const DEMO_SIM_LABEL = "Demo-simulering · Live-pris · låtsaspengar";
export const DEMO_SIM_SHORT = "Demo-simulering";
export const DEMO_SIM_PREFIX = "SIM-";
export const DEMO_SIM_CURRENCY = "SEK";
export const isSimDealId = (id: unknown): id is string => typeof id === "string" && id.startsWith(DEMO_SIM_PREFIX);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const QUOTE_MAX_AGE_MS = 60_000;

export interface SimQuote { bid: number; offer: number; receivedAt: number; observedAt: number | null; delayTime: number | null; marketStatus: string | null }
/** Live-marknadens form (som getIgMarket returnerar), bara fälten simuleringen använder. */
export interface SimMarket {
  epic: string; name?: string | null; quote: SimQuote & Record<string, unknown>;
  calculationRules?: { verified?: boolean; pointValue?: number | null; profitPointValue?: number | null; marginRate?: number | null; pointCurrency?: string | null; fxError?: string; note?: string; priceScalingFactor?: number | null; fx?: { label?: string; stale?: boolean; path?: string; baseCurrency?: string; accountCurrency?: string; safetyMargin?: number } | null };
  dealingRules?: { minDealSize?: { value?: number }; minNormalStopOrLimitDistance?: { unit?: string; value?: number } };
  instrument?: { unit?: string | null; contractSize?: number | null; scalingFactor?: number | null };
}
export interface SimPosition {
  dealId: string; epic: string; name: string; direction: "BUY" | "SELL"; size: number; level: number;
  stopLevel: number | null; limitLevel: number | null; openedAt: number; margin: number;
  /** Verifierade värden från öppningen (reserv vid stängning om färsk Live-regel saknas) */
  pointValue: number; profitPointValue: number; marginRate: number; fxNote: string | null;
  /** Senast kända pris (för visning) */
  lastBid?: number; lastOffer?: number; lastAt?: number;
}
export interface SimTrade {
  dealId: string; epic: string; name: string; direction: "BUY" | "SELL"; size: number;
  openLevel: number; closeLevel: number; openedAt: number; closedAt: number; pnl: number; currency: string;
  reason: string; ruleBasis: string;
}
interface SimState { version: 1; currency: string; startBalance: number; balance: number; positions: SimPosition[]; closed: SimTrade[] }

export interface SimStakeQuote {
  ok: boolean; reason?: string; fxNote?: string | null; epic: string; name: string | null; direction: "BUY" | "SELL"; currency: string | null;
  entry: number | null; bid: number | null; offer: number | null; stake: number; size: number | null; minSize: number | null; unit: string | null;
  contractSize: number | null; pointValue: number | null; marginRate: number | null; margin: number | null; minMargin: number | null;
  exposure: number | null; moneyAtSl: number | null; moneyAtTp: number | null; stopLoss: number | null; takeProfit: number | null;
  quoteAgeMs: number | null; basis: string; sim: true; simLabel: string;
}

export interface IgDemoSimDeps {
  /** Live-marknad (LÄSNING): kvot, IG:s handelsregler och punktvärde i kontovalutan. */
  market: (epic: string) => Promise<SimMarket>;
  /** Färsk Live-strömkvot om den finns (ingen IG-läsning). */
  streamQuote?: (epic: string) => SimQuote | null;
  /** Kill switch (samma tillstånd som IG-ordern läser). */
  guard: () => Promise<{ killSwitchActive: boolean }>;
  now?: () => number;
  file?: string;
  startBalance?: number;
  maxOpenPositions?: number;
}

export function createIgDemoSim(deps: IgDemoSimDeps) {
  const now = deps.now ?? Date.now;
  const file = deps.file;
  const startBalance = finite(deps.startBalance) && deps.startBalance > 0 ? deps.startBalance : 100_000;
  const maxOpen = finite(deps.maxOpenPositions) && deps.maxOpenPositions > 0 ? deps.maxOpenPositions : Number.MAX_SAFE_INTEGER;
  let state: SimState | null = null;
  let busy = false;

  function load(): SimState {
    if (state) return state;
    let s: SimState | null = null;
    if (file) {
      try {
        const d = JSON.parse(fs.readFileSync(file, "utf8"));
        if (d && d.version === 1 && finite(d.balance) && Array.isArray(d.positions) && Array.isArray(d.closed)) s = d as SimState;
      } catch { /* första gången */ }
    }
    state = s ?? { version: 1, currency: DEMO_SIM_CURRENCY, startBalance, balance: startBalance, positions: [], closed: [] };
    return state;
  }
  function save(): void {
    if (!file) return;
    // Atomisk skrivning: temporär fil + byte av namn
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 1));
    fs.renameSync(tmp, file);
  }

  const fresh = (q: SimQuote | null | undefined): q is SimQuote => !!q && q.marketStatus === "TRADEABLE" && q.delayTime === 0
    && finite(q.bid) && finite(q.offer) && q.bid > 0 && q.offer >= q.bid
    && finite(q.receivedAt) && now() - q.receivedAt >= 0 && now() - q.receivedAt <= QUOTE_MAX_AGE_MS
    && finite(q.observedAt) && now() - q.observedAt >= 0 && now() - q.observedAt <= QUOTE_MAX_AGE_MS;

  /** Färskaste Live-kvoten: strömmen först, annars Live-marknadens REST-kvot. */
  function bestQuote(epic: string, m: SimMarket | null): SimQuote | null {
    const s = deps.streamQuote?.(epic) ?? null;
    if (fresh(s)) return s;
    return m && fresh(m.quote) ? m.quote : null;
  }
  /** Verifierade pengaregler i SEK, annars ett klartextfel. Gissar aldrig valutakurs. */
  function verifiedRules(m: SimMarket, what: string) {
    const r = m.calculationRules;
    if (r?.fxError) throw new Error(`${DEMO_SIM_SHORT}: ${r.fxError} ${what}`);
    if (!r?.verified || r.pointCurrency !== load().currency || !finite(r.pointValue) || r.pointValue <= 0 || !finite(r.marginRate) || r.marginRate <= 0) {
      throw new Error(`${DEMO_SIM_SHORT}: Live-instrumentets punktvärde i ${load().currency} (valutakurs/marginal) kunde inte verifieras. ${what}`);
    }
    const profit = finite(r.profitPointValue) && r.profitPointValue > 0 ? r.profitPointValue : r.pointValue;
    const fxNote = r.fx ? (r.fx.stale ? `${r.fx.label ?? "senaste växelkurs"} · säkerhetsmarginal` : `växelkurs ${r.fx.path ?? `${r.fx.baseCurrency}/${r.fx.accountCurrency}`} (Live)`) : null;
    return { pointValue: r.pointValue, profitPointValue: profit, marginRate: r.marginRate, fxNote };
  }
  function pnlOf(p: Pick<SimPosition, "direction" | "level" | "size">, exit: number, pv: { pointValue: number; profitPointValue: number }): number {
    const delta = (p.direction === "BUY" ? 1 : -1) * (exit - p.level);
    return delta * p.size * (delta >= 0 ? pv.profitPointValue : pv.pointValue);
  }
  /** Stängningspris: lång stängs på bid, kort på offer. */
  const exitPrice = (p: { direction: "BUY" | "SELL" }, q: SimQuote) => (p.direction === "BUY" ? q.bid : q.offer);

  function minDistanceOf(m: SimMarket, entry: number): number {
    const d = m.dealingRules?.minNormalStopOrLimitDistance;
    const scaling = m.calculationRules?.priceScalingFactor ?? m.instrument?.scalingFactor;
    if (d?.unit === "POINTS" && finite(d.value) && finite(scaling) && scaling > 0) return d.value / scaling;
    if (d?.unit === "PERCENTAGE" && finite(d.value)) return entry * d.value / 100;
    return NaN;
  }

  /** Orealiserad P/L med senast kända pris (strömmen först). null om priset saknas. */
  function unrealized(p: SimPosition): number | null {
    const s = deps.streamQuote?.(p.epic) ?? null;
    const q = fresh(s) ? s : null;
    if (q) { p.lastBid = q.bid; p.lastOffer = q.offer; p.lastAt = now(); }
    const exit = p.direction === "BUY" ? p.lastBid : p.lastOffer;
    return finite(exit) ? pnlOf(p, exit, p) : null;
  }
  function startOfDay(): number { const d = new Date(now()); d.setHours(0, 0, 0, 0); return d.getTime(); }

  /** Konto i SEK: saldo (realiserat), orealiserat, marginal och tillgängligt. */
  function account() {
    const s = load();
    let upnl = 0, verified = true, margin = 0;
    for (const p of s.positions) { const u = unrealized(p); if (u === null) verified = false; else upnl += u; margin += p.margin; }
    const available = s.balance + Math.min(0, upnl) - margin;
    return { currency: s.currency, balance: s.balance, available, profitLoss: upnl, margin, startBalance: s.startBalance, verified, label: DEMO_SIM_LABEL };
  }

  /** Samma budget som IG-ordern: per position (igPositionLimitReason), total marginal, antal och dagsförlust. */
  function checkBudget(margin: number, risk: number | null): void {
    const s = load(), a = account();
    const why = igPositionLimitReason({ margin, risk, balance: s.balance, available: a.available, currency: s.currency });
    if (why) throw new Error(`${DEMO_SIM_SHORT}: ${why}`);
    const limits = igAccountLimits(s.balance);
    if (a.margin + margin > limits.maxTotalMargin) throw new Error(`${DEMO_SIM_SHORT}: total marginal ${(a.margin + margin).toFixed(2)} ${s.currency} skulle överstiga gränsen ${limits.maxTotalMargin.toFixed(2)} ${s.currency}`);
    if (s.positions.length >= maxOpen) throw new Error(`${DEMO_SIM_SHORT}: gränsen för samtidiga positioner är nådd`);
    const today = s.closed.filter((t) => t.closedAt >= startOfDay()).reduce((t, x) => t + x.pnl, 0);
    if (today + Math.min(0, a.profitLoss) <= -limits.maxDailyLoss) throw new Error(`${DEMO_SIM_SHORT}: daglig förlustgräns är nådd`);
  }

  async function stakeQuote(input: { epic: string; direction: "BUY" | "SELL"; stake: number; stopLoss?: number; takeProfit?: number; size?: number }): Promise<SimStakeQuote> {
    const m = await deps.market(input.epic);
    const q = bestQuote(input.epic, m);
    const r = m.calculationRules ?? {};
    const entry = q ? (input.direction === "BUY" ? q.offer : q.bid) : null;
    const minSize = finite(m.dealingRules?.minDealSize?.value) ? m.dealingRules!.minDealSize!.value! : null;
    const base: SimStakeQuote = {
      ok: false, epic: input.epic, name: m.name ?? null, direction: input.direction, currency: load().currency,
      entry, bid: q?.bid ?? null, offer: q?.offer ?? null, stake: input.stake, size: null, minSize,
      unit: m.instrument?.unit ?? null, contractSize: m.instrument?.contractSize ?? null,
      pointValue: finite(r.pointValue) ? r.pointValue : null, marginRate: finite(r.marginRate) ? r.marginRate : null,
      margin: null, minMargin: null, exposure: null, moneyAtSl: null, moneyAtTp: null,
      stopLoss: input.stopLoss ?? null, takeProfit: input.takeProfit ?? null,
      quoteAgeMs: q && finite(q.observedAt) ? now() - q.observedAt : null,
      basis: `${DEMO_SIM_LABEL} · IG Live-regler`, fxNote: null, sim: true, simLabel: DEMO_SIM_LABEL,
    };
    if (!q || !finite(entry) || entry <= 0) return { ...base, reason: `${DEMO_SIM_SHORT}: inget färskt Live-pris (marknaden stängd eller fördröjd)` };
    let pv;
    try { pv = verifiedRules(m, "Ingen storlek räknas."); } catch (e) { return { ...base, reason: e instanceof Error ? e.message : String(e) }; }
    const perContractMargin = entry * pv.pointValue * pv.marginRate;
    const decimals = minSize !== null ? Math.max(0, (String(minSize).split(".")[1] ?? "").length) : 2;
    const step = 10 ** -decimals;
    const size = finite(input.size) && input.size > 0 ? input.size : Math.floor(input.stake / perContractMargin / step + 1e-9) * step;
    const minMargin = minSize !== null ? minSize * perContractMargin : null;
    if (minSize !== null && size < minSize) return { ...base, fxNote: pv.fxNote, minMargin, reason: `Minsta IG-kontrakt (${minSize} ${m.instrument?.unit ?? "kontrakt"}) kräver ca ${minMargin!.toFixed(2)} ${load().currency} i marginal, mer än insatsen ${input.stake.toFixed(2)} ${load().currency}. Höj insatsen eller välj ett annat instrument.` };
    if (!(size > 0)) return { ...base, fxNote: pv.fxNote, minMargin, reason: "Insatsen räcker inte till något kontrakt" };
    const priced = {
      size: +size.toFixed(decimals), margin: size * perContractMargin, exposure: entry * size * pv.pointValue,
      moneyAtSl: finite(input.stopLoss) ? Math.abs(entry - input.stopLoss) * size * pv.pointValue : null,
      moneyAtTp: finite(input.takeProfit) ? Math.abs(input.takeProfit - entry) * size * pv.profitPointValue : null,
    };
    try { checkBudget(priced.margin, priced.moneyAtSl); } catch (e) { return { ...base, ...priced, fxNote: pv.fxNote, minMargin, reason: e instanceof Error ? e.message : String(e) }; }
    return { ...base, ...priced, fxNote: pv.fxNote, minMargin, ok: true };
  }

  /** Öppnar en simulerad position. Skickar ALDRIG något till IG. */
  async function open(input: { epic: string; direction: "BUY" | "SELL"; size: number; stopLevel?: number | null; targetLevel?: number | null; orderType?: "MARKET" | "LIMIT"; name?: string | null }): Promise<SimPosition> {
    if (busy) throw new Error(`${DEMO_SIM_SHORT}: en order behandlas redan`);
    busy = true;
    try {
      if (input.orderType === "LIMIT") throw new Error(`${DEMO_SIM_SHORT}: limitorder stöds inte för Live-instrument i Demo. Använd marknadsorder.`);
      if (input.direction !== "BUY" && input.direction !== "SELL") throw new Error(`${DEMO_SIM_SHORT}: Köp eller Sälj krävs`);
      if ((await deps.guard()).killSwitchActive) throw new Error(`${DEMO_SIM_SHORT}: stoppad av kill switch`);
      const m = await deps.market(input.epic);
      if (m.epic !== input.epic) throw new Error(`${DEMO_SIM_SHORT}: Live svarade för fel instrument`);
      const q = bestQuote(input.epic, m);
      if (!q) throw new Error(`${DEMO_SIM_SHORT}: inget färskt Live-pris för ${m.name ?? input.epic} (marknaden stängd eller fördröjd). Inget öppnades.`);
      const pv = verifiedRules(m, "Inget öppnades.");
      const entry = input.direction === "BUY" ? q.offer : q.bid;
      const size = input.size, min = m.dealingRules?.minDealSize?.value;
      if (!finite(size) || size <= 0 || !finite(min) || size < min) throw new Error(`${DEMO_SIM_SHORT}: storleken ${size} är under IG:s minsta (${min ?? "okänd"})`);
      const stop = finite(input.stopLevel) ? input.stopLevel : null, target = finite(input.targetLevel) ? input.targetLevel : null;
      const sign = input.direction === "BUY" ? 1 : -1;
      if ((stop !== null && sign * (entry - stop) <= 0) || (target !== null && sign * (target - entry) <= 0)) throw new Error(`${DEMO_SIM_SHORT}: stop-loss och målpris ligger på fel sida om priset ${entry}`);
      const minDist = minDistanceOf(m, entry);
      if ((stop !== null || target !== null) && !finite(minDist)) throw new Error(`${DEMO_SIM_SHORT}: IG:s minsta stop-/målavstånd kunde inte verifieras`);
      if ((stop !== null && Math.abs(entry - stop) < minDist) || (target !== null && Math.abs(target - entry) < minDist)) throw new Error(`${DEMO_SIM_SHORT}: stop-loss/målpris ligger närmare än IG:s minsta avstånd (${minDist})`);
      const margin = entry * size * pv.pointValue * pv.marginRate;
      const risk = stop !== null ? Math.abs(entry - stop) * size * pv.pointValue : null;
      checkBudget(margin, risk);
      if ((await deps.guard()).killSwitchActive) throw new Error(`${DEMO_SIM_SHORT}: stoppad av kill switch`);
      const p: SimPosition = {
        dealId: `${DEMO_SIM_PREFIX}${randomUUID()}`, epic: input.epic, name: input.name ?? m.name ?? input.epic, direction: input.direction, size, level: entry,
        stopLevel: stop, limitLevel: target, openedAt: now(), margin, pointValue: pv.pointValue, profitPointValue: pv.profitPointValue, marginRate: pv.marginRate,
        fxNote: pv.fxNote, lastBid: q.bid, lastOffer: q.offer, lastAt: now(),
      };
      load().positions.push(p);
      save();
      return { ...p };
    } finally { busy = false; }
  }

  /** Stänger en simulerad position till Live-pris (lång på bid, kort på offer). Skickar ALDRIG något till IG. */
  async function close(dealId: string, reason = "manuell"): Promise<SimTrade> {
    const s = load();
    const p = s.positions.find((x) => x.dealId === dealId);
    if (!p) throw new Error(`${DEMO_SIM_SHORT}: positionen ${dealId} finns inte (redan stängd)`);
    let m: SimMarket | null = null;
    try { m = await deps.market(p.epic); } catch { m = null; }
    const q = bestQuote(p.epic, m);
    if (!q) throw new Error(`${DEMO_SIM_SHORT}: inget färskt Live-pris för ${p.name}; positionen lämnas öppen och stängs vid nästa försök`);
    // Färska verifierade regler först; annars öppningens verifierade punktvärde (märkt). Aldrig gissat.
    let pv: { pointValue: number; profitPointValue: number } = p, ruleBasis = "öppningens verifierade punktvärde/växelkurs";
    if (m) { try { pv = verifiedRules(m, ""); ruleBasis = "IG Live-regler vid stängning"; } catch { /* öppningens regler */ } }
    if (!s.positions.includes(p)) throw new Error(`${DEMO_SIM_SHORT}: positionen stängdes redan`);
    const exit = exitPrice(p, q);
    const pnl = pnlOf(p, exit, pv);
    s.positions = s.positions.filter((x) => x !== p);
    s.balance += pnl;
    const t: SimTrade = { dealId: p.dealId, epic: p.epic, name: p.name, direction: p.direction, size: p.size, openLevel: p.level, closeLevel: exit, openedAt: p.openedAt, closedAt: now(), pnl, currency: s.currency, reason, ruleBasis };
    s.closed.push(t);
    if (s.closed.length > 500) s.closed.splice(0, s.closed.length - 500);
    save();
    return { ...t };
  }

  /** TP/SL-bevakning (IG gör det på sin server för riktiga positioner; här gör vi det själva). */
  async function tick(): Promise<SimTrade[]> {
    const done: SimTrade[] = [];
    for (const p of [...load().positions]) {
      if (p.stopLevel === null && p.limitLevel === null) continue;
      const s = deps.streamQuote?.(p.epic) ?? null;
      let q: SimQuote | null = fresh(s) ? s : null;
      if (!q) { try { q = bestQuote(p.epic, await deps.market(p.epic)); } catch { q = null; } }
      if (!q) continue;
      p.lastBid = q.bid; p.lastOffer = q.offer; p.lastAt = now();
      const px = exitPrice(p, q), long = p.direction === "BUY";
      const hitSl = p.stopLevel !== null && (long ? px <= p.stopLevel : px >= p.stopLevel);
      const hitTp = p.limitLevel !== null && (long ? px >= p.limitLevel : px <= p.limitLevel);
      if (!hitSl && !hitTp) continue;
      try { done.push(await close(p.dealId, hitSl ? "SL" : "TP")); } catch { /* nästa varv */ }
    }
    return done;
  }

  function positionsView() {
    return load().positions.map((p) => {
      const u = unrealized(p);
      return { ...p, currentPrice: (p.direction === "BUY" ? p.lastBid : p.lastOffer) ?? null, upnl: u, pnlVerified: u !== null };
    });
  }
  function snapshot(): SimState { return JSON.parse(JSON.stringify(load())); }
  function hasPosition(dealId: string): boolean { return load().positions.some((p) => p.dealId === dealId); }
  function openEpics(): string[] { return [...new Set(load().positions.map((p) => p.epic))]; }
  /** Live-kvot för visning/storlek (strömmen först, annars Live-marknaden). */
  async function quote(epic: string): Promise<{ market: SimMarket; quote: SimQuote | null }> { const m = await deps.market(epic); return { market: m, quote: bestQuote(epic, m) }; }

  return { open, close, tick, stakeQuote, account, positionsView, snapshot, hasPosition, openEpics, quote, label: DEMO_SIM_LABEL };
}
export type IgDemoSim = ReturnType<typeof createIgDemoSim>;

// ── Vilka EPICs simuleras? Bara vid POSITIVT belägg för att Demo saknar instrumentet ──
// Belägg: Live-katalogen har EPIC:en OCH (Demo-katalogens sökningar är klara utan den, ELLER IG Demo svarade 404
// på just den EPIC:en). Delvis katalog, läsgräns eller frånkoppling räknas aldrig som belägg: då går ordern
// den vanliga IG Demo-vägen (som själv nekar ett instrument som inte finns) eller nekas med klartext.
export interface SimCatalogue { markets: Array<{ epic: string } & Record<string, unknown>>; complete?: boolean; searchCompletedAt?: number | null }
export interface DemoSimRouterDeps {
  live: (category: "forex" | "crypto") => SimCatalogue | null;
  demo: (category: "forex" | "crypto") => SimCatalogue | null;
  /** Läser instrumentet på IG Demo: finns, saknas (HTTP 404) eller okänt (annat fel). */
  probeDemo?: (epic: string) => Promise<"exists" | "missing" | "unknown">;
  /** IG Demo-strömmen avvisade prisposten för EPIC:en (Lightstreamer-fel): IG säger att Demo saknar priset.
   *  Positivt belägg även om Demo-sökningen listar EPIC:en (prislösa katalograder). */
  demoRejected?: (epic: string) => boolean;
  now?: () => number;
}
export function createDemoSimRouter(deps: DemoSimRouterDeps) {
  const missing = new Set<string>(); // IG Demo svarade 404 (positivt belägg)
  const present = new Set<string>(); // IG Demo har instrumentet
  const probing = new Map<string, Promise<"exists" | "missing" | "unknown">>();
  const unknownAt = new Map<string, number>(); // "okänt"-svar minns 60 s så att samma EPIC inte läses om hela tiden
  const CATS = ["forex", "crypto"] as const;
  const clock = deps.now ?? Date.now;
  // Katalogerna (kopior) läses högst var 5:e s till ett uppslagsindex: anropas för varje Live-kvot och i seriesorteringen.
  type Index = { live: Map<string, Record<string, unknown> & { epic: string }>; demo: Record<"forex" | "crypto", Set<string> | null>; searched: Record<"forex" | "crypto", boolean> };
  let index: { at: number; value: Index } | null = null;
  function idx(): Index {
    if (index && clock() - index.at < 5_000) return index.value;
    const live = new Map<string, Record<string, unknown> & { epic: string }>();
    const demo = { forex: null, crypto: null } as Index["demo"], searched = { forex: false, crypto: false };
    for (const c of CATS) {
      for (const m of deps.live(c)?.markets ?? []) if (typeof m.epic === "string") live.set(m.epic, { ...m, category: m.category ?? c });
      const d = deps.demo(c);
      demo[c] = d ? new Set(d.markets.map((m) => m.epic)) : null;
      searched[c] = !!d && (d.complete === true || finite(d.searchCompletedAt));
    }
    index = { at: clock(), value: { live, demo, searched } };
    return index.value;
  }
  const catOf = (row: Record<string, unknown>) => (row.category === "crypto" || row.category === "forex" ? row.category : null);
  function liveRow(epic: string) { return idx().live.get(epic) ?? null; }
  /** IG har sagt att Demo saknar instrumentet (404 eller avvisad prisström). Minns för processen, så att
   *  avslutad Demo-prenumeration (som raderar felet) inte får instrumentet att växla fram och tillbaka. */
  function rejected(epic: string): boolean {
    if (present.has(epic)) return false;
    if (missing.has(epic)) return true;
    let r = false; try { r = !!deps.demoRejected?.(epic); } catch { r = false; }
    if (r) missing.add(epic);
    return r;
  }
  function inDemo(epic: string): boolean { const i = idx(); return present.has(epic) || (!rejected(epic) && CATS.some((c) => i.demo[c]?.has(epic) === true)); }
  /** Synkront: simuleras EPIC:en (positivt belägg)? */
  function known(epic: string): boolean {
    if (typeof epic !== "string" || inDemo(epic)) return false;
    const row = liveRow(epic);
    if (!row) return false;
    if (missing.has(epic)) return true;
    const cat = catOf(row);
    return cat ? idx().searched[cat] : false;
  }
  /** Synkront, för LÄSNING/visning: Live har EPIC:en och den inlästa Demo-katalogen (samma kategori) saknar den.
   *  Saknas Demo-katalogen (frånkopplad/omloggning) är svaret nej, så att Demo-instrument aldrig läses från Live.
   *  Ger aldrig ordervägen; den avgörs av route() som kräver positivt belägg. */
  function liveOnly(epic: string): boolean {
    if (typeof epic !== "string" || inDemo(epic)) return false;
    const row = liveRow(epic);
    if (!row) return false;
    if (missing.has(epic)) return true;
    const cat = catOf(row);
    return !!cat && idx().demo[cat] !== null;
  }
  async function probe(epic: string): Promise<"exists" | "missing" | "unknown"> {
    if (!deps.probeDemo) return "unknown";
    if (clock() - (unknownAt.get(epic) ?? -Infinity) < 60_000) return "unknown";
    let job = probing.get(epic);
    if (!job) { job = deps.probeDemo(epic).catch(() => "unknown" as const); probing.set(epic, job); }
    try {
      const r = await job;
      if (r === "missing") missing.add(epic); else if (r === "exists") present.add(epic); else unknownAt.set(epic, clock());
      return r;
    } finally { probing.delete(epic); }
  }
  /** Vid order/kvot: "ig" (vanliga IG Demo-vägen) eller "sim". Kastar om det inte går att avgöra. */
  async function route(epic: string): Promise<"ig" | "sim"> {
    if (known(epic)) return "sim";
    if (inDemo(epic) || !liveRow(epic)) return "ig";
    const r = await probe(epic);
    if (r === "missing") return "sim";
    if (r === "exists") return "ig";
    throw new Error(`Det går inte att avgöra just nu om ${String(liveRow(epic)?.name ?? epic)} finns på IG Demo (läsgräns eller anslutning). Inget skickades; försök igen om en minut.`);
  }
  /** Live-rader som saknas i Demo: bevisade (simuleras) och obevisade (bara referens). */
  function split(category: "forex" | "crypto", demoMarkets: Array<{ epic: string }>): { sim: Array<Record<string, unknown> & { epic: string }>; unproven: Array<Record<string, unknown> & { epic: string }> } {
    const have = new Set(demoMarkets.map((m) => m.epic));
    const sim: Array<Record<string, unknown> & { epic: string }> = [], unproven: Array<Record<string, unknown> & { epic: string }> = [];
    for (const m of deps.live(category)?.markets ?? []) {
      // Demo-rader som IG avvisat (prislösa sökträffar) ersätts av Live-raden
      if (typeof m.epic !== "string" || present.has(m.epic) || (have.has(m.epic) && !rejected(m.epic))) continue;
      (known(m.epic) ? sim : unproven).push(m);
    }
    return { sim, unproven };
  }
  return { known, liveOnly, route, probe, split };
}
export type DemoSimRouter = ReturnType<typeof createDemoSimRouter>;

/** Katalograd för Demo-vyn: Live-instrumentets data, tydligt märkt som simulering. */
export function demoSimRow(m: Record<string, unknown> & { epic: string }): Record<string, unknown> & { epic: string; name: string; liveName: string; category?: unknown; sim: true; simLabel: string; priceSource: string } {
  const name = typeof m.name === "string" && m.name ? m.name : m.epic;
  return { ...m, name: `${name} · ${DEMO_SIM_SHORT}`, liveName: name, sim: true as const, simLabel: DEMO_SIM_LABEL, priceSource: "IG Live" };
}
