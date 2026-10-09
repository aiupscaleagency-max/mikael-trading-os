// ═══════════════════════════════════════════════════════════════════════════
// INSATS-TRAPPA (Mike 2026-10-03), nu på IG: insatsen är en andel av IG-saldot
// i kontovalutan (= marginalen en order får använda). Start 1 %, upp mot 3 %
// när IG Demo-resultaten visar att det fungerar. Trappan räknas på avslutade
// affärer i IG Demo (rapporteras av results.ts från IG:s transaktionshistorik).
//   start                                         → 1 %
//   ≥10 avslutade, total vinst > 0                → 2 %
//   ≥20 avslutade, vinst > 0, träffsäkerhet ≥50 % → 3 % (tak, STAKE_PCT_MAX)
// Går de senaste 10 med förlust → tillbaka till 1 %.
// ═══════════════════════════════════════════════════════════════════════════

export interface StakeLevel {
  pct: number;
  /** Insats i kontovalutan (fältnamnet behålls av bakåtkompatibilitet; IG: SEK) */
  usd: number;
  amount: number;
  currency: string | null;
  equityUsd: number;
  closed: number;
  winRate: number;
  totalPnl: number;
  reason: string;
}

let demo: { pnls: number[]; balance: number | null; currency: string | null; at: number } = { pnls: [], balance: null, currency: null, at: 0 };

/** Anropas med IG Demo:s avslutade affärer (äldst först) och saldot. */
export function setStakeHistory(pnls: number[], balance: number | null, currency: string | null): void {
  demo = { pnls: pnls.filter((x) => Number.isFinite(x)), balance, currency, at: Date.now() };
}

export function currentStake(): StakeLevel | null {
  const pnls = demo.pnls;
  const total = pnls.reduce((t, p) => t + p, 0);
  const winRate = pnls.length ? pnls.filter((p) => p > 0).length / pnls.length : 0;
  const last10 = pnls.slice(-10).reduce((t, p) => t + p, 0);
  const start = Number(process.env.STAKE_PCT_START ?? 1) || 1;
  const max = Number(process.env.STAKE_PCT_MAX ?? 3) || 3;
  let pct = start, reason = "start: 1 % av saldot tills agenterna visat resultat i IG Demo";
  const n = pnls.length;
  if (n >= 10 && last10 < 0) reason = "senaste 10 affärerna gick med förlust: tillbaka till 1 %";
  else if (n >= 20 && total > 0 && winRate >= 0.5) { pct = 3; reason = `${n} affärer, vinst, ${Math.round(winRate * 100)} % träff`; }
  else if (n >= 10 && total > 0) { pct = 2; reason = `${n} affärer med vinst`; }
  else if (n > 0) reason = `${n} av 10 affärer klara innan nästa steg`;
  pct = Math.min(Math.max(pct, start), max);
  const amount = demo.balance !== null ? Math.floor(demo.balance * pct) / 100 : 0;
  return { pct, usd: amount, amount, currency: demo.currency, equityUsd: demo.balance ?? 0, closed: n, winRate, totalPnl: total, reason };
}
