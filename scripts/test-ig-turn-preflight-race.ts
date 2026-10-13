// Kör runOnce-funktionen isolerat; ingen serverstart, modell eller mäklare används.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { beginIgTurn, configureIgTurnGuard, currentIgTurn, endIgTurn, igTurnStale } from '../src/server/igTurnGuard.js';
const source = fs.readFileSync(new URL('../src/run.ts', import.meta.url), 'utf8');
const fragment = source.slice(source.indexOf('async function runOnce('), source.indexOf('// ── CLI ──'));
const compiled = ts.transpileModule(fragment, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
class FakeIgBroker { constructor(public env: 'demo' | 'live') {} get mode() { return this.env; } }
for (const scenario of ['environment', 'binding', 'load-state', 'skip', 'kill', 'failure', 'unchanged'] as const) {
  let active: 'demo' | 'live' = 'demo', generation = 'a', orchestration = 0;
  configureIgTurnGuard({ activeEnv: () => active, generation: () => generation });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const sentinel = new Error('isolerat orkestreringsstopp');
  const demo = new FakeIgBroker('demo'), live = new FakeIgBroker('live');
  const context = vm.createContext({ Date, Set, process: { env: {} }, IgBroker: FakeIgBroker,
    getActiveBrokerName: () => active === 'demo' ? 'ig-demo' : 'ig', beginIgTurn, endIgTurn, igTurnStale,
    config: { crypto: { symbols: [] }, stocks: { symbols: [] } }, log: { info() {}, warn() {}, error() {} },
    rememberPrescreen() {}, broadcastEvent() {}, RiskManager: class {},
    jevReviewSymbols: async () => { if (scenario !== 'load-state') await wait; return { kept: scenario === 'skip' ? [] : ['CS.D.EURUSD.MINI.IP'], stopped: [] }; },
    loadState: async () => { if (scenario === 'load-state') await wait; if (scenario === 'failure') throw sentinel; return { killSwitchActive: scenario === 'kill' }; },
    runOrchestratedTurn: async ({ broker }: { broker: unknown }) => { orchestration++; assert.equal(broker, demo); throw sentinel; },
  });
  vm.runInContext(compiled, context);
  const run = vm.runInContext('runOnce', context) as (...args: unknown[]) => Promise<void>;
  const completion = run({ 'ig-demo': demo, ig: live }, [], 'test', true, false, ['CS.D.EURUSD.MINI.IP']).catch(error => { assert.equal(error, sentinel); });
  // Bindningen måste redan finnas medan JEV eller kontotillståndet väntar.
  assert.equal(currentIgTurn()?.env, 'demo', scenario);
  if (scenario === 'environment' || scenario === 'load-state') active = 'live';
  if (scenario === 'binding') generation = 'b';
  release();
  await completion;
  assert.equal(orchestration, scenario === 'unchanged' ? 1 : 0, scenario);
  assert.equal(currentIgTurn(), null, 'Bindningen ska städas även vid tidigt avbrott/fel');
}
console.log('PASS: broker binds före JEV; miljö-/kontobyte före orkestrering avbryts; skip, kill switch och fel städar turbindningen');
