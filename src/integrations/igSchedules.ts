import {igChanged} from './igEvents.js';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {getIgStatus,type IgEnvironment} from './igConnection.js';
import {canSpend} from '../cost/tracker.js';
import {loadState} from '../memory/store.js';
import {config} from '../config.js';
import {startIgSession,type IgSelection} from './igWorkspace.js';
export interface IgSchedule extends IgSelection {id:string;revision:string;name:string;timezone:'Europe/Stockholm';localTime:string;weekdays:number[];durationMinutes:number;intervalMinutes:number;maxPositions:number;recurrence:"once"|"weekly";date:string|null;enabled:boolean;binding:string;createdAt:number;lastOccurrence:string|null;lastResult:string|null}
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Stockholm',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'});
export function stockholmSlot(at:number){const p=Object.fromEntries(formatter.formatToParts(at).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`,weekday:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(p.weekday!)+1};}
export function createIgSchedules(deps:{status?:typeof getIgStatus;start?:typeof startIgSession;now?:()=>number;directory?:string;guard?:()=>Promise<boolean>}={}){
 const status=deps.status??getIgStatus,start=deps.start??startIgSession,now=deps.now??Date.now,dir=deps.directory??path.resolve('data/ig-schedules');
 const store=new Map<IgEnvironment,IgSchedule[]>();let ticking=false;
 function modeGuard(mode:IgEnvironment){if(mode!=='demo'&&mode!=='live')throw Error('Ogiltig IG-miljö');}
 function binding(mode:IgEnvironment){modeGuard(mode);const c=status().environments[mode];if(c.status!=='connected'||!c.connectionGeneration)throw Error('Anslut IG innan schemat aktiveras');return c.connectionGeneration;}
 function persist(mode:IgEnvironment,rows:IgSchedule[]){fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`${mode}.json`),tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(rows));fs.renameSync(tmp,file);store.set(mode,rows);igChanged(mode);}
 function rows(mode:IgEnvironment){modeGuard(mode);let value=store.get(mode);if(value)return value;try{const parsed=JSON.parse(fs.readFileSync(path.join(dir,`${mode}.json`),'utf8'));if(!Array.isArray(parsed))throw Error('shape');value=parsed.map((s:IgSchedule)=>({...s,enabled:false,lastResult:'Servern startades om; aktivera schemat igen'}));}catch{value=[];}store.set(mode,value!);persist(mode,value!);return value!;}
 function list(mode:IgEnvironment){return JSON.parse(JSON.stringify(rows(mode))) as IgSchedule[];}
 function save(mode:IgEnvironment,input:Partial<IgSchedule>){
  if(input.timezone!==undefined&&input.timezone!=='Europe/Stockholm')throw Error('Scheman använder Europe/Stockholm');
  if(input.recurrence!==undefined&&input.recurrence!=='once'&&input.recurrence!=='weekly')throw Error('Ogiltig upprepning');
  if(!Array.isArray(input.epics)||input.epics.length<1||input.epics.length>10||input.epics.some(e=>typeof e!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(e)))throw Error('Välj 1–10 IG-instrument');
  if(!['1m','3m','5m','15m','30m','1h','4h','1d'].includes(input.timeframe??''))throw Error('Ogiltigt intervall');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime??''))throw Error('Ange lokal tid HH:mm');
  if(input.recurrence==='once'&&(!/^\d{4}-\d{2}-\d{2}$/.test(input.date??'')||new Date(`${input.date}T12:00:00Z`).toISOString().slice(0,10)!==input.date||`${input.date} ${input.localTime}`<=`${stockholmSlot(now()).date} ${stockholmSlot(now()).time}`))throw Error('Välj ett giltigt framtida datum');
  if(input.recurrence!=='once'&&(!Array.isArray(input.weekdays)||!input.weekdays.length||input.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7)))throw Error('Välj veckodagar 1–7');
  if(![15,30,60,120].includes(input.durationMinutes??0)||![1,5,15,30].includes(input.intervalMinutes??0)||!Number.isFinite(input.percent)||input.percent!<0.1||input.percent!>5||![1,5,15,30,60,120].includes(input.horizonMinutes??0))throw Error('Ogiltiga sessionsvillkor');
  const maxPositions=input.maxPositions??1;if(!Number.isInteger(maxPositions)||maxPositions<1||maxPositions>10)throw Error('Ogiltig positionsgräns');
  const existing=rows(mode),old=existing.find(s=>s.id===input.id);if(input.id&&!old)throw Error('Schemat finns inte');if(!old&&existing.length>=20)throw Error('Högst 20 scheman per miljö');
  const enabled=input.enabled===true,b=enabled?binding(mode):'';
  const next:IgSchedule={id:old?.id??randomUUID(),revision:randomUUID(),timezone:'Europe/Stockholm',name:typeof input.name==='string'?input.name.trim().slice(0,80)||'Agentsession':'Agentsession',epics:[...new Set(input.epics)],timeframe:input.timeframe!,percent:input.percent!,horizonMinutes:input.horizonMinutes!,localTime:input.localTime!,weekdays:[...new Set(input.weekdays??[])],recurrence:input.recurrence==='once'?'once':'weekly',date:input.recurrence==='once'?input.date!:null,durationMinutes:input.durationMinutes!,intervalMinutes:input.intervalMinutes!,maxPositions,enabled,binding:b,createdAt:old?.createdAt??now(),lastOccurrence:old?.lastOccurrence??null,lastResult:old?.lastResult??null};
  persist(mode,[...existing.filter(s=>s.id!==next.id),next]);return structuredClone(next);
 }
 function enable(mode:IgEnvironment,id:string,enabled:boolean){if(typeof enabled!=='boolean')throw Error('Ogiltig aktivering');const old=rows(mode).find(s=>s.id===id);if(!old)throw Error('Schemat finns inte');const next={...old,revision:randomUUID(),enabled,binding:enabled?binding(mode):'',lastResult:enabled?'Aktiverat för aktuell IG-anslutning':'Pausat'};persist(mode,rows(mode).map(s=>s.id===id?next:s));return structuredClone(next);}
 function remove(mode:IgEnvironment,id:string){const old=rows(mode);if(!old.some(s=>s.id===id))throw Error('Schemat finns inte');persist(mode,old.filter(s=>s.id!==id));return {deleted:true};}
 async function tick(){if(ticking)return;ticking=true;try{const slot=stockholmSlot(now());for(const mode of ['demo','live'] as const){for(const snapshot of [...rows(mode)]){const s=rows(mode).find(x=>x.id===snapshot.id);if(!s||s.revision!==snapshot.revision||!s.enabled)continue;if(s.recurrence==='once'&&`${s.date} ${s.localTime}`<`${slot.date} ${slot.time}`){persist(mode,rows(mode).map(x=>x.id===s.id?{...x,enabled:false,lastResult:'Missad tid; ingen återspelning (DST-vårhopp hoppas över)'}:x));continue;}let currentBinding='';try{currentBinding=binding(mode);}catch{}if(currentBinding!==s.binding){enable(mode,s.id,false);continue;}if(s.localTime!==slot.time||(s.recurrence==='once'?s.date!==slot.date:!s.weekdays.includes(slot.weekday)))continue;const occurrence=`${slot.date}:${s.localTime}`;if(s.lastOccurrence===occurrence)continue;
 // Spara före start: ingen återspelning efter krasch eller dubbel hösttimme.
 const claimed={...s,lastOccurrence:occurrence,lastResult:'Start begärd'};persist(mode,rows(mode).map(x=>x.id===s.id?claimed:x));
 let result='Session startad · endast analys och manuell granskning';try{const allowed=deps.guard?await deps.guard():!(await loadState()).killSwitchActive&&(await canSpend({dailyCapUsd:config.costCap.dailyUsd,weeklyCapUsd:config.costCap.weeklyUsd})).allowed;if(!allowed)throw Error('Budget eller kill-switch');if(binding(mode)!==s.binding||!rows(mode).some(x=>x.id===s.id&&x.revision===s.revision&&x.enabled&&x.binding===s.binding&&x.lastOccurrence===occurrence))throw Error('Schemat eller anslutningen ändrades');await start(mode,s,()=>rows(mode).some(x=>x.id===s.id&&x.revision===s.revision&&x.enabled&&x.binding===s.binding));}catch{result='Session kunde inte startas; inget nytt försök för denna tid';}
 persist(mode,rows(mode).map(x=>x.id===s.id&&x.revision===s.revision?{...x,lastResult:result,enabled:s.recurrence==='once'?false:x.enabled}:x));}}}finally{ticking=false;}}
 return {list,save,enable,remove,tick};
}
const schedules=createIgSchedules();
export const listIgSchedules=schedules.list,saveIgSchedule=schedules.save,setIgScheduleEnabled=schedules.enable,deleteIgSchedule=schedules.remove,tickIgSchedules=schedules.tick;
