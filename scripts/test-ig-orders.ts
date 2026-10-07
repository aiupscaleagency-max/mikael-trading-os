import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createIgOrders} from '../src/integrations/igOrders.js';
let now=Date.parse('2026-10-07T10:00:00Z'),generation='account-A',enabled=false,killed=false,timeout=false,marketStale=false;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ig-orders-test-'));
const ps:any[]=[];const calls:any[]=[];
const environment=(mode:string)=>({environment:mode,status:'connected',connectionGeneration:`${generation}-${mode}`,account:{accountType:'CFD',available:1000,profitLoss:0,currency:'USD'}});
const status=()=>({environments:{demo:environment('demo'),live:environment('live')}});
const market=async(_mode:string,epic:string)=>({epic,expiry:'-',quote:{bid:100,offer:101,receivedAt:now,observedAt:marketStale?now-60001:now,delayTime:0,marketStatus:'TRADEABLE'},calculationRules:{verified:true,pointValue:1,pointCurrency:'USD',marginRate:.1},dealingRules:{minDealSize:{value:.1},minNormalStopOrLimitDistance:{unit:'POINTS',value:1}}});
let n=0;const call=async(mode:string,route:string,method:string,_version:string,body:any,extra:any)=>{
 calls.push({mode,route,method,body,extra});
 if(route==='workingorders')return {workingOrders:[]};
 if(route==='history/transactions')return {transactions:[],metadata:{pageData:{totalPages:1}}};
 if(method==='POST'){if(timeout)throw Error('mock timeout');n++;return {dealReference:`ref-${n}`};}
 if(route.startsWith('confirms/'))return {dealStatus:'ACCEPTED',dealId:'opened-deal',affectedDeals:[{dealId:'opened-deal',status:'DELETED'}]};
 throw Error('Unexpected mock call');
};
const deps={status:status as never,accounts:async()=>({}) as never,positions:async()=>({status:'ready',positions:ps}) as never,market,call:call as never,guard:async()=>({killSwitchActive:killed}),now:()=>now,directory,enabled:()=>enabled,positionLimit:()=>3,limits:{maxPositionUsd:1000,maxTotalExposureUsd:3000,maxDailyLossUsd:100,maxOpenPositions:3}};
const orders=createIgOrders(deps),ticket={epic:'CS.D.EURUSD.MINI.IP',direction:'BUY',size:1,entry:101,stopLevel:95,targetLevel:110,orderType:'MARKET',holdingMinutes:15,autoClose:true};
const draft=await orders.preview('demo',ticket);assert.equal(draft.risk,6);assert.equal(calls.some(c=>c.method==='POST'),false,'Granskning skickar aldrig order');
await assert.rejects(orders.confirm('demo',draft.id),/avstängd/);enabled=true;
const order=await orders.confirm('demo',draft.id);assert.equal(order.status,'accepted');assert.equal(calls.filter(c=>c.method==='POST').length,1);
await assert.rejects(orders.confirm('demo',draft.id),/redan behandlat/);assert.equal(calls.filter(c=>c.method==='POST').length,1,'Dubbelklick omsänder aldrig order');
assert.equal(orders.snapshot('live').pendingOrders.length,0,'IG Demo blandas aldrig med Live');
ps.push({dealId:'opened-deal',epic:ticket.epic,direction:'BUY',size:1,level:101});
assert.equal(orders.snapshot('demo',ps).pendingOrders.length,0,'Accepterad order blir position endast via mäklarens positionslista');
const previous=orders.snapshot('demo').exitPlans[0]!.closeAt;
const roll=await orders.rollover('demo','opened-deal',15);assert.equal(roll.closeAt,previous+15*60000);
const closed=await orders.close('demo','opened-deal');assert.equal(closed.status,'confirmed');assert.equal(calls.at(-2).extra._method,'DELETE');
await assert.rejects(orders.close('demo','opened-deal'),/redan begärd/);
marketStale=true;await assert.rejects(orders.preview('demo',ticket),/inaktuell/);marketStale=false;
killed=true;await assert.rejects(orders.preview('demo',ticket),/kill switch/);killed=false;
const changed=await orders.preview('demo',ticket);generation='account-B';await assert.rejects(orders.confirm('demo',changed.id),/ändrades/);
const unknown=await orders.preview('demo',ticket);timeout=true;const result=await orders.confirm('demo',unknown.id);assert.equal(result.status,'unknown');await assert.rejects(orders.confirm('demo',unknown.id),/redan behandlat/);timeout=false;
await assert.rejects(orders.preview('demo',ticket),/avstämmas/);
const clean=createIgOrders({...deps,directory:path.join(directory,'clean')});
const limit=await clean.preview('demo',{...ticket,orderType:'LIMIT',entry:99,autoClose:false});await clean.confirm('demo',limit.id);assert.ok(calls.some(c=>c.route==='workingorders/otc'&&c.method==='POST'));
const restart=createIgOrders({...deps,directory});assert.equal(restart.snapshot('demo').exitPlans.some(p=>p.status==='scheduled'),false,'Ingen automatisk tidsstängning återupptas efter omstart');
console.log('PASS: serverräknad risk, befintliga gränser, kill switch, färska priser, preview utan order, explicit flagga, bekräftelse, idempotens, okänt utfall utan omsändning, Demo/Live, limit, stängningsbekräftelse och rollover; enbart mockade IG-anrop');

// En äldre tidsplan får inte återaktiveras efter en ny IG-kontosession.
const reconnect=createIgOrders({...deps,directory:path.join(directory,'reconnect')});
const rcDraft=await reconnect.preview('demo',ticket);await reconnect.confirm('demo',rcDraft.id);
const countBefore=calls.filter(c=>c.method==='POST').length;generation='account-C';now+=16*60000;await reconnect.tick();assert.equal(calls.filter(c=>c.method==='POST').length,countBefore,'Reconnect skickar ingen gammal tidsstängning');
assert.ok(JSON.parse(fs.readFileSync(path.join(directory,'reconnect/demo.json'),'utf8')).plans.every((p:any)=>p.status==='interrupted'));
console.log('PASS: reconnect avbryter gamla tidsplaner utan stängningsanrop');

// Ett okänt orderutfall förblir spärrat även efter en ny anslutning.
generation='account-D';assert.ok(orders.snapshot('demo').pendingOrders.some(d=>d.status==='unknown'&&d.previousConnection));await assert.rejects(orders.preview('demo',ticket),/avstämmas/);
// Tidsgränsen kontrolleras efter en långsam riskvalidering.
let slow=false;const expiry=createIgOrders({...deps,directory:path.join(directory,'expiry'),accounts:(async()=>{if(slow)now+=31000;return {};}) as never});
const exp=await expiry.preview('demo',ticket);slow=true;const beforeExpiry=calls.filter(c=>c.method==='POST').length;await assert.rejects(expiry.confirm('demo',exp.id),/hann gå ut/);assert.equal(calls.filter(c=>c.method==='POST').length,beforeExpiry);
console.log('PASS: okänt orderutfall spärrar efter reconnect och utgånget underlag skickas inte');

await assert.rejects(clean.preview('demo',{...ticket,orderType:'LIMIT',entry:99}),/manuell stängning/);

assert.equal((await clean.brokerPending('demo','older-binding')).status,'unavailable','Workingorders får inte blandas mellan anslutningsgenerationer');
