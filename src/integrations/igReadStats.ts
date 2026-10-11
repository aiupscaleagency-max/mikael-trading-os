// ═══════════════════════════════════════════════════════════════════════════
//  IG-läsningar per förbrukare (mätning + rättvisa tak för bakgrundsjobb).
//
//  Läsbudgeten (igConnection) är 24 läsningar/min per miljö, varav 12 är orderreserv
//  (rörs ALDRIG härifrån). Kvar för allt annat: 12/min ("backgroundRemaining").
//  Den här modulen ändrar inte budgeten; den
//   1. märker vem som läser (AsyncLocalStorage, samma teknik som withIgPriority),
//   2. räknar läsningarna per miljö och förbrukare (senaste minuten, 10 min, sedan start),
//   3. ger bakgrundsjobben (katalog, minidiagram, sim) var sitt minuttak och ett golv:
//      de backar när bakgrundsutrymmet är lågt, så att kurser/konto/positioner/diagram
//      (det Mike tittar på) alltid har läsningar kvar.
//  Inga nycklar, tokens eller kontouppgifter lagras – bara antal och vägtyp.
// ═══════════════════════════════════════════════════════════════════════════
import { AsyncLocalStorage } from "node:async_hooks";
import type { IgEnvironment } from "./igConnection.js";

export type IgReadConsumer = "katalog" | "minidiagram" | "sim" | "bevakning" | "agenter" | "vy";
export type IgBackgroundConsumer = "katalog" | "minidiagram" | "sim";

/**
 * Tak per minut och miljö för bakgrundsjobben, samt golv (minsta kvarvarande bakgrundsutrymme
 * för att jobbet ens får läsa). Motivering, utgår från 12 bakgrundsläsningar/min per miljö:
 *  - katalog 4/min, golv 5: en full genomsökning (≈65 sökord + några kategorisidor) tar ≈17 min,
 *    och görs bara en gång per dygn/inloggning; därefter 1 uppfriskning/min. Golvet 5 gör att
 *    katalogen aldrig tar de sista läsningarna som vyerna behöver.
 *  - minidiagram 4/min, golv 3: en IG-hämtning kostar 1–3 läsningar (instrument + historik),
 *    alltså 1–4 diagram/min via IG; resten visas ur cache/minne eller Tiingo (ej IG-pris).
 *  - sim 2/min, golv 3: TP/SL-varvet läser bara REST när strömkvot saknas.
 *  Summan 4+4+2 = 10 < 12, så minst 2 bakgrundsläsningar/min finns alltid kvar för vyer,
 *  bevakningens kvoter/diagram och agenterna, även när alla tre jobben går för fullt.
 */
export const IG_BACKGROUND_CAPS: Record<IgBackgroundConsumer, { perMinute: number; floor: number }> = {
  katalog: { perMinute: 4, floor: 5 },
  minidiagram: { perMinute: 4, floor: 3 },
  sim: { perMinute: 2, floor: 3 },
};

const context = new AsyncLocalStorage<IgReadConsumer>();
/** Kör fn märkt med förbrukaren (alla IG-läsningar inuti räknas på den). */
export function withIgReadConsumer<T>(consumer: IgReadConsumer, fn: () => Promise<T>): Promise<T> { return context.run(consumer, fn); }
export function currentIgReadConsumer(): IgReadConsumer | null { return context.getStore() ?? null; }

/** Vägtyp ur IG-routen (bara typ, aldrig EPIC eller frågeparametrar). */
export function igRouteKind(route: string): string {
  if (route === "markets") return "sök";
  if (route === "categories" || route.startsWith("categories/")) return "kategorier";
  if (route.startsWith("prices/")) return "historik";
  if (route.startsWith("markets/")) return "instrument";
  if (route.startsWith("client-sentiment/")) return "sentiment";
  if (route.startsWith("history/")) return "kontohistorik";
  return "annat";
}

