// PTQ connector: translation to PTQ's composer format, and the server routes against a fake PTQ.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EXAMPLE_STRATEGIES } from '../public/lib/backtest.js';

const seen = [];
let killSwitch = { engaged: false };
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : undefined;
    seen.push({ method: req.method, url: req.url, body: json, auth: req.headers.authorization });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/health') return send(200, { ok: true, version: '9.9.9', engine: 'real' });
    if (u.pathname === '/api/markets') return send(200, { items: [{ id: 'BITGET:SPOT:BTCUSDT', history: { status: 'available' } }, { id: 'YAHOO:STOCKS:AAPL', history: { status: 'available' } }] });
    if (u.pathname === '/api/strategies' && req.method === 'POST') return send(200, json);
    if (u.pathname === '/api/backtest/run') return send(200, { id: 'bt_1', provenance: 'real-engine', metrics: { netReturnPct: 4.2, sharpe: 0.6, trades: 30, maxDrawdownPct: 5 } });
    if (u.pathname === '/api/backtest/bt_1/validate') return send(200, { verdict: 'block', pboPct: 71, deflatedSharpe: 0.5, gates: [{ key: 'pbo', label: 'Overfitting (PBO)', value: '71%', pass: false }] });
    if (u.pathname === '/api/portfolio') return send(200, { connected: false, positions: [], message: 'No broker connected' });
    if (u.pathname === '/api/execution/strategy-arms') return send(200, []);
    if (u.pathname === '/api/autopilot') return send(200, { running: true });
    if (u.pathname === '/api/journal') return send(200, []);
    if (u.pathname === '/api/execution/kill-switch' && req.method === 'POST') { killSwitch = { engaged: json.engaged }; return send(200, killSwitch); }
    if (u.pathname === '/api/execution/kill-switch') return send(200, killSwitch);
    if (/\/api\/execution\/strategy-arms\/.+\/disarm$/.test(u.pathname)) return send(200, { ok: true });
    return send(404, { error: 'not in fake' });
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.PTQ_URL = `http://127.0.0.1:${fake.address().port}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-ptq-'));
fs.writeFileSync(path.join(home, 'license.json'), JSON.stringify({ key: 'TOS-x', lease: 'lease-token', exp: Date.now() + 3600e3 }));
process.env.PTQ_HOME = home;
process.env.QT_OFFLINE = '1';
process.env.QT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-ptq-data-'));
const ptq = await import('../lib/ptq.js');
const { start } = await import('../server.js');
let server, base;
const H = { 'x-qt': '1', 'Content-Type': 'application/json' };
before(async () => { const s = await start(41000 + Math.floor(Math.random() * 1000)); server = s.server; base = `http://127.0.0.1:${s.port}`; });
after(() => { server.close(); fake.close(); });

test('the EMA cross example becomes a PTQ composer manifest', () => {
  const { manifest, problems } = ptq.translate(EXAMPLE_STRATEGIES['EMA cross (9/21)'], { tf: '1D', name: 'EMA' });
  assert.deepEqual(problems, []);
  assert.equal(manifest.entryLogic, 'composed');
  assert.equal(manifest.signalTimeframe, '1d');
  assert.deepEqual(manifest.composed.entry.conditions[0], { kind: 'comparison', left: { indicator: 'ema', params: { length: 9 } }, op: 'crosses_above', right: { indicator: 'ema', params: { length: 21 } } });
  assert.equal(manifest.composed.exit.conditions[0].op, 'crosses_below');
});

test('MACD, Bollinger and constants map to the right PTQ terms', () => {
  assert.deepEqual(ptq.toTerm('macd.signal', { macd: { id: 'macd' } }).term, { indicator: 'macd_signal', params: { fast: 12, slow: 26, signal: 9 } });
  assert.deepEqual(ptq.toTerm('bb.upper', { bb: { id: 'bb', params: { length: 20, mult: 2 } } }).term, { indicator: 'bb_upper', params: { length: 20, mult: 2 } });
  assert.deepEqual(ptq.toTerm(30).term, { indicator: 'constant', value: 30 });
  assert.deepEqual(ptq.toTerm('close').term, { indicator: 'close' });
});

test('anything PTQ cannot evaluate is refused with a reason, never approximated', () => {
  const st = ptq.translate(EXAMPLE_STRATEGIES['Supertrend follow'], { tf: '1D' });
  assert.ok(st.problems.some((p) => /Supertrend isn't in PTQ's strategy builder/.test(p)));
  assert.ok(ptq.translate(EXAMPLE_STRATEGIES['EMA cross (9/21)'], { tf: '7m' }).problems.some((p) => /PTQ tests on/.test(p)));
  assert.ok(ptq.toTerm('hl2').error);
  assert.ok(ptq.toTerm('fast', { fast: { id: 'ema', params: { length: 900 } } }).error, 'out of PTQ bounds');
  const crosses = ptq.translate({ indicators: {}, entryLong: [{ left: 'close', op: 'crosses', right: 10 }] }, { tf: '1D' });
  assert.ok(crosses.problems.length);
});

