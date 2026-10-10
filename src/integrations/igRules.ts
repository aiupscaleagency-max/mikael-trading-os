// Kursens prisenhet, exekveringsvaluta och kontovaluta verifieras separat.
// FX (granskning 2): valfri noteringsvaluta → kontovaluta. baseCurrency = instrumentets exekveringsvaluta.
// stale=true: valutamarknaden är stängd (helg) och senaste verifierade kurs används med säkerhetsmarginal
// (bid sänkt, offer höjd med safetyMargin) och etiketten "senaste växelkurs (fredag)".
export interface IgAccountFx {baseCurrency:string;accountCurrency:string;bid:number;offer:number;receivedAt:number;observedAt:number;source:string;epic?:string;stale?:boolean;label?:string;safetyMargin?:number;path?:string}
export const FX_SAFETY_MARGIN=0.02;
/** Hur länge en senaste verifierad kurs får användas när FX-marknaden är stängd (helg + helgdag). */
export const FX_STALE_MAX_MS=4*86400000;
const WEEKDAYS=['söndag','måndag','tisdag','onsdag','torsdag','fredag','lördag'];
/** Bygger en "senaste växelkurs"-variant med säkerhetsmarginal. Ändrar aldrig den sparade kursen. */
export function igStaleFx(last:IgAccountFx,margin=FX_SAFETY_MARGIN):IgAccountFx{
  const day=WEEKDAYS[new Date(last.observedAt).getDay()]??'okänd dag';
  return {...last,bid:last.bid*(1-margin),offer:last.offer*(1+margin),stale:true,safetyMargin:margin,label:`senaste växelkurs (${day})`,source:`${last.source} · senaste verifierade kurs ±${Math.round(margin*100)} % säkerhetsmarginal`};
}
/** FX-rimlighet (granskning 3): en ny kurs får avvika högst 20 % från senaste verifierade kurs. */
export const FX_MAX_DEVIATION=0.2;
/** Direkt, omvänd och korsad väg (via USD) för samma par får skilja högst 3 % i mittkurs. */
export const FX_PATH_TOLERANCE=0.03;
/** Senaste verifierade kurs äldre än så används inte som jämförelse (då gäller bara vägarnas inbördes kontroll). */
export const FX_REFERENCE_MAX_MS=30*86400000;
const mid=(r:{bid:number;offer:number})=>(r.bid+r.offer)/2;
/** Returnerar ett tydligt skäl när kursen inte är rimlig, annars null. Rör aldrig storleksberäkningen själv. */
export function igFxPlausibility(base:string,quote:string,rate:{bid:number;offer:number;path?:string},others:readonly {bid:number;offer:number;path:string}[],last:{bid:number;offer:number;observedAt:number}|null|undefined,now:number):string|null{
  if(![rate.bid,rate.offer].every(v=>Number.isFinite(v)&&v>0)||rate.offer<rate.bid)return `Växelkursen ${base}/${quote} är ogiltig; ingen storlek räknas.`;
  const m=mid(rate);
  for(const o of others){if(![o.bid,o.offer].every(v=>Number.isFinite(v)&&v>0))continue;const dev=Math.abs(mid(o)-m)/m;if(dev>FX_PATH_TOLERANCE)return `Växelkursen ${base}/${quote} stämmer inte mellan vägarna ${rate.path??'direkt'} (${m.toPrecision(6)}) och ${o.path} (${mid(o).toPrecision(6)}), ${Math.round(dev*100)} % skillnad. Ingen storlek räknas; kontrollera kursen i IG.`;}
  if(last&&Number.isFinite(last.observedAt)&&now-last.observedAt<=FX_REFERENCE_MAX_MS&&last.bid>0&&last.offer>0){const ref=mid(last),dev=Math.abs(m-ref)/ref;if(dev>FX_MAX_DEVIATION)return `Växelkursen ${base}/${quote} (${m.toPrecision(6)}) avviker ${Math.round(dev*100)} % från senaste verifierade kurs (${ref.toPrecision(6)}). Mer än 20 % tyder på fel skalning eller fel par, så ingen storlek räknas; kontrollera kursen i IG.`;}
  return null;
}
const numeric=(v:unknown)=>typeof v==='number'?v:typeof v==='string'&&/^[0-9]+(?:\.[0-9]+)?$/.test(v.trim())?Number(v):NaN;
export function igFxIsFresh(fx:IgAccountFx|null|undefined,accountCurrency:string,now:number,baseCurrency='USD'){
  if(!fx||fx.baseCurrency!==baseCurrency||fx.accountCurrency!==accountCurrency||!Number.isFinite(fx.bid)||!Number.isFinite(fx.offer)||fx.bid<=0||fx.offer<fx.bid)return false;
  // Senaste kurs vid stängd FX-marknad: bara med säkerhetsmarginal och högst FX_STALE_MAX_MS gammal.
  if(fx.stale===true)return (fx.safetyMargin??0)>=FX_SAFETY_MARGIN&&[fx.receivedAt,fx.observedAt].every(t=>Number.isFinite(t)&&now-t>=0&&now-t<=FX_STALE_MAX_MS);
  return [fx.receivedAt,fx.observedAt].every(t=>Number.isFinite(t)&&now-t>=0&&now-t<=60000);
}
/** Kurs för ett IG-valutapar "X/Y" (eller "X/Y Mini"). Kräver färsk, ofördröjd, handlingsbar kvot. */
export function igPairQuote(market:Record<string,any>,base:string,quote:string,now:number):{bid:number;offer:number;receivedAt:number;observedAt:number;epic:string}|null{
  const q=market?.quote;const name=String(market?.name??'');
  if(market?.type!=='CURRENCIES'||!new RegExp(`^${base}\\s*\\/\\s*${quote}(?:\\s+Mini)?\\s*$`,'i').test(name))return null;
  // N3 (granskning 3): parets egna instrumentregler. Kvoten ska vara i parets kvotvaluta med en positiv skalning.
  const inst=market?.instrument??{},cur=Array.isArray(inst.currencies)?inst.currencies:[];
  const code=(cur.find((c:any)=>c?.isDefault===true)??(cur.length===1?cur[0]:null))?.code;
  if(cur.length&&code!==quote)return null;
  if(inst.scalingFactor!==undefined&&inst.scalingFactor!==null&&!(numeric(inst.scalingFactor)>0))return null;
  if(q?.marketStatus!=='TRADEABLE'||q.delayTime!==0||!(q.bid>0)||!(q.offer>=q.bid))return null;
  if(![q.receivedAt,q.observedAt].every((t:number)=>Number.isFinite(t)&&now-t>=0&&now-t<=60000))return null;
  return {bid:q.bid,offer:q.offer,receivedAt:q.receivedAt,observedAt:q.observedAt,epic:market.epic};
}
// IG:s exchangeRate-fält anger inte riktning. Bara ett uttryckligen verifierat par används.
export function igUsdSekFx(market:Record<string,any>,now:number):IgAccountFx|null {
  const q=market.quote,scale=numeric(market.instrument?.scalingFactor);
  const rules=igCalculationRules(market.instrument??{},{scalingFactor:scale},'SEK',null,now);
  if(!rules.verified||rules.executionCurrency!=='SEK'||market.type!=='CURRENCIES'||!/^USD\s*\/\s*SEK(?:\s+Mini)?\s*$/i.test(market.name??'')||!(scale>0)||q?.marketStatus!=='TRADEABLE'||q.delayTime!==0)return null;
  const fx:IgAccountFx={baseCurrency:'USD',accountCurrency:'SEK',bid:q.bid,offer:q.offer,receivedAt:q.receivedAt,observedAt:q.observedAt,source:'IG USD/SEK · verifierad native bid/ask',epic:market.epic};
  return igFxIsFresh(fx,'SEK',now)?fx:null;
}
export function igCalculationRules(instrument:Record<string,any>,snapshot:Record<string,any>,accountCurrency:string|null,fx:IgAccountFx|null=null,now=Date.now()) {
  const meaning=typeof instrument.onePipMeans==='string'?/^([0-9]+(?:\.[0-9]+)?)\s*(?:([A-Z]{3})\/([A-Z]{3}))?$/.exec(instrument.onePipMeans.trim()):null;
  const pip=meaning?numeric(meaning[1]):NaN,value=numeric(instrument.valueOfOnePip),scaling=numeric(snapshot.scalingFactor);
  const offered=Array.isArray(instrument.currencies)?instrument.currencies:[];
  const currency=(offered.find((c:any)=>c.isDefault===true)??(offered.length===1?offered[0]:null))?.code??null;
  const contract=numeric(instrument.contractSize),native=value/pip;
  const contractMatches=instrument.type!=='CURRENCIES'||instrument.unit==='CONTRACTS'&&contract>0&&Math.abs(native-contract)<=contract*1e-8;
  // Bid/ask anges redan i native prisnivå. scalingFactor används för pip-avstånd, aldrig en andra gång för kursvärdet.
  const nativePointValue=[pip,value,scaling].every(v=>Number.isFinite(v)&&v>0)&&Number.isFinite(native)&&currency&&(!meaning?.[2]||meaning[2]===currency)&&contractMatches?native:null;
  const convert=!!currency&&!!accountCurrency&&currency!==accountCurrency&&igFxIsFresh(fx,accountCurrency,now,currency);
  const pointValue=nativePointValue!==null?(currency===accountCurrency?nativePointValue:convert?nativePointValue*fx!.offer:null):null;
  const profitPointValue=pointValue!==null?(convert?nativePointValue!*fx!.bid:pointValue):null;
  const factor=numeric(instrument.marginFactor),bands=instrument.marginDepositBands;
  const percentages=Array.isArray(bands)?[factor,...bands.map((b:any)=>numeric(b.margin))]:[];
  const marginRate=instrument.marginFactorUnit==='PERCENTAGE'&&percentages.length>0&&percentages.every(v=>Number.isFinite(v)&&v>0&&v<=100)?Math.max(...percentages)/100:null;
  const marginBasis=marginRate!==null&&percentages.some(v=>v!==factor)?'Konservativ övre gräns · högsta verifierade IG-marginalband':'IG procentmarginal';
  return {pointValue,profitPointValue,nativePointValue,pointCurrency:pointValue!==null?accountCurrency:currency??null,executionCurrency:currency??null,marginRate,marginBasis,priceScalingFactor:scaling,fx:convert?fx:null,verified:pointValue!==null,source:'IG native valueOfOnePip / onePipMeans · verifierat mot contractSize',note:pointValue===null?'Punktvärde eller färsk kontovalutaomräkning kunde inte verifieras':`${marginBasis} · bruttoscenario före slippage och okända avgifter`};
}
export function igQuoteTimestamp(time:unknown,receivedAt:number):number|null {
  if(typeof time!=='string'||!/^\d{2}:\d{2}:\d{2}$/.test(time))return null;
  const parts=time.split(':').map(Number);if(parts[0]!>23||parts[1]!>59||parts[2]!>59)return null;
  const date=new Date(receivedAt);date.setUTCHours(parts[0]!,parts[1]!,parts[2]!,0);
  const timestamp=date.getTime();return timestamp<=receivedAt?timestamp:timestamp-86400000;
}

