// Kursens prisenhet, exekveringsvaluta och kontovaluta verifieras separat.
export interface IgAccountFx {baseCurrency:'USD';accountCurrency:string;bid:number;offer:number;receivedAt:number;observedAt:number;source:string;epic?:string}
const numeric=(v:unknown)=>typeof v==='number'?v:typeof v==='string'&&/^[0-9]+(?:\.[0-9]+)?$/.test(v.trim())?Number(v):NaN;
export function igFxIsFresh(fx:IgAccountFx|null|undefined,accountCurrency:string,now:number){return !!fx&&fx.baseCurrency==='USD'&&fx.accountCurrency===accountCurrency&&Number.isFinite(fx.bid)&&Number.isFinite(fx.offer)&&fx.bid>0&&fx.offer>=fx.bid&&[fx.receivedAt,fx.observedAt].every(t=>Number.isFinite(t)&&now-t>=0&&now-t<=60000);}
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
  const convert=currency==='USD'&&accountCurrency==='SEK'&&igFxIsFresh(fx,'SEK',now);
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