export function createIgReadStats(deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  // [tid, miljö, förbrukare, vägtyp, avvisad]
  const recent: Array<{ at: number; env: IgEnvironment; consumer: string; kind: string; rejected: boolean }> = [];
  const totals = new Map<string, { reads: number; rejected: number }>();
  function prune(): void { while (recent.length && now() - recent[0]!.at >= 600_000) recent.shift(); }

  /** Räknar en läsning (rejected = budgeten/IG nekade, ingen data kom). */
  function record(env: IgEnvironment, route: string, rejected = false, consumer?: IgReadConsumer | null): void {
    const who = consumer ?? currentIgReadConsumer() ?? "vy";
    const kind = igRouteKind(route);
    recent.push({ at: now(), env, consumer: who, kind, rejected });
    const k = `${env}|${who}`;
    const t = totals.get(k) ?? { reads: 0, rejected: 0 };
    if (rejected) t.rejected++; else t.reads++;
    totals.set(k, t);
    prune();
  }
  /** Lyckade läsningar senaste minuten för förbrukaren i miljön. */
  function lastMinute(env: IgEnvironment, consumer: string): number {
    prune();
    return recent.filter((r) => r.env === env && r.consumer === consumer && !r.rejected && now() - r.at < 60_000).length;
  }
  /**
   * null = bakgrundsjobbet får läsa nu; annars skälet. backgroundRemaining = igConnection:s
   * bakgrundsutrymme (undefined i tester utan budget → bara minuttaket gäller).
   */
  function backgroundBlock(env: IgEnvironment, consumer: IgBackgroundConsumer, backgroundRemaining: number | undefined): string | null {
    const cap = IG_BACKGROUND_CAPS[consumer];
    if (backgroundRemaining !== undefined && backgroundRemaining < cap.floor) return `${consumer} väntar: lågt läsutrymme (${backgroundRemaining} kvar, golv ${cap.floor})`;
    if (lastMinute(env, consumer) >= cap.perMinute) return `${consumer} väntar: högst ${cap.perMinute} läsningar/min`;
    return null;
  }
  /** Ögonblicksbild för GET /api/ig/read-stats. budget = igConnection:s läsbudget (används för "övrigt"). */
  function snapshot(budget?: (env: IgEnvironment) => { used: number; remaining: number; reserve: number; backgroundRemaining: number }) {
    prune();
    const envs: Record<string, unknown> = {};
    for (const env of ["demo", "live"] as IgEnvironment[]) {
      const rows = recent.filter((r) => r.env === env);
      const consumers: Record<string, { lastMinute: number; last10Min: number; rejectedLast10Min: number; sinceStart: number; rejectedSinceStart: number; kinds: Record<string, number> }> = {};
      for (const r of rows) {
        const c = consumers[r.consumer] ??= { lastMinute: 0, last10Min: 0, rejectedLast10Min: 0, sinceStart: 0, rejectedSinceStart: 0, kinds: {} };
        if (r.rejected) { c.rejectedLast10Min++; continue; }
        c.last10Min++;
        if (now() - r.at < 60_000) c.lastMinute++;
        c.kinds[r.kind] = (c.kinds[r.kind] ?? 0) + 1;
      }
      for (const [k, t] of totals) {
        const [e, who] = k.split("|") as [string, string];
        if (e !== env) continue;
        const c = consumers[who] ??= { lastMinute: 0, last10Min: 0, rejectedLast10Min: 0, sinceStart: 0, rejectedSinceStart: 0, kinds: {} };
        c.sinceStart = t.reads; c.rejectedSinceStart = t.rejected;
      }
      let b: ReturnType<NonNullable<typeof budget>> | null = null;
      try { b = budget ? budget(env) : null; } catch { b = null; }
      const attributed = Object.values(consumers).reduce((s, c) => s + c.lastMinute, 0);
      envs[env] = {
        budget: b,
        consumers,
        // Läsningar som inte går via marknadsmodulen (saldo, positioner, orderkontroller, kontopollning)
        otherLastMinute: b ? Math.max(0, b.used - attributed) : null,
      };
    }
    return { since: startedAt, caps: IG_BACKGROUND_CAPS, environments: envs };
  }
  return { record, lastMinute, backgroundBlock, snapshot };
}

// En gemensam instans för servern
export const igReadStats = createIgReadStats();
