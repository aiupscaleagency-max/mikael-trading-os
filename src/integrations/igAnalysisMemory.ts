import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {getIgStatus,getIgAccountIdentity,type IgEnvironment} from './igConnection.js';
interface Identity {accountId:string;generation:string}
interface Status {environments:Record<IgEnvironment,{status:string;connectionGeneration?:string|null;accountId?:string|null;account?:{accountId?:string|null}|null}>}
export interface IgMemoryRecord {requestId:string;at:number;timeframe:string;epics:string[];strategies:{id:string;version:number}[];decisions:{epic:string;action:'BUY'|'SELL'|'HOLD';reason:string}[];jev:{available:boolean;mode:string|null};outcomes:null;outcomeAttribution:'unattributed'}
const unavailable='Analysminnet är otillgängligt; ingen tidigare analys används';
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9._-]{1,100}$/.test(v);
const timeframe=(v:unknown):v is string=>typeof v==='string'&&['1m','3m','5m','15m','30m','1h','4h','1d'].includes(v);
export function createIgAnalysisMemory(deps:{directory?:string;status?:()=>Status;identity?:(mode:IgEnvironment)=>Identity|null;now?:()=>number}={}){
 const directory=deps.directory??path.resolve('data/ig-analysis-memory'),now=deps.now??Date.now;const status:()=>Status=deps.status??getIgStatus;
 function identity(mode:IgEnvironment):Identity|null{if(mode!=='demo'&&mode!=='live')return null;try{const c=status().environments[mode];if(c.status!=='connected')return null;const privateIdentity=deps.identity?deps.identity(mode):deps.status?null:getIgAccountIdentity(mode);const accountId=privateIdentity?.accountId??(deps.status?c.accountId??c.account?.accountId:null),generation=privateIdentity?.generation??c.connectionGeneration;if(typeof accountId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(accountId)||typeof generation!=='string'||!generation)return null;return {accountId,generation};}catch{return null;}}
 function location(mode:IgEnvironment,id:Identity){return path.join(directory,`${mode}-${createHash('sha256').update(`ig-analysis-memory-v1:${mode}:${id.accountId}`).digest('hex')}.json`);}
 function noLinks(){try{if(fs.lstatSync(directory).isSymbolicLink())throw Error('link');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 function prepare(){noLinks();fs.mkdirSync(directory,{recursive:true,mode:0o700});const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('directory');fs.chmodSync(directory,0o700);}
 function text(value:unknown,id:Identity){return (typeof value==='string'?value:'').replaceAll(id.accountId,'[konto]').replace(/(?:CST|XST|api[_ -]?key|password|token)\s*[:=]\s*\S+/gi,'[borttaget]').replace(/[\u0000-\u001f]/g,' ').slice(0,300);}
 function slim(raw:any,id:Identity):IgMemoryRecord|null{
  if(!raw||!validId(raw.requestId)||!Number.isFinite(raw.at)||raw.at<0||!timeframe(raw.timeframe)||!Array.isArray(raw.epics)||raw.epics.length<1||raw.epics.length>10||raw.epics.some((e:any)=>!validId(e)))return null;
  const epics=[...new Set<string>(raw.epics)];
  if(!Array.isArray(raw.decisions)||!Array.isArray(raw.strategies))return null;
  const decisions=raw.decisions.filter((d:any)=>d&&epics.includes(d.epic)&&['BUY','SELL','HOLD'].includes(d.action)).slice(0,10).map((d:any)=>({epic:d.epic,action:d.action as 'BUY'|'SELL'|'HOLD',reason:text(d.reason,id)}));
  const strategies=raw.strategies.filter((s:any)=>s&&validId(s.id)&&Number.isInteger(s.version)&&s.version>=1&&s.version<=1000).slice(0,30).map((s:any)=>({id:s.id,version:s.version}));
  return {requestId:raw.requestId,at:raw.at,timeframe:raw.timeframe,epics,strategies,decisions,jev:{available:raw.jev?.available===true,mode:typeof raw.jev?.mode==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(raw.jev.mode)?raw.jev.mode:null},outcomes:null,outcomeAttribution:'unattributed'};
 }
 function read(mode:IgEnvironment,id:Identity){noLinks();const file=location(mode,id);let fd:number|undefined;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1024*1024||(stat.mode&0o077)!==0)throw Error('private');const value=JSON.parse(fs.readFileSync(fd,'utf8'));if(value.format!=='ig-analysis-memory-v1'||!Array.isArray(value.records)||value.records.length>100)throw Error('shape');const records=value.records.map((r:any)=>slim(r,id));if(records.some((r:any)=>!r))throw Error('shape');return records as IgMemoryRecord[];}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw Error(unavailable);}finally{if(fd!==undefined)fs.closeSync(fd);}}
 function list(mode:IgEnvironment,epics?:string[]){const id=identity(mode);if(!id)return {status:'unavailable' as const,records:[] as IgMemoryRecord[],reason:unavailable};try{const records=read(mode,id).filter(r=>!epics?.length||r.epics.some(e=>epics.includes(e))).sort((a,b)=>b.at-a.at);return {status:'ready' as const,records,reason:null};}catch{return {status:'unavailable' as const,records:[] as IgMemoryRecord[],reason:unavailable};}}
 function record(mode:IgEnvironment,analysis:Record<string,any>){const id=identity(mode);if(!id||analysis?.status!=='completed'||analysis.accountBinding!==id.generation)return {saved:false,status:'unavailable' as const,reason:unavailable};try{
  const selection=analysis.selection,at=analysis.completedAt??now();if(!Number.isFinite(at)||at<0||at>now()+1000)throw Error('time');
  const strategyEntries=(Array.isArray(analysis.technical?.observations)?analysis.technical.observations:[]).flatMap((o:any)=>Array.isArray(o.strategyComparisons)?o.strategyComparisons:o.strategyContext?[o.strategyContext]:[]);
  const strategies=[...new Map<string,{id:string;version:number}>(strategyEntries.filter((s:any)=>s&&validId(s.strategyId)&&Number.isInteger(s.strategyVersion)).map((s:any)=>[`${s.strategyId}:${s.strategyVersion}`,{id:s.strategyId,version:s.strategyVersion}])).values()];
  const projected=slim({requestId:analysis.requestId,at,timeframe:selection?.timeframe,epics:selection?.epics,strategies,decisions:analysis.head?.analyses,jev:{available:analysis.jev?.available,mode:analysis.jev?.mode??analysis.jev?.route}},id);if(!projected||projected.decisions.length!==projected.epics.length||new Set(projected.decisions.map(d=>d.epic)).size!==projected.epics.length)throw Error('projection');
  const previous=read(mode,id);if(previous.some(r=>r.requestId===projected.requestId))return {saved:false,status:'ready' as const,reason:'Analysen finns redan i minnet'};
  prepare();const records=[...previous,projected].slice(-100);let payload=JSON.stringify({format:'ig-analysis-memory-v1',records});while(Buffer.byteLength(payload)>1000000&&records.length>1){records.shift();payload=JSON.stringify({format:'ig-analysis-memory-v1',records});}const file=location(mode,id),temp=`${file}.${randomUUID()}.tmp`;try{fs.writeFileSync(temp,payload,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch{/* En lyckad rename lämnar ingen temporär fil. */}}
  return {saved:true,status:'ready' as const,reason:null};
 }catch{return {saved:false,status:'unavailable' as const,reason:unavailable};}}
 function summary(mode:IgEnvironment,epics?:string[]){const result=list(mode,epics);return {status:result.status,recordCount:result.records.length,recentDecisions:result.records.slice(0,10),reason:result.reason,note:'Lokalt minne av tidigare analysbeslut. Utfallet är inte attribuerat; ingen vinststatistik eller självträning.'};}
 return {list,record,summary};
}
export const igAnalysisMemory=createIgAnalysisMemory();
