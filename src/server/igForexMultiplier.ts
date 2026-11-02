// ═══════════════════════════════════════════════════════════════════════════
//  Forexprisets representation (nativePriceMultiplier) för Tiingo-historik — ENDAST VISNING OCH ANALYS.
//
//  Tiingo anger valutor som kurs (1,1195) medan IG ofta anger punkter (11195). Omräkningen kräver IG:s
//  verifierade bevis (calculationRules.nativePriceMultiplier). IG Demo saknar ibland beviset för en EPIC
//  som Live har verifierat. Då lånas Live:s verifierade värde, men bara när båda miljöerna anger samma
//  scalingFactor och onePipMeans för EPIC:en. Gissar aldrig från prisets storlek, suffix eller decimaler.
//  Värdet skrivs aldrig in i marknadens regler: storlek, marginal, TP/SL och ordrar läser det aldrig.
//  Live läses UTANFÖR orderns läsförtur (som igDemoSimLive), märkt "vy", och svaret cachas länge.
// ═══════════════════════════════════════════════════════════════════════════
import type { IgEnvironment } from "../integrations/igConnection.js";
import { withoutIgPriority } from "../integrations/igConnection.js";
import { withIgReadConsumer } from "../integrations/igReadStats.js";
import { getIgMarket } from "../integrations/igMarkets.js";

/** Verifierat (eller lånat) värde gäller så här länge per miljö och EPIC */
export const FX_MULTIPLIER_TTL_MS = 6 * 3600_000;
/** Saknat bevis: försök inte igen förrän efter så här lång tid (sparar IG:s läsbudget) */
export const FX_MULTIPLIER_MISS_TTL_MS = 10 * 60_000;

export interface FxMultiplier { multiplier: number; borrowedFromLive: boolean }

type MarketLike = { epic?: string; type?: unknown; instrument?: Record<string, unknown>; calculationRules?: Record<string, unknown> };

const verified = (m: MarketLike | null | undefined): number | null => {
  const v = Number(m?.calculationRules?.nativePriceMultiplier);
  return m?.calculationRules?.nativePriceMultiplier != null && Number.isFinite(v) && v > 0 ? v : null;
};

export function createIgForexMultiplier(deps: {
  market?: (env: IgEnvironment, epic: string) => Promise<MarketLike>;
  now?: () => number;
} = {}) {
  const market = deps.market ?? ((env, epic) => withoutIgPriority(() => withIgReadConsumer("vy", () => getIgMarket(env, epic) as Promise<MarketLike>)));
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: FxMultiplier | null }>();
  /**
   * Verifierad representation för forex-EPIC i miljön, eller null när den inte kan verifieras.
   * own = redan hämtat IG-svar för miljön (undviker en extra läsning).
   */
  async function get(env: IgEnvironment, epic: string, own?: MarketLike | null): Promise<FxMultiplier | null> {
    const k = `${env}|${epic}`, hit = cache.get(k);
    if (hit && now() - hit.at < (hit.value ? FX_MULTIPLIER_TTL_MS : FX_MULTIPLIER_MISS_TTL_MS)) return hit.value;
    let value: FxMultiplier | null = null;
    try {
      const mine = own ?? await market(env, epic);
      const v = verified(mine);
      if (v !== null) value = { multiplier: v, borrowedFromLive: false };
      else if (env === "demo") {
        // Låna Live:s bevis bara när kontraktet beskrivs likadant i båda miljöerna
        const live = await market("live", epic);
        const lv = verified(live);
        const same = (key: string) => String(mine?.instrument?.[key] ?? "") === String(live?.instrument?.[key] ?? "");
        if (lv !== null && live?.epic === epic && mine?.instrument && same("scalingFactor") && same("onePipMeans")) value = { multiplier: lv, borrowedFromLive: true };
      }
    } catch { value = null; }
    cache.set(k, { at: now(), value });
    return value;
  }
  return { get };
}

export const igForexMultiplier = createIgForexMultiplier();
