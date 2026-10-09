import {callIgAuthenticated,getIgReadBudget,getIgStatus,type IgEnvironment} from './igConnection.js';
import {getIgCatalogue,getIgCandles,igMarketCategory} from './igMarkets.js';
const numeric=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)?x:null;
export function enrichIgDirectoryMarket(m:Record<string,any>){const bid=numeric(m.bid),offer=numeric(m.offer),changePercent=numeric(m.percentageChange??m.changePercent);return {...m,changePercent,movementPercent:changePercent===null?null:Math.abs(changePercent),spread:bid!==null&&offer!==null&&offer>=bid?offer-bid:null,trendScore:null,sentimentLongPercent:null};}
export const igDirectoryRankings={gainers:{available:true,field:'changePercent',direction:'desc',period:'IG:s sessionsförändring; inte en egen rullande 24h-beräkning'},losers:{available:true,field:'changePercent',direction:'asc'},movers:{available:true,field:'movementPercent',direction:'desc'},spread:{available:true,field:'spread',direction:'asc',note:'Endast jämförbart inom samma prisenhet'},trend:{available:false,reason:'Kräver verifierade stängda ljus med gemensam period'},mostBought:{available:false,reason:'Verifierad kundsentimentdata saknas; är inte handelsvolym'},profits:{available:false,reason:'Marknadsuppgång är inte realiserad strategivinst'}};
export function createIgMarketDirectory(deps:{call?:typeof callIgAuthenticated;status?:typeof getIgStatus;budget?:typeof getIgReadBudget;fallback?:typeof getIgCatalogue;now?:()=>number;candles?:typeof getIgCandles}={}){
 const call=deps.call??callIgAuthenticated,status=deps.status??getIgStatus,budget=deps.budget??getIgReadBudget,fallback=deps.fallback??getIgCatalogue,now=deps.now??Date.now;
 const candles=deps.candles??getIgCandles;
 const cache=new Map<string,{at:number;value:any}>(),pending=new Map<string,Promise<any>>();
 // Senaste katalogen per miljö/kategori (oavsett inloggning) — bara för katalogreferenser, aldrig priser.
 const latest=new Map<string,{binding:string;value:any}>();
 function identity(mode:IgEnvironment){if(mode!=='demo'&&mode!=='live')throw Error('Ogiltig IG-miljö');const c=status().environments[mode];if(c.status!=='connected'||!c.connectionGeneration)throw Error('IG är inte anslutet');return c.connectionGeneration;}
 async function catalogue(mode:IgEnvironment,category:unknown){if(category!=='forex'&&category!=='crypto')throw Error('Välj Forex eller Kryptovalutor');const binding=identity(mode),key=`${mode}:${binding}:${category}`,old=cache.get(key);if(old&&now()-old.at<60000)return structuredClone(old.value);if(pending.has(key))return structuredClone(await pending.get(key));
 // En enda hämtare äger pagination och läskvot. Parallella kategorier delar dess framsteg.
 const job=(async()=>{const markets=new Map<string,any>();let unclassified=0;
 const result=await fallback(mode,category);unclassified=Number.isInteger(result.unclassifiedInstruments)&&result.unclassifiedInstruments>=0?result.unclassifiedInstruments:0;if(identity(mode)!==binding)throw Error('IG-kontoanslutningen ändrades');
 for(const raw of result.markets){const m={...raw,name:raw.name??raw.instrumentName,type:raw.type??raw.instrumentType};const classified=igMarketCategory(m);if(!classified){unclassified++;continue;}if(typeof m.epic==='string'&&classified===category)markets.set(m.epic,enrichIgDirectoryMarket({...m,category}));}
 const complete=result.complete===true&&unclassified===0,source=result.source??'IG kontosökning',note=result.note;
 const remainingSearches=Number.isInteger(result.remainingSearches)&&result.remainingSearches>=0?result.remainingSearches:null;
 const rows=[...markets.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name),'sv'));const hasChanges=rows.some(m=>m.changePercent!==null),hasSpread=rows.some(m=>m.spread!==null);
 const rankings=structuredClone(igDirectoryRankings);rankings.gainers.available=hasChanges;rankings.losers.available=hasChanges;rankings.movers.available=hasChanges;rankings.spread.available=hasSpread;
 const value={environment:mode,category,markets:rows,complete,status:complete?'ready':'partial',source,note,error:result.error??result.categoryError??null,progress:result.progress??null,updatedAt:now(),remainingSearches,unclassifiedInstruments:unclassified,rankings};cache.set(key,{at:now(),value});latest.set(`${mode}:${category}`,{binding,value});return value;})();pending.set(key,job);try{return structuredClone(await job);}finally{pending.delete(key);}}
 /** Senast hämtade katalog utan IG-anrop (null om ingen finns eller om miljön inte längre är ansluten med samma inloggning). */
 function peek(mode:IgEnvironment,category:'forex'|'crypto'){const l=latest.get(`${mode}:${category}`);if(!l)return null;const c=status().environments[mode];if(c.status!=='connected'||c.connectionGeneration!==l.binding)return null;return structuredClone(l.value);}
 async function enrich(mode:IgEnvironment,epic:string){
 if(typeof epic!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(epic))throw Error('Ogiltigt IG-instrument');
 const binding=identity(mode),key=`enrich:${mode}:${binding}:${epic}`,cached=cache.get(key);if(cached&&now()-cached.at<60000)return structuredClone(cached.value);if(pending.has(key))return structuredClone(await pending.get(key));
 const job=(async()=>{let trendScore:number|null=null,sentimentLongPercent:number|null=null;const reasons:string[]=[];
 try{if(budget(mode).remaining<3||budget(mode).used>=8)throw Error('budget');const detail=await call(mode,`markets/${epic}`,'GET','3');if(identity(mode)!==binding||detail.instrument?.epic!==epic)throw Error('identity');const marketId=detail.instrument?.marketId;
 if(typeof marketId!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(marketId))throw Error('marketId');const sentiment=await call(mode,`client-sentiment/${encodeURIComponent(marketId)}`,'GET','1');const long=numeric(sentiment.longPositionPercentage),short=numeric(sentiment.shortPositionPercentage);if(sentiment.marketId!==marketId||long===null||short===null||long<0||short<0||long>100||short>100||Math.abs(long+short-100)>0.1)throw Error('sentiment');sentimentLongPercent=long;
 }catch{reasons.push('Verifierat IG-kundsentiment saknas för instrumentet');}
 try{if(budget(mode).remaining<1||budget(mode).used>=10)throw Error('budget');const result=await candles(mode,epic,'1h',60);const bars=result.candles.slice(-50);if(bars.length!==50||bars.some((b,i)=>!Number.isFinite(b.close)||b.close<=0||b.closeTime>now()||(i>0&&b.openTime-bars[i-1]!.openTime!==3600000))||now()-bars[49]!.closeTime>3600000)throw Error('candles');const sma=(n:number)=>bars.slice(-n).reduce((total,b)=>total+b.close,0)/n;trendScore=(sma(20)/sma(50)-1)*100;
 }catch{reasons.push('Trend kräver 50 sammanhängande aktuella stängda 1h-ljus');}
 if(identity(mode)!==binding)throw Error('IG-kontoanslutningen ändrades');const value={environment:mode,epic,trendScore,sentimentLongPercent,trendBasis:'SMA20/SMA50 på 50 stängda 1h-ljus · procentuell skillnad',sentimentBasis:'IG andel långa positioner · inte köpvolym',updatedAt:now(),reasons};cache.set(key,{at:now(),value});return value;})();pending.set(key,job);try{return structuredClone(await job);}finally{pending.delete(key);}
 }

 // Båda anslutna miljöer fortsätter oberoende av vilken flik användaren visar.
 const scans=new Map<IgEnvironment,{binding:string;at:number;cryptoFirst:boolean}>();let scanning=false;
 async function tickCatalogues(){
  if(scanning)return;scanning=true;
  try{for(const mode of ['demo','live'] as const){
   if(status().environments[mode].status!=='connected')continue;
   const binding=identity(mode),previous=scans.get(mode);
   if(previous?.binding===binding&&now()-previous.at<65000)continue;
   const cryptoFirst=previous?.binding===binding?!previous.cryptoFirst:false;
   scans.set(mode,{binding,at:now(),cryptoFirst});
   for(const category of cryptoFirst?['crypto','forex']:['forex','crypto']){
    if(identity(mode)!==binding)break;
    try{await catalogue(mode,category);}catch{/* Nästa begränsade cykel försöker igen; HTTP-anrop visar felet. */}
   }
  }}finally{scanning=false;}
 }
 return {catalogue,enrich,tickCatalogues,peek};
}
const directory=createIgMarketDirectory();export const getIgMarketDirectory=directory.catalogue,getIgDirectoryEnrichment=directory.enrich,tickIgCatalogues=directory.tickCatalogues,peekIgMarketDirectory=directory.peek;

/**
 * Live-EPICs som saknas i Demo-katalogen: bara katalogreferens (namn/EPIC/typ), märkt
 * "ej tillgänglig på Demo". Inga Live-priser, -saldon eller -ändringar följer med.
 */
export function igLiveOnlyReferences(demoMarkets:{epic:string}[],liveMarkets:Record<string,any>[]|null|undefined){
 const have=new Set(demoMarkets.map(m=>m.epic));
 return (liveMarkets??[]).filter(m=>typeof m.epic==='string'&&!have.has(m.epic)).map(m=>({epic:m.epic as string,name:(m.name??null) as string|null,category:(m.category??null) as string|null,type:(m.type??null) as string|null,availableHere:false,reference:true,label:'ej tillgänglig på Demo'}));
}