test('the stop loss % is not sent (PTQ\'s engine rejects it on composed strategies)', () => {
  const { manifest, notes } = ptq.translate(EXAMPLE_STRATEGIES['RSI mean reversion (30/55)'], { tf: '1D' });
  assert.equal(manifest.risk.stopPct, undefined);
  assert.ok(notes.some((n) => /stop-loss %/.test(n)));
});

test('status reports the connection and the lease is forwarded', async () => {
  const s = await (await fetch(`${base}/api/ptq/status`)).json();
  assert.equal(s.connected, true);
  assert.equal(s.licensed, true);
  assert.equal(seen.find((r) => r.url === '/api/health').auth, 'Bearer lease-token');
});

test('check creates the strategy, backtests it and validates it in PTQ', async () => {
  const r = await (await fetch(`${base}/api/ptq/check`, { method: 'POST', headers: H, body: JSON.stringify({ strategy: EXAMPLE_STRATEGIES['EMA cross (9/21)'], symbol: 'BINANCE:BTCUSDT', tf: '1D', name: 'EMA' }) })).json();
  assert.equal(r.validation.verdict, 'block');
  assert.equal(r.instrument, 'BITGET:SPOT:BTCUSDT');
  const created = seen.find((x) => x.url === '/api/strategies' && x.method === 'POST');
  assert.equal(created.body.instrument, 'BITGET:SPOT:BTCUSDT');
  assert.ok(r.links.strategy.includes(encodeURIComponent(created.body.id)));
});

test('an untranslatable strategy answers 422 with the reasons', async () => {
  const res = await fetch(`${base}/api/ptq/check`, { method: 'POST', headers: H, body: JSON.stringify({ strategy: EXAMPLE_STRATEGIES['Supertrend follow'], symbol: 'BINANCE:BTCUSDT', tf: '1D' }) });
  assert.equal(res.status, 422);
  assert.ok((await res.json()).problems.length > 0);
});

test('the terminal can only engage PTQ\'s stop, never release it', async () => {
  await fetch(`${base}/api/ptq/kill-switch`, { method: 'POST', headers: H, body: JSON.stringify({ engaged: false }) });
  assert.equal(killSwitch.engaged, true);
  const noHeader = await fetch(`${base}/api/ptq/kill-switch`, { method: 'POST' });
  assert.equal(noHeader.status, 403);
});

test('there is no route to arm a strategy or place an order', async () => {
  for (const p of ['/api/ptq/arm', '/api/ptq/strategies/x/arm', '/api/ptq/execution/submit', '/api/ptq/order']) {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: H, body: '{}' });
    assert.equal(res.status, 404, p);
  }
  assert.ok(!seen.some((r) => /arm$|submit/.test(r.url) && !/disarm/.test(r.url)));
});

test('overview gathers portfolio, arms, autopilot, stop and journal', async () => {
  const o = await (await fetch(`${base}/api/ptq/overview`)).json();
  assert.equal(o.autopilot.running, true);
  assert.ok(Array.isArray(o.arms));
  assert.equal(o.portfolio.connected, false);
});

test('with PTQ not running, status says so plainly', async () => {
  const saved = process.env.PTQ_URL;
  process.env.PTQ_URL = 'http://127.0.0.1:9'; // nothing listens on the discard port
  const mod = await import(`../lib/ptq.js?down=${Date.now()}`);
  process.env.PTQ_URL = saved;
  const s = await mod.status();
  assert.equal(s.connected, false);
  assert.match(s.reason, /ptq serve/);
});

test('either/or exits go to PTQ as an OR group, and the time exit as whole hours', async () => {
  const ptq = await import('../lib/ptq.js');
  const s = { ...EXAMPLE_STRATEGIES['EMA cross (9/21)'], exitLong: [{ left: 'fast', op: 'crossesBelow', right: 'slow' }, { left: 'close', op: '<', right: 'slow' }], exitMatch: 'any', maxBarsInTrade: 10 };
  const h = ptq.translate(s, { tf: '1h' });
  assert.equal(h.manifest.composed.exit.op, 'OR');
  assert.equal(h.manifest.maxHoldingHours, 10);
  const q = ptq.translate(s, { tf: '15m' });
  assert.equal(q.manifest.maxHoldingHours, 3);
  assert.ok(q.notes.some((n) => /3 hours/.test(n)));
  assert.equal(ptq.translate(EXAMPLE_STRATEGIES['EMA cross (9/21)'], { tf: '1h' }).manifest.composed.exit.op, 'AND');
  assert.equal(ptq.translate(EXAMPLE_STRATEGIES['EMA cross (9/21)'], { tf: '1h' }).manifest.maxHoldingHours, 0);
});
