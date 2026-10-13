// Isolerade cacheprov: inga nätverksanrop eller order.
import assert from 'node:assert/strict';
import { createResultsCache, RESULTS_CACHE_MS, type Results } from '../src/server/results.js';
import type { BrokerAdapter } from '../src/brokers/adapter.js';
let generation = 'A';
let reads = 0;
let finish: ((value: Results) => void) | null = null;
const value = (label: string): Results => ({ mode: 'TEST', label, trades: [], open: [], totals: {realized: 0, unrealized: 0, wins: 0, losses: 0, trades: 0, today: 0} });
const cached = createResultsCache({
  identity: () => ({ accountId: 'konto', generation }),
  read: async () => { reads++; return new Promise<Results>(resolve => { finish = resolve; }); },
});
const brokers = { 'ig-demo': {} as BrokerAdapter };
const a = cached(brokers, 'TEST');
const b = cached(brokers, 'TEST');
assert.equal(reads, 1);
finish!(value('A'));
const av = await a;
await b;
av.label = 'muterad';
assert.equal((await cached(brokers, 'TEST')).label, 'A');
generation = 'B';
const old = cached(brokers, 'TEST');
assert.equal(reads, 2);
const finishOld = finish!;
generation = 'C';
const fresh = cached(brokers, 'TEST');
const finishFresh = finish!;
assert.equal(reads, 3);
// B-läsningen får inte presenteras efter byte till C.
finishOld(value('B'));
await assert.rejects(old, /sessionen byttes/);
finishFresh(value('C'));
assert.equal((await fresh).label, 'C');
let release!: (value: Results) => void;
const race = createResultsCache({ identity: () => ({ accountId: 'konto', generation }), read: async () => new Promise<Results>(r => { release = r; }) });
const pending = race(brokers, 'TEST');
generation = 'D';
release(value('gammal'));
await assert.rejects(pending, /sessionen byttes/);
console.log('PASS: samtidiga läsningar delas, svar isoleras och sessionsbyte spärrar gamla resultat');

// Samma generation räcker inte om kontot eller mäklarobjektet byts.
let accountId = 'konto-a', clock = 1000, extraReads = 0, fail = false;
const extra = createResultsCache({ identity: () => ({ accountId, generation: 'samma' }),
  read: async () => { extraReads++; if (fail) throw Error('isolerat läsfel'); return value(accountId); } });
const separate = { 'ig-demo': {} as BrokerAdapter };
await extra(separate, 'TEST', () => clock);
accountId = 'konto-b';
assert.equal((await extra(separate, 'TEST', () => clock)).label, 'konto-b');
assert.equal(extraReads, 2, 'Kontobyte ger ny läsning även med samma generation');
separate['ig-demo'] = {} as BrokerAdapter;
await extra(separate, 'TEST', () => clock);
assert.equal(extraReads, 3, 'Mäklarobjekt isolerar cachen');
clock += RESULTS_CACHE_MS - 1;
await extra(separate, 'TEST', () => clock);
assert.equal(extraReads, 3, 'Färskt värde återanvänds');
clock++;
await extra(separate, 'TEST', () => clock);
assert.equal(extraReads, 4, 'Exakt TTL-gräns hämtar nytt värde');
accountId = 'konto-fel'; fail = true;
await assert.rejects(extra(separate, 'TEST', () => clock), /isolerat läsfel/);
fail = false;
assert.equal((await extra(separate, 'TEST', () => clock)).label, accountId);
assert.equal(extraReads, 6, 'Ett läsfel cachas inte och lämnar ingen fastnad pågående läsning');
const replacing = createResultsCache({ identity: () => ({ accountId, generation: 'samma' }),
  read: async () => new Promise<Results>(resolve => { release = resolve; }) });
const replaced = replacing(separate, 'TEST');
separate['ig-demo'] = {} as BrokerAdapter;
release(value('gammal mäklare'));
await assert.rejects(replaced, /sessionen byttes/);
console.log('PASS: konto, mäklarobjekt, TTL och fel-retry isoleras; ersatt mäklare spärrar väntande resultat');
