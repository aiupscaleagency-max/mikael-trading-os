// Kursens prisenhet och kontovaluta måste vara verifierade före beloppsberäkning.
export function igCalculationRules(instrument:Record<string,any>,snapshot:Record<string,any>,accountCurrency:string|null) {
  const numeric=(v:unknown)=>typeof v==='number'?v:typeof v==='string'&&/^[0-9]+(?:\.[0-9]+)?$/.test(v.trim())?Number(v):NaN;
  const pip=numeric(instrument.onePipMeans),value=numeric(instrument.valueOfOnePip),scaling=numeric(snapshot.scalingFactor);
  const currency=Array.isArray(instrument.currencies)?instrument.currencies.find((c:any)=>c.isDefault===true)?.code:null;
  const pointValue=[pip,value,scaling].every(v=>Number.isFinite(v)&&v>0)&&currency===accountCurrency?value/(pip*scaling):null;
  const bands=instrument.marginDepositBands;
  const factor=numeric(instrument.marginFactor),flat=Array.isArray(bands)&&bands.every((b:any)=>numeric(b.margin)===factor);
  const marginRate=instrument.marginFactorUnit==='PERCENTAGE'&&factor>0&&factor<=100&&flat?factor/100:null;
  return {pointValue,pointCurrency:currency??null,marginRate,verified:pointValue!==null,source:'IG instrument.valueOfOnePip / (onePipMeans × snapshot.scalingFactor)',note:pointValue===null?'Punktvärde eller kontovaluta kunde inte verifieras':'Bruttoscenario före slippage och okända avgifter'};
}
export function igQuoteTimestamp(time:unknown,receivedAt:number):number|null {
  if(typeof time!=='string'||!/^\d{2}:\d{2}:\d{2}$/.test(time))return null;
  const parts=time.split(':').map(Number);if(parts[0]!>23||parts[1]!>59||parts[2]!>59)return null;
  const date=new Date(receivedAt);date.setUTCHours(parts[0]!,parts[1]!,parts[2]!,0);
  const timestamp=date.getTime();return timestamp<=receivedAt?timestamp:timestamp-86400000;
}
