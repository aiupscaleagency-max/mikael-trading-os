// IG marknadsdata (katalog, instrument, kvot, historik, kontohistorik).
// Utdrag ur Codex igWorkspace.ts (codex/ig-continuation-20261007): endast läsvägar.
// Analys/sessioner ligger i vårt eget agentflöde (JEV → Teknisk + Risk → Hanna).
import {igCalculationRules,igQuoteTimestamp,igSnapshotQuote,igFxIsFresh,igPairQuote,igStaleFx,igFxPlausibility,FX_STALE_MAX_MS,type IgAccountFx} from "./igRules.js";
import {callIgAuthenticated,getIgReadBudget,isIgTemporaryRateError,getIgStatus,type IgEnvironment} from "./igConnection.js";
import fs from "node:fs";
import path from "node:path";
import {dataPath} from "../dataDir.js";

const frames={"1m":{resolution:"MINUTE",ms:60000},"3m":{resolution:"MINUTE_3",ms:180000},"5m":{resolution:"MINUTE_5",ms:300000},"15m":{resolution:"MINUTE_15",ms:900000},"30m":{resolution:"MINUTE_30",ms:1800000},"1h":{resolution:"HOUR",ms:3600000},"4h":{resolution:"HOUR_4",ms:14400000},"1d":{resolution:"DAY",ms:86400000}} as const;
export type IgTimeframe=keyof typeof frames;
export interface IgCandle {openTime:number;closeTime:number;open:number;high:number;low:number;close:number;volume:number|null}
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const metadataNumber=(v:unknown):number|null=>typeof v==="string"&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim())?num(Number(v)):num(v);
const str=(v:unknown):string|null=>typeof v==="string"&&v.length<=250?v:null;
const safeErrors=new Set(["IG-analys avbruten av sessionsstopp","IG-ljusserien är inaktuell","IG-ljusserien innehåller luckor","IG-budgetgränsen är nådd; inga AI-anrop startas","IG-analys är stoppad av kill-switch","IG-kontoanslutningen ändrades under analysen","Analys saknas i teknisk IG-rapport","Analys saknas för något valt IG-instrument","Analys saknas i Hannas IG-rapport","Analys kräver minst 20 verifierade stängda IG-ljus"]);
const errorText=(e:unknown)=>e instanceof Error && safeErrors.has(e.message)?e.message:"IG-underlaget eller analysen kunde inte verifieras; inga order skickades";
function modeGuard(mode:unknown):asserts mode is IgEnvironment {if(mode!=="demo"&&mode!=="live")throw Error("Ogiltig IG-miljö");}
function epicGuard(epic:unknown):asserts epic is string {if(typeof epic!=="string"||!/^[A-Za-z0-9._-]{1,100}$/.test(epic))throw Error("Ogiltig IG-epic");}
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
export function createIgMarkets(deps:{call?:typeof callIgAuthenticated;status?:typeof getIgStatus;now?:()=>number}={}) {
  const call=deps.call??callIgAuthenticated,status=deps.status??getIgStatus,now=deps.now??Date.now;
  const cache=new Map<string,{at:number,value:any}>(),pending=new Map<string,Promise<any>>();
  const fixtureReads:{environment:IgEnvironment;at:number}[]=[];
  const catalogueReads:{environment:IgEnvironment;at:number;category:'forex'|'crypto'|null}[]=[];
  function catalogueBudget(mode:IgEnvironment,category:'forex'|'crypto'|null=null){
    while(catalogueReads.length&&now()-catalogueReads[0]!.at>=60000)catalogueReads.shift();
    const global=readBudget(mode);
    // Katalogen lämnar alltid 2 bakgrundsläsningar per minut åt diagram och prisuppslag, så att de inte svälter medan katalogen fylls.
    const bg=(global as {backgroundRemaining?:number}).backgroundRemaining;
    return global.remaining>6&&(bg===undefined||bg>2)&&global.appUsed<36&&catalogueReads.filter(r=>r.environment===mode).length<10&&(category===null||catalogueReads.filter(r=>r.environment===mode&&r.category===category).length<4);
  }
  // Fyra sökläsningar per kategori reserverar plats åt den andra även när HTTP-klienter kommer först.
  async function catalogueReadFor(category:'forex'|'crypto'|null,...args:Parameters<typeof call>){if(!catalogueBudget(args[0],category))throw Error("Katalogens läsutrymme är slut för denna minut");catalogueReads.push({environment:args[0],at:now(),category});return read(...args);}
  const catalogueRead=(...args:Parameters<typeof call>)=>catalogueReadFor(null,...args);
  // Produktionsanrop räknas centralt i anslutningen; injicerade testanrop får samma miljöbudget.
  function readBudget(mode:IgEnvironment){
    if(!deps.call)return getIgReadBudget(mode);
    while(fixtureReads.length&&now()-fixtureReads[0]!.at>=60000)fixtureReads.shift();
    const used=fixtureReads.filter(r=>r.environment===mode).length;
    return {used,appUsed:fixtureReads.length,remaining:Math.max(0,Math.min(24-used,48-fixtureReads.length))};
  }
  const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
  const connectionIdentity=(mode:IgEnvironment)=>{const c=status().environments[mode];return c.status==="connected" ? c.connectionGeneration ?? `${c.checkedAt}:${c.account?.accountId}` : null;};
  function consumeRead(mode:IgEnvironment){if(!deps.call)return;if(readBudget(mode).remaining===0)throw Error("IG-läsbudgeten är slut för denna minut");fixtureReads.push({environment:mode,at:now()});}
  async function read(...args:Parameters<typeof call>){consumeRead(args[0]);return call(...args);}
  /** Läser en cachad post utan att hämta något (ingen IG-läsning). */
  function peek<T>(key:string,ttl:number):T|undefined{const environment=key.split(":")[1] as IgEnvironment,hit=cache.get(`${key}:account:${connectionIdentity(environment)}`);return hit&&now()-hit.at<ttl?clone(hit.value) as T:undefined;}
  async function cached<T>(key:string,ttl:number,job:()=>Promise<T>):Promise<T> {
    const environment=key.split(":")[1] as IgEnvironment,identity=connectionIdentity(environment);
    key=`${key}:account:${identity}`;
    const prev=cache.get(key);if(prev&&now()-prev.at<ttl)return clone(prev.value);
    const running=pending.get(key);if(running)return clone(await running);
    const promise=job();pending.set(key,promise);try{const value=await promise;if(connectionIdentity(environment)!==identity)throw Error("IG-kontosessionen ändrades under hämtningen");cache.set(key,{at:now(),value});return clone(value);}finally{if(pending.get(key)===promise)pending.delete(key);}
  }
  function connected(mode:IgEnvironment){modeGuard(mode);if(status().environments[mode].status!=="connected")throw Error("IG-miljön är inte ansluten; verifiera credentials och anslut först");}
  function marketRow(m:any){return {epic:m.epic,name:str(m.instrumentName)??m.epic,type:str(m.instrumentType),category:igMarketCategory(m),expiry:str(m.expiry),bid:num(m.bid),offer:num(m.offer),percentageChange:num(m.percentageChange),netChange:num(m.netChange),high:num(m.high),low:num(m.low),updateTimeUTC:str(m.updateTimeUTC),observedAt:igQuoteTimestamp(m.updateTimeUTC,now()),receivedAt:now(),marketStatus:str(m.marketStatus),streamingPricesAvailable:m.streamingPricesAvailable===true,delayTime:num(m.delayTime),scalingFactor:num(m.scalingFactor)};}
  async function searchMarkets(mode:IgEnvironment,term:string,catalogueRequest:false|'forex'|'crypto'=false) {
    connected(mode);if(typeof term!=="string"||term.trim().length<2||term.length>80)throw Error("Ogiltig IG-sökning");
    return cached(`search:${mode}:${term}`,60000,async()=>{
      const data=await (catalogueRequest?((...args:Parameters<typeof call>)=>catalogueReadFor(catalogueRequest,...args)):read)(mode,"markets","GET","1",undefined,{query:new URLSearchParams({searchTerm:term.trim()}).toString()});
      if(!Array.isArray(data.markets))throw Error("IG-marknadskatalogen kunde inte verifieras");
      return {environment:mode,status:"ready",error:null,markets:data.markets.filter((m:any)=>typeof m.epic==="string").map((m:any)=>({...marketRow(m)})),updatedAt:now()};
    });
  }
  // IG:s tidigare navigation finns inte längre. Katalogen byggs från verkliga kontosökningar och märks som sökbaserad.
  const fiatCodes=['USD','EUR','GBP','AUD','CAD','CHF','CNH','CNY','NZD','JPY','NOK','SEK','DKK','SGD','HKD','ZAR','TRY','PLN','HUF','MXN','INR','ILS','CZK','BRL','RUB','KRW','TWD','IDR','THB','MYR','PHP','RON','CLP','COP'];
  const cryptoTerms=['Crypto','Bitcoin','Ether','Litecoin','Ripple','Cardano','Solana','Dogecoin','Polkadot','Chainlink','Stellar','Avalanche','Uniswap','NEO','EOS','TRON','Toncoin','Polygon','BNB','Cosmos','Aave','Sui','Near','Tezos','Filecoin','Shiba','Arbitrum','Optimism','Algorand'];
  const categoryProgress=new Map<string,{codes:string[]|null;index:number;page:number;done:boolean;unsupported:boolean;unclassified:number;markets:Map<string,any>;at:number;failures:number;retryAt:number;reason:string|null}>();
  async function accountCatalogue(mode:IgEnvironment,category:'forex'|'crypto'){
    const identity=connectionIdentity(mode),key=`${mode}:${identity}`;
    let p=categoryProgress.get(key);
    if(!p||p.done&&now()-p.at>300000){p={codes:null,index:0,page:0,done:false,unsupported:false,unclassified:0,markets:new Map(),at:now(),failures:0,retryAt:0,reason:null};categoryProgress.set(key,p);}
    if(p.unsupported)return null;
    const jobKey=`categories:${key}`,running=pending.get(jobKey);
    const work=async()=>{
      if(now()<p!.retryAt)return;
      try{
        if(p!.codes===null){
          if(!catalogueBudget(mode)){p!.reason="budget";return;}
          const data=await catalogueRead(mode,'categories','GET','1');
          if(!Array.isArray(data.categories))throw Error('categories shape');
          p!.codes=data.categories.filter((c:any)=>c.nonTradeable!==true&&typeof c.code==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(c.code)&&/FOREX|CURRENC|CRYPTO|DIGITAL/i.test(c.code)).map((c:any)=>c.code);
          if(!p!.codes.length){p!.unsupported=true;return;}
        }
        while(p!.index<p!.codes.length){
          if(!catalogueBudget(mode)){p!.reason="budget";return;}
          const data=await catalogueRead(mode,`categories/${p!.codes[p!.index]}/instruments`,'GET','1',undefined,{query:new URLSearchParams({pageNumber:String(p!.page),pageSize:'1000'}).toString()});
          if(!Array.isArray(data.instruments)||data.instruments.length>1000)throw Error('categories shape');
          if(data.metadata?.pageNumber!==undefined&&data.metadata.pageNumber!==p!.page)throw Error('category page mismatch');
          for(const m of data.instruments){const category=igMarketCategory(m);if(typeof m?.epic==='string'&&category)p!.markets.set(m.epic,marketRow(m));else if(!['SHARES','INDICES','COMMODITIES','RATES','SECTORS'].includes(m?.type??m?.instrumentType))p!.unclassified++;}
          const pageSize=data.metadata?.pageSize??1000,totalPages=data.metadata?.totalPages;
          if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000||data.instruments.length>pageSize||totalPages!==undefined&&(!Number.isInteger(totalPages)||totalPages<0||totalPages>101))throw Error('categories shape');
          const lastPage=totalPages!==undefined?totalPages===0||p!.page>=totalPages-1:data.instruments.length<pageSize;
          p!.at=now();p!.failures=0;p!.reason=null;if(lastPage){p!.index++;p!.page=0;}else p!.page++;
          if(p!.page>100)throw Error('category page cap');
        }
        p!.done=true;
      }catch(e){p!.reason='endpoint_error';p!.failures++;p!.retryAt=now()+60000;if(e instanceof Error&&/HTTP (404|400|403)|categories shape|category page mismatch|category page cap/.test(e.message))p!.unsupported=true;}
    };
    if(running)await running;else{const job=work();pending.set(jobKey,job);try{await job;}finally{pending.delete(jobKey);}}
    if(connectionIdentity(mode)!==identity)throw Error('IG-kontosessionen ändrades under kataloghämtningen');
    if(p.unsupported)return null;
    return {environment:mode,category,status:p.done&&p.unclassified===0?'ready':'partial',complete:p.done&&p.unclassified===0,traversalComplete:p.done,progress:{reason:p.reason,failures:p.failures,page:p.page,categoryIndex:p.index,lastProgressAt:p.at,retryAt:p.retryAt},unclassifiedInstruments:p.unclassified,error:p.failures?'IG-kategorin kunde inte hämtas; nytt försök sker automatiskt och sökreserv används vid upprepade fel':null,markets:[...p.markets.values()].filter(m=>m.category===category).sort((a,b)=>a.name.localeCompare(b.name,'sv')),updatedAt:p.at,remainingSearches:p.done?0:Math.max(1,(p.codes?.length??1)-p.index),source:'IG aktiverade kontokategorier',note:p.done?'Alla hämtade Forex- och kryptoinstrument i IG-kontots aktiverade valutakategorier.':'Kontokategorier hämtas automatiskt inom IG:s läskvot.'};
  }
  const catalogProgress=new Map<string,{cursor:number;markets:Map<string,any>;updatedAt:number;failed:Map<string,{attempts:number;retryAt:number}>;reason:string|null}>();
  // Cross-environment discovery transfers identifiers only. Every visible Demo row is
  // independently read from Demo; no Live name, quote or market status is copied.
  const demoCandidates=new Map<string,Map<string,{at:number;row:any|null}>>();
  async function discoverDemoCrypto(){
    const identity=connectionIdentity('demo');
    let checked=demoCandidates.get(identity!);if(!checked){checked=new Map();demoCandidates.set(identity!,checked);}
    const liveIdentity=connectionIdentity('live');let candidates:any[]=[];
    if(liveIdentity){
      // The existing background catalogue tick discovers Live; never recurse or
      // spend Live quota from a Demo request. Read current-generation EPICs only.
      candidates=[...(categoryProgress.get(`live:${liveIdentity}`)?.markets.values()??[]),...(catalogProgress.get(`live:${liveIdentity}:crypto`)?.markets.values()??[])];
      candidates=[...new Map(candidates.map(m=>[m.epic,m])).values()];
    }
    let pendingCount=0,reason:string|null=liveIdentity?(candidates.length?null:'waiting_live_catalogue'):'live_not_connected';
    // Never-seen EPICs precede refreshes; otherwise a catalogue larger than
    // five minutes of quota can permanently starve its final candidates.
    candidates.sort((a,b)=>(checked.get(a.epic)?.at??Number.NEGATIVE_INFINITY)-(checked.get(b.epic)?.at??Number.NEGATIVE_INFINITY));
    for(const candidate of candidates){
      const epic=candidate.epic;if(typeof epic!=='string'||igMarketCategory(candidate)!=='crypto')continue;
      const previous=checked.get(epic);if(previous&&now()-previous.at<300000)continue;
      if(!catalogueBudget('demo','crypto')){pendingCount++;reason='budget';continue;}
      try{
        epicGuard(epic);
        const data=await catalogueReadFor('crypto','demo',`markets/${epic}`,'GET','3');
        if(connectionIdentity('demo')!==identity)throw Error('IG-kontosessionen ändrades under kataloghämtningen');
        const i=data.instrument,q=data.snapshot;
        if(i?.epic!==epic||!q||!data.dealingRules||igMarketCategory({name:i.name,type:i.type})!=='crypto')throw Error('Demo-instrumentet kunde inte verifieras');
        const row=marketRow({...q,epic,instrumentName:i.name,instrumentType:i.type,expiry:i.expiry,streamingPricesAvailable:i.streamingPricesAvailable});
        checked.set(epic,{at:now(),row});
      }catch(e){
        if(connectionIdentity('demo')!==identity)throw Error('IG-kontosessionen ändrades under kataloghämtningen');
        // Negative probes cool down as well; transient errors remain visible in progress.
        checked.set(epic,{at:now(),row:null});reason='verification_unavailable';
      }
    }
    if(connectionIdentity('demo')!==identity)throw Error('IG-kontosessionen ändrades under kataloghämtningen');
    return {markets:[...checked.values()].flatMap(v=>v.row?[v.row]:[]),progress:{source:'Live EPIC candidates; individually verified with Demo',candidates:candidates.length,verified:[...checked.values()].filter(v=>v.row).length,pending:pendingCount,reason}};
  }
  async function catalogue(mode:IgEnvironment,category:unknown){
    connected(mode);if(category!=='forex'&&category!=='crypto')throw Error('Välj Forex eller Kryptovalutor');
    const discovery=mode==='demo'&&category==='crypto'?await cached('demodiscovery:demo',15000,discoverDemoCrypto):null;
    const enabled=await accountCatalogue(mode,category);
    // Tomt eller oklassificerat kategorisvar bevisar inte att kontot saknar marknader.
    if(!discovery&&enabled&&(!enabled.traversalComplete&&enabled.progress.failures<2||enabled.traversalComplete&&enabled.markets.length>0&&enabled.unclassifiedInstruments===0))return enabled;
    const identity=connectionIdentity(mode),key=`${mode}:${identity}:${category}`;
    let progress=catalogProgress.get(key);const terms=category==='forex'?['Forex',...fiatCodes,'Weekend']:cryptoTerms; // 'Weekend': IG:s helgmarknader (t.ex. Weekend EUR/USD) är öppna lör–sön
    if(!progress||progress.cursor===terms.length&&progress.failed.size===0&&now()-progress.updatedAt>300000){progress={cursor:0,markets:progress?.markets??new Map(),updatedAt:now(),failed:new Map(),reason:null};catalogProgress.set(key,progress);}
    // Delresultat återanvänds när minutbudgeten tar slut. Parallella anrop delar samma hämtning.
    const running=pending.get(`catalog:${key}`);if(running)return clone(await running);
    const job=(async()=>{
      let blocked=false;
      const retried=new Set<string>();
      while(progress!.cursor<terms.length||[...progress!.failed].some(([term,f])=>f.retryAt<=now()&&!retried.has(term))){
        if(!catalogueBudget(mode,category)){blocked=true;progress!.reason='budget';break;}
        const normal=progress!.cursor<terms.length,term=normal?terms[progress!.cursor]!: [...progress!.failed].find(([t,f])=>f.retryAt<=now()&&!retried.has(t))![0];
        if(normal&&(progress!.failed.get(term)?.retryAt??0)>now()){blocked=true;progress!.reason='search_error';break;}
        if(!normal)retried.add(term);
        if(connectionIdentity(mode)!==identity)throw Error('IG-kontosessionen ändrades under kataloghämtningen');
        try{
          const result=await searchMarkets(mode,term,category);
          for(const m of result.markets){
            if(m.type!=='CURRENCIES')continue;
            if(igMarketCategory(m)!==category)continue;
            progress!.markets.set(m.epic,{...m,category});
          }
          if(normal)progress!.cursor++;progress!.failed.delete(term);progress!.reason=null;progress!.updatedAt=now();
        }catch(e){
          blocked=true;
          if(isIgTemporaryRateError(e)||e instanceof Error&&e.message.startsWith('Katalogens läsutrymme')){progress!.reason='budget';break;}
          progress!.reason='search_error';const attempts=(progress!.failed.get(term)?.attempts??0)+1;
          progress!.failed.set(term,{attempts,retryAt:now()+60000});
          if(normal&&attempts>=2){progress!.cursor++;continue;}
          if(!normal)continue;
          break;
        }
      }
      if(connectionIdentity(mode)!==identity)throw Error('IG-kontosessionen ändrades under kataloghämtningen');
      return {environment:mode,category,status:blocked?'partial':'ready',complete:false,error:null,markets:[...new Map([...(enabled?.markets??[]),...(discovery?.markets??[]),...progress!.markets.values()].map(m=>[m.epic,m])).values()].sort((a,b)=>a.name.localeCompare(b.name,'sv')),updatedAt:progress!.updatedAt,remainingSearches:terms.length-progress!.cursor+[...progress!.failed].filter(([term])=>terms.indexOf(term)<progress!.cursor).length,source:'IG kontosökning',progress:{discovery:discovery?.progress??null,category:enabled?.progress??null,search:{reason:progress!.reason,failedTerms:[...progress!.failed.keys()]}},categoryError:progress!.failed.size?'En eller flera IG-sökningar misslyckades; övriga termer hämtas och felande termer återförsöks':enabled?.error??null,unclassifiedInstruments:enabled?.unclassifiedInstruments??0,note:blocked?'Hämtningen är delvis klar och fortsätter automatiskt inom IG:s läskvot.':'Alla hämtade IG-instrument. Ytterligare instrument kan sökas hos IG; fullständigheten kan inte verifieras.'};
    })();pending.set(`catalog:${key}`,job);try{return clone(await job);}finally{pending.delete(`catalog:${key}`);}
  }
  async function marketOverview(mode:IgEnvironment,epics:string[]=[]){
    connected(mode);if(!Array.isArray(epics)||epics.length>10)throw Error('Välj högst 10 instrument för sentiment');for(const epic of epics)epicGuard(epic);
    const forex=await catalogue(mode,'forex'),crypto=await catalogue(mode,'crypto'),selected=[];
    for(const epic of [...new Set(epics)]){
      let marketId:string|null=null,sentiment:any={status:'unavailable',longPositionPercentage:null,shortPositionPercentage:null,updatedAt:null};
      try{
        const detail=await rawMarket(mode,epic);marketId=detail.instrument.marketId;
        if(marketId&&/^[A-Za-z0-9._-]{1,100}$/.test(marketId))sentiment=await cached(`sentiment:${mode}:${marketId}`,60000,async()=>{
          const data=await read(mode,`client-sentiment/${marketId}`,'GET','1');
          const long=num(data.longPositionPercentage),short=num(data.shortPositionPercentage);
          if(data.marketId!==marketId||long===null||short===null||long<0||long>100||short<0||short>100||Math.abs(long+short-100)>0.1)throw Error('sentiment shape');
          return {status:'ready',longPositionPercentage:long,shortPositionPercentage:short,updatedAt:now(),source:'IG kundpositioner, inte vinstsannolikhet'};
        });
      }catch{/* Saknat eller begränsat sentiment är inte en köp-/säljsignal. */}
      selected.push({epic,marketId,sentiment});
    }
    return {environment:mode,forex,crypto,selected};
  }
  async function rawMarket(mode:IgEnvironment,epic:string) {
    connected(mode);epicGuard(epic);
    return cached(`rawmarket:${mode}:${epic}`,15000,async()=>{
      const metadata=await cached(`metadata:${mode}:${epic}`,300000,async()=>{
        const data=await read(mode,`markets/${epic}`,"GET","3");
        if(data.instrument?.epic!==epic || !data.snapshot || !data.dealingRules)throw Error("IG-instrumentet kunde inte verifieras");
        return {data,at:now()};
      });
      const data=metadata.data,i=data.instrument,s=data.snapshot;let priceSnapshot=s,streamingPricesAvailable=i.streamingPricesAvailable===true;
      // Metadata kan återanvändas, men en äldre V3-kvot blir aldrig en ny färsk kvot.
      if(metadata.at!==now()||igQuoteTimestamp(s.updateTimeUTC,now())===null){
        priceSnapshot={marketStatus:s.marketStatus,delayTime:s.delayTime,bid:s.bid,offer:s.offer};
        try{const latest=await read(mode,`markets/${epic}`,"GET","4");if(latest.instrument?.epic===epic&&latest.snapshot?.scalingFactor===s.scalingFactor){priceSnapshot=latest.snapshot;streamingPricesAvailable=latest.instrument.streamingPricesAvailable===true;}}catch(e){if(e instanceof Error&&e.message.startsWith('IG begränsade antal'))throw e;/* Saknad UTC-tid håller order- och signalgrinden stängd. */}
      }
      return {environment:mode,epic,name:str(i.name),type:str(i.type),category:igMarketCategory({name:i.name,type:i.type}),expiry:str(i.expiry),status:"ready",error:null,
        quote:{...igSnapshotQuote(priceSnapshot,now()),percentageChange:num(priceSnapshot.percentageChange),netChange:num(priceSnapshot.netChange),high:num(priceSnapshot.high),low:num(priceSnapshot.low)},
        instrument:{epic,streamingPricesAvailable,marketId:str(i.marketId),type:str(i.type),expiry:str(i.expiry),unit:str(i.unit),contractSize:metadataNumber(i.contractSize),lotSize:metadataNumber(i.lotSize),valueOfOnePip:metadataNumber(i.valueOfOnePip),onePipMeans:str(i.onePipMeans),scalingFactor:num(s.scalingFactor),decimalPlacesFactor:num(s.decimalPlacesFactor),marginFactor:num(i.marginFactor),marginFactorUnit:str(i.marginFactorUnit),marginDepositBands:clone(i.marginDepositBands??[]),currencies:clone(i.currencies??[]),controlledRiskAllowed:i.controlledRiskAllowed===true,forceOpenAllowed:i.forceOpenAllowed===true,stopsLimitsAllowed:i.stopsLimitsAllowed===true},
        dealingRules:clone(data.dealingRules),updatedAt:now()};
    });
  }
  // ── Valutaomräkning (granskning 2, FX) ──
  // Exekveringsvaluta B → kontovaluta A: direkt par B/A, omvänt A/B, annars kors via USD (B→USD→A).
  // Stängd FX-marknad (helg): senaste verifierade kurs med 2 % säkerhetsmarginal, märkt "senaste växelkurs (fredag)".
  const fxFile=()=>dataPath('ig-fx-last.json');
  let fxLast:Record<string,IgAccountFx>|null=null;
  function loadFxLast(){if(fxLast)return fxLast;try{fxLast=JSON.parse(fs.readFileSync(fxFile(),'utf8'));}catch{fxLast={};}return fxLast!;}
  function saveFxLast(key:string,fx:IgAccountFx){const all=loadFxLast();all[key]=fx;try{fs.mkdirSync(path.dirname(fxFile()),{recursive:true});fs.writeFileSync(fxFile(),JSON.stringify(all));}catch{/* bara en reserv */}}
  async function pairEpic(mode:IgEnvironment,x:string,y:string):Promise<string|null>{
    // Parets EPIC ändras inte: sökningen cachas en timme. Stängd marknad (helg) hindrar inte att paret hittas.
    return cached(`fxpair:${mode}:${x}${y}`,3600000,async()=>{
      const found=await searchMarkets(mode,`${x}/${y}`);
      const re=new RegExp(`^${x}\\s*\\/\\s*${y}(?:\\s+Mini)?\\s*$`,'i');
      const rows=(found.markets as any[]).filter(m=>m.type==='CURRENCIES'&&re.test(m.name??''));
      rows.sort((a,b)=>Number(/Mini/i.test(a.name))-Number(/Mini/i.test(b.name)));
      return rows[0]?.epic??null;
    });
  }
  type Rate={bid:number;offer:number;receivedAt:number;observedAt:number;path:string;rejected?:string};
  // Granskning 3 (FX-rimlighet): finns både direkt och omvänt par jämförs de; skiljer de mer än 3 % används ingen kurs.
  async function pairRate(mode:IgEnvironment,from:string,to:string):Promise<Rate|null>{
    return cached<Rate|null>(`fxrate:${mode}:${from}${to}`,15000,async()=>{
      const paths:Rate[]=[];
      const direct=await pairEpic(mode,from,to).catch(()=>null);
      if(direct){const q=igPairQuote(await rawMarket(mode,direct),from,to,now());if(q)paths.push({bid:q.bid,offer:q.offer,receivedAt:q.receivedAt,observedAt:q.observedAt,path:`${from}/${to}`});}
      const inverse=await pairEpic(mode,to,from).catch(()=>null);
      if(inverse){const q=await rawMarket(mode,inverse).then(m=>igPairQuote(m,to,from,now())).catch(e=>{if(paths.length)return null;throw e;});if(q)paths.push({bid:1/q.offer,offer:1/q.bid,receivedAt:q.receivedAt,observedAt:q.observedAt,path:`1/(${to}/${from})`});}
      if(!paths.length)return null;
      const [first,...rest]=paths;const rejected=igFxPlausibility(from,to,first!,rest,null,now());
      return rejected?{...first!,rejected}:first!;
    });
  }
  const cross=(a:Rate,b:Rate):Rate=>({bid:a.bid*b.bid,offer:a.offer*b.offer,receivedAt:Math.min(a.receivedAt,b.receivedAt),observedAt:Math.min(a.observedAt,b.observedAt),path:`${a.path} × ${b.path}`});
  /** Senaste skäl till att en växelkurs inte godtogs (per miljö och par). Visas i stället för en storlek. */
  const fxRejected=new Map<string,string>();
  function accountFxError(mode:IgEnvironment,base:string):string|null{const currency=status().environments[mode].account?.currency;return currency?fxRejected.get(`${mode}:${base}:${currency}`)??null:null;}
  async function accountFx(mode:IgEnvironment,base='USD'):Promise<IgAccountFx|null> {
    connected(mode);const currency=status().environments[mode].account?.currency;
    if(!currency||!/^[A-Z]{3}$/.test(currency)||!/^[A-Z]{3}$/.test(base))return null;
    if(currency===base)return {baseCurrency:base,accountCurrency:currency,bid:1,offer:1,receivedAt:now(),observedAt:now(),source:`${base}-konto · ingen valutaomräkning`};
    const key=`${mode}:${base}:${currency}`;
    let fresh:IgAccountFx|null=null,rejected:string|null=null;
    try{
      const got=await cached<{fx:IgAccountFx}|{rejected:string}|null>(`fx:${mode}:${base}${currency}`,30000,async()=>{
        let r=await pairRate(mode,base,currency);const others:Rate[]=[];
        if(r?.rejected)return {rejected:r.rejected};
        if(base!=='USD'&&currency!=='USD'){
          if(!r){const a=await pairRate(mode,base,'USD'),b2=a&&!a.rejected?await pairRate(mode,'USD',currency):null;if(a?.rejected)return {rejected:a.rejected};if(b2?.rejected)return {rejected:b2.rejected};if(a&&b2)r=cross(a,b2);}
          else{
            // Korsvägen jämförs när båda USD-benen redan finns i cachen (kostar inga extra IG-läsningar).
            const a=peek<Rate|null>(`fxrate:${mode}:${base}USD`,15000),b2=peek<Rate|null>(`fxrate:${mode}:USD${currency}`,15000);
            if(a&&b2&&!a.rejected&&!b2.rejected)others.push(cross(a,b2));
          }
        }
        if(!r)return null; // även "ingen färsk kurs" cachas 30 s så att en stängd FX-marknad inte kostar läsningar
        const reason=igFxPlausibility(base,currency,r,others,loadFxLast()[key]??null,now());
        if(reason)return {rejected:reason};
        return {fx:{baseCurrency:base,accountCurrency:currency,bid:r.bid,offer:r.offer,receivedAt:r.receivedAt,observedAt:r.observedAt,source:`IG ${r.path} · verifierad bid/ask`,path:r.path} as IgAccountFx};
      });
      if(got&&'rejected' in got)rejected=got.rejected;else fresh=got?.fx??null;
    }catch(e){if(e instanceof Error&&e.message.startsWith('IG begränsade antal'))fresh=null;}
    // En orimlig kurs ersätts aldrig av en äldre: ingen storlek räknas förrän kurserna stämmer igen.
    if(rejected){fxRejected.set(key,rejected);return null;}
    fxRejected.delete(key);
    if(fresh&&igFxIsFresh(fresh,currency,now(),base)){saveFxLast(key,fresh);return fresh;}
    const last=loadFxLast()[key];
    if(last&&now()-last.observedAt<=FX_STALE_MAX_MS){const stale=igStaleFx(last);return igFxIsFresh(stale,currency,now(),base)?stale:null;}
    return null;
  }
  async function market(mode:IgEnvironment,epic:string) {
    const detail=await rawMarket(mode,epic),currency=status().environments[mode].account?.currency??null;
    const currencies=detail.instrument.currencies;
    const execution=(currencies.find((c:any)=>c.isDefault===true)??(currencies.length===1?currencies[0]:null))?.code;
    const fx=execution&&currency&&execution!==currency?await accountFx(mode,execution):null;
    const rules=igCalculationRules(detail.instrument,{scalingFactor:detail.instrument.scalingFactor},currency,fx,now());
    // Orimlig växelkurs: tydligt besked i stället för en storlek (pointValue saknas då redan).
    const fxError=execution&&currency&&execution!==currency&&!fx?accountFxError(mode,execution):null;
    return {...detail,calculationRules:{...rules,...(fxError?{note:fxError,fxError}:{}),minSize:detail.dealingRules.minDealSize?.value??null}};
  }
  async function candles(mode:IgEnvironment,epic:string,timeframe:IgTimeframe,limit=100) {
    connected(mode);epicGuard(epic);if(!Object.hasOwn(frames,timeframe)||!Number.isInteger(limit)||limit<20||limit>200)throw Error("Ogiltiga IG-ljusparametrar");
    const detail=await market(mode,epic);
    const cacheKey=`prices:${mode}:${epic}:${timeframe}:${limit}`;
    const prior=cache.get(`${cacheKey}:account:${connectionIdentity(mode)}`)?.value;
    const last=prior?.candles?.at(-1);
    const incremental=last && now()-last.closeTime < frames[timeframe].ms*2;
    const count=incremental?3:limit+1;
    const result = await cached(cacheKey,Math.min(60000,frames[timeframe].ms-now()%frames[timeframe].ms),async()=>{
      if(prior?.allowance && num(prior.allowance.remainingAllowance)!==null && prior.allowance.remainingAllowance<count)throw Error("IG-historikkvoten räcker inte för nya ljus");
      const data=await read(mode,`prices/${epic}`,"GET","3",undefined,{query:new URLSearchParams({resolution:frames[timeframe].resolution,max:String(count),pageSize:String(count)}).toString()});
      const normalized=normalizeIgCandles(data.prices,timeframe,now());
      normalized.candles=normalized.candles.slice(-limit);
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
    return cached(`history:${mode}`,120000,async()=>{
      const from=new Date(now()-30*86400000).toISOString().slice(0,19),to=new Date(now()).toISOString().slice(0,19);
      const query=new URLSearchParams({from,to,pageSize:"100",pageNumber:"1"}).toString();
      const [t,a]=await Promise.all([read(mode,"history/transactions","GET","2",undefined,{query}),read(mode,"history/activity","GET","3",undefined,{query})]);
      if(!Array.isArray(t.transactions)||!Array.isArray(a.activities))throw Error("IG-historiken kunde inte verifieras");
      const txPages=num(t.metadata?.pageData?.totalPages),hasMore=(txPages!==null&&txPages>1)||!!a.metadata?.paging?.next;
      return {status:hasMore?"partial":"ready",error:null,complete:!hasMore,periodDays:30,transactions:t.transactions.map((r:any)=>({date:str(r.dateUtc)??str(r.date),openDate:str(r.openDateUtc)??null,type:str(r.transactionType),instrumentName:str(r.instrumentName),reference:str(r.reference),profitAndLoss:str(r.profitAndLoss),currency:str(r.currency),openLevel:str(r.openLevel),closeLevel:str(r.closeLevel),size:str(r.size),cashTransaction:typeof r.cashTransaction==="boolean"?r.cashTransaction:["DEPOSIT","WITHDRAWAL","TRANSFER","INTEREST","FEE"].includes(r.transactionType)?true:null})),activities:a.activities.map((r:any)=>({date:str(r.date),type:str(r.type),status:str(r.status),description:str(r.description),epic:str(r.epic),dealId:str(r.dealId)})),pagination:{transactions:{pageNumber:num(t.metadata?.pageData?.pageNumber),pageSize:num(t.metadata?.pageData?.pageSize),totalPages:txPages},activities:{nextPageAvailable:!!a.metadata?.paging?.next,size:num(a.metadata?.size)}},note:"Kontohändelser och kassatransaktioner är inte automatiskt avslutade trades eller strategins PnL",updatedAt:now()};
    });
  }
  return {searchMarkets,catalogue,marketOverview,market,rawMarket,accountFx,accountFxError,candles,history};
}
const markets=createIgMarkets();
export const searchIgMarkets=markets.searchMarkets,getIgMarket=markets.market,getIgCandles=markets.candles,getIgHistory=markets.history,getIgAccountFx=markets.accountFx,getIgCatalogue=markets.catalogue,getIgMarketOverview=markets.marketOverview;
