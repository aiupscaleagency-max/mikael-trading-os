import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createIgWorkspace} from '../src/integrations/igWorkspace.js';

// Verklig pipeline med injicerade läsdata/JEV/LLM. Inga order eller leverantörsanrop.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ig-jev-pipeline-'));
const now=Date.parse('2026-10-07T09:00:00Z'),epic='CS.D.EURUSD.CFD.IP';
const selected={epics:[epic],timeframe:'5m' as const,percent:1,horizonMinutes:15};
try{
 for(const scenario of ['veto','unavailable','no-upgrade','generation','budget','cancel','unsupported-strategy-frame'] as const){
  let generation='fixture',allowed=true;const events:string[]=[];let workspace:ReturnType<typeof createIgWorkspace>;
  const timeframe=scenario==='unsupported-strategy-frame'?'1m':'5m',ms=timeframe==='1m'?60000:300000;
  const status=()=>({environments:{demo:{status:'connected',connectionGeneration:generation,account:{currency:'USD',balance:10000}},live:{status:'missing'}}}) as any;
  workspace=createIgWorkspace({directory:path.join(root,scenario),now:()=>now,status,guard:async()=>({allowed,killSwitchActive:false}),call:async(_mode,route,method,_version,_body,extra)=>{
   assert.equal(method,'GET','Pipeline får aldrig lägga order');
   if(route===`markets/${epic}`)return {instrument:{epic,name:'EUR/USD',type:'CURRENCIES',currencies:[],contractSize:'1'},snapshot:{bid:1.1,offer:1.1001,marketStatus:'TRADEABLE',delayTime:0,updateTimeUTC:'09:00:00',scalingFactor:1},dealingRules:{}};
   assert.equal(route,`prices/${epic}`);const count=Number(new URLSearchParams(extra?.query).get('max'));assert.ok(count>=50&&count<=200);
   const half=(v:number)=>({bid:v-0.00001,ask:v+0.00001});
   return {prices:Array.from({length:count},(_,i)=>{const close=1+i/10000;return {snapshotTimeUTC:new Date(now-(count-i)*ms).toISOString().slice(0,19),openPrice:half(close),highPrice:half(close+0.001),lowPrice:half(close-0.001),closePrice:half(close),lastTradedVolume:null};}),metadata:{allowance:{remainingAllowance:1000}}};
  },jevMarket:async observations=>{
   events.push('jev');assert.equal(observations.length,1);assert.equal(observations[0]?.strategyComparisons.length,7,'Alla sju strategier jämförs före JEV');assert.equal(observations[0]?.timeframe,timeframe);
   if(scenario==='generation')generation='changed';if(scenario==='budget')allowed=false;if(scenario==='cancel')workspace.stopSession('demo');
   return {available:scenario!=='unavailable',mode:scenario==='unavailable'?'rules_only':'gateway',route:'gateway',model:'fixture',latencyMs:1,calibrated:false,advisoryOnly:true,canCreateSignal:false,canUpgradeSignal:false,note:'fixture',assessments:scenario==='unavailable'?[]:[{epic,regime:'trending',direction:scenario==='veto'?'down':'up',strategyFit:'aligned',missingData:0,confidence:{regime:0.8,direction:0.8,strategyFit:0.8}}]};
  },llm:async(role,context)=>{
   events.push(role);assert.ok(events.indexOf('jev')<events.indexOf(role));
   const observations=role==='technical'?context.observations:context.technical.observations;assert.equal(observations[0].strategyComparisons.length,7);assert.equal(context.jev.market.available,scenario!=='unavailable');
   if(role==='technical')return {analyses:[{epic,bias:'bullish',signals:[],reason:'fixture'}]};
   return {analyses:[{epic,action:scenario==='no-upgrade'?'HOLD':'BUY',reason:'fixture',entryLevel:1.1,stopLevel:1.09,targetLevel:1.12}],summary:'fixture'};
  }});
  if(['generation','budget','cancel'].includes(scenario)){
   await assert.rejects(workspace.analyze('demo',{...selected,timeframe}));assert.deepEqual(events,['jev'],'Efter konto/budget/stopp får inga agenter startas');
   const saved=JSON.parse(fs.readFileSync(path.join(root,scenario,'demo.json'),'utf8'));assert.equal(saved.pendingOrders.length,0);
  }else{
   const result=await workspace.analyze('demo',{...selected,timeframe});assert.deepEqual(events,['jev','technical','head']);assert.equal(result.execution,'manual_review_only');
   assert.equal(result.head.analyses[0].action,['veto','no-upgrade'].includes(scenario)?'HOLD':'BUY');
   const saved=JSON.parse(fs.readFileSync(path.join(root,scenario,'demo.json'),'utf8'));assert.equal(saved.pendingOrders.length,['veto','no-upgrade'].includes(scenario)?0:1);
  }
 }
 console.log('IG JEV pipeline: sju jämförelser → JEV → två agenter, veto/no-upgrade/fallback, konto/budget/stopp och 1m PASS');
}finally{fs.rmSync(root,{recursive:true,force:true});}
