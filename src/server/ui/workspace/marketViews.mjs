const clean = (value) => typeof value === 'string' ? value.trim() : '';
const nameKey = (value) => clean(value).normalize('NFKC').toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ');
const marketName = (market) => clean(market?.name) || clean(market?.instrumentName) || clean(market?.epic);

// Historikens namn måste matcha exakt och entydigt; valuta-/kontraktsvarianter får inte sammanblandas.
export function accountMarketActivity(markets, {positions, positionsStatus, history} = {}) {
  const items = Array.isArray(markets) ? markets : [];
  const counts = new Map();
  const epics = new Set();
  const names = new Map();
  for (const market of items) {
    const epic = clean(market?.epic);
    if (!epic) continue;
    epics.add(epic);
    counts.set(epic, 0);
    const key = nameKey(marketName(market));
    if (key) names.set(key, names.has(key) && names.get(key) !== epic ? null : epic);
  }
  const positionsVerified = positionsStatus === 'ready' && Array.isArray(positions);
  const historyVerified = ['ready', 'partial'].includes(history?.status) && Array.isArray(history?.transactions);
  const verified = positionsVerified || historyVerified;
  const sourcesComplete = positionsVerified && historyVerified && history.status === 'ready' && history.complete === true;
  const seen = new Set();
  let unmatched = 0;
  const record = (epic, reference) => {
    if (!epic || !epics.has(epic)) { unmatched += 1; return; }
    const key = JSON.stringify([epic, reference]);
    if (seen.has(key)) return;
    seen.add(key);
    counts.set(epic, counts.get(epic) + 1);
  };
  if (positionsVerified) positions.forEach((row, index) => {
    const epic = clean(row?.market?.epic) || clean(row?.epic);
    const reference = clean(row?.position?.dealId) || clean(row?.dealId);
    record(epic, reference ? `deal:${reference}` : `position:${index}`);
  });
  if (historyVerified) history.transactions.forEach((row) => {
    // Endast explicit verifierade affärer räknas; kassatransaktioner och aktivitetsloggar räknas aldrig.
    if (clean(row?.type || row?.transactionType).toUpperCase() !== 'DEAL' || row?.cashTransaction === true) return;
    if (row?.cashTransaction !== false) { unmatched += 1; return; }
    const reference = clean(row?.reference);
    if (!reference) { unmatched += 1; return; }
    const explicitEpic = clean(row?.epic);
    const epic = explicitEpic ? (epics.has(explicitEpic) ? explicitEpic : null) : names.get(nameKey(row?.instrumentName));
    record(epic, `deal:${reference}`);
  });
  const complete = sourcesComplete && unmatched === 0;
  const period = Number.isFinite(history?.periodDays) ? `${history.periodDays} dagar` : 'hämtad period';
  const note = !verified ? 'Handelsantal är okänt: verifierade kontodata saknas.'
    : `${complete ? 'Verifierade' : 'Delvis hämtade'} handelsantal på detta konto: öppna positioner och DEAL-transaktioner (${period}). ${unmatched ? `${unmatched} poster kunde inte matchas säkert. ` : ''}Ingen global IG-rankning.`;
  return {counts, verified, complete, unmatched, note};
}

export function marketViewRows(markets, {category = 'all', query = '', sort = 'alpha', favorites = [], kind, activity} = {}) {
  const favoriteSet = favorites instanceof Set ? favorites : new Set(Array.isArray(favorites) ? favorites : []);
  const search = nameKey(query);
  const used = new Set();
  const result = [];
  for (const market of Array.isArray(markets) ? markets : []) {
    const epic = clean(market?.epic);
    if (!epic || used.has(epic)) continue;
    const explicitCategory = ['forex', 'crypto'].includes(market?.category) ? market.category : null;
    let inferred = null;
    if (!explicitCategory && typeof kind === 'function') {
      try { inferred = kind(market); } catch { inferred = null; }
    }
    const marketCategory = explicitCategory || (['forex', 'crypto'].includes(inferred) ? inferred : null);
    if (!marketCategory) continue;
    if (['forex', 'crypto'].includes(category) && category !== marketCategory) continue;
    if (category === 'favorites' && !favoriteSet.has(epic)) continue;
    if (search && !nameKey(`${marketName(market)} ${epic}`).includes(search)) continue;
    used.add(epic);
    const value = activity?.verified && activity?.counts instanceof Map ? activity.counts.get(epic) : null;
    const tradeCount = Number.isInteger(value) && value >= 0 ? value : null;
    result.push({...market, category: marketCategory, tradeCount, tradeCountComplete: activity?.complete === true});
  }
  return result.sort((a, b) => compareMarketRows(a, b, category === 'popular' ? 'activity' : sort));
}

