import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {getIgStatus,type IgEnvironment} from './igConnection.js';

export interface IgImportedSignalInput {epic:string;sourceText:string;direction:'BUY'|'SELL';entryLevel:number;stopLevel:number;targetLevel:number;validUntil:number}
export interface IgImportedSignal extends IgImportedSignalInput {id:string;environment:IgEnvironment;generation:string;createdAt:number;source:'user_pasted_IG_unverified';status:'unverified_draft';copyable:false;executable:false}
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0;
function validateInput(input:IgImportedSignalInput,now:number,checkExpiry=true){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Ogiltig IG-signal');
 if(typeof input.epic!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(input.epic))throw Error('Ogiltigt IG-instrument');
 if(typeof input.sourceText!=='string'||!input.sourceText.trim()||input.sourceText.length>12000)throw Error('IG-signaltext måste innehålla 1–12000 tecken');
 if(input.direction!=='BUY'&&input.direction!=='SELL')throw Error('Välj BUY eller SELL för IG-signalen');
 if(![input.entryLevel,input.stopLevel,input.targetLevel].every(positive))throw Error('IG-signalens priser måste vara positiva ändliga tal');
 if(input.direction==='BUY'?!(input.stopLevel<input.entryLevel&&input.targetLevel>input.entryLevel):!(input.stopLevel>input.entryLevel&&input.targetLevel<input.entryLevel))throw Error('IG-signalens stopp och mål ligger på fel sida om entry');
 if(!positive(input.validUntil)||(checkExpiry&&(input.validUntil<=now||input.validUntil>now+24*60*60*1000)))throw Error('IG-signalens giltighet måste vara i framtiden, högst 24 timmar');
}
/** Inklistrad text lagras enbart som data. Modulen har ingen order- eller agentkoppling. */
export function createIgImportedSignals(deps:{status?:typeof getIgStatus;now?:()=>number;directory?:string}={}){
 const status=deps.status??getIgStatus,now=deps.now??Date.now,directory=deps.directory??path.resolve('data/ig-imported-signals');
 function file(mode:IgEnvironment){if(mode!=='demo'&&mode!=='live')throw Error('Ogiltig IG-miljö');return path.join(directory,`${mode}.json`);}
 function read(mode:IgEnvironment):IgImportedSignal[]{
  const dest=file(mode);if(!fs.existsSync(dest))return [];
  try{const data:unknown=JSON.parse(fs.readFileSync(dest,'utf8'));if(!Array.isArray(data)||data.length>100)throw Error('shape');
   for(const record of data){validateInput(record,now(),false);if(record.environment!==mode||typeof record.id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(record.id)||typeof record.generation!=='string'||!record.generation||!positive(record.createdAt)||record.source!=='user_pasted_IG_unverified'||record.status!=='unverified_draft'||record.copyable!==false||record.executable!==false)throw Error('shape');}
   return data;
  }catch{throw Error('IG-signalarkivet kunde inte verifieras; inga utkast ändrades');}
 }
 function persist(mode:IgEnvironment,rows:IgImportedSignal[]){fs.mkdirSync(directory,{recursive:true});const dest=file(mode),temp=`${dest}.${process.pid}.${randomUUID()}.tmp`;try{fs.writeFileSync(temp,JSON.stringify(rows),{mode:0o600});fs.renameSync(temp,dest);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
 function generation(mode:IgEnvironment){file(mode);const connection=status().environments[mode];return connection.status==='connected'&&typeof connection.connectionGeneration==='string'&&connection.connectionGeneration?connection.connectionGeneration:null;}
 function list(mode:IgEnvironment){const current=generation(mode),time=now();return read(mode).map(row=>({...row,stale:!current||row.generation!==current,expired:row.validUntil<=time}));}
 function save(mode:IgEnvironment,input:IgImportedSignalInput){file(mode);const current=generation(mode);if(!current)throw Error('IG måste vara anslutet innan en signal sparas');const time=now();validateInput(input,time);
  const rows=read(mode);if(rows.length>=100)throw Error('IG-signalarkivet är fullt; ta bort ett utkast först');
  const row:IgImportedSignal={id:randomUUID(),environment:mode,generation:current,createdAt:time,epic:input.epic,sourceText:input.sourceText,direction:input.direction,entryLevel:input.entryLevel,stopLevel:input.stopLevel,targetLevel:input.targetLevel,validUntil:input.validUntil,source:'user_pasted_IG_unverified',status:'unverified_draft',copyable:false,executable:false};
  if(generation(mode)!==current)throw Error('IG-kontoanslutningen ändrades; spara signalen igen');persist(mode,[...rows,row]);return {...row,stale:false,expired:false};
 }
 function remove(mode:IgEnvironment,id:string){if(typeof id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(id))throw Error('Ogiltigt IG-signal-ID');const rows=read(mode);if(!rows.some(row=>row.id===id))throw Error('IG-signalen finns inte');persist(mode,rows.filter(row=>row.id!==id));return {deleted:true};}
 return {list,save,remove};
}
const imported=createIgImportedSignals();
export const listIgImportedSignals=imported.list,saveIgImportedSignal=imported.save,deleteIgImportedSignal=imported.remove;
