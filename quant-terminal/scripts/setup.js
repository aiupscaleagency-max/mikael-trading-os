#!/usr/bin/env node
// Personalise a fresh install before first launch.
//   node scripts/setup.js --watchlist "BTC,ETH,SOL,AAPL,NVDA" --symbol BTC --tf 4h --theme dark
// Run it while the app is stopped (or refresh the browser tab afterwards).
import { resolve, getCandles } from '../lib/providers.js';
import * as store from '../lib/store.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const state = store.read('state', {});
const out = [];

if (args.watchlist) {
  const ids = [];
  const raws = args.watchlist.split(',').map((s) => s.trim()).filter(Boolean);
  // Resolve each symbol and make sure it actually loads, so typos don't land in the list.
  const checked = await Promise.all(raws.map(async (raw) => {
    try {
      const { id } = await resolve(raw);
      await getCandles(id, '1D', 5);
      return { id };
    } catch (e) { return { raw, error: e.message.split('|')[0].trim() }; }
  }));
  for (const c of checked) {
    if (c.id) ids.push(c.id);
    else out.push(`Skipped "${c.raw}": no free source has it (${c.error.slice(0, 120)})`);
  }
  const name = args.name || 'Main';
  state.watchlists = { ...(state.watchlists || {}), [name]: [...new Set(ids)] };
  state.activeWatchlist = name;
  out.push(`Watchlist "${name}": ${ids.join(', ')}`);
}
if (args.symbol || args.tf) {
  const symbol = args.symbol ? (await resolve(args.symbol)).id : state.panes?.[0]?.symbol || 'BINANCE:BTCUSDT';
  const tf = args.tf || state.panes?.[0]?.tf || '1D';
  const first = state.panes?.[0] || { type: 'candles', indicators: [{ uid: 'i-ema', id: 'ema', params: { length: 21 } }, { uid: 'i-rsi', id: 'rsi', params: {} }], compare: [] };
  state.panes = [{ ...first, symbol, tf }, ...(state.panes || []).slice(1)];
  out.push(`First chart: ${symbol} on ${tf}`);
}
if (args.theme) {
  state.settings = { ...(state.settings || {}), theme: args.theme === 'light' ? 'light' : 'dark' };
  out.push(`Theme: ${state.settings.theme}`);
}
store.write('state', state);
console.log(out.join('\n') || 'Nothing to change. Use --watchlist, --symbol, --tf or --theme.');
