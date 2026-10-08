import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createIgSchedules} from '../src/integrations/igSchedules.js';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ig-capacity-'));
let starts=0,guards=0;const now=Date.parse('2026-10-07T07:00:00Z');
const service=createIgSchedules({directory,now:()=>now,status:()=>({environments:{demo:{status:'connected',connectionGeneration:'same'},live:{status:'disconnected'}}}) as any,guard:async()=>{guards++;return true;},start:async()=>{starts++;return {} as any;}});
const epics=Array.from({length:200},(_,i)=>`FX.${i}`);
const input={epics,timeframe:'1m' as const,percent:1,horizonMinutes:5,durationMinutes:60,intervalMinutes:5,localTime:'09:00',weekdays:[3],enabled:true,marginPercent:1,maxTrades:5};
assert.throws(()=>service.save('demo',input),/kräver uppdatering/);
const valid=service.save('demo',{...input,intervalMinutes:1});assert.equal(valid.epics.length,200);
assert.equal(service.save('demo',{...input,epics:Array.from({length:300},(_,i)=>`FX.${i}`),intervalMinutes:1}).epics.length,300);
assert.throws(()=>service.save('demo',{...input,epics:Array.from({length:301},(_,i)=>`FX.${i}`),intervalMinutes:1}),/kräver uppdatering/);
// A previously enabled legacy row preserves its original interval and order
// policy while existing restart safety pauses it. Re-enabling is rejected.
const legacy={...valid,intervalMinutes:5,enabled:true};fs.writeFileSync(path.join(directory,'demo.json'),JSON.stringify([legacy]));
const reloaded=createIgSchedules({directory,now:()=>now,status:()=>({environments:{demo:{status:'connected',connectionGeneration:'same'},live:{status:'disconnected'}}}) as any,guard:async()=>{guards++;return true;},start:async()=>{starts++;return {} as any;}});
const row=reloaded.list('demo')[0];assert.equal(row.intervalMinutes,5);assert.equal(row.marginPercent,1);assert.equal(row.maxTrades,5);assert.match(row.capacityError!,/kräver uppdatering/);assert.equal(row.enabled,false,'existing restart safety remains');
assert.throws(()=>reloaded.enable('demo',row.id,true),/kräver uppdatering/);
await reloaded.tick();assert.equal(starts,0);assert.equal(guards,0,'legacy invalid capacity never reaches model/budget work');
console.log('PASS schedule capacity validation, 200/60/5 legacy unchanged and blocked, 300 boundary, no automatic model calls');
