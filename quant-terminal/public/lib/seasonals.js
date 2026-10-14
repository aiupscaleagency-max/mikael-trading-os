// Seasonals: how a symbol moved through each calendar year, from daily bars (UTC dates).
// Each year's path is measured from the previous year's last close, so 1 January's move counts.

const dayOfYear = (t) => {
  const d = new Date(t * 1000);
  return (
    Math.floor(
      (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        Date.UTC(d.getUTCFullYear(), 0, 1)) /
        86400000,
    ) + 1
  );
};

export function seasonals(bars) {
  const byYear = new Map();
  for (const b of bars) {
    const y = new Date(b.time * 1000).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(b);
  }
  const yearsList = [...byYear.keys()].sort((a, b) => a - b);
  const thisYear = new Date().getUTCFullYear();
  const years = [],
    monthly = [];
  yearsList.forEach((y, k) => {
    const rows = byYear.get(y);
    const prev =
      k > 0 && yearsList[k - 1] === y - 1
        ? byYear.get(y - 1).at(-1).close
        : null;
    const base = prev ?? rows[0].open;
    const points = rows.map((b) => ({
      doy: dayOfYear(b.time),
      pct: (b.close / base - 1) * 100,
    }));
    // complete = we hold the whole year (starts within the first week, and it's not the current year)
    const complete =
      y !== thisYear &&
      prev != null &&
      rows.at(-1) &&
      dayOfYear(rows.at(-1).time) > 350;
    years.push({
      year: y,
      points,
      total: points.at(-1)?.pct ?? null,
      complete,
    });
    const months = new Array(12).fill(null);
    let last = base;
    for (let m = 0; m < 12; m++) {
      const inMonth = rows.filter(
        (b) => new Date(b.time * 1000).getUTCMonth() === m,
      );
      if (!inMonth.length) continue;
      const close = inMonth.at(-1).close;
      months[m] = (close / last - 1) * 100;
      last = close;
    }
    monthly.push({ year: y, months, total: points.at(-1)?.pct ?? null });
  });
  // Average path over complete years: each year sampled per day of year, carrying the last value
  // over weekends and holidays.
  const done = years.filter((y) => y.complete);
  const average = [];
  if (done.length) {
    const sampled = done.map((y) => {
      const out = new Array(367).fill(null);
      let i = 0,
        cur = 0;
      for (let d = 1; d <= 366; d++) {
        while (i < y.points.length && y.points[i].doy <= d)
          cur = y.points[i++].pct;
        out[d] = cur;
      }
      return out;
    });
    for (let d = 1; d <= 366; d++)
      average.push({
        doy: d,
        pct: sampled.reduce((s, x) => s + x[d], 0) / sampled.length,
      });
  }
  const monthAvg = new Array(12).fill(0).map((_, m) => {
    const vals = monthly.map((r) => r.months[m]).filter((v) => v != null);
    return vals.length
      ? {
          avg: vals.reduce((s, v) => s + v, 0) / vals.length,
          upPct: (vals.filter((v) => v > 0).length / vals.length) * 100,
          n: vals.length,
        }
      : null;
  });
  return { years, monthly, average, monthAvg, completeYears: done.length };
}
