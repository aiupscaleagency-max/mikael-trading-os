import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.QT_OFFLINE = '1';
process.env.QT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-test-'));
const { start } = await import('../server.js');
let server, base;
const H = { 'x-qt': '1', 'Content-Type': 'application/json' };

before(async () => { const s = await start(0 || 39000 + Math.floor(Math.random() * 1000)); server = s.server; base = `http://127.0.0.1:${s.port}`; });
after(() => server.close());

test('health and the app page load', async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.ok, true);
  const page = await (await fetch(`${base}/`)).text();
  assert.ok(page.includes('Quant Terminal'));
  const lib = await fetch(`${base}/vendor/lightweight-charts.standalone.production.js`);
  assert.equal(lib.status, 200);
});

test('candles come back sorted with OHLCV', async () => {
  const r = await (await fetch(`${base}/api/candles?symbol=BTCUSDT&tf=1W&limit=50`)).json();
  assert.equal(r.candles.length, 50);
  for (let i = 1; i < r.candles.length; i++) assert.ok(r.candles[i].time > r.candles[i - 1].time);
  assert.ok(['open', 'high', 'low', 'close', 'volume'].every((k) => k in r.candles[0]));
});

test('state round-trips', async () => {
  await fetch(`${base}/api/state`, { method: 'PUT', headers: H, body: JSON.stringify({ watchlists: { Main: ['BINANCE:BTCUSDT'] } }) });
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(s.watchlists, { Main: ['BINANCE:BTCUSDT'] });
});

test('alerts can be created, listed and deleted', async () => {
  const a = await (await fetch(`${base}/api/alerts`, { method: 'POST', headers: H, body: JSON.stringify({ symbol: 'BINANCE:BTCUSDT', tf: '1D', left: 'close', op: '>', right: 1 }) })).json();
  assert.ok(a.id);
  await fetch(`${base}/api/alerts/check`, { method: 'POST', headers: H });
  const log = await (await fetch(`${base}/api/alerts/log`)).json();
  assert.ok(log.some((e) => e.alertId === a.id), 'the alert fired');
  await fetch(`${base}/api/alerts/${a.id}`, { method: 'DELETE', headers: H });
  assert.equal((await (await fetch(`${base}/api/alerts`)).json()).length, 0);
});

test('writes without the app header are refused', async () => {
  const r = await fetch(`${base}/api/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('a custom indicator file can be saved and loaded', async () => {
  const code = "export default { name: 'Double close', calc: (bars, p, ta) => ({ value: ta.source(bars).map((v) => v * 2) }) };";
  const r = await (await fetch(`${base}/api/custom`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Test double close', code }) })).json();
  assert.equal(r.ok, true);
  const list = await (await fetch(`${base}/api/custom`)).json();
  assert.ok(list.some((c) => c.file === 'test-double-close.js'));
  await fetch(`${base}/api/custom/test-double-close.js`, { method: 'DELETE', headers: H });
});

test('screener and scan work', async () => {
  const rows = await (await fetch(`${base}/api/screener?universe=crypto`)).json();
  assert.ok(rows.length > 0);
  const scan = await (await fetch(`${base}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ symbols: ['BTCUSDT'], tf: '1D', indicators: { rsi: { id: 'rsi', params: { length: 14 } } }, rules: [{ left: 'rsi', op: '>', right: 0 }] }) })).json();
  assert.equal(scan[0].pass, true);
});

// ---- regressions from the API fuzz (Oct 2026) ----
const status = async (url, init) => (await fetch(`${base}${url}`, init)).status;

test('client mistakes get a 400, not a 500', async () => {
  assert.equal(await status('/api/candles?symbol=&tf=1D'), 400);
  assert.equal(await status('/api/candles?symbol=BTCUSDT&tf=banana'), 400);
  assert.equal(await status('/api/resolve?symbol='), 400);
  assert.equal(await status('/%E0%A4%A'), 400);
  assert.equal(await status('/api/state', { method: 'PUT', headers: H, body: 'not json' }), 400);
  assert.equal(await status('/api/state', { method: 'PUT', headers: H, body: '[1,2]' }), 400);
  assert.equal(await status('/api/scan', { method: 'POST', headers: H, body: '{"symbols":5,"rules":"x"}' }), 400);
  assert.equal(await status('/api/webhook-test', { method: 'POST', headers: H, body: '{"url":"notaurl"}' }), 400);
});

test('symbols that could reshape an upstream URL are refused', async () => {
  for (const s of ['BINANCE:BTC&interval=1m', 'US:../../admin', ':::', 'A B?C', 'x'.repeat(80)])
    assert.equal(await status(`/api/candles?symbol=${encodeURIComponent(s)}&tf=1D`), 400, s);
  for (const s of ['BTCUSDT', 'EUR/USD', '^FTSE', 'YAHOO:GC=F', 'VOD.L', 'BRK-B'])
    assert.equal(await status(`/api/resolve?symbol=${encodeURIComponent(s)}`), 200, s);
});

test('an opaque Origin is refused with 403, not a crash', async () => {
  assert.equal(await status('/api/state', { method: 'PUT', headers: { ...H, Origin: 'null' }, body: '{}' }), 403);
});

