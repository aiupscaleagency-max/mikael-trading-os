import assert from 'node:assert/strict';
import {accountMarketActivity, marketViewRows, marketTradeLabel, accountMarketProfits, parseVerifiedProfit, marketMetric, compareMarketRows, marketMetricLabel} from '../src/server/ui/workspace/marketViews.mjs';

const markets = [
  {epic: 'FX.EUR', name: 'EUR/USD', category: 'forex'},
  {epic: 'CR.BTC', name: 'Bitcoin ($1)', category: 'crypto'},
  {epic: 'FX.CAD', name: 'CAD/CHF', category: 'forex'},
  {epic: 'SH.BTC', name: 'Bitcoin ETF', category: 'shares'},
];
const position = {market: {epic: 'CR.BTC'}, position: {dealId: 'OPEN1'}};
const trade = (reference, instrumentName, extra = {}) => ({reference, instrumentName, type: 'DEAL', cashTransaction: false, ...extra});
const activity = accountMarketActivity(markets, {
  positions: [position, position], positionsStatus: 'ready',
  history: {status: 'ready', complete: true, periodDays: 30, transactions: [
    trade('CLOSED1', 'EUR/USD'), trade('CLOSED2', 'EUR/USD'), trade('CLOSED2', 'EUR/USD'),
    trade('OPEN1', 'Bitcoin ($1)'), trade('CASH', 'EUR/USD', {cashTransaction: true}),
    trade('INTEREST', 'EUR/USD', {type: 'INTEREST'}),
  ]},
});
assert.equal(activity.counts.get('FX.EUR'), 2);
assert.equal(activity.counts.get('CR.BTC'), 1, 'Öppen position och samma DEAL-referens får inte räknas dubbelt');
assert.equal(activity.counts.get('FX.CAD'), 0);
assert.equal(activity.complete, true);
const popular = marketViewRows(markets, {category: 'popular', activity});
assert.deepEqual(popular.map(row => row.epic), ['FX.EUR', 'CR.BTC', 'FX.CAD']);
assert.match(marketTradeLabel(popular[0]), /2 registrerade affärer/);
assert.deepEqual(marketViewRows(markets, {category: 'all'}).map(row => row.epic), ['CR.BTC', 'FX.CAD', 'FX.EUR']);
assert.deepEqual(marketViewRows(markets, {category: 'favorites', favorites: new Set(['FX.CAD'])}).map(row => row.epic), ['FX.CAD']);
assert.deepEqual(marketViewRows(markets, {category: 'forex', query: 'eur'}).map(row => row.epic), ['FX.EUR']);
assert.equal(marketViewRows([...markets, markets[0]]) .length, 3, 'Dubbletter och andra kategorier ska inte förvanska listan');
assert.equal(marketViewRows([{epic: 'C', name: 'Cardano', category: 'crypto'}], {category: 'crypto', kind: () => 'forex'}).length, 1);
assert.equal(marketViewRows([{epic: 'T', name: 'TRON'}], {kind: () => 'crypto'}).length, 1);
assert.equal(marketViewRows([{epic: 'T', name: 'TRON'}], {kind: () => { throw Error('bad'); }}).length, 0);