// Version 4 anger UTC-epoch; IG:s svar förekommer i både sekunder och millisekunder.
export function igSnapshotQuote(snapshot:Record<string,any>,receivedAt:number){
 const value=(v:unknown)=>{const n=typeof v==='number'?v:typeof v==='string'&&/^[0-9]+(?:\.[0-9]+)?$/.test(v)?Number(v):NaN;return Number.isFinite(n)?n:null;};
 const epoch=value(snapshot.updateTimestampUTC);
 const observedAt=epoch!==null&&epoch>0?(epoch<100000000000?epoch*1000:epoch):igQuoteTimestamp(snapshot.updateTimeUTC,receivedAt);
 const ladder=Array.isArray(snapshot.priceLadder)?snapshot.priceLadder[0]:null;
 const sizes=Array.isArray(snapshot.currencyLadders)&&snapshot.currencyLadders.length===1?snapshot.currencyLadders[0]:null;const buy=value(sizes?.askSizes?.[0]),sell=value(sizes?.bidSizes?.[0]);const maxQuoteSize=buy!==null&&sell!==null&&buy>0&&sell>0?Math.min(buy,sell):null;
 return {maxQuoteSize,quoteSizeCurrency:typeof sizes?.currency==='string'?sizes.currency:null,observedAt,bid:value(ladder?.bid??snapshot.bid),offer:value(ladder?.ask??snapshot.offer),marketStatus:typeof snapshot.marketStatus==='string'?snapshot.marketStatus:null,delayTime:value(snapshot.delayTime),updateTimeUTC:typeof snapshot.updateTimeUTC==='string'?snapshot.updateTimeUTC:null,receivedAt,source:epoch!==null?'IG REST v4 · UTC-tidsstämpel':'IG REST snapshot'};
}
