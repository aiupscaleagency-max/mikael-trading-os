// Kör den verkliga orderpanelens kod isolerat: inga IG-anrop eller order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const elements = new Map();
const $ = id => {
  if (!elements.has(id)) elements.set(id, { value: id === 'ot-pct' ? '1' : '', checked: false, handlers: {}, addEventListener(t, fn) { this.handlers[t] = fn; }, dispatchEvent(e) { this.handlers[e.type]?.(e); } });
  return elements.get(id);
};
const events = {};
let epic = 'CS.D.BITCOIN.CFD.IP';
let resolveFetch;
let request;
let now = 100000, fetchCalls = 0;
const IG = { st: { balance: 100000, available: 100000, connected: true, env: 'demo' }, on: (t, f) => events[t] = f, isEpic: () => true, envLabel: () => 'TEST', money: String };
const context = vm.createContext({ $, IG, Date: { now: () => now }, document: { querySelectorAll: () => [] }, esc: String, sym: () => epic, Event: class { constructor(type) { this.type = type; } }, fetch: async (_url, options) => { fetchCalls++; request = JSON.parse(options.body); return await new Promise(resolve => resolveFetch = resolve); } });
const amountCode = html.slice(html.indexOf('  // Kontantbelopp behåller'), html.indexOf('  // Pengar för ordern'));
const quoteCode = html.slice(html.indexOf('  async function stakeQuote(direction)'), html.indexOf('  async function renderEst()'));
vm.runInContext('let sq = null, sqKey = "", sqBusy = false, sqRetryKey = "", sqRetryAt = 0;\n' + amountCode + quoteCode, context);
const run = code => vm.runInContext(code, context);
$('ot-amt').value = '125'; $('ot-amt').dispatchEvent({ type: 'input' });
assert.equal(run('pct()'), 0.125);
assert.equal(Math.round(IG.st.balance * run('pct()') / 100 * 100) / 100, 125);
IG.st.balance = 500; events.account();
assert.equal(run('pct()'), 25); assert.equal(run('validPct()'), false);
assert.equal($('ot-amt').value, '125');
$('ot-pct').value = '1'; $('ot-pct').dispatchEvent({ type: 'input' });
assert.equal($('ot-amt').value, '5.00');
IG.st.balance = 1000; events.account(); assert.equal($('ot-amt').value, '10.00');
$('ot-amt').value = '12.50'; $('ot-amt').dispatchEvent({ type: 'input' });
const pending = run('stakeQuote("BUY")');
assert.equal(request.pct, 1.25); assert.equal('stake' in request, false);
assert.equal(await run('stakeQuote("BUY")'), null);
epic = 'CS.D.EURUSD.MINI.IP';
resolveFetch({ json: async () => ({ ok: true, stake: 12.5 }) });
assert.equal(await pending, null); assert.equal(run('sq'), null);
const pendingEnv = run('stakeQuote("BUY")');
IG.st.env = 'live';
resolveFetch({ json: async () => ({ ok: true }) });
assert.equal(await pendingEnv, null);
console.log('PASS: exakt kontantbelopp, kontobyte, saldobyte, procentläge och gamla instrument-/miljösvar; inga nätverksanrop/order');
// Samma fel väntar 30 sekunder; nytt instrument kan ändå beräknas direkt.
const failureRequest = run('stakeQuote("BUY")');
resolveFetch({ json: async () => ({ ok: false, error: 'IG:s läsbudget är slut' }) });
assert.equal((await failureRequest).error, 'IG:s läsbudget är slut');
const callsAtFailure = fetchCalls;
now += 29999;
assert.equal((await run('stakeQuote("BUY")')).error, 'IG:s läsbudget är slut');
assert.equal(fetchCalls, callsAtFailure, 'samma felnyckel får inte pollas inom 30 s');
epic = 'CS.D.ETHUSD.CFD.IP';
const changedInstrument = run('stakeQuote("BUY")');
assert.equal(fetchCalls, callsAtFailure + 1, 'ändrat instrument kan försöka direkt');
resolveFetch({ json: async () => ({ ok: false, error: 'IG:s läsbudget är slut' }) });
await changedInstrument;
now += 30000;
const retry = run('stakeQuote("BUY")');
assert.equal(fetchCalls, callsAtFailure + 2, 'samma nyckel försöker igen efter 30 s');
resolveFetch({ json: async () => ({ ok: true, stake: 12.5 }) });
assert.equal((await retry).ok, true);
assert.equal(run('sqRetryAt'), 0); assert.equal(run('sqRetryKey'), '');
assert.equal((await run('stakeQuote("BUY")')).ok, true);
assert.equal(fetchCalls, callsAtFailure + 2, 'lyckad offert återanvänds');
console.log('PASS: felbackoff 30 s, nytt instrument, återförsök och återställd lyckad offertcache');


// Kör förkontrollen från submit med isolerade svar; kön får aldrig anropas här.
const submitPrefix = html.slice(html.indexOf('  async function submit(side, closeAll)'), html.indexOf('    const body = { symbol: s, side, stakePct: pct()'));
const notices = [];
let preview = { ok: false, reason: 'Minsta kontrakt överstiger budgeten' };
let checkedSide;
const guardContext = vm.createContext({
  CFG: { mode: 'live' }, STATE: { killActive: false }, IG,
  sym: () => epic, validPct: () => true, quoteKey: () => IG.st.env,
  stakeQuote: async side => { checkedSide = side; return preview; },
  alert: value => notices.push(value),
});
vm.runInContext(submitPrefix + '\nreturn "verified"; }', guardContext);
assert.equal(await vm.runInContext('submit("SELL", false)', guardContext), undefined);
assert.equal(checkedSide, 'SELL');
assert.match(notices.at(-1), /Minsta kontrakt/);
preview = { ok: true, error: 'IG:s läsbudget är slut' };
assert.equal(await vm.runInContext('submit("BUY", false)', guardContext), undefined);
assert.match(notices.at(-1), /läsbudget/);
preview = null;
assert.equal(await vm.runInContext('submit("BUY", false)', guardContext), undefined);
preview = { ok: true };
assert.equal(await vm.runInContext('submit("SELL", false)', guardContext), 'verified');
vm.runInContext('stakeQuote = async () => { IG.st.env = "demo"; return {ok: true}; }', guardContext);
assert.equal(await vm.runInContext('submit("BUY", false)', guardContext), undefined);
assert.match(notices.at(-1), /ändrades/);
console.log('PASS: riktningsspecifik förkontroll stoppar otillräcklig marginal, saknad offert och kontobyte före orderkön');
