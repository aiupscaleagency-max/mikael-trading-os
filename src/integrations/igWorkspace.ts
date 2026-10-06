import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {callIgAuthenticated,getIgStatus,getIgPositions,getIgAccounts,type IgEnvironment} from "./igConnection.js";
import {createLlmClient,extractJson,modelFor} from "../llm/gateway.js";
import {trackClaudeCall,canSpend} from "../cost/tracker.js";
import {askJev} from "../server/jevClient.js";
import {runTwoAgentPipeline} from "../orchestrator/twoAgentPipeline.js";
import {sma,rsi,ema} from "../indicators/ta.js";
import {loadState} from "../memory/store.js";
import {config} from "../config.js";

const frames={"1m":{resolution:"MINUTE",ms:60000},"3m":{resolution:"MINUTE_3",ms:180000},"5m":{resolution:"MINUTE_5",ms:300000},"15m":{resolution:"MINUTE_15",ms:900000},"30m":{resolution:"MINUTE_30",ms:1800000},"1h":{resolution:"HOUR",ms:3600000},"4h":{resolution:"HOUR_4",ms:14400000},"1d":{resolution:"DAY",ms:86400000}} as const;
export type IgTimeframe=keyof typeof frames;
export interface IgSelection {epics:string[];timeframe:IgTimeframe;percent:number;horizonMinutes:number}
export interface IgSession extends IgSelection {id:string;environment:IgEnvironment;startedAt:number;endsAt:number;intervalMinutes:number;nextRunAt:number;status:"running"|"stopped"|"completed"|"interrupted";analyses:number;lastError:string|null}
export interface IgCandle {openTime:number;closeTime:number;open:number;high:number;low:number;close:number;volume:number|null}
interface WorkspaceState {connectionGeneration?:string|null;selection:IgSelection;session:IgSession|null;analysis:Record<string,any>|null;pendingOrders:Record<string,any>[]}
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const metadataNumber=(v:unknown):number|null=>typeof v==="string"&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim())?num(Number(v)):num(v);
const str=(v:unknown):string|null=>typeof v==="string"&&v.length<=250?v:null;
const safeErrors=new Set(["IG-budgetgränsen är nådd; inga AI-anrop startas","IG-analys är stoppad av kill-switch","IG-kontoanslutningen ändrades under analysen","Analys saknas i teknisk IG-rapport","Analys saknas för något valt IG-instrument","Analys saknas i Hannas IG-rapport","Analys kräver minst 20 verifierade stängda IG-ljus"]);
const errorText=(e:unknown)=>e instanceof Error && safeErrors.has(e.message)?e.message:"IG-underlaget eller analysen kunde inte verifieras; inga order skickades";
function modeGuard(mode:unknown):asserts mode is IgEnvironment {if(mode!=="demo"&&mode!=="live")throw Error("Ogiltig IG-miljö");}
function epicGuard(epic:unknown):asserts epic is string {if(typeof epic!=="string"||!/^[A-Za-z0-9._-]{1,100}$/.test(epic))throw Error("Ogiltig IG-epic");}
function selectionGuard(input:Partial<IgSelection>,allowEmpty=false):IgSelection {
  if(!Array.isArray(input.epics)||(!allowEmpty&&input.epics.length<1)||input.epics.length>10)throw Error("Välj 1–10 verkliga IG-instrument");
  for(const epic of input.epics)epicGuard(epic);
  if(!input.timeframe||!Object.hasOwn(frames,input.timeframe))throw Error("Ogiltigt IG-intervall");
  const percent=input.percent??1,horizonMinutes=input.horizonMinutes??15;
  if(!Number.isFinite(percent)||percent<0.1||percent>5||![1,5,15,30,60,120].includes(horizonMinutes))throw Error("Ogiltig IG-riskprocent eller horisont");
  return {epics:[...new Set(input.epics)],timeframe:input.timeframe,percent,horizonMinutes};
}
/** IG:s snapshotTime är lokal tid; endast snapshotTimeUTC får användas som UTC-ljusklocka. */
export function normalizeIgCandles(prices:unknown,timeframe:IgTimeframe,now:number) {
  const frame=frames[timeframe];if(!frame)throw Error("Ogiltigt IG-intervall");
  if(!Array.isArray(prices))throw Error("IG returnerade inget historiskt prisunderlag");
  const candles:IgCandle[]=[],seen=new Set<number>();let rejected=0,forming=0;
  for(const p of prices) {
    const date=typeof p?.snapshotTimeUTC==="string"?p.snapshotTimeUTC.replace(/\//g,"-").replace(" ","T"):"";
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(date)){rejected++;continue;}
    const openTime=Date.parse(date.endsWith("Z")?date:`${date}Z`),closeTime=openTime+frame.ms;
    if(!Number.isFinite(openTime) || new Date(openTime).toISOString().slice(0,19)!==date.slice(0,19)){rejected++;continue;}if(closeTime>now){forming++;continue;}
    const midpoint=(v:any)=>num(v?.bid)!==null&&num(v?.ask)!==null&&(v.bid>0&&v.ask>=v.bid)?(v.bid+v.ask)/2:null;
    const open=midpoint(p.openPrice),high=midpoint(p.highPrice),low=midpoint(p.lowPrice),close=midpoint(p.closePrice);
    if(open===null||high===null||low===null||close===null||high<Math.max(open,close)||low>Math.min(open,close)||seen.has(openTime)){rejected++;continue;}
    seen.add(openTime);candles.push({openTime,closeTime,open,high,low,close,volume:num(p.lastTradedVolume)});
  }
  candles.sort((a,b)=>a.openTime-b.openTime);
  return {candles,rejected,forming};
}
export function createIgWorkspace(deps:{call?:typeof callIgAuthenticated;status?:typeof getIgStatus;positions?:typeof getIgPositions;accounts?:typeof getIgAccounts;now?:()=>number;directory?:string;guard?:()=>Promise<{allowed:boolean;killSwitchActive:boolean}>;jev?:(context:Record<string,unknown>)=>Promise<unknown>;llm?:(role:"technical"|"head",context:Record<string,any>)=>Promise<Record<string,any>>}={}) {
  const call=deps.call??callIgAuthenticated,status=deps.status??getIgStatus,positions=deps.positions??getIgPositions,accounts=deps.accounts??getIgAccounts,now=deps.now??Date.now;
  const directory=deps.directory??path.resolve("data/ig-workspace");
  const states=new Map<IgEnvironment,WorkspaceState>(),cache=new Map<string,{at:number,value:any}>(),pending=new Map<string,Promise<any>>(),busy=new Set<IgEnvironment>();
  let rateWindow=0,rateCount=0;
  function state(mode:IgEnvironment):WorkspaceState {
    modeGuard(mode);let s=states.get(mode);if(s)return s;
    try {s=JSON.parse(fs.readFileSync(path.join(directory,`${mode}.json`),"utf8"));if(!s||!s.selection||!Array.isArray(s.pendingOrders))throw Error("shape");
      if(s.selection.epics.length)selectionGuard(s.selection);if(s.session?.status==="running")s.session.status="interrupted";
    } catch {s={selection:{epics:[],timeframe:"5m",percent:1,horizonMinutes:15},session:null,analysis:null,pendingOrders:[]};}
    states.set(mode,s!);return s!;
  }
  function persist(mode:IgEnvironment,next:WorkspaceState) {fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,`${mode}.json`),temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(next));fs.renameSync(temp,file);states.set(mode,next);}
  const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
  const connectionIdentity=(mode:IgEnvironment)=>{const c=status().environments[mode];return c.status==="connected" ? c.connectionGeneration ?? `${c.checkedAt}:${c.account?.accountId}` : null;};
  async function cached<T>(key:string,ttl:number,job:()=>Promise<T>):Promise<T> {
    const environment=key.split(":")[1] as IgEnvironment,identity=connectionIdentity(environment);
    key=`${key}:account:${identity}`;
    const prev=cache.get(key);if(prev&&now()-prev.at<ttl)return clone(prev.value);
    const running=pending.get(key);if(running)return clone(await running);
    if(now()-rateWindow>=60000){rateWindow=now();rateCount=0;}if(rateCount>=40)throw Error("IG-läsbudgeten är slut för denna minut");rateCount++;
    const promise=job();pending.set(key,promise);try{const value=await promise;if(connectionIdentity(environment)!==identity)throw Error("IG-kontosessionen ändrades under hämtningen");cache.set(key,{at:now(),value});return clone(value);}finally{if(pending.get(key)===promise)pending.delete(key);}
  }
  function connected(mode:IgEnvironment){
    modeGuard(mode);if(status().environments[mode].status!=="connected")throw Error("IG-miljön är inte ansluten; verifiera credentials och anslut först");
    const identity=connectionIdentity(mode),current=state(mode);
    if(current.connectionGeneration!==identity){
      const session=current.session?.status==="running"?{...current.session,status:"interrupted" as const,lastError:"IG-kontoanslutningen ändrades; starta ny session"}:current.session;
      persist(mode,{...current,connectionGeneration:identity,session,analysis:current.analysis?{...current.analysis,status:"stale",error:"IG-kontoanslutningen ändrades"}:null,pendingOrders:current.pendingOrders.map(o=>({...o,status:"stale",blocker:"IG-kontoanslutningen ändrades; förslaget måste göras om"}))});
    }
  }
  async function searchMarkets(mode:IgEnvironment,term:string) {
    connected(mode);if(typeof term!=="string"||term.trim().length<2||term.length>80)throw Error("Ogiltig IG-sökning");
    return cached(`search:${mode}:${term}`,60000,async()=>{
      const data=await call(mode,"markets","GET","1",undefined,{query:new URLSearchParams({searchTerm:term.trim()}).toString()});
      if(!Array.isArray(data.markets))throw Error("IG-marknadskatalogen kunde inte verifieras");
      return {environment:mode,status:"ready",error:null,markets:data.markets.filter((m:any)=>typeof m.epic==="string").map((m:any)=>({epic:m.epic,name:str(m.instrumentName),type:str(m.instrumentType),expiry:str(m.expiry),bid:num(m.bid),offer:num(m.offer),marketStatus:str(m.marketStatus),streamingPricesAvailable:m.streamingPricesAvailable===true,delayTime:num(m.delayTime)})),updatedAt:now()};
    });
  }
  async function market(mode:IgEnvironment,epic:string) {
    connected(mode);epicGuard(epic);
    return cached(`market:${mode}:${epic}`,15000,async()=>{
      const data=await call(mode,`markets/${epic}`,"GET","3");
      if(data.instrument?.epic!==epic || !data.snapshot || !data.dealingRules)throw Error("IG-instrumentet kunde inte verifieras");
      const i=data.instrument,s=data.snapshot;
      return {environment:mode,epic,name:str(i.name),type:str(i.type),expiry:str(i.expiry),status:"ready",error:null,
        quote:{bid:num(s.bid),offer:num(s.offer),marketStatus:str(s.marketStatus),delayTime:num(s.delayTime),updateTimeUTC:str(s.updateTimeUTC),receivedAt:now(),source:"IG REST snapshot"},
        instrument:{epic,type:str(i.type),expiry:str(i.expiry),unit:str(i.unit),contractSize:metadataNumber(i.contractSize),lotSize:metadataNumber(i.lotSize),valueOfOnePip:metadataNumber(i.valueOfOnePip),onePipMeans:str(i.onePipMeans),scalingFactor:num(s.scalingFactor),decimalPlacesFactor:num(s.decimalPlacesFactor),marginFactor:num(i.marginFactor),marginFactorUnit:str(i.marginFactorUnit),marginDepositBands:clone(i.marginDepositBands??[]),currencies:clone(i.currencies??[]),controlledRiskAllowed:i.controlledRiskAllowed===true,forceOpenAllowed:i.forceOpenAllowed===true,stopsLimitsAllowed:i.stopsLimitsAllowed===true},
        dealingRules:clone(data.dealingRules),updatedAt:now()};
    });
  }
  async function candles(mode:IgEnvironment,epic:string,timeframe:IgTimeframe,limit=100) {
    connected(mode);epicGuard(epic);if(!Object.hasOwn(frames,timeframe)||!Number.isInteger(limit)||limit<20||limit>200)throw Error("Ogiltiga IG-ljusparametrar");
    const detail=await market(mode,epic);
    const cacheKey=`prices:${mode}:${epic}:${timeframe}:${limit}`;
    const prior=cache.get(`${cacheKey}:account:${connectionIdentity(mode)}`)?.value;
    const last=prior?.candles?.at(-1);
    const incremental=last && now()-last.closeTime < frames[timeframe].ms*2;
    const count=incremental?3:limit;
    const result = await cached(cacheKey,Math.min(3600000,Math.max(60000,frames[timeframe].ms)),async()=>{
      if(prior?.allowance && num(prior.allowance.remainingAllowance)!==null && prior.allowance.remainingAllowance<count)throw Error("IG-historikkvoten räcker inte för nya ljus");
      const data=await call(mode,`prices/${epic}`,"GET","3",undefined,{query:new URLSearchParams({resolution:frames[timeframe].resolution,max:String(count),pageSize:String(count)}).toString()});
      const normalized=normalizeIgCandles(data.prices,timeframe,now());
      if(incremental && normalized.candles.length){
        const merged=new Map<number,IgCandle>(prior.candles.map((b:IgCandle)=>[b.openTime,b]));
        for(const b of normalized.candles)merged.set(b.openTime,b);
        normalized.candles=[...merged.values()].sort((a,b)=>a.openTime-b.openTime).slice(-limit);
      }
      return {environment:mode,epic,timeframe,priceBasis:"mid",source:"IG historical bid/ask midpoint",status:normalized.candles.length?normalized.rejected?"partial":"ready":"unavailable",error:normalized.candles.length?null:"IG saknar verifierade stängda ljus",...normalized,quote:detail.quote,allowance:clone(data.metadata?.allowance??null),updatedAt:now()};
    });
    return {...result,quote:detail.quote};
  }
  async function history(mode:IgEnvironment) {
    connected(mode);
    return cached(`history:${mode}`,60000,async()=>{
      const from=new Date(now()-30*86400000).toISOString().slice(0,19),to=new Date(now()).toISOString().slice(0,19);
      const query=new URLSearchParams({from,to,pageSize:"100",pageNumber:"1"}).toString();
      const [t,a]=await Promise.all([call(mode,"history/transactions","GET","2",undefined,{query}),call(mode,"history/activity","GET","3",undefined,{query})]);
      if(!Array.isArray(t.transactions)||!Array.isArray(a.activities))throw Error("IG-historiken kunde inte verifieras");
      const txPages=num(t.metadata?.pageData?.totalPages),hasMore=(txPages!==null&&txPages>1)||!!a.metadata?.paging?.next;
      return {status:hasMore?"partial":"ready",error:null,complete:!hasMore,periodDays:30,transactions:t.transactions.map((r:any)=>({date:str(r.dateUtc)??str(r.date),type:str(r.transactionType),instrumentName:str(r.instrumentName),reference:str(r.reference),profitAndLoss:str(r.profitAndLoss),currency:str(r.currency),openLevel:str(r.openLevel),closeLevel:str(r.closeLevel),size:str(r.size),cashTransaction:typeof r.cashTransaction==="boolean"?r.cashTransaction:["DEPOSIT","WITHDRAWAL","TRANSFER","INTEREST","FEE"].includes(r.transactionType)?true:null})),activities:a.activities.map((r:any)=>({date:str(r.date),type:str(r.type),status:str(r.status),description:str(r.description),epic:str(r.epic),dealId:str(r.dealId)})),pagination:{transactions:{pageNumber:num(t.metadata?.pageData?.pageNumber),pageSize:num(t.metadata?.pageData?.pageSize),totalPages:txPages},activities:{nextPageAvailable:!!a.metadata?.paging?.next,size:num(a.metadata?.size)}},note:"Kontohändelser och kassatransaktioner är inte automatiskt avslutade trades eller strategins PnL",updatedAt:now()};
    });
  }
  async function setSelection(mode:IgEnvironment,input:Partial<IgSelection>) {
    modeGuard(mode);connected(mode);const binding=connectionIdentity(mode),selected=selectionGuard(input,true);
    for(const epic of selected.epics){const m=await market(mode,epic);if(!["CURRENCIES","INDICES","COMMODITIES","SHARES"].includes(m.type??""))throw Error("IG-instrumenttypen stöds inte i denna CFD-vy");}
    if(connectionIdentity(mode)!==binding)throw Error("IG-kontoanslutningen ändrades under parvalet");
    const current=state(mode);persist(mode,{...current,selection:selected});return clone(selected);
  }
  async function analysisGuard(){
    const checked=deps.guard?await deps.guard():{killSwitchActive:(await loadState()).killSwitchActive,allowed:(await canSpend({dailyCapUsd:config.costCap.dailyUsd,weeklyCapUsd:config.costCap.weeklyUsd})).allowed};
    if(checked.killSwitchActive)throw Error("IG-analys är stoppad av kill-switch");
    if(!checked.allowed)throw Error("IG-budgetgränsen är nådd; inga AI-anrop startas");
  }
  async function llm(role:"technical"|"head",context:Record<string,any>) {
    await analysisGuard();
    if(deps.llm)return deps.llm(role,context);
    const model=role==="technical"?modelFor("specialist","claude-haiku-4-5-20251001"):modelFor("head","claude-sonnet-4-6");
    const client=createLlmClient(config.anthropicApiKey);
    const response=await client.messages.create({model,max_tokens:4000,system:`Du är ${role==="technical"?"Teknisk analytiker":"Hanna, Head Trader"} för IG CFD/forex. Använd endast valda EPICs och verifierade stängda mid-ljus för angivet intervall. Bid/offer är separat indikativ REST-kvot, inte garanterat exekveringspris. Använd inte Bybit, USDC-spot, USD/price som kontraktsstorlek, fabricerad volym eller saknade belopp som noll. Marknad som inte är TRADEABLE eller har fördröjd/okänd kvot ska få HOLD med tydligt skäl. ${role==="technical"?'Svara JSON {analyses:[{epic,bias,signals,reason}]} för varje valt instrument.':'Svara JSON {analyses:[{epic,action:"BUY"|"SELL"|"HOLD",reason,entryLevel:null|number,stopLevel:null|number,targetLevel:null|number}],summary:string}. BUY/SELL är förslag för manuell granskning, inga orders skickas. Kvantitet och margin/valutarisk ska inte gissas.'}`,messages:[{role:"user",content:JSON.stringify(context)}]},{timeout:45000});
    await trackClaudeCall(role, response.model||model,response.usage).catch(()=>{});
    const text=response.content.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("");return JSON.parse(extractJson(text));
  }
  async function analyze(mode:IgEnvironment,input?:Partial<IgSelection>) {
    modeGuard(mode);if(busy.has(mode))throw Error("Analys körs redan för IG-miljön");
    const selected=selectionGuard(input??state(mode).selection);connected(mode);busy.add(mode);
    const requestId=randomUUID(),startedAt=now(),accountBinding=connectionIdentity(mode);
    try {
      const result=await runTwoAgentPipeline({
        jev:async()=>{
          await analysisGuard();
          const sanitized={task:"Read-only IG CFD/forex market analysis: two existing agent roles, no order execution",constraints:["no market/account data sent","existing models only","no CFD size guessing"]};
          if(deps.jev)return deps.jev(sanitized);
          const verdict=await askJev(sanitized,8000,{execution_depth:{type:"choice",instructions:"Choose analysis depth",criteria:{standard:"normal market analysis",deep:"financial risk correctness"}}});
          return {available:verdict.available,note:verdict.available?"JEV-förkontroll genomförd":"JEV otillgänglig; befintliga två agentroller behålls"};
        },
        technical:async(jev)=>{
          if(connectionIdentity(mode)!==accountBinding)throw Error("IG-kontoanslutningen ändrades under analysen");
          const observations=[];
          for(const epic of selected.epics){const [m,c]=await Promise.all([market(mode,epic),candles(mode,epic,selected.timeframe)]);if(!["CURRENCIES","INDICES","COMMODITIES","SHARES"].includes(m.type??""))throw Error("IG-instrumenttypen stöds inte i denna CFD-vy");if(c.candles.length<20)throw Error("Analys kräver minst 20 verifierade stängda IG-ljus");
            const closes=c.candles.map(b=>b.close);observations.push({epic,market:m,candles:c.candles,indicators:{sma20:sma(closes,20),sma50:sma(closes,50),ema20:ema(closes,20),rsi14:rsi(closes,14),volumeSignal:null},dataQuality:{rejected:c.rejected,forming:c.forming,allowance:c.allowance}});}
          if(connectionIdentity(mode)!==accountBinding)throw Error("IG-kontoanslutningen ändrades under analysen");
          const technical=await llm("technical",{environment:mode,selection:selected,observations,jev});
          if(!Array.isArray(technical.analyses))throw Error("Analys saknas i teknisk IG-rapport");
          technical.analyses=technical.analyses.filter((a:any)=>selected.epics.includes(a.epic));if(technical.analyses.length!==selected.epics.length || new Set(technical.analyses.map((a:any)=>a.epic)).size!==selected.epics.length)throw Error("Analys saknas för något valt IG-instrument");
          return {...technical,observations};
        },
        head:async(technical,jev)=>{
          if(connectionIdentity(mode)!==accountBinding)throw Error("IG-kontoanslutningen ändrades under analysen");
          const head=await llm("head",{environment:mode,selection:selected,technical,jev,lastVerifiedAccount:status().environments[mode].account,execution:"manual review; no CFD execution before units and margin verification"});
          if(!Array.isArray(head.analyses))throw Error("Analys saknas i Hannas IG-rapport");
          head.analyses=head.analyses.filter((a:any)=>selected.epics.includes(a.epic)&&["BUY","SELL","HOLD"].includes(a.action));if(head.analyses.length!==selected.epics.length || new Set(head.analyses.map((a:any)=>a.epic)).size!==selected.epics.length)throw Error("Analys saknas för något valt IG-instrument");return head;
        }
      });
      if(connectionIdentity(mode)!==accountBinding)throw Error("IG-kontoanslutningen ändrades under analysen");
      const analysis={requestId,accountBinding,environment:mode,selection:selected,startedAt,completedAt:now(),status:"completed",jev:result.jev,technical:result.technical,head:result.head,execution:"manual_review_only"};
      const proposals=result.head.analyses.filter((a:any)=>a.action!=="HOLD").map((a:any)=>({id:randomUUID(),accountBinding,environment:mode,epic:a.epic,direction:a.action,quantity:null,status:"manual_review_blocked",reason:a.reason,entryLevel:num(a.entryLevel),stopLevel:num(a.stopLevel),targetLevel:num(a.targetLevel),percent:selected.percent,horizonMinutes:selected.horizonMinutes,createdAt:now(),requestId,blocker:"CFD-kontraktsstorlek, valuta, marginal och servergrind kräver verifiering innan order"}));
      const current=state(mode);persist(mode,{...current,analysis,pendingOrders:[...current.pendingOrders,...proposals].slice(-100)});return clone(analysis);
    } catch(e){const current=state(mode);persist(mode,{...current,analysis:{requestId,environment:mode,selection:selected,startedAt,completedAt:now(),status:"failed",error:errorText(e)}});throw Error(errorText(e));}
    finally{busy.delete(mode);}
  }
  async function startSession(mode:IgEnvironment,input:Partial<IgSelection>&{durationMinutes:number;intervalMinutes:number}) {
    modeGuard(mode);if(busy.has(mode)||state(mode).session?.status==="running")throw Error("Session körs redan för IG-miljön");
    if(![15,30,60,120].includes(input.durationMinutes)||![1,5,15,30].includes(input.intervalMinutes))throw Error("Ogiltiga IG-sessionsintervall");
    connected(mode);const binding=connectionIdentity(mode);
    const selected=selectionGuard(input);for(const epic of selected.epics){const m=await market(mode,epic);if(!["CURRENCIES","INDICES","COMMODITIES","SHARES"].includes(m.type??""))throw Error("IG-instrumenttypen stöds inte i denna CFD-vy");}
    if(connectionIdentity(mode)!==binding)throw Error("IG-kontoanslutningen ändrades under sessionsstarten");
    if(busy.has(mode)||state(mode).session?.status==="running")throw Error("Session körs redan för IG-miljön");
    const session:IgSession={...selected,id:randomUUID(),environment:mode,startedAt:now(),endsAt:now()+input.durationMinutes*60000,intervalMinutes:input.intervalMinutes,nextRunAt:now(),status:"running",analyses:0,lastError:null};
    persist(mode,{...state(mode),selection:selected,session});return clone(session);
  }
  function stopSession(mode:IgEnvironment){modeGuard(mode);const current=state(mode);if(current.session?.status==="running")persist(mode,{...current,session:{...current.session,status:"stopped"}});return clone(state(mode).session);}
  async function tickSessions() {
    for(const mode of ["demo","live"] as const){
      if(status().environments[mode].status==="connected")connected(mode);
      else {const old=state(mode);if(old.session?.status==="running")persist(mode,{...old,session:{...old.session,status:"interrupted",lastError:"IG-anslutningen saknas; starta om sessionen efter anslutning"}});continue;}
      const current=state(mode),s=current.session;if(!s||s.status!=="running"||busy.has(mode))continue;
      if(now()>=s.endsAt){persist(mode,{...current,session:{...s,status:"completed"}});continue;}if(now()<s.nextRunAt)continue;
      const id=s.id;persist(mode,{...current,session:{...s,nextRunAt:now()+s.intervalMinutes*60000}});
      let error:string|null=null;try{await analyze(mode,s);}catch(e){error=errorText(e);}
      const updated=state(mode);if(updated.session?.id===id)persist(mode,{...updated,session:{...updated.session,analyses:updated.session.analyses+(error?0:1),lastError:error,status:updated.session.status==="running"&&now()>=updated.session.endsAt?"completed":updated.session.status}});
    }
  }
  async function workspace(mode:IgEnvironment) {
    modeGuard(mode);if(status().environments[mode].status==="connected")connected(mode);
    const connection=status().environments[mode],current=state(mode);
    const markets=[];let pos:any={positions:null,status:"unavailable",error:connection.error},hist:any={transactions:null,activities:null,status:"unavailable",error:connection.error};
    if(connection.status==="connected") {
      try{await cached(`accounts:${mode}`,15000,()=>accounts(mode));}catch { /* Saknat saldo ska inte bli ett beräknat nollvärde. */ }
      try{pos=await cached(`positions:${mode}`,10000,()=>positions(mode));}catch(e){pos.error=errorText(e);}
      try{hist=await history(mode);}catch(e){hist.error=errorText(e);}
      for(const epic of current.selection.epics){try{markets.push(await market(mode,epic));}catch(e){markets.push({epic,status:"unavailable",error:errorText(e)});}}
    }
    if(status().environments[mode].status==="connected")connected(mode);
    if(state(mode)!==current)return workspace(mode);
    const finalConnection=status().environments[mode];
    if(finalConnection.status!=="connected" || connectionIdentity(mode)!==current.connectionGeneration){pos={positions:null,status:"unavailable",error:"IG-anslutningen kunde inte verifieras"};hist={transactions:null,activities:null,status:"unavailable",error:"IG-anslutningen kunde inte verifieras"};}
    return {environment:mode,connection:finalConnection,selection:clone(current.selection),markets:finalConnection.status==="connected"?markets:[],positions:pos.positions,positionsStatus:pos.status,positionsError:pos.error,history:hist,analysis:clone(current.analysis),session:clone(current.session),pendingOrders:clone(current.pendingOrders),transport:"REST polling",execution:{enabled:false,reason:"IG CFD-order kräver verifierad kontrakts-/marginalrisk och servergodkännande"},serverNow:now()};
  }
  return {searchMarkets,market,candles,history,setSelection,analyze,startSession,stopSession,tickSessions,workspace};
}
const workspace=createIgWorkspace();
export const searchIgMarkets=workspace.searchMarkets,getIgMarket=workspace.market,getIgCandles=workspace.candles,getIgHistory=workspace.history,setIgSelection=workspace.setSelection,runIgAnalysis=workspace.analyze,startIgSession=workspace.startSession,stopIgSession=workspace.stopSession,tickIgSessions=workspace.tickSessions,getIgWorkspace=workspace.workspace;
