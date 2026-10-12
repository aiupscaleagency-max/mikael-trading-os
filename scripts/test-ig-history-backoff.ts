// Isolerad historikbackoff: inga externa anrop, inga order eller kontouppgifter.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ig-history-backoff-'));
process.env.TRADING_DATA_DIR=dir;
globalThis.fetch=(async()=>{throw new Error('Nätverk förbjudet');}) as typeof fetch;
const {createIgMarketData}=await import('../src/server/igMarketData.js');
const {beginIgAnalysis}=await import('../src/integrations/igAnalysisGate.js');
const {IG_HISTORY_RATE_ERROR,IG_HISTORY_BLOCK_MS}=await import('../src/integrations/igConnection.js');
let now=1_800_000_000_000,calls=0,mode='throw';
const md=createIgMarketData({now:()=>now,file:e=>path.join(dir,`${e}.json`),
  stream:{events:new EventEmitter(),summary:()=>({status:'DISCONNECTED'}),ensure(){}} as never,
  candles:(async()=>{calls++; if(mode==='throw')throw new Error(IG_HISTORY_RATE_ERROR); if(mode==='unavailable')return {status:'unavailable',error:'historik saknas',candles:[]};return {status:'ready',candles:[{openTime:now-120000,closeTime:now-60001,open:1,high:2,low:1,close:2}]};}) as never,
  market:(async(_e:string,epic:string)=>({epic,name:'Test',quote:{}})) as never});
await md.refreshHistory('demo','TEST','1m'); assert.equal(calls,1);
now+=60_000; await md.refreshHistory('demo','TEST','1m'); assert.equal(calls,1,'historikkvot respekterar lång backoff');
now+=IG_HISTORY_BLOCK_MS;mode='ready';await md.refreshHistory('demo','TEST','1m');assert.equal(calls,2);
assert.equal(md.closed('TEST','1m','demo').length,1);
mode='unavailable';await md.refreshHistory('demo','TEST','1m');assert.equal(calls,3);
now+=15_000;await md.refreshHistory('demo','TEST','1m');assert.equal(calls,3,'unavailable får också backoff med befintliga ljus');
now+=45_000;mode='ready';await md.refreshHistory('demo','TEST','1m');assert.equal(calls,4);
const release=beginIgAnalysis('demo');
try{await md.refreshHistory('demo','TEST','1m');assert.equal(calls,4,'bakgrundshistorik vilar under analys');
  await md.refreshHistory('live','TEST','1m');assert.equal(calls,5,'annan miljö pausas inte');
}finally{release();}
await md.refreshHistory('demo','TEST','1m');assert.equal(calls,6,'historiken fortsätter efter analys');
console.log('IG-historik: kvotbackoff, unavailable, befintliga ljus och miljöseparerad analysvila godkända');
