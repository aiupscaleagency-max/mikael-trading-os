// Stängd marknad (2026-10-25): motorn får inte hämta om samma ~200 historikljus varje minut,
// det tömde IG:s veckokvot för historik. Inga externa anrop, inga order eller kontouppgifter.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ig-closed-market-'));
process.env.TRADING_DATA_DIR=dir;
process.env.IG_DEFAULT_WATCH='';
globalThis.fetch=(async()=>{throw new Error('Nätverk förbjudet');}) as typeof fetch;
const {createIgMarketData,CLOSED_REFRESH_MS}=await import('../src/server/igMarketData.js');
const EPIC='CS.D.EURUSD.CEE.IP';
let now=1_800_000_000_000;const calls:string[]=[];
const stream={events:new EventEmitter(),summary:()=>({status:'DISCONNECTED'}),ensure(){}};
const status=()=>({environments:{demo:{status:'connected',credentialsComplete:true},live:{status:'disconnected'}}});
const md=createIgMarketData({now:()=>now,file:e=>path.join(dir,`${e}.json`),status:status as never,stream:stream as never,
  search:(async()=>({markets:[]})) as never,
  candles:(async(_e:string,epic:string)=>{calls.push(epic);return {status:'ready',candles:[{openTime:now-120_000,closeTime:now-60_001,open:1,high:1,low:1,close:1}]};}) as never,
  market:(async(_e:string,epic:string)=>({epic,name:'EUR/USD',quote:{}})) as never});
md.setActiveEnv('demo');
const quote=(marketStatus:string)=>stream.events.emit('quote','demo',{epic:EPIC,bid:1.1,offer:1.1001,observedAt:now,receivedAt:now,delayTime:0,marketStatus});
md.start();
try{
  await md.ensureSeries('demo',EPIC,'1m');
  const first=calls.filter((e)=>e===EPIC).length;
  assert.equal(first,1,'första hämtningen görs');
  quote('EDIT');
  // En timme med stängd marknad, varv var 15:e s, serien följs hela tiden (diagram öppet)
  for(let i=0;i<240;i++){now+=15_000;md.ensureSeries('demo',EPIC,'1m');await md.tick();}
  const closedCalls=calls.filter((e)=>e===EPIC).length-first;
  assert.ok(closedCalls<=Math.ceil(3_600_000/CLOSED_REFRESH_MS),`stängd marknad: högst ${Math.ceil(3_600_000/CLOSED_REFRESH_MS)} hämtningar/h, fick ${closedCalls} (förr ≈ 60)`);
  // Öppen marknad: varje stängt ljus hämtas som förut
  quote('TRADEABLE');
  const before=calls.filter((e)=>e===EPIC).length;
  for(let i=0;i<20;i++){now+=15_000;md.ensureSeries('demo',EPIC,'1m');await md.tick();}
  assert.ok(calls.filter((e)=>e===EPIC).length-before>=3,'öppen marknad hämtar nya ljus som förut');
  console.log('IG-historik: stängd marknad hämtar högst en gång per 30 min och serie, öppen marknad som förut');
}finally{md.stop();}
