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
  // Granskning 2 (mindre 11): .env kan sänka men aldrig höja taket över 3 %.
  const stakePct = Math.min(3, num("IG_MAX_STAKE_PCT") ?? 3);
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

/**
 * Pengar för en order i kontovalutan, som orderpanelen visar dem (D2).
 * 1–3 % är MARGINALANDEL av saldot, inte maxförlust: förlusten vid stop-loss visas separat.
 * Inga värden hittas på — saknas något blir det null och förklaras i `missing`.
 */
export function igOrderMoneyView(i: {
  currency: string | null; balance: number | null; available: number | null; profitLoss: number | null;
  pct: number; stake: number;
  quote: { ok: boolean; size: number | null; unit: string | null; contractSize: number | null; minSize: number | null; minMargin: number | null; margin: number | null; exposure: number | null; moneyAtSl: number | null; moneyAtTp: number | null; bid: number | null; offer: number | null; pointValue: number | null; reason?: string };
  portfolio: { margin: number; exposure: number; positions: number; verified: boolean } | null;
}) {
  const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const b = fin(i.balance) && i.balance > 0 ? i.balance : null;
  const l = b !== null ? igAccountLimits(b) : null;
  const q = i.quote;
  const spreadCost = q.ok && fin(q.size) && fin(q.bid) && fin(q.offer) && fin(q.pointValue) ? (q.offer - q.bid) * q.size * q.pointValue : null;
  const missing: string[] = [];
  if (b === null) missing.push("IG-saldot");
  if (!i.portfolio?.verified) missing.push("öppna positioners marginal");
  if (spreadCost === null) missing.push("spreadkostnad");
  return {
    currency: i.currency,
    balance: b, available: fin(i.available) ? i.available : null, profitLoss: fin(i.profitLoss) ? i.profitLoss : null,
    budgetPct: i.pct, budgetAmount: i.stake,
    maxStakePct: l?.maxStakePct ?? null, maxPositionMargin: l?.maxPositionMargin ?? null, maxTotalMargin: l?.maxTotalMargin ?? null, maxDailyLoss: l?.maxDailyLoss ?? null,
    margin: q.margin, marginPctOfBalance: b !== null && fin(q.margin) ? q.margin / b * 100 : null,
    exposure: q.exposure,
    size: q.size, unit: q.unit, contractSize: q.contractSize, minSize: q.minSize, minMargin: q.minMargin,
    lossAtSl: q.moneyAtSl, lossAtSlPctOfBalance: b !== null && fin(q.moneyAtSl) ? q.moneyAtSl / b * 100 : null,
    gainAtTp: q.moneyAtTp,
    spreadCost,
    costsNote: "Kostnad = spread vid öppning. Finansiering över natten och eventuell garanterad stop tillkommer enligt IG och visas inte här.",
    openMargin: i.portfolio?.verified ? i.portfolio.margin : null,
    openExposure: i.portfolio?.verified ? i.portfolio.exposure : null,
    totalMarginAfter: i.portfolio?.verified && fin(q.margin) ? i.portfolio.margin + q.margin : null,
    totalExposureAfter: i.portfolio?.verified && fin(q.exposure) ? i.portfolio.exposure + q.exposure : null,
    minContractNote: !q.ok && fin(q.minMargin) ? `Minsta IG-kontrakt (${q.minSize} ${q.unit ?? "kontrakt"}) kräver ca ${q.minMargin.toFixed(2)} ${i.currency ?? ""} i marginal, mer än budgeten ${i.stake.toFixed(2)} ${i.currency ?? ""}.` : null,
    pctMeaning: "1–3 % = andel av saldot som binds som marginal, inte maxförlust. Förlust vid stop-loss visas separat.",
    missing,
  };
}
