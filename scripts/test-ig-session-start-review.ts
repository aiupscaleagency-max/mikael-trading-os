import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createIgWorkspace} from '../src/integrations/igWorkspace.js';
import {createIgSchedules} from '../src/integrations/igSchedules.js';

// Metadata-await simuleras deterministiskt; inga API-anrop, AI-anrop eller order.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ig-start-review-'));
const now=Date.parse('2026-10-07T07:00:00Z');
const status=()=>({environments:{demo:{status:'connected',connectionGeneration:'fixture',account:{currency:'USD'}},live:{status:'missing'}}}) as any;
const input={epics:['EUR'],timeframe:'5m' as const,percent:1,horizonMinutes:15,durationMinutes:15,intervalMinutes:5,maxPositions:1};
try{
 for(const action of ['pause','delete','stop'] as const){
  let entered!:()=>void,release!:(value:any)=>void;
  const waiting=new Promise<void>(resolve=>entered=resolve);
  const data=path.join(root,action,'workspace');
  const workspace=createIgWorkspace({directory:data,now:()=>now,status,call:async(_mode,route)=>{
   assert.equal(route,'markets/EUR');entered();return new Promise(resolve=>release=resolve);
  }});
  const schedules=createIgSchedules({directory:path.join(root,action,'schedules'),now:()=>now,status,guard:async()=>true,start:workspace.startSession});
  const schedule=schedules.save('demo',{...input,localTime:'09:00',weekdays:[3],enabled:true,recurrence:'weekly'});
  const tick=schedules.tick();await waiting;
  if(action==='pause')schedules.enable('demo',schedule.id,false);
  else if(action==='delete')schedules.remove('demo',schedule.id);
  else workspace.stopSession('demo');
  release({instrument:{epic:'EUR',type:'CURRENCIES',currencies:[]},snapshot:{updateTimeUTC:'07:00:00',bid:1,offer:1.1,scalingFactor:1},dealingRules:{}});
  await tick;
  const state=JSON.parse(fs.readFileSync(path.join(data,'demo.json'),'utf8'));
  assert.equal(state.session,null,`${action} under metadata-await får inte skapa session`);
  if(action==='delete')assert.equal(schedules.list('demo').length,0);
  if(action==='pause')assert.equal(schedules.list('demo')[0]?.enabled,false);
 }
 console.log('IG session start review: pause/delete/stop under metadata-await förhindrar sessionsstart');
}finally{fs.rmSync(root,{recursive:true,force:true});}