export function marketTradeLabel(market) {
  if (market?.tradeCount === null || market?.tradeCount === undefined) return 'Handelsantal okänt';
  return `${market.tradeCount} ${market.tradeCountComplete ? 'registrerade' : 'noterade'} affärer · mitt konto`;
}

// En tvetydig lokal decimal som "12,50" får aldrig tolkas som 1250.
export function parseVerifiedProfit(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/.test(text)) return null;
  const parsed = Number(text.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function accountMarketProfits(markets, {history, currency} = {}) {
  const profits = new Map();
  if (!['ready', 'partial'].includes(history?.status) || !Array.isArray(history?.transactions) || !clean(currency)) return profits;
  const items = Array.isArray(markets) ? markets : [];
  const names = new Map();
  const epics = new Set();
  for (const market of items) {
    const epic = clean(market?.epic), key = nameKey(marketName(market));
    if (!epic) continue;
    epics.add(epic);
    if (key) names.set(key, names.has(key) && names.get(key) !== epic ? null : epic);
  }
  const seen = new Set(), invalid = new Set();
  let incomplete = false;
  for (const row of history.transactions) {
    if (clean(row?.type || row?.transactionType).toUpperCase() !== 'DEAL' || row?.cashTransaction === true) continue;
    const explicitEpic = clean(row?.epic);
    const epic = explicitEpic ? (epics.has(explicitEpic) ? explicitEpic : null) : names.get(nameKey(row?.instrumentName));
    if (!epic) { incomplete = true; continue; }
    const reference = clean(row?.reference);
    const value = parseVerifiedProfit(row?.profitAndLoss);
    if (!reference || row.cashTransaction !== false || value === null || clean(row.currency) !== clean(currency)) {
      invalid.add(epic); incomplete = true; continue;
    }
    const key = JSON.stringify([epic, reference]);
    if (seen.has(key)) continue;
    seen.add(key);
    const previous = profits.get(epic)?.value ?? 0;
    profits.set(epic, {value: previous + value, currency: clean(currency), verified: true, complete: false});
  }
  // Ofullständiga summor visas inte som instrumentets verifierade totalvinst.
  for (const epic of invalid) profits.delete(epic);
  const complete = !incomplete && history.status === 'ready' && history.complete === true;
  for (const value of profits.values()) value.complete = complete;
  return profits;
}

export function marketMetric(market, mode) {
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (mode === 'popular' || mode === 'activity') return finite(market?.tradeCount);
  if (mode === 'movers') { const value = finite(market?.percentageChange); return value === null ? null : Math.abs(value); }
  if (mode === 'trend') return finite(market?.percentageChange);
  if (mode === 'buying') {
    const value = finite(market?.sentiment?.longPositionPercentage ?? market?.sentiment?.longPercentage);
    return value !== null && value >= 0 && value <= 100 ? value : null;
  }
  if (mode === 'profit') return market?.accountProfit?.verified === true && clean(market.accountProfit.currency) ? finite(market.accountProfit.value) : null;
  return null;
}

export function compareMarketRows(a, b, mode = 'alpha') {
  const av = marketMetric(a, mode), bv = marketMetric(b, mode);
  if (mode !== 'alpha') {
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    const comparable = mode !== 'profit' || a?.accountProfit?.currency === b?.accountProfit?.currency;
    if (av !== null && bv !== null && comparable && av !== bv) return bv - av;
  }
  return marketName(a).localeCompare(marketName(b), 'sv-SE') || clean(a?.epic).localeCompare(clean(b?.epic));
}

export function marketMetricLabel(market, mode) {
  const value = marketMetric(market, mode);
  if (value === null) return 'Okänt';
  if (mode === 'activity' || mode === 'popular') return marketTradeLabel(market);
  if (mode === 'profit') return `${market.accountProfit.complete ? '' : 'Noterat: '}${value.toLocaleString('sv-SE', {maximumFractionDigits: 2})} ${market.accountProfit.currency}`;
  if (mode === 'buying') return `${value.toLocaleString('sv-SE', {maximumFractionDigits: 1})} % långa · IG-klienter`;
  if (mode === 'trend') return `${value > 0 ? '↑ +' : value < 0 ? '↓ ' : '→ '}${value.toLocaleString('sv-SE', {maximumFractionDigits: 2})} % idag`;
  if (mode === 'movers') return `${value.toLocaleString('sv-SE', {maximumFractionDigits: 2})} % rörelse idag`;
  return 'Okänt';
}
