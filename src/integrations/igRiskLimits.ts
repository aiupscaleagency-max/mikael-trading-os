// ═══════════════════════════════════════════════════════════════════════════
// IG-gränser i KONTOVALUTAN (SEK på Mikes konto), härledda ur saldot.
//
// De gamla USD-gränserna (MAX_POSITION_USD=100 osv.) var gjorda för spot-krypto
// och stoppar varje IG-CFD (ett EUR/USD Mini-kontrakt är ~10 000 EUR exponering).
// För IG gäller i stället samma budget som insatsen (1–3 % av saldot i marginal),
// så att stake-uträkningen och godkännandet säger samma sak:
//
//   per position : marginal ≤ IG_MAX_STAKE_PCT (3) % av saldot   (eller IG_MAX_POSITION_MARGIN)
//                  förlust vid stop-loss ≤ 5 % av tillgängligt
//                  marginal ≤ tillgängligt
//   totalt       : summa marginal ≤ IG_MAX_TOTAL_MARGIN_PCT (15) % av saldot (eller IG_MAX_TOTAL_MARGIN)
//   per dag      : realiserad + orealiserad förlust ≤ IG_MAX_DAILY_LOSS_PCT (5) % av saldot (eller IG_MAX_DAILY_LOSS)
//
// Beloppsvarianterna (…_MARGIN, …_LOSS) anges i kontovalutan.
// ═══════════════════════════════════════════════════════════════════════════

const num = (name: string): number | null => {
  const v = process.env[name];
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export interface IgAccountLimits {
  maxPositionMargin: number;
  maxTotalMargin: number;
  maxDailyLoss: number;
  maxSlRiskShareOfAvailable: number;
  maxStakePct: number;
  basis: string;
}

export function igAccountLimits(balance: number): IgAccountLimits {
  const b = Number.isFinite(balance) && balance > 0 ? balance : 0;
  const stakePct = Math.min(100, num("IG_MAX_STAKE_PCT") ?? 3);
  const totalPct = Math.min(100, num("IG_MAX_TOTAL_MARGIN_PCT") ?? 15);
  const lossPct = Math.min(100, num("IG_MAX_DAILY_LOSS_PCT") ?? 5);
  return {
    maxPositionMargin: num("IG_MAX_POSITION_MARGIN") ?? b * stakePct / 100,
    maxTotalMargin: num("IG_MAX_TOTAL_MARGIN") ?? b * totalPct / 100,
    maxDailyLoss: num("IG_MAX_DAILY_LOSS") ?? b * lossPct / 100,
    maxSlRiskShareOfAvailable: 0.05,
    maxStakePct: stakePct,
    basis: `marginal ≤ ${stakePct} % av saldot per position, ≤ ${totalPct} % totalt, dagsförlust ≤ ${lossPct} %`,
  };
}

/** Samma kontroll i stake-uträkningen och vid godkännandet. null = OK, annars förklaring på svenska. */
export function igPositionLimitReason(i: { margin: number; risk: number | null; balance: number; available: number; currency: string }): string | null {
  const l = igAccountLimits(i.balance);
  const f = (v: number) => `${v.toFixed(2)} ${i.currency}`;
  if (!(i.balance > 0)) return "IG-saldot kunde inte verifieras";
  if (i.margin > l.maxPositionMargin * 1.000001) return `Marginalen ${f(i.margin)} är mer än ${l.maxStakePct} % av saldot (${f(l.maxPositionMargin)}).`;
  if (i.margin > i.available) return `Marginalen ${f(i.margin)} är mer än tillgängligt (${f(i.available)}).`;
  if (i.risk !== null && i.risk > i.available * l.maxSlRiskShareOfAvailable) return `Förlusten vid stop-loss ${f(i.risk)} är mer än 5 % av tillgängligt (${f(i.available * 0.05)}).`;
  return null;
}
