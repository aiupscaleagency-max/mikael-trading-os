// Gemensamma beräkningar: okända CFD-regler ger aldrig påhittade belopp.
export const frames = { '1m':60, '3m':180, '5m':300, '15m':900, '30m':1800, '1h':3600, '4h':14400, '1d':86400 };
export function quoteIsFresh(market, now=Date.now()) {
  const q=market?.quote;
  return !!q && q.marketStatus==='TRADEABLE' && q.delayTime===0 && Number.isFinite(q.receivedAt) && now-q.receivedAt>=0 && now-q.receivedAt<=60000 && (q.observedAt===undefined || (Number.isFinite(q.observedAt)&&now-q.observedAt>=0&&now-q.observedAt<=60000)) && Number.isFinite(q.bid) && Number.isFinite(q.offer) && q.bid>0 && q.offer>=q.bid;
}
export function scenario({direction,entry,stop,target,size,pointValue,marginRate,available,currency,pointCurrency,knownFees=null}) {
  const finite=v=>Number.isFinite(v);
  const ready=[entry,stop,target,size,pointValue].every(finite) && entry>0 && stop>0 && target>0 && size>0 && pointValue>0 && currency===pointCurrency;
  const sign=direction==='BUY'?1:-1;
  const levels=ready && sign*(entry-stop)>0 && sign*(target-entry)>0;
  if(!levels)return {valid:false,error:'Verifiera storlek, punktvärde, valuta och nivåerna för SL/TP.',risk:null,reward:null,exposure:null,margin:null,percent:null};
  const exposure=entry*size*pointValue, risk=sign*(entry-stop)*size*pointValue, reward=sign*(target-entry)*size*pointValue;
  const margin=finite(marginRate)&&marginRate>0&&marginRate<=1?exposure*marginRate:null;
  return {valid:true,risk,reward,exposure,margin,percent:reward/exposure*100,capitalPercent:finite(available)&&available>0?risk/available*100:null,ratio:reward/risk,knownFees};
}
export function sizeForCapitalRisk({available,percent,entry,stop,pointValue,minSize=0,step=0.01}) {
  if(![available,percent,entry,stop,pointValue,step].every(Number.isFinite)||available<=0||percent<=0||percent>5||pointValue<=0||entry===stop||step<=0)return null;
  const raw=available*(percent/100)/(Math.abs(entry-stop)*pointValue);
  const size=Number((Math.floor((raw+Number.EPSILON)/step)*step).toFixed(8));
  return size>=minSize&&size>0?size:null;
}
export function increaseDraft(position) {
  if(!position || !(position.size>0))throw Error('Positionens storlek saknas');
  return {epic:position.epic,direction:position.direction,size:position.size,stop:position.stopLevel,target:position.limitLevel,sourceDealId:position.dealId};
}
export function extendDeadline(position,minutes,now=Date.now()) {
  if(!Number.isFinite(minutes)||minutes<=0||minutes>120)throw Error('Välj 1–120 minuter');
  return Math.max(now,position.closeAt??now)+minutes*60000;
}
export function normalizeSignal(row,analysis,now=Date.now()) {
  const action=['BUY','SELL','HOLD'].includes(row.action)?row.action:'HOLD';
  const completed=analysis?.completedAt??now, validUntil=completed+Math.min(15*60000,(frames[analysis?.selection?.timeframe]??300)*1000);
  const levels=[row.entryLevel,row.stopLevel,row.targetLevel].every(v=>Number.isFinite(v)&&v>0);
  return {...row,action,completedAt:completed,validUntil,timeframe:analysis?.selection?.timeframe??'5m',horizonMinutes:analysis?.selection?.horizonMinutes??15,copyable:action!=='HOLD'&&levels&&now<validUntil};
}
