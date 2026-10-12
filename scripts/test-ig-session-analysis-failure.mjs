// Kör produktionskodens felhantering isolerat, utan mäklare eller modellanrop.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../src/run.ts',import.meta.url),'utf8');
const start=source.indexOf('      try { await runOnce(brokers, engines, instruction, true, ctx.scheduled, epics, out); }');
const end=source.indexOf('      const a = getAnalysis();',start);
assert.ok(start>=0 && end>start);
const fragment=source.slice(start,end);
async function run(initial,reject){
  let analysis=initial, interval='1m', runId='session-test';
  const failure=new Error('isolerat testfel');
  const context={ brokers:{}, engines:[], instruction:'test', ctx:{scheduled:false}, epics:['TEST'], out:{},
    runOnce:async()=>{ if(reject) throw failure; },
    getAnalysis:()=>analysis, analysisEnd:patch=>{ analysis={...analysis,...patch,endedAt:'klar'}; },
    setSessionAnalysisInterval:value=>{interval=value;}, setNotesRunId:value=>{runId=value;} };
  let caught;
  try{ await vm.runInNewContext('(async()=>{'+fragment+'})()',context); }catch(err){caught=err;}
  assert.equal(interval,null); assert.equal(runId,null);
  if(reject) assert.equal(caught,failure); else assert.equal(caught,undefined);
  return analysis;
}
assert.equal((await run({status:'running'},true)).status,'failed');
assert.equal((await run({status:'done'},true)).status,'done');
assert.equal((await run({status:'stopped'},true)).status,'stopped');
assert.equal((await run({status:'running'},false)).status,'running');
console.log('IG-sessionsanalys: 4 felstatus- och städkontroller godkända');
