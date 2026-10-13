// Isolerad sessionskö med fördröjd grind; inga mäklare, modeller eller order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIgSessions } from '../src/server/igSessions.js';

for (const scenario of ['stop', 'environment', 'binding', 'replacement', 'deadline', 'parallel', 'unchanged'] as const) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-session-guard-'));
  let clock = Date.UTC(2026, 9, 12, 12), active: 'demo' | 'live' = 'demo', binding = 'account-a', batches = 0;
  let release!: (why: string | null) => void;
  const wait = new Promise<string | null>(resolve => { release = resolve; });
  const sessions = createIgSessions({ directory, now: () => clock, binding: () => binding, activeEnv: () => active,
    guard: () => wait, runBatch: async () => { batches++; return { picks: [] }; } });
  const initial = sessions.start('demo', { epics: ['CS.D.EURUSD.MINI.IP'], durationMinutes: 15 });
  const running = sessions.runNext('demo');
  if (scenario === 'stop') sessions.stop('demo');
  if (scenario === 'environment') active = 'live';
  if (scenario === 'binding') binding = 'account-b';
  if (scenario === 'deadline') clock += 15 * 60_000;
  if (scenario === 'replacement') { sessions.stop('demo'); sessions.start('demo', { epics: ['CS.D.GBPUSD.MINI.IP'], durationMinutes: 15 }); }
  const other = scenario === 'parallel' ? sessions.runNext('demo') : Promise.resolve();
  release(null);
  await Promise.all([running, other]);
  assert.equal(batches, scenario === 'unchanged' || scenario === 'parallel' ? 1 : 0, scenario);
  const current = sessions.state('demo').session;
  assert(current);
  if (scenario === 'replacement') { assert.notEqual(current.id, initial.id); assert.equal(current.batches, 0); assert.equal(current.status, 'running'); }
  if (scenario === 'environment' || scenario === 'binding') assert.equal(current.status, 'interrupted');
  if (scenario === 'deadline') assert.equal(current.status, 'completed');
}
console.log('PASS: fördröjd sessionsgrind stoppar gamla omgångar vid stopp, miljö-/kontobyte, ersatt session och sluttid; parallella anrop kör högst en omgång');
