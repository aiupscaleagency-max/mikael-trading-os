import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.chdir(mkdtempSync(path.join(os.tmpdir(),'ig-demo-discovery-')));
const {createIgWorkspace}=await import('../src/integrations/igWorkspace.js');
let clock=Date.UTC(2026,9,8,12),generation='demo1',liveConnected=true;
const reads:{mode:string;route:string}[]=[];
const candidates=Array.from({length:6},(_,i)=>({epic:`CR.BTC${i}`,instrumentName:`Bitcoin ${i}`,instrumentType:'CURRENCIES',bid:99999,offer:100000,marketStatus:'CLOSED'}));
const status=()=>({environments:{demo:{status:'connected',connectionGeneration:generation},live:{status:liveConnected?'connected':'configured',connectionGeneration:'live1'}}});
const w=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-demo-state-')),now:()=>clock,status:status as any,call:async(mode,route,method)=>{
 assert.equal(method,'GET');reads.push({mode,route});
 if(route==='categories')return {categories:[{code:'CURRENCIES'}]};
 if(route.startsWith('categories/'))return {instruments:mode==='live'?candidates:[],metadata:{pageNumber:0,pageSize:1000,totalPages:1}};
 if(route==='markets')return {markets:[]};
 if(route.startsWith('markets/')){assert.equal(mode,'demo');return {instrument:{epic:route.slice(8),name:'Bitcoin Demo',type:'CURRENCIES',streamingPricesAvailable:true},snapshot:{bid:101,offer:102,marketStatus:'TRADEABLE',updateTimeUTC:'12:00:00',delayTime:0},dealingRules:{}};}
 throw Error('unexpected');
}});
let r=await w.catalogue('demo','crypto');assert.equal(r.markets.length,0);assert.equal(r.progress?.discovery?.reason,'waiting_live_catalogue');assert.equal(reads.filter(v=>v.mode==='live').length,0,'Demo never recursively queries Live');
await w.catalogue('live','crypto');clock+=61000;r=await w.catalogue('demo','crypto');
assert.equal(r.markets.length,4);assert.equal(r.complete,false);
assert.ok(r.markets.every(m=>m.bid===101&&m.offer===102&&m.name==='Bitcoin Demo'&&m.marketStatus==='TRADEABLE'));
assert.equal(r.progress?.discovery?.pending,2);
assert.equal(reads.filter(v=>v.mode==='demo'&&v.route.startsWith('markets/')).length,4,'actor budget caps candidate probes');
await w.catalogue('demo','crypto');assert.equal(reads.filter(v=>v.route.startsWith('markets/')).length,4,'concurrent/cache repeat does not duplicate probes');
clock+=61000;r=await w.catalogue('demo','crypto');assert.equal(r.markets.length,6);assert.equal(r.progress?.discovery?.pending,0);
generation='demo2';clock+=61000;r=await w.catalogue('demo','crypto');assert.equal(r.markets.length,4,'new account generation cannot reuse previous Demo rows');
liveConnected=false;generation='demo3';clock+=61000;const count=reads.filter(v=>v.mode==='live').length;r=await w.catalogue('demo','crypto');assert.equal(r.markets.length,0);assert.equal(reads.filter(v=>v.mode==='live').length,count,'never connect or query disconnected Live');assert.equal(r.progress?.discovery?.reason,'live_not_connected');
console.log('PASS Demo candidate discovery: actual Demo quotes, budgets, resume, generation isolation, no connection mutation');

// Thirty candidates exceed the five-minute refresh horizon at four probes/min.
{
 let tick=clock;const probes=new Map<string,number>();
 const many=Array.from({length:30},(_,i)=>({...candidates[0],epic:`CR.LONG${i}`}));
 const x=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-demo-fair-')),now:()=>tick,status:status as any,call:async(mode,route)=>{
  if(route==='categories')return {categories:[{code:'CURRENCIES'}]};
  if(route.startsWith('categories/'))return {instruments:mode==='live'?many:[],metadata:{pageNumber:0,pageSize:1000,totalPages:1}};
  if(route==='markets')return {markets:[]};
  if(route.startsWith('markets/')){const epic=route.slice(8);probes.set(epic,(probes.get(epic)??0)+1);if(epic==='CR.LONG0')throw Error('unavailable');return {instrument:{epic,name:'Bitcoin Demo',type:'CURRENCIES'},snapshot:{bid:1,offer:2},dealingRules:{}};}
  throw Error('unexpected');
 }});
 liveConnected=true;await x.catalogue('live','crypto');
 for(let minute=0;minute<8;minute++){const before=[...probes.values()].reduce((a,b)=>a+b,0);await x.catalogue('demo','crypto');const after=[...probes.values()].reduce((a,b)=>a+b,0);assert.ok(after-before<=4);if(minute<7)assert.equal(probes.get('CR.LONG0'),1,'negative probe is not retried ahead of unseen candidates');tick+=61000;}
 assert.equal(probes.size,30,'all thirty EPICs get a first probe before refreshes can starve them');
 assert.ok((probes.get('CR.LONG0')??0)<=2,'expired negative probe may refresh only after all first probes');
 console.log('PASS thirty-candidate fairness over eight minutes, including negative probe and four/min quota');
}