const unknown = accountMarketActivity(markets, {positionsStatus: 'error', positions: [position], history: {status: 'error', transactions: [trade('1', 'EUR/USD')]}});
assert.equal(unknown.verified, false);
assert.equal(marketViewRows(markets, {activity: unknown})[0].tradeCount, null);
assert.equal(marketTradeLabel({tradeCount: null}), 'Handelsantal okänt');
const partial = accountMarketActivity(markets, {positionsStatus: 'ready', positions: [], history: {status: 'partial', complete: false, transactions: [trade('P', 'EUR/USD')]}});
assert.equal(partial.complete, false);
assert.equal(partial.counts.get('FX.EUR'), 1);
assert.match(marketTradeLabel(marketViewRows(markets, {query: 'EUR', activity: partial})[0]), /1 noterade/);
const ambiguous = accountMarketActivity([...markets, {epic: 'FX.EUR2', name: 'EUR/USD', category: 'forex'}], {
  positions: [], positionsStatus: 'ready', history: {status: 'ready', complete: true, transactions: [trade('A', 'EUR/USD')]},
});
assert.equal(ambiguous.unmatched, 1);
assert.equal(ambiguous.complete, false, 'Tvetydiga namn ger aldrig falskt komplett ranking');
assert.equal(ambiguous.counts.get('FX.EUR'), 0);
const wrongEpic = accountMarketActivity(markets, {history: {status: 'partial', transactions: [trade('A', 'EUR/USD', {epic: 'OTHER'})]}});
assert.equal(wrongEpic.unmatched, 1, 'Fel explicit EPIC får inte ersättas av namnmatchning');
const unknownCash = accountMarketActivity(markets, {positionsStatus: 'ready', positions: [], history: {status: 'ready', complete: true, transactions: [trade('UNKNOWN', 'EUR/USD', {cashTransaction: null})]}});
assert.equal(unknownCash.complete, false);
assert.equal(unknownCash.unmatched, 1, 'DEAL med okänd kontantflagga räknas inte som verifierad affär');
assert.equal(accountMarketActivity(null).verified, false);
assert.deepEqual(marketViewRows(null), []);
assert.equal(parseVerifiedProfit('1,234.56'), 1234.56);
assert.equal(parseVerifiedProfit('-21.40'), -21.4);
assert.equal(parseVerifiedProfit('12,50'), null);
assert.equal(parseVerifiedProfit('SK10.00'), null);
assert.equal(parseVerifiedProfit(''), null);
const profitHistory = {status: 'ready', complete: true, transactions: [
  trade('A', 'EUR/USD', {profitAndLoss: '100.00', currency: 'SEK'}),
  trade('A', 'EUR/USD', {profitAndLoss: '100.00', currency: 'SEK'}),
  trade('B', 'EUR/USD', {profitAndLoss: '-20.00', currency: 'SEK'}),
  trade('C', 'Bitcoin ($1)', {profitAndLoss: '12,50', currency: 'SEK'}),
]};
const profits = accountMarketProfits(markets, {history: profitHistory, currency: 'SEK'});
assert.equal(profits.get('FX.EUR').value, 80);
assert.equal(profits.get('FX.EUR').complete, false);
assert.equal(profits.has('CR.BTC'), false);
assert.equal(profits.has('FX.CAD'), false, 'Ingen historik får inte bli nollvinst');
assert.equal(accountMarketProfits(markets, {history: profitHistory, currency: 'USD'}).size, 0);
assert.equal(accountMarketProfits(markets, {history: {...profitHistory, status: 'error'}, currency: 'SEK'}).size, 0);
const ranked = [
  {epic: 'A', name: 'A', category: 'forex', percentageChange: -4, accountProfit: {value: -20, currency: 'SEK', verified: true}, sentiment: {longPositionPercentage: 65}},
  {epic: 'B', name: 'B', category: 'forex', percentageChange: 1, accountProfit: {value: 50, currency: 'SEK', verified: true}, sentiment: {longPercentage: 70}},
  {epic: 'C', name: 'C', category: 'forex', percentageChange: null},
];
assert.equal([...ranked].sort((a, b) => compareMarketRows(a, b, 'movers'))[0].epic, 'A');
assert.equal(marketViewRows(ranked, {sort: 'trend'})[0].epic, 'B');
assert.equal(marketViewRows(ranked, {sort: 'profit'})[0].epic, 'B');
assert.equal(marketViewRows(ranked, {sort: 'buying'})[0].epic, 'B');
assert.equal(marketMetric({percentageChange: '5'}, 'movers'), null);
assert.equal(marketMetric({sentiment: {longPercentage: 101}}, 'buying'), null);
assert.equal(marketMetricLabel(ranked[2], 'profit'), 'Okänt');
assert.match(marketMetricLabel(ranked[0], 'trend'), /↓ [-−]4/);
assert.match(marketMetricLabel(ranked[0], 'buying'), /65.*IG-klienter/);
console.log('PASS: kontospecifik marknadsranking, kategorier, deduplicering, partiella/okända data och entydig matchning');