test('alerts with a bad operator, operand or body are refused up front', async () => {
  const post = (b) => status('/api/alerts', { method: 'POST', headers: H, body: JSON.stringify(b) });
  assert.equal(await post('x'), 400);
  assert.equal(await post({ symbol: 'BTCUSDT', right: 1, op: 'bogus' }), 400);
  assert.equal(await post({ symbol: 'BTCUSDT', right: 1, op: '>', left: 'nope' }), 400);
  assert.equal(await post({ symbol: 'BTCUSDT', op: '>', left: 'rsi', right: 70, indicators: { rsi: { id: 'rsi', params: { length: 14 } } } }), 200);
  assert.equal(await status('/api/alerts/doesnotexist', { method: 'PATCH', headers: H, body: '{}' }), 404);
  for (const a of await (await fetch(`${base}/api/alerts`)).json()) await fetch(`${base}/api/alerts/${a.id}`, { method: 'DELETE', headers: H });
});

test('a "once" alert fires once even when checks overlap', async () => {
  const a = await (await fetch(`${base}/api/alerts`, { method: 'POST', headers: H, body: JSON.stringify({ symbol: 'BINANCE:BTCUSDT', tf: '1D', left: 'close', op: '>', right: 1 }) })).json();
  await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/api/alerts/check`, { method: 'POST', headers: H })));
  const log = await (await fetch(`${base}/api/alerts/log`)).json();
  assert.equal(log.filter((e) => e.alertId === a.id).length, 1);
  await fetch(`${base}/api/alerts/${a.id}`, { method: 'DELETE', headers: H });
});

test('static files cannot escape their folder', async () => {
  for (const u of ['/..%2F..%2Fserver.js', '/custom/..%2Fserver.js', '/custom/..%2F..%2F..%2Fetc%2Fpasswd', '/..%5cserver.js'])
    assert.ok([403, 404].includes(await status(u)), u);
});

test('POST /api/shutdown stops a running copy (used by the installer to update)', async () => {
  const { spawn } = await import('node:child_process');
  const port = 41000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), QT_OFFLINE: '1' }, stdio: 'pipe' });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 50 && !out.includes('Open:'); i++) await new Promise((r) => setTimeout(r, 100));
  const actual = Number(/localhost:(\d+)/.exec(out)[1]);
  assert.equal((await fetch(`http://127.0.0.1:${actual}/api/shutdown`, { method: 'POST' })).status, 403, 'needs the app header');
  assert.equal((await fetch(`http://127.0.0.1:${actual}/api/shutdown`, { method: 'POST', headers: { 'x-qt': '1' } })).status, 200);
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
});

test('slash notation: pairs stay pairs, two symbols make a ratio', async () => {
  const r = async (s) => (await (await fetch(`${base}/api/resolve?symbol=${encodeURIComponent(s)}`)).json()).id;
  assert.equal(await r('BTC/USDT'), 'BINANCE:BTCUSDT');
  assert.equal(await r('EUR/USD'), 'FX:EURUSD');
  assert.equal(await r('BTCUSDT/ETHUSDT'), 'SPREAD:BINANCE:BTCUSDT / BINANCE:ETHUSDT');
  const sp = await (await fetch(`${base}/api/candles?symbol=${encodeURIComponent('BTCUSDT/ETHUSDT')}&tf=1D&limit=20`)).json();
  assert.equal(sp.candles.length, 20);
  assert.ok(Math.abs(sp.candles.at(-1).close - 1) < 1e-9, 'offline fixture serves the same bars for both sides');
});

test('multi-condition alerts: all must hold, or any, and five at most', async () => {
  const mk = async (body) => fetch(`${base}/api/alerts`, { method: 'POST', headers: H, body: JSON.stringify({ symbol: 'BTCUSDT', tf: '1D', trigger: 'once', ...body }) });
  const all = await (await mk({ conditions: [{ left: 'close', op: '>', right: 1 }, { left: 'close', op: '<', right: 1 }], match: 'all' })).json();
  const any = await (await mk({ conditions: [{ left: 'close', op: '>', right: 1 }, { left: 'close', op: '<', right: 1 }], match: 'any' })).json();
  const line = await (await mk({ conditions: [{ left: 'close', op: '>', right: { line: { t1: 0, p1: 1, t2: 1, p2: 1, extend: 'right' } } }] })).json();
  await fetch(`${base}/api/alerts/check`, { method: 'POST', headers: H });
  const log = await (await fetch(`${base}/api/alerts/log`)).json();
  assert.ok(!log.some((e) => e.alertId === all.id), 'all: one false condition blocks it');
  assert.ok(log.some((e) => e.alertId === any.id), 'any: one true condition fires it');
  assert.ok(log.some((e) => e.alertId === line.id), 'a drawn line works as a condition');
  const six = await mk({ conditions: Array.from({ length: 6 }, () => ({ left: 'close', op: '>', right: 1 })) });
  assert.equal(six.status, 400);
  for (const a of [all, any, line]) await fetch(`${base}/api/alerts/${a.id}`, { method: 'DELETE', headers: H });
});
