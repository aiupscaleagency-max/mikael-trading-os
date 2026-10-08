// Gemensamma beräkningar: okända CFD-regler ger aldrig påhittade belopp.
export const frames = { '1m':60, '3m':180, '5m':300, '15m':900, '30m':1800, '1h':3600, '4h':14400, '1d':86400 };
export function quoteIsFresh(market, now=Date.now()) {
  const q=market?.quote;
  const fx=market?.calculationRules?.fx;
  const fxFresh=!fx||[fx.receivedAt,fx.observedAt].every(t=>Number.isFinite(t)&&now-t>=0&&now-t<=60000);
  const proof=q?.delayVerification;
  const delayFresh=!proof||(proof.generation===q.generation&&Number.isFinite(proof.verifiedAt)&&Number.isFinite(proof.validUntil)&&now>=proof.verifiedAt&&now<proof.validUntil);
  return delayFresh && fxFresh && !!q && q.marketStatus==='TRADEABLE' && q.delayTime===0 && Number.isFinite(q.receivedAt) && now-q.receivedAt>=0 && now-q.receivedAt<=60000 && (q.observedAt===undefined || (Number.isFinite(q.observedAt)&&now-q.observedAt>=0&&now-q.observedAt<=60000)) && Number.isFinite(q.bid) && Number.isFinite(q.offer) && q.bid>0 && q.offer>=q.bid;
}
export function scenario({direction,entry,stop,target,size,pointValue,marginRate,available,currency,pointCurrency,knownFees=null,profitPointValue=pointValue}) {
  const finite=v=>Number.isFinite(v);
  const ready=[entry,stop,target,size,pointValue].every(finite) && entry>0 && stop>0 && target>0 && size>0 && pointValue>0 && currency===pointCurrency;
  const sign=direction==='BUY'?1:-1;
  const levels=ready && sign*(entry-stop)>0 && sign*(target-entry)>0;
  if(!levels)return {valid:false,error:'Verifiera storlek, punktvärde, valuta och nivåerna för SL/TP.',risk:null,reward:null,exposure:null,margin:null,percent:null};
  const exposure=entry*size*pointValue, risk=sign*(entry-stop)*size*pointValue, reward=sign*(target-entry)*size*(finite(profitPointValue)&&profitPointValue>0?profitPointValue:pointValue);
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

// Rankningar använder endast explicit leverantörsdata, aldrig prisnivå som proxy.
export function marketMetric(m, ranking) {
  const q=m.quote??m, metrics=m.metrics??{};
  const finite=v=>Number.isFinite(v)?v:null;
  if(['up','down','movement'].includes(ranking))return finite(m.changePercent??metrics.changePercent??m.percentageChange??q.percentageChange);
  if(['trendUp','trendDown'].includes(ranking))return finite(m.trendScore??metrics.trendScore);
  if(ranking==='sentiment')return finite(m.sentimentLongPercent??m.sentiment?.longPositionPercentage??metrics.longPositionPercentage);
  if(ranking==='spread'){const bid=q.bid??m.bid,ask=q.offer??m.offer;return Number.isFinite(bid)&&Number.isFinite(ask)&&bid>0&&ask>=bid?(ask-bid)/((ask+bid)/2)*100:null;}
  return null;
}
export function rankMarkets(rows, ranking='name') {
  return [...rows].sort((a,b)=>{
    const av=marketMetric(a,ranking),bv=marketMetric(b,ranking);
    if(ranking!=='name'){
      if(av===null&&bv!==null)return 1;if(bv===null&&av!==null)return -1;
      if(av!==null&&bv!==null){const diff=ranking==='movement'?Math.abs(bv)-Math.abs(av):['down','spread','trendDown'].includes(ranking)?av-bv:bv-av;if(diff)return diff;}
    }
    return String(a.name??a.epic).localeCompare(String(b.name??b.epic),'sv');
  });
}

// Ofullständiga kvotsvar får inte radera samma kontos instrumentmetadata eller förnya priset.
export function mergeWorkspaceMarket(previous,incoming,binding){
 if(!incoming)return previous?.workspaceBinding===binding?previous:null;
 const same=previous?.workspaceBinding===binding&&previous.epic===incoming.epic;
 const old=same?previous.quote:null,candidate=incoming.quote;
 const quote=old&&(!candidate||old.observedAt>(candidate.observedAt??0))?old:candidate;
 return {...(same?previous:{}),...incoming,quote,workspaceBinding:binding};
}
export function nextCatalogCategory(states,categories){
 return categories.filter(c=>states[c]?.status==='partial'&&states[c]?.remainingSearches>0).sort((a,b)=>(states[a].lastAttemptAt??0)-(states[b].lastAttemptAt??0))[0];
}
