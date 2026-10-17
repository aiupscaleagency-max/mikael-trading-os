import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {getTiingoStatus} from '../data/tiingoHistory.js';
const execute=promisify(execFile),bundleHash='14758cc73bc9e20c434ceca26bcff84f1864fe93861037e45dc529664d1aea15';
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
export function createIgCourse(deps:{workspace?:string;python?:string;bundle?:string;runtime?:string;downloads?:string;ready?:()=>boolean;run?:(file:string,args:string[],options:any)=>Promise<any>}={}){
 const base=path.join(os.homedir(),'ai_upscale_work/projects/ptqa-trading');
 const workspace=deps.workspace??process.env.PTQA_COURSE_WORKSPACE??path.join(base,'day-1-recording-work');
 const python=deps.python??process.env.PTQA_COURSE_PYTHON??path.join(base,'ptqa-local-environment/venv/bin/python');
 const bundle=deps.bundle??path.resolve('reference/academy/ptqa-runtime-14758cc73bc9.zip'),runtime=deps.runtime??path.resolve('data/ptqa-runtime-14758cc73bc9/runtime');
 const academyHome=process.env.PTQ_ACADEMY_HOME??path.dirname(path.dirname(path.dirname(python)));
 const downloads=deps.downloads??path.join(os.homedir(),'Downloads'),cardFile=path.join(workspace,'day-4-card.png'),refusalFile=path.join(workspace,'backtest-card.txt');
 const specFile=path.join(workspace,'strategy.json'),resultFile=path.join(workspace,'backtest-result.json'),recordFile=path.join(workspace,'ig-day4-run.json');let job:Promise<void>|null=null;
 function read(file:string){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>5_000_000)throw Error('Otillåten kursfil');return fs.readFileSync(file);}
 function json(file:string){return JSON.parse(read(file).toString('utf8'));}
 // Kursens kort ska ligga i Hämtade filer som day-4-card.png (Skool-inlägget). Ett äldre kort med samma namn sparas med datum, och bara ett kort från denna körning kopieras.
 function publishCard(stamp:string){
  if(!fs.existsSync(cardFile))return null;
  const dest=path.join(downloads,'day-4-card.png');fs.mkdirSync(downloads,{recursive:true});
  if(fs.existsSync(dest))fs.copyFileSync(dest,path.join(downloads,'day-4-card-'+stamp+'.png'));
  fs.writeFileSync(dest,read(cardFile));return dest;
 }
 // Varför körningen stoppade, med kursmotorns egna ord: dess NO RESULT-block om det skrevs nu, annars slutet av utskriften. Motorn skriver aldrig ut nycklar.
 function why(error:any){
  try{return read(refusalFile).toString('utf8').trim().slice(-1500);}catch{/* Inget nytt besked från motorn. */}
  const out=[error?.stdout,error?.stderr].map((x)=>String(x??'').trim()).filter(Boolean).join('\n');
  return (out?out.split('\n').slice(-15).join('\n'):String(error?.message??error)).slice(-1500);
 }
 function save(record:any){const temp=recordFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(record,null,2),{mode:0o600,flag:'wx'});fs.renameSync(temp,recordFile);}
 function view(){
  let spec:any;try{spec=json(specFile);}catch{return {status:'blocked',canRun:false,note:'Den sparade Day 3-strategin saknas eller kunde inte läsas på servern.'};}
  let record:any=null,result:any=null;try{record=json(recordFile);result=json(resultFile);}catch{/* Ett saknat resultat får aldrig bli exempelvärden. */}
  const same=record?.status==='completed'&&record.specSha256===digest(read(specFile))&&result&&record.resultSha256===digest(read(resultFile));
  const ready=(deps.ready??(()=>{if(getTiingoStatus().configured)return true;try{const key=json(path.join(academyHome,'keys.json')).tiingo;return typeof key==='string'&&key.trim().length>0;}catch{return false;}}))(),hasPython=fs.existsSync(python),hasBundle=fs.existsSync(bundle),supported=spec.instrument?.data_source==='tiingo',resolved=Array.isArray(spec.unresolved)&&spec.unresolved.length===0;
  const canRun=!job&&hasPython&&hasBundle&&ready&&supported&&resolved;
  const note=job?'Backtest körs med sparade regler och riktiga Tiingo-priser.':same?'Day 4-resultat sparat med oförändrad strategi och indataidentitet. Day 5-granskningen återstår.':!hasPython?'Kursens privata Python-miljö saknas på denna dator.':!ready?'Tiingo är inte konfigurerat på denna dator.':!supported?'Den sparade kursstrategin måste ange Tiingo som källa; inga andra leverantörer startas.':!resolved?'Day 3 har olösta regler; backtest är blockerat.':record?.status==='failed'?'Senaste körningen gav inget resultat. Orsaken visas nedan; inget nytt verifierat resultat finns.':'Inget verifierat Day 4-resultat för den aktuella strategin. Kör backtest före Day 5.';
  const d=same?result.data??{}:null,data=d?{source:d.source,provider:d.provider,adjustment:d.adjustment,start:d.startISO,end:d.endISO,bars:d.bars,costBps:d.costBps}:null;
  return {name:spec.name,symbol:spec.instrument?.symbol,interval:spec.timeframe?.bar,status:job?'running':same?'completed':record?.status==='failed'?'failed':'blocked',canRun,note,metrics:same?result.metrics:null,data,buyAndHoldPct:same?result.context?.buyAndHoldPct??null:null,warnings:same&&Array.isArray(result.warnings)?result.warnings:[],inputIdentity:same?result.inputIdentity:null,reason:!job&&!same&&record?.status==='failed'?record.reason??null:null,card:!job&&(same||record?.status==='failed')?record.card??null:null};
 }
 async function run(){
  if(job)throw Error('Day 4-backtest körs redan');if(!view().canRun)throw Error(view().note);
  if(digest(read(bundle))!==bundleHash)throw Error('Kursmotorns checksumma stämmer inte');
  const specSha256=digest(read(specFile)),stamp=new Date().toISOString().replace(/[:.]/g,'-');
  // Bevara tidigare evidens innan motorn skriver dagens resultat på samma kursplats.
  const backup=path.join(workspace,'backups','day4-'+stamp);fs.mkdirSync(backup,{recursive:true,mode:0o700});
  for(const name of ['strategy.json','rule.json','rule.md','backtest-result.json','backtest-card.txt','day-4-card.png','ig-day4-run.json']){const file=path.join(workspace,name);if(fs.existsSync(file))fs.writeFileSync(path.join(backup,name),read(file),{mode:0o600});}
  // Säkerhetskopierat ovan; tas bort så att bara det denna körning skriver kan visas som dagens resultat, kort eller orsak.
  for(const file of [resultFile,cardFile,refusalFile])if(fs.existsSync(file))fs.unlinkSync(file);
  save({status:'running',specSha256,startedAt:stamp});
  job=Promise.resolve().then(async()=>{
   try{
    const call=deps.run??execute;const env={...process.env,PTQ_QUANT_HOME:workspace,PTQ_ACADEMY_HOME:academyHome};
    fs.mkdirSync(path.dirname(runtime),{recursive:true,mode:0o700});
    await call('/usr/bin/unzip',['-q','-o',bundle,'-d',path.dirname(runtime)],{timeout:30000,maxBuffer:1_000_000});
    await call(python,[path.join(runtime,'day-3/skill/scripts/validate_spec.py'),specFile],{env,timeout:30000,maxBuffer:1_000_000});
    const fingerprint=await call(python,['-c','import json,hashlib,sys; s=json.load(open(sys.argv[1])); print(hashlib.sha256(json.dumps(s,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest())',specFile],{env,timeout:30000,maxBuffer:1000});
    const canonicalHash=String(fingerprint.stdout).trim();if(!/^[a-f0-9]{64}$/.test(canonicalHash))throw Error('Strategins identitet kunde inte verifieras');
    await call(python,[path.join(runtime,'day-4/skill/scripts/run_backtest.py'),'--spec',specFile,'--out',resultFile],{env,timeout:180000,maxBuffer:1_000_000});
    const result=json(resultFile);if(digest(read(specFile))!==specSha256||result.specName!==json(specFile).name||result.inputIdentity?.specSha256!==canonicalHash||!/^[a-f0-9]{64}$/.test(result.inputIdentity?.barsSha256??'')||!result.metrics)throw Error('Resultatets identitet kunde inte verifieras');
    await call(python,[path.join(runtime,'day-4/skill/scripts/make_card.py'),'--workspace',workspace],{env,timeout:30000,maxBuffer:1_000_000});
    const card=publishCard(stamp);if(!card)throw Error('Inget nytt Day 4-kort skapades');
    save({status:'completed',specSha256,resultSha256:digest(read(resultFile)),completedAt:Date.now(),card});
   }catch(error){
    const reason=why(error);let card:string|null=null;
    // Kursens ofullständiga kort (make_card --incomplete) visar ärligt att inget resultat finns; inga gamla siffror följer med.
    try{await (deps.run??execute)(python,[path.join(runtime,'day-4/skill/scripts/make_card.py'),'--workspace',workspace,'--incomplete'],{env:{...process.env,PTQ_QUANT_HOME:workspace,PTQ_ACADEMY_HOME:academyHome},timeout:30000,maxBuffer:1_000_000});}catch{/* Kortet är frivilligt; orsaken sparas ändå. */}
    try{card=publishCard(stamp);}catch{/* Hämtade filer kunde inte nås. */}
    try{save({status:'failed',specSha256,failedAt:Date.now(),reason,card});}catch{/* Ett filfel får inte avsluta handelsservern. */}
   }finally{job=null;}
  });return {started:true};
 }
 return {view,run,wait:()=>job};
}
export const igCourse=createIgCourse();
