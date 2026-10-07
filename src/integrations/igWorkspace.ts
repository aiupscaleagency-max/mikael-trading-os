import {igCalculationRules,igQuoteTimestamp,igSnapshotQuote,igUsdSekFx,type IgAccountFx} from "./igRules.js";
import {getHistoricalContext} from "../data/tiingoHistory.js";
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {callIgAuthenticated,getIgReadBudget,getIgStatus,getIgPositions,getIgAccounts,type IgEnvironment} from "./igConnection.js";
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
export interface IgSession extends IgSelection {id:string;environment:IgEnvironment;startedAt:number;endsAt:number;intervalMinutes:number;nextRunAt:number;status:"running"|"stopped"|"completed"|"interrupted";analyses:number;lastError:string|null;maxPositions:number}
export interface IgCandle {openTime:number;closeTime:number;open:number;high:number;low:number;close:number;volume:number|null}
interface WorkspaceState {connectionGeneration?:string|null;selection:IgSelection;session:IgSession|null;analysis:Record<string,any>|null;pendingOrders:Record<string,any>[]}
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const metadataNumber=(v:unknown):number|null=>typeof v==="string"&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim())?num(Number(v)):num(v);
const str=(v:unknown):string|null=>typeof v==="string"&&v.length<=250?v:null;
const safeErrors=new Set(["IG-analys avbruten av sessionsstopp","IG-ljusserien är inaktuell","IG-ljusserien innehåller luckor","IG-budgetgränsen är nådd; inga AI-anrop startas","IG-analys är stoppad av kill-switch","IG-kontoanslutningen ändrades under analysen","Analys saknas i teknisk IG-rapport","Analys saknas för något valt IG-instrument","Analys saknas i Hannas IG-rapport","Analys kräver minst 20 verifierade stängda IG-ljus"]);
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
// Endast kända fiatpar eller kryptonamn kategoriseras; aktier med liknande namn utesluts.
export function igMarketCategory(m:Record<string,any>):'forex'|'crypto'|null {
  if((m.type??m.instrumentType)!=='CURRENCIES')return null;
  const name=m.name??m.instrumentName??'';
  if(/bitcoin|ether|crypto|krypto|litecoin|ripple|cardano|solana|dogecoin|polkadot|chainlink|stellar|avalanche|uniswap|\b(?:neo|eos|tron|toncoin|polygon|bnb|cosmos|aave|sui|near|tezos|filecoin|shiba|arbitrum|optimism|algorand|btc|eth)\b/i.test(name))return 'crypto';
  if(/\b[A-Z]{3}\s*\/\s*[A-Z]{3}\b/.test(name))return 'forex';
  return null;
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
  const states=new Map<IgEnvironment,WorkspaceState>(),cache=new Map<string,{at:number,value:any}>(),pending=new Map<string,Promise<any>>(),busy=new Set<IgEnvironment>(),cancellations=new Map<IgEnvironment,number>();
  const fixtureReads:{environment:IgEnvironment;at:number}[]=[];
  // Produktionsanrop räknas centralt i anslutningen; injicerade testanrop får samma miljöbudget.
  function readBudget(mode:IgEnvironment){
    if(!deps.call)return getIgReadBudget(mode);
    while(fixtureReads.length&&now()-fixtureReads[0]!.at>=60000)fixtureReads.shift();
    const used=fixtureReads.filter(r=>r.environment===mode).length;
    return {used,appUsed:fixtureReads.length,remaining:Math.max(0,Math.min(24-used,48-fixtureReads.length))};
  }
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
  function consumeRead(mode:IgEnvironment){if(!deps.call)return;if(readBudget(mode).remaining===0)throw Error("IG-läsbudgeten är slut för denna minut");fixtureReads.push({environment:mode,at:now()});}
  async function read(...args:Parameters<typeof call>){consumeRead(args[0]);return call(...args);}
  async function cached<T>(key:string,ttl:number,job:()=>Promise<T>):Promise<T> {
    const environment=key.split(":")[1] as IgEnvironment,identity=connectionIdentity(environment);
    key=`${key}:account:${identity}`;
    const prev=cache.get(key);if(prev&&now()-prev.at<ttl)return clone(prev.value);
    const running=pending.get(key);if(running)return clone(await running);
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
      const data=await read(mode,"markets","GET","1",undefined,{query:new URLSearchParams({searchTerm:term.trim()}).toString()});
      if(!Array.isArray(data.markets))throw Error("IG-marknadskatalogen kunde inte verifieras");
      return {environment:mode,status:"ready",error:null,markets:data.markets.filter((m:any)=>typeof m.epic==="string").map((m:any)=>({epic:m.epic,name:str(m.instrumentName),type:str(m.instrumentType),category:igMarketCategory(m),expiry:str(m.expiry),bid:num(m.bid),offer:num(m.offer),marketStatus:str(m.marketStatus),streamingPricesAvailable:m.streamingPricesAvailable===true,delayTime:num(m.delayTime)})),updatedAt:now()};
    });
  }
  // IG:s tidigare navigation finns inte längre. Katalogen byggs från verkliga kontosökningar och märks som sökbaserad.
  const fiatCodes=['USD','EUR','GBP','AUD','CAD','CHF','CNH','CNY','NZD','JPY','NOK','SEK','DKK','SGD','HKD','ZAR','TRY','PLN','HUF','MXN','INR','ILS','CZK','BRL','RUB','KRW','TWD','IDR','THB','MYR','PHP','RON','CLP','COP'];
  const cryptoTerms=['Crypto','Bitcoin','Ether','Litecoin','Ripple','Cardano','Solana','Dogecoin','Polkadot','Chainlink','Stellar','Avalanche','Uniswap','NEO','EOS','TRON','Toncoin','Polygon','BNB','Cosmos','Aave','Sui','Near','Tezos','Filecoin','Shiba','Arbitrum','Optimism','Algorand'];
  const catalogProgress=new Map<string,{cursor:number;markets:Map<string,any>;updatedAt:number}>();
  async function catalogue(mode:IgEnvironment,category:unknown){
    connected(mode);if(category!=='forex'&&category!=='crypto')throw Error('Välj Forex eller Kryptovalutor');
    const identity=connectionIdentity(mode),key=`${mode}:${identity}:${category}`;
    let progress=catalogProgress.get(key);const terms=category==='forex'?['Forex',...fiatCodes]:cryptoTerms;
    if(!progress||progress.cursor===terms.length&&now()-progress.updatedAt>300000){progress={cursor:0,markets:new Map(),updatedAt:now()};catalogProgress.set(key,progress);}
    // Delresultat återanvänds när minutbudgeten tar slut. Parallella anrop delar samma hämtning.
    const running=pending.get(`catalog:${key}`);if(running)return clone(await running);
    const job=(async()=>{
      let blocked=false;
      while(progress!.cursor<terms.length){
        if(readBudget(mode).remaining===0||readBudget(mode).used>=10||readBudget(mode).appUsed>=36){blocked=true;break;}
        if(connectionIdentity(mode)!==identity)throw Error('IG-kontosessionen ändrades under kataloghämtningen');
        try{
          const result=await searchMarkets(mode,terms[progress!.cursor]!);
          for(const m of result.markets){
            if(m.type!=='CURRENCIES')continue;
            if(igMarketCategory(m)!==category)continue;
            progress!.markets.set(m.epic,{...m,category});
          }
          progress!.cursor++;progress!.updatedAt=now();
        }catch{blocked=true;break;}
      }
      if(connectionIdentity(mode)!==identity)throw Error('IG-kontosessionen ändrades under kataloghämtningen');
      return {environment:mode,category,status:blocked?'partial':'ready',complete:false,error:null,markets:[...progress!.markets.values()].sort((a,b)=>a.name.localeCompare(b.name,'sv')),updatedAt:progress!.updatedAt,remainingSearches:terms.length-progress!.cursor,source:'IG kontosökning',note:blocked?'Hämtningen är delvis klar. Ladda om efter en minut för att fortsätta.':'Alla hämtade IG-instrument. Ytterligare instrument kan sökas hos IG; fullständigheten kan inte verifieras.'};
    })();pending.set(`catalog:${key}`,job);try{return clone(await job);}finally{pending.delete(`catalog:${key}`);}
  }
  async function rawMarket(mode:IgEnvironment,epic:string) {
    connected(mode);epicGuard(epic);
    return cached(`rawmarket:${mode}:${epic}`,15000,async()=>{
      const metadata=await cached(`metadata:${mode}:${epic}`,300000,async()=>{
        const data=await read(mode,`markets/${epic}`,"GET","3");
        if(data.instrument?.epic!==epic || !data.snapshot || !data.dealingRules)throw Error("IG-instrumentet kunde inte verifieras");
        return {data,at:now()};
      });
      const data=metadata.data,i=data.instrument,s=data.snapshot;let priceSnapshot=s;
      // Metadata kan återanvändas, men en äldre V3-kvot blir aldrig en ny färsk kvot.
      if(metadata.at!==now()||igQuoteTimestamp(s.updateTimeUTC,now())===null){
        priceSnapshot={marketStatus:s.marketStatus,delayTime:s.delayTime,bid:s.bid,offer:s.offer};
        try{const latest=await read(mode,`markets/${epic}`,"GET","4");if(latest.instrument?.epic===epic&&latest.snapshot?.scalingFactor===s.scalingFactor)priceSnapshot=latest.snapshot;}catch(e){if(e instanceof Error&&e.message.startsWith('IG begränsade antal'))throw e;/* Saknad UTC-tid håller order- och signalgrinden stängd. */}
      }
      return {environment:mode,epic,name:str(i.name),type:str(i.type),category:igMarketCategory({name:i.name,type:i.type}),expiry:str(i.expiry),status:"ready",error:null,
        quote:igSnapshotQuote(priceSnapshot,now()),
        instrument:{epic,type:str(i.type),expiry:str(i.expiry),unit:str(i.unit),contractSize:metadataNumber(i.contractSize),lotSize:metadataNumber(i.lotSize),valueOfOnePip:metadataNumber(i.valueOfOnePip),onePipMeans:str(i.onePipMeans),scalingFactor:num(s.scalingFactor),decimalPlacesFactor:num(s.decimalPlacesFactor),marginFactor:num(i.marginFactor),marginFactorUnit:str(i.marginFactorUnit),marginDepositBands:clone(i.marginDepositBands??[]),currencies:clone(i.currencies??[]),controlledRiskAllowed:i.controlledRiskAllowed===true,forceOpenAllowed:i.forceOpenAllowed===true,stopsLimitsAllowed:i.stopsLimitsAllowed===true},
        dealingRules:clone(data.dealingRules),updatedAt:now()};
    });
  }
  async function accountFx(mode:IgEnvironment):Promise<IgAccountFx|null> {
    connected(mode);const currency=status().environments[mode].account?.currency;
    if(currency==='USD')return {baseCurrency:'USD',accountCurrency:'USD',bid:1,offer:1,receivedAt:now(),observedAt:now(),source:'USD-konto · ingen valutaomräkning'};
    if(currency!=='SEK')return null;
    try{
      const found=await searchMarkets(mode,'USD/SEK');
      const pair=found.markets.find((m:any)=>m.type==='CURRENCIES'&&/^USD\s*\/\s*SEK(?:\s+Mini)?\s*$/i.test(m.name??'')&&m.marketStatus==='TRADEABLE');
      if(!pair)return null;
      return igUsdSekFx(await rawMarket(mode,pair.epic),now());
    }catch{return null;}
  }
  async function market(mode:IgEnvironment,epic:string) {
    const detail=await rawMarket(mode,epic),currency=status().environments[mode].account?.currency??null;
    const currencies=detail.instrument.currencies;
    const execution=(currencies.find((c:any)=>c.isDefault===true)??(currencies.length===1?currencies[0]:null))?.code;
    const fx=execution==='USD'&&currency==='SEK'?await accountFx(mode):null;
    return {...detail,calculationRules:{...igCalculationRules(detail.instrument,{scalingFactor:detail.instrument.scalingFactor},currency,fx,now()),minSize:detail.dealingRules.minDealSize?.value??null}};
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
      const data=await read(mode,`prices/${epic}`,"GET","3",undefined,{query:new URLSearchParams({resolution:frames[timeframe].resolution,max:String(count),pageSize:String(count)}).toString()});
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
      const [t,a]=await Promise.all([read(mode,"history/transactions","GET","2",undefined,{query}),read(mode,"history/activity","GET","3",undefined,{query})]);
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
    const requestId=randomUUID(),startedAt=now(),accountBinding=connectionIdentity(mode),cancellation=cancellations.get(mode)??0;
    const activeSession=state(mode).session?.status==="running"?state(mode).session?.id:null;
    const checkCurrent=()=>{if((cancellations.get(mode)??0)!==cancellation || (activeSession&&(state(mode).session?.id!==activeSession||state(mode).session?.status!=="running"||now()>=state(mode).session!.endsAt)))throw Error("IG-analys avbruten av sessionsstopp");if(connectionIdentity(mode)!==accountBinding)throw Error("IG-kontoanslutningen ändrades under analysen");};
    const steps=[{name:"JEV",status:"Inväntar"},{name:"Teknisk analytiker",status:"Inväntar"},{name:"Hanna / Head Trader",status:"Inväntar"}];
    const stage=(index:number,status:string)=>{checkCurrent();steps[index]!.status=status;const current=state(mode);persist(mode,{...current,analysis:{requestId,accountBinding,environment:mode,selection:selected,startedAt,status:"running",steps:clone(steps)}});};
    try {
      stage(0,"Arbetar");
      const result=await runTwoAgentPipeline({
        jev:async()=>{
          await analysisGuard();
          const sanitized={task:"Read-only IG CFD/forex market analysis: two existing agent roles, no order execution",constraints:["no market/account data sent","existing models only","no CFD size guessing"]};
          try {
          if(deps.jev)return await deps.jev(sanitized);
          const verdict=await askJev(sanitized,8000,{execution_depth:{type:"choice",instructions:"Choose analysis depth",criteria:{standard:"normal market analysis",deep:"financial risk correctness"}}});
          return {available:verdict.available,advice:verdict.answers,note:verdict.available?"JEV-förkontroll genomförd":"JEV otillgänglig; befintliga två agentroller behålls"};
          } catch {return {available:false,note:"JEV otillgänglig; befintliga två agentroller behålls"};}
        },
        technical:async(jev)=>{
          stage(0,"Klar");stage(1,"Arbetar");
          if(connectionIdentity(mode)!==accountBinding)throw Error("IG-kontoanslutningen ändrades under analysen");
          const observations=[];
          for(const epic of selected.epics){const [m,c]=await Promise.all([market(mode,epic),candles(mode,epic,selected.timeframe)]);if(!["CURRENCIES","INDICES","COMMODITIES","SHARES"].includes(m.type??""))throw Error("IG-instrumenttypen stöds inte i denna CFD-vy");if(c.candles.length<20)throw Error("Analys kräver minst 20 verifierade stängda IG-ljus");
            checkCurrent();
            const last=c.candles.at(-1)!;if(now()-last.closeTime<0||now()-last.closeTime>frames[selected.timeframe].ms)throw Error("IG-ljusserien är inaktuell");
            if(c.candles.some((bar,index)=>index>0&&bar.openTime-c.candles[index-1]!.openTime!==frames[selected.timeframe].ms))throw Error("IG-ljusserien innehåller luckor");
            const closes=c.candles.map(b=>b.close);
            // Tiingo är referenshistorik, aldrig IG:s handelspris. Forex mappas inte till kryptohistorik.
            const refs:[[RegExp,string],...[RegExp,string][]]=[[/bitcoin|\bBTC\b/i,"BTCUSDC"],[/ethereum|\bETH\b/i,"ETHUSDC"],[/solana|\bSOL\b/i,"SOLUSDC"],[/litecoin|\bLTC\b/i,"LTCUSDC"]];
            const reference=refs.find(([pattern])=>pattern.test(m.name??""))?.[1];
            const historicalReference=reference&&!deps.llm?await getHistoricalContext(reference):{source:"Tiingo",purpose:"historical_reference_only",status:"unavailable",error:"Ingen verifierad Tiingo-referens för detta instrument"};
            observations.push({epic,market:m,candles:c.candles,historicalReference,indicators:{sma20:sma(closes,20),sma50:sma(closes,50),ema20:ema(closes,20),rsi14:rsi(closes,14),volumeSignal:null},dataQuality:{rejected:c.rejected,forming:c.forming,allowance:c.allowance}});}
          if(connectionIdentity(mode)!==accountBinding)throw Error("IG-kontoanslutningen ändrades under analysen");
          const technical=await llm("technical",{environment:mode,selection:selected,observations,jev});
          if(!Array.isArray(technical.analyses))throw Error("Analys saknas i teknisk IG-rapport");
          technical.analyses=technical.analyses.filter((a:any)=>selected.epics.includes(a.epic));if(technical.analyses.length!==selected.epics.length || new Set(technical.analyses.map((a:any)=>a.epic)).size!==selected.epics.length)throw Error("Analys saknas för något valt IG-instrument");
          return {...technical,observations};
        },
        head:async(technical,jev)=>{
          stage(1,"Klar");stage(2,"Arbetar");
          if(connectionIdentity(mode)!==accountBinding)throw Error("IG-kontoanslutningen ändrades under analysen");
          const head=await llm("head",{environment:mode,selection:selected,technical,jev,lastVerifiedAccount:status().environments[mode].account,execution:"manual review; no CFD execution before units and margin verification"});
          if(!Array.isArray(head.analyses))throw Error("Analys saknas i Hannas IG-rapport");
          head.analyses=head.analyses.filter((a:any)=>selected.epics.includes(a.epic)&&["BUY","SELL","HOLD"].includes(a.action));if(head.analyses.length!==selected.epics.length || new Set(head.analyses.map((a:any)=>a.epic)).size!==selected.epics.length)throw Error("Analys saknas för något valt IG-instrument");
          head.analyses=head.analyses.map((a:any)=>{
            const observed=technical.observations.find((o:any)=>o.epic===a.epic),quote=observed?.market.quote;
            if(!quote || quote.marketStatus!=="TRADEABLE" || quote.delayTime!==0 || num(quote.receivedAt)===null || quote.receivedAt<0 || now()-quote.receivedAt<0 || now()-quote.receivedAt>60000 || num(quote.observedAt)===null || now()-quote.observedAt<0 || now()-quote.observedAt>60000)return {...a,action:"HOLD",reason:"IG-marknaden eller en färsk ofördröjd kvot kunde inte verifieras",entryLevel:null,stopLevel:null,targetLevel:null};
            return a;
          });return head;
        }
      });
      if(connectionIdentity(mode)!==accountBinding)throw Error("IG-kontoanslutningen ändrades under analysen");
      await analysisGuard();
      checkCurrent();
      stage(2,"Klar");
      const analysis={steps:clone(steps),requestId,accountBinding,environment:mode,selection:selected,startedAt,completedAt:now(),status:"completed",jev:result.jev,technical:result.technical,head:result.head,execution:"manual_review_only"};
      const proposals=result.head.analyses.filter((a:any)=>a.action!=="HOLD").map((a:any)=>({id:randomUUID(),accountBinding,environment:mode,epic:a.epic,direction:a.action,quantity:null,status:"manual_review_blocked",reason:a.reason,entryLevel:num(a.entryLevel),stopLevel:num(a.stopLevel),targetLevel:num(a.targetLevel),percent:selected.percent,horizonMinutes:selected.horizonMinutes,createdAt:now(),requestId,blocker:"CFD-kontraktsstorlek, valuta, marginal och servergrind kräver verifiering innan order"}));
      const current=state(mode);persist(mode,{...current,analysis,pendingOrders:[...current.pendingOrders,...proposals].slice(-100)});return clone(analysis);
    } catch(e){const current=state(mode);persist(mode,{...current,analysis:{requestId,environment:mode,selection:selected,startedAt,completedAt:now(),status:(cancellations.get(mode)??0)!==cancellation?"stopped":"failed",steps:clone(steps),error:errorText(e)}});throw Error(errorText(e));}
    finally{busy.delete(mode);}
  }
  async function startSession(mode:IgEnvironment,input:Partial<IgSelection>&{durationMinutes:number;intervalMinutes:number;maxPositions?:number}) {
    modeGuard(mode);if(busy.has(mode)||state(mode).session?.status==="running")throw Error("Session körs redan för IG-miljön");
    if(![15,30,60,120].includes(input.durationMinutes)||![1,5,15,30].includes(input.intervalMinutes))throw Error("Ogiltiga IG-sessionsintervall");
    const maxPositions=input.maxPositions??1;
    if(!Number.isInteger(maxPositions)||maxPositions<1||maxPositions>10)throw Error("Ogiltig gräns för samtidiga positioner");
    connected(mode);const binding=connectionIdentity(mode);
    const selected=selectionGuard(input);for(const epic of selected.epics){const m=await market(mode,epic);if(!["CURRENCIES","INDICES","COMMODITIES","SHARES"].includes(m.type??""))throw Error("IG-instrumenttypen stöds inte i denna CFD-vy");}
    if(connectionIdentity(mode)!==binding)throw Error("IG-kontoanslutningen ändrades under sessionsstarten");
    if(busy.has(mode)||state(mode).session?.status==="running")throw Error("Session körs redan för IG-miljön");
    const session:IgSession={...selected,id:randomUUID(),environment:mode,startedAt:now(),endsAt:now()+input.durationMinutes*60000,intervalMinutes:input.intervalMinutes,nextRunAt:now(),status:"running",analyses:0,lastError:null,maxPositions};
    persist(mode,{...state(mode),selection:selected,session});return clone(session);
  }
  function stopSession(mode:IgEnvironment){modeGuard(mode);cancellations.set(mode,(cancellations.get(mode)??0)+1);const current=state(mode);if(current.session?.status==="running")persist(mode,{...current,session:{...current.session,status:"stopped"}});return clone(state(mode).session);}
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
      try{await cached(`accounts:${mode}`,30000,()=>{consumeRead(mode);return accounts(mode);});}catch { /* Saknat saldo ska inte bli ett beräknat nollvärde. */ }
      try{pos=await cached(`positions:${mode}`,30000,()=>{consumeRead(mode);return positions(mode);});}catch(e){pos.error=errorText(e);}
      if(Array.isArray(pos.positions)){
        pos.positions=await Promise.all(pos.positions.map(async(p:any)=>{
          try{const m=await market(mode,p.epic),q=m.quote,r=m.calculationRules;
            const fresh=q.marketStatus==="TRADEABLE"&&q.delayTime===0&&q.observedAt!==null&&Number.isFinite(q.observedAt)&&now()-q.observedAt>=0&&now()-q.observedAt<=60000;
            const current=p.direction==="BUY"?q.bid:q.offer;
            const basis=["BUY","SELL"].includes(p.direction)&&num(p.level)!==null&&p.level>0&&num(p.size)!==null&&p.size>0&&r.verified&&p.currency===r.executionCurrency;
            const delta=current!==null&&Number.isFinite(current)?(p.direction==="BUY"?1:-1)*(current-p.level):null;
            const profitLoss=fresh&&basis&&delta!==null?delta*p.size*(delta>=0?r.profitPointValue!:r.pointValue!):null;
            const exposure=basis?p.level*p.size*r.pointValue!:null;
            return {...p,bid:q.bid,offer:q.offer,priceFresh:fresh,profitLoss,profitLossPercent:profitLoss!==null&&exposure?profitLoss/exposure*100:null,pnlCurrency:r.pointCurrency,pnlBasis:"IG-kvot · konservativ kontovalutaomräkning · brutto före kostnader"};
          }catch{return {...p,profitLoss:null,profitLossPercent:null,priceFresh:false};}
        }));
      }
      try{hist=await history(mode);}catch(e){hist.error=errorText(e);}
      for(const epic of current.selection.epics){try{markets.push(await market(mode,epic));}catch(e){markets.push({epic,status:"unavailable",error:errorText(e)});}}
    }
    if(status().environments[mode].status==="connected")connected(mode);
    if(state(mode)!==current)return workspace(mode);
    const finalConnection=status().environments[mode];
    if(finalConnection.status!=="connected" || connectionIdentity(mode)!==current.connectionGeneration){pos={positions:null,status:"unavailable",error:"IG-anslutningen kunde inte verifieras"};hist={transactions:null,activities:null,status:"unavailable",error:"IG-anslutningen kunde inte verifieras"};}
    return {environment:mode,connection:finalConnection,selection:clone(current.selection),markets:finalConnection.status==="connected"?markets:[],positions:pos.positions,positionsStatus:pos.status,positionsError:pos.error,history:hist,analysis:clone(current.analysis),session:clone(current.session),pendingOrders:clone(current.pendingOrders),transport:"REST polling",execution:{enabled:false,reason:"IG CFD-order kräver verifierad kontrakts-/marginalrisk och servergodkännande"},serverNow:now()};
  }
  return {searchMarkets,catalogue,market,accountFx,candles,history,setSelection,analyze,startSession,stopSession,tickSessions,workspace,positionLimit:(mode:IgEnvironment)=>state(mode).session?.status==="running"?state(mode).session!.maxPositions:1};
}
const workspace=createIgWorkspace();
export const searchIgMarkets=workspace.searchMarkets,getIgMarket=workspace.market,getIgCandles=workspace.candles,getIgHistory=workspace.history,setIgSelection=workspace.setSelection,runIgAnalysis=workspace.analyze,startIgSession=workspace.startSession,stopIgSession=workspace.stopSession,tickIgSessions=workspace.tickSessions,getIgWorkspace=workspace.workspace;

export const getIgSessionPositionLimit=workspace.positionLimit;

export const getIgAccountFx=workspace.accountFx;

export const getIgCatalogue=workspace.catalogue;
