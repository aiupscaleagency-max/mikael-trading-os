import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {callIgAuthenticated,getIgStatus,getIgAccounts,getIgPositions,isIgTemporaryRateError,IG_READ_RATE_ERROR,type IgEnvironment} from './igConnection.js';
import {getIgMarket,getIgAccountFx} from './igMarkets.js';
import {igOrderExecutionEnabled} from './igConnection.js';
import {dataPath} from '../dataDir.js';
// Vår version har inga IG-agentsessioner i ordermodulen: ingen sessionspolicy, positionsgräns från config.
const getIgSessionPolicy=(_mode:IgEnvironment):{id:string;marginPercent:number;maxTrades:number;riskPercent:number;holdingMinutes:number}|null=>null;
const getIgSessionPositionLimit=(_mode:IgEnvironment)=>Number.MAX_SAFE_INTEGER;
import {loadState} from '../memory/store.js';
import {config} from '../config.js';
import {igFxIsFresh,type IgAccountFx} from './igRules.js';
import {igAccountLimits,igPositionLimitReason} from './igRiskLimits.js';

interface Draft {accountRef?:string|null;nextCheckAt?:number;timedExitSec?:number;lateExitAdded?:boolean;submittedAt?:number;sessionId?:string;id:string;environment:IgEnvironment;binding:string;epic:string;direction:'BUY'|'SELL';size:number;orderType:'MARKET'|'LIMIT';entry:number;stopLevel:number;targetLevel:number;holdingMinutes:number;autoClose:boolean;createdAt:number;expiresAt:number;status:'draft'|'submitted'|'accepted'|'rejected'|'unknown';dealReference?:string;dealId?:string;error?:string;positionObserved?:boolean;body:Record<string,unknown>;risk:number;exposure:number;margin:number;currency:string;executionCurrency:string}
interface ExitPlan {accountRef?:string|null;nextCheckAt?:number;submittedAt?:number;dealId:string;binding:string;closeAt:number;status:'scheduled'|'interrupted'|'submitted'|'confirmed'|'failed'|'unknown';dealReference?:string;error?:string;retryAt?:number}
interface OrderState {drafts:Draft[];plans:ExitPlan[]}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
function modeGuard(mode:unknown):asserts mode is IgEnvironment {if(mode!=='demo'&&mode!=='live')throw Error('Ogiltig IG-miljö');};
/** B1 (granskning 2): en order som först blev "okänd" och senare stäms av som accepterad ska ändå få sin
 *  tidsstängning. api.ts registrerar hooken; igOrders anropar den bara vid sen avstämning (tick/resolve). */
export type IgLateAccepted=(mode:IgEnvironment,d:{dealId:string;epic:string;size:number;timedExitSec:number;submittedAt:number})=>void;
let lateAcceptedHook:IgLateAccepted|null=null;
export function setIgLateAcceptedHook(fn:IgLateAccepted|null){lateAcceptedHook=fn;}
/** Servern räknar om varje bekräftad order. UI-belopp är aldrig säkerhetsunderlag. */
export function createIgOrders(deps:{status?:typeof getIgStatus;accounts?:typeof getIgAccounts;positions?:typeof getIgPositions;market?:(mode:IgEnvironment,epic:string)=>Promise<any>;call?:typeof callIgAuthenticated;guard?:()=>Promise<{killSwitchActive:boolean}>;now?:()=>number;directory?:string;enabled?:(mode:IgEnvironment)=>boolean;limits?:{maxPositionUsd:number;maxTotalExposureUsd:number;maxDailyLossUsd:number;maxOpenPositions:number};sessionPolicy?:typeof getIgSessionPolicy;positionLimit?:(mode:IgEnvironment)=>number;fx?:(mode:IgEnvironment)=>Promise<IgAccountFx|null>}={}) {
  const status=deps.status??getIgStatus,accounts=deps.accounts??getIgAccounts,positions=deps.positions??getIgPositions,market=deps.market??getIgMarket,call=deps.call??callIgAuthenticated,guard=deps.guard??loadState,now=deps.now??Date.now,enabled=deps.enabled??igOrderExecutionEnabled;
  // Utan injicerade USD-gränser (tester) gäller gränser i kontovalutan, härledda ur saldot (igRiskLimits).
  const accountMode=!deps.limits;
  const limits=deps.limits??config.risk,directory=deps.directory??dataPath('ig-orders'),states=new Map<IgEnvironment,OrderState>(),busy=new Set<IgEnvironment>();
  // Endast visningsvägen cachelagras. Ordervalidering läser arbetsorder direkt och färskt.
  const pendingDisplay=new Map<string,{at:number;value:any}>(),pendingDisplayJobs=new Map<string,Promise<any>>();
  // B1 (granskning 2): bekräftelsen återanvänder granskningens läsningar (konto, positioner, arbetsorder,
  // dagens transaktioner) om de är högst 5 s gamla och från samma IG-session. Annars läses de färskt.
  const REUSE_MS=5000,recent=new Map<string,{at:number;value:any}>();
  async function reuse<T>(mode:IgEnvironment,id:string,kind:string,allow:boolean,read:()=>Promise<T>,ok:(v:T)=>boolean):Promise<T>{
    const key=`${mode}|${id}|${kind}`,hit=recent.get(key);
    if(allow&&hit&&now()-hit.at<=REUSE_MS)return hit.value as T;
    const value=await read();if(ok(value))recent.set(key,{at:now(),value});else recent.delete(key);return value;
  }
  function state(mode:IgEnvironment){modeGuard(mode);let s=states.get(mode);if(s)return s;try{s=JSON.parse(fs.readFileSync(path.join(directory,`${mode}.json`),'utf8'));if(!Array.isArray(s?.drafts)||!Array.isArray(s?.plans))throw Error('shape');for(const p of s!.plans)if(p.status==='scheduled')p.status='interrupted';}catch{s={drafts:[],plans:[]};}states.set(mode,s!);return s!;}
  function persist(mode:IgEnvironment){fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,`${mode}.json`),temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(state(mode)));fs.renameSync(temp,file);}
  function binding(mode:IgEnvironment){modeGuard(mode);const c=status().environments[mode];if(c.status!=='connected'||!c.connectionGeneration||c.account?.accountType!=='CFD')throw Error('IG kräver verifierad CFD-kontosession');return c.connectionGeneration;}
  /** Maskerat konto-id (••••1234). Sen avstämning efter IG:s omloggning kräver SAMMA konto. */
  function accountRef(mode:IgEnvironment){return status().environments[mode].account?.accountId??null;}
  // Utkast utan kontoreferens (äldre, eller konto utan id i svaret) kan inte bindas; då gäller sessionens egen generation.
  function sameAccount(mode:IgEnvironment,ref:string|null|undefined){if(!ref)return true;return accountRef(mode)===ref;}
  function stable(mode:IgEnvironment,id:string){if(binding(mode)!==id)throw Error('IG-kontosessionen ändrades; gör om orderunderlaget');}
  function execution(mode:IgEnvironment){return {enabled:enabled(mode),reason:enabled(mode)?'Manuell IG-order · verifieras på servern':'Orderläget är avstängt för IG '+(mode==='live'?'Live':'Demo')+' (IG_ORDER_EXECUTION_ENABLED_'+mode.toUpperCase()+'). Inget skickades.'};}
  function fresh(m:any){const q=m?.quote;return q&&q.marketStatus==='TRADEABLE'&&q.delayTime===0&&finite(q.receivedAt)&&finite(q.observedAt)&&now()-q.receivedAt>=0&&now()-q.receivedAt<=60000&&now()-q.observedAt>=0&&now()-q.observedAt<=60000&&finite(q.bid)&&finite(q.offer)&&q.bid>0&&q.offer>=q.bid;}
  async function dailyPnl(mode:IgEnvironment,currency:string,id='',allow=false){
    const from=new Date(now()).toISOString().slice(0,10)+'T00:00:00';
    const data=await reuse(mode,id,'transactions',allow,()=>call(mode,'history/transactions','GET','2',undefined,{query:new URLSearchParams({from,to:new Date(now()).toISOString().slice(0,19),pageSize:'500',pageNumber:'1',type:'ALL'}).toString()}),(d:any)=>Array.isArray(d?.transactions));
    if(!Array.isArray(data.transactions)||data.metadata?.pageData?.totalPages!==1)throw Error('IG daglig P/L är ofullständig; nya order stoppas');
    let total=0;for(const t of data.transactions){if(t.cashTransaction===true)continue;if(t.cashTransaction!==false||t.transactionType!=='DEAL'||t.currency!==currency||typeof t.dateUtc!=='string')throw Error('IG daglig P/L saknar verifierad valuta eller UTC-tid');const transactionTime=Date.parse(t.dateUtc.endsWith('Z')?t.dateUtc:t.dateUtc+'Z');if(!Number.isFinite(transactionTime)||transactionTime<Date.parse(from+'Z')||transactionTime>now())throw Error('IG daglig P/L har ogiltig UTC-tid');const text=String(t.profitAndLoss).trim().replace(new RegExp(`^(?:${currency}\\s*|kr\\s*|\\$|€|£|¥)`,'i'),'').trim();if(!/^[+-]?\d+(?:\.\d+)?$/.test(text))throw Error('IG daglig P/L kunde inte läsas entydigt');total+=Number(text);}
    return total;
  }
  /** M1: accepterade order från en tidigare IG-session stämmer av mot en färsk positionsläsning.
   *  Finns dealId bland positionerna räknas den redan i exponeringen; finns den inte är positionen stängd. */
  async function observeOld(mode:IgEnvironment,id:string){
    const old=state(mode).drafts.filter(d=>d.binding!==id&&d.status==='accepted'&&!d.positionObserved);
    if(!old.length)return;
    const ps=await positions(mode);if(ps.status!=='ready'||!Array.isArray(ps.positions)){if(isIgTemporaryRateError(ps.error))throw Error(IG_READ_RATE_ERROR);return;}
    for(const d of old)d.positionObserved=true;
    persist(mode);
  }
  async function validate(mode:IgEnvironment,input:Record<string,any>,id:string,allow=false){
    const policy=(deps.sessionPolicy??getIgSessionPolicy)(mode);
    if(input.sessionId&&input.sessionId!==policy?.id)throw Error('Orderns agentsession är avslutad eller utbytt');
    if(policy){if(input.orderType!=='MARKET'||input.autoClose!==true||input.holdingMinutes!==policy.holdingMinutes)throw Error('Session kräver marknadsorder med sessionens tidsstängning');if(state(mode).drafts.filter(d=>d.sessionId===policy.id&&d.status!=='draft').length>=policy.maxTrades)throw Error('Sessionens gräns för nya order är nådd');}
    if((await guard()).killSwitchActive)throw Error('IG-order stoppad av kill switch');
    await observeOld(mode,id);
    if(state(mode).drafts.some(d=>['submitted','unknown'].includes(d.status)||(d.binding!==id&&d.status==='accepted'&&!d.positionObserved)))throw Error('IG tidigare orderutfall måste avstämmas innan nya order');
    const accountRead=await reuse(mode,id,'accounts',allow,()=>accounts(mode),(r:any)=>r?.status==='ready');if(accountRead?.status!=='ready'){if(isIgTemporaryRateError(accountRead?.error))throw Error(IG_READ_RATE_ERROR);throw Error('IG nya order kräver ett färskt verifierat kontounderlag');}stable(mode,id);const a=status().environments[mode].account;
    if(!a||!/^[A-Z]{3}$/.test(a.currency??'')||!finite(a.available)||a.available<=0||!finite(a.profitLoss))throw Error('IG orderrisk kräver verifierad kontovaluta och tillgängligt kapital/P-L');
    const currency=a.currency!;
    const usdFx={baseCurrency:'USD' as const,accountCurrency:'USD',bid:1,offer:1,receivedAt:now(),observedAt:now(),source:'USD-identitet'};
    const fx=accountMode||currency==='USD'?usdFx:await (deps.fx??getIgAccountFx)(mode);
    if(!accountMode&&!igFxIsFresh(fx,currency,now()))throw Error('IG nya order kräver färsk verifierad USD/SEK-kvot');
    if(accountMode&&(!finite(a.balance)||a.balance<=0))throw Error('IG-saldot kunde inte verifieras');
    const acctLimits=accountMode?igAccountLimits(a.balance!):null;
    // USD-gränser omräknas med bid; risk, exponering och marginal med ask. Det sänker aldrig säkerhetsmarginalen.
    const riskLimits={position:limits.maxPositionUsd*fx!.bid,total:limits.maxTotalExposureUsd*fx!.bid,loss:accountMode?acctLimits!.maxDailyLoss:limits.maxDailyLossUsd*fx!.bid};
    const m=await market(mode,input.epic);if(!fresh(m))throw Error('IG-order stoppad: inaktuell eller fördröjd kvot');
    const r=m.calculationRules;if(!r?.verified||r.pointCurrency!==currency||!finite(r.pointValue)||r.pointValue<=0||!finite(r.marginRate)||r.marginRate<=0)throw Error('IG kontraktsvärde, valuta eller marginal kunde inte verifieras');
    const executionCurrency=r.executionCurrency??r.pointCurrency;
    if(!/^[A-Z]{3}$/.test(executionCurrency)||!Array.isArray(m.instrument?.currencies)||!m.instrument.currencies.some((c:any)=>c.code===executionCurrency))throw Error('IG exekveringsvaluta är inte verifierad som erbjuden instrumentvaluta');
    const direction=input.direction;if(direction!=='BUY'&&direction!=='SELL')throw Error('IG kräver Köp eller Sälj');
    const type=input.orderType;if(type!=='MARKET'&&type!=='LIMIT')throw Error('IG kräver marknadsorder eller limitorder');
    const size=input.size,stop=input.stopLevel,target=input.targetLevel,entry=type==='LIMIT'?input.entry:direction==='BUY'?m.quote.offer:m.quote.bid;
    const min=m.dealingRules?.minDealSize?.value;
    if(![size,stop,target,entry,min].every(finite)||size<=0||size<min||entry<=0||stop<=0||target<=0)throw Error('IG kräver giltig storlek och prisnivåer');
    if(m.quote.source?.startsWith('IG REST v4')&&(!finite(m.quote.maxQuoteSize)||m.quote.quoteSizeCurrency!==executionCurrency||size>m.quote.maxQuoteSize))throw Error('IG orderstorlek saknar verifierad prisnivå i prisstegen');
    const sign=direction==='BUY'?1:-1;if(sign*(entry-stop)<=0||sign*(target-entry)<=0)throw Error('IG stop-loss och målpris ligger på fel sida');
    const distance=m.dealingRules?.minNormalStopOrLimitDistance;
    const scaling=r.priceScalingFactor??m.instrument?.scalingFactor;
    const minDistance=distance?.unit==='POINTS'&&finite(scaling)&&scaling>0?distance.value/scaling:distance?.unit==='PERCENTAGE'?entry*distance.value/100:NaN;
    if(!finite(minDistance)||Math.abs(entry-stop)<minDistance||Math.abs(target-entry)<minDistance)throw Error('IG minsta stop-/målavstånd kunde inte verifieras');
    const exposure=entry*size*r.pointValue,risk=Math.abs(entry-stop)*size*r.pointValue,margin=exposure*r.marginRate;
    if(accountMode){const why=igPositionLimitReason({margin,risk,balance:a.balance!,available:a.available,currency});if(why)throw Error('IG-order stoppad: '+why);}
    else if(exposure>riskLimits.position||risk>a.available*.05||margin>a.available)throw Error('IG-order överstiger befintlig positionsgräns, 5 % SL-risk eller tillgänglig marginal');
    if(policy){if(!finite(a.balance)||a.balance<=0)throw Error('Sessionens kontobudget kunde inte verifieras');if(margin>a.balance*policy.marginPercent/100||risk>a.available*policy.riskPercent/100)throw Error('Ordern överstiger sessionens separata marginal- eller SL-riskgräns');}
    const ps=await reuse(mode,id,'positions',allow,()=>positions(mode),(r:any)=>r?.status==='ready'&&Array.isArray(r.positions));if(ps.status!=='ready'||!Array.isArray(ps.positions))throw Error('IG öppna positioner kunde inte verifieras');
    const working=await reuse(mode,id,'working',allow,()=>call(mode,'workingorders','GET','2'),(w:any)=>Array.isArray(w?.workingOrders));if(!Array.isArray(working.workingOrders))throw Error('IG väntande mäklarorder kunde inte verifieras');
    const workingRows=working.workingOrders;
    const verifiedPositions=ps.positions;
    const pending=state(mode).drafts.filter(d=>d.binding===id&&!d.positionObserved&&['submitted','unknown','accepted'].includes(d.status)&&!verifiedPositions.some((p:any)=>p.dealId===d.dealId)&&!workingRows.some((w:any)=>w.workingOrderData?.dealId===d.dealId));
    if(ps.positions.length+workingRows.length+pending.length>=Math.min(limits.maxOpenPositions,(deps.positionLimit??getIgSessionPositionLimit)(mode)))throw Error('IG gränsen för samtidiga positioner är nådd');
    if(pending.some(d=>d.currency!==currency))throw Error('IG tidigare orderexponering saknar verifierad kontovaluta');
    let total=exposure,totalMargin=margin;
    // En accepterad men ännu osynkad order reserveras med dagens verifierade FX, inte gårdagens SEK-belopp.
    for(const d of pending){const pm=await market(mode,d.epic),pr=pm.calculationRules;if(!pr?.verified||pr.pointCurrency!==currency||(d.executionCurrency??d.body.currencyCode)!==(pr.executionCurrency??pr.pointCurrency))throw Error('IG tidigare orderexponering kunde inte räknas om');total+=d.size*d.entry*pr.pointValue;totalMargin+=d.size*d.entry*pr.pointValue*(finite(pr.marginRate)?pr.marginRate:1);}
    for(const p of ps.positions){const pm=await market(mode,p.epic!);if(!finite(p.size)||p.size<=0||!finite(p.level)||p.level<=0||!pm.calculationRules?.verified||pm.calculationRules.pointCurrency!==currency||p.currency!==(pm.calculationRules.executionCurrency??pm.calculationRules.pointCurrency))throw Error('IG portföljexponering kunde inte verifieras');total+=p.size*p.level*pm.calculationRules.pointValue;totalMargin+=p.size*p.level*pm.calculationRules.pointValue*(finite(pm.calculationRules.marginRate)?pm.calculationRules.marginRate:1);}
    for(const w of workingRows){const data=w.workingOrderData,m=await market(mode,w.marketData?.epic);if(!finite(data?.size)||data.size<=0||!finite(data?.level)||data.level<=0||!m.calculationRules?.verified||m.calculationRules.pointCurrency!==currency||data.currencyCode!==(m.calculationRules.executionCurrency??m.calculationRules.pointCurrency))throw Error('IG väntande orderexponering kunde inte verifieras');total+=data.size*data.level*m.calculationRules.pointValue;totalMargin+=data.size*data.level*m.calculationRules.pointValue*(finite(m.calculationRules.marginRate)?m.calculationRules.marginRate:1);}
    if(accountMode?totalMargin>acctLimits!.maxTotalMargin:total>riskLimits.total)throw Error(accountMode?`IG total marginal ${totalMargin.toFixed(2)} ${currency} skulle överstiga gränsen ${acctLimits!.maxTotalMargin.toFixed(2)} ${currency}`:'IG totalexponering överstiger befintlig gräns');
    const realized=await dailyPnl(mode,currency,id,allow);if(realized+Math.min(a.profitLoss,0)<=-riskLimits.loss)throw Error('IG daglig förlustgräns är nådd');
    if((await guard()).killSwitchActive)throw Error('IG-order stoppad av kill switch');
    if(!fresh(m)||(!accountMode&&!igFxIsFresh(fx,currency,now()))||r.fx&&!igFxIsFresh(r.fx,currency,now(),r.fx.baseCurrency))throw Error('IG-kvoten eller valutakursen hann bli inaktuell under valideringen');stable(mode,id);
    const body:Record<string,unknown>={epic:m.epic,expiry:m.expiry,direction,size,currencyCode:executionCurrency,guaranteedStop:false,forceOpen:true,stopLevel:stop,limitLevel:target};
    if(type==='MARKET')Object.assign(body,{orderType:'MARKET',timeInForce:'FILL_OR_KILL'});else Object.assign(body,{type:'LIMIT',level:entry,timeInForce:'GOOD_TILL_CANCELLED'});
    if((deps.sessionPolicy??getIgSessionPolicy)(mode)?.id!==policy?.id)throw Error('Agentsessionen ändrades under ordervalideringen');
    return {sessionId:policy?.id,body,entry,risk,reward:Math.abs(target-entry)*size*(r.profitPointValue??r.pointValue),exposure,margin,currency,executionCurrency};
  }
  async function preview(mode:IgEnvironment,input:Record<string,any>){modeGuard(mode);if(!/^[A-Za-z0-9._-]{1,100}$/.test(input.epic??''))throw Error('Ogiltig IG-epic');if(![1,2,3,4,5,15,30,60,120].includes(input.holdingMinutes)||typeof input.autoClose!=='boolean')throw Error('Ogiltig IG-innehavstid');if(input.orderType==='LIMIT'&&input.autoClose)throw Error('IG limitorder kräver manuell stängning tills fyllnad kan följas entydigt');const id=binding(mode),calc=await validate(mode,input,id);
    const tes=Number(input.timedExitSec);const draft:Draft={...calc,accountRef:accountRef(mode),...(Number.isFinite(tes)&&tes>0&&tes<=7200?{timedExitSec:tes}:{}),epic:input.epic,direction:input.direction,size:input.size,orderType:input.orderType,stopLevel:input.stopLevel,targetLevel:input.targetLevel,holdingMinutes:input.holdingMinutes,autoClose:input.autoClose,id:randomUUID(),environment:mode,binding:id,createdAt:now(),expiresAt:now()+30000,status:'draft'};state(mode).drafts.push(draft);persist(mode);return {...draft,execution:execution(mode)};}
  async function confirm(mode:IgEnvironment,draftId:string){modeGuard(mode);if(!enabled(mode))throw Error(execution(mode).reason);if(busy.has(mode))throw Error('IG-order behandlas redan');busy.add(mode);
    try{const d=state(mode).drafts.find(d=>d.id===draftId);if(!d||d.status!=='draft'||now()>d.expiresAt)throw Error('IG-utkastet är utgånget eller redan behandlat');stable(mode,d.binding);if(d.sessionId!==(deps.sessionPolicy??getIgSessionPolicy)(mode)?.id)throw Error('Granska nytt orderutkast för aktuell agentsession');const checked=await validate(mode,d,d.binding,true);if(checked.risk>d.risk*1.02||checked.margin>d.margin*1.02)throw Error('IG-kurs/risk ändrades; granska nytt underlag');
      if(now()>d.expiresAt)throw Error('IG-utkastet hann gå ut; granska nytt underlag');
      // Reservation och revisionsunderlag måste motsvara den omvaliderade order som faktiskt skickas.
      Object.assign(d,checked);d.status='submitted';d.submittedAt=now();persist(mode);
      try{const result=await call(mode,d.orderType==='MARKET'?'positions/otc':'workingorders/otc','POST','2',checked.body);stable(mode,d.binding);if(typeof result.dealReference!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(result.dealReference))throw Error('confirmation');d.dealReference=result.dealReference;persist(mode);await reconcile(mode,d);}catch{d.status='unknown';d.error='IG-orderutfallet är okänt. Ingen automatisk omsändning.';persist(mode);}
      return {...d};
    }finally{busy.delete(mode);}}
  async function reconcile(mode:IgEnvironment,d:Draft,late=false){if(!d.dealReference)return;if(!late)stable(mode,d.binding);const result=await call(mode,`confirms/${d.dealReference}`,'GET','1');if(!late)stable(mode,d.binding);
    if(result.dealStatus==='REJECTED'){d.status='rejected';d.error='IG avvisade ordern';}
    else if(result.dealStatus==='ACCEPTED'&&typeof result.dealId==='string'){d.status='accepted';d.dealId=result.dealId;d.error=undefined;if(d.autoClose&&d.orderType==='MARKET'&&!state(mode).plans.some(p=>p.dealId===d.dealId&&p.binding===d.binding))state(mode).plans.push({dealId:d.dealId!,binding:d.binding,closeAt:(d.sessionId?(d.submittedAt??d.createdAt):now())+d.holdingMinutes*60000,status:'scheduled'});}
    else{d.status='unknown';d.error='IG-bekräftelsen har inget verifierat avslut';}persist(mode);if(late)lateAccepted(mode,d);}
  /** M2 (granskning 2): avstämning av okänd order MED dealReference, även efter IG:s timvisa omloggning
   *  (ny connectionGeneration) så länge kontot är detsamma. Först confirms/{ref}; svarar IG inte längre
   *  på den, används history/activity filtrerad på dealReference. Skickar aldrig något. */
  async function reconcileLate(mode:IgEnvironment,d:Draft){
    if(!d.dealReference)return;if(!sameAccount(mode,d.accountRef))throw Error('Annat IG-konto är inloggat; avstämningen väntar');
    try{await reconcile(mode,d,true);if(d.status!=='unknown')return;}catch(e){if(isIgTemporaryRateError(e))throw e;}
    const since=new Date((d.submittedAt??d.createdAt)-120000).toISOString().slice(0,19);
    const act=await call(mode,'history/activity','GET','3',undefined,{query:new URLSearchParams({from:since,detailed:'true',pageSize:'50'}).toString()});
    if(!Array.isArray(act.activities))throw Error('IG-aktiviteten kunde inte läsas');
    const hit=act.activities.find((a:any)=>a?.details?.dealReference===d.dealReference||a?.dealReference===d.dealReference);
    if(!hit)return;
    const st=String(hit.status??'').toUpperCase();
    if(st==='ACCEPTED'&&typeof hit.dealId==='string'){d.status='accepted';d.dealId=hit.dealId;d.error='Avstämd i efterhand via IG-aktivitet (dealReference).';persist(mode);lateAccepted(mode,d);}
    else if(st==='REJECTED'){d.status='rejected';d.error='IG-aktiviteten visar att ordern avvisades (dealReference).';persist(mode);}
  }
  async function reconcileCloseLate(mode:IgEnvironment,p:ExitPlan){
    if(!sameAccount(mode,p.accountRef))throw Error('Annat IG-konto är inloggat; avstämningen väntar');
    if(p.dealReference){try{const result=await call(mode,`confirms/${p.dealReference}`,'GET','1');if(result.dealStatus==='ACCEPTED'&&result.affectedDeals?.some((x:any)=>x.dealId===p.dealId&&x.status==='DELETED')){p.status='confirmed';p.error=undefined;persist(mode);return;}if(result.dealStatus==='REJECTED'){p.status='failed';p.error='IG avvisade stängningen';persist(mode);return;}}catch(e){if(isIgTemporaryRateError(e))throw e;}}
    // Positionsläsning avgör: finns dealId inte längre är positionen stängd; finns den är stängningen inte gjord.
    const ps=await positions(mode);if(ps.status!=='ready'||!Array.isArray(ps.positions)){if(isIgTemporaryRateError(ps.error))throw Error(IG_READ_RATE_ERROR);return;}
    const open=ps.positions.some((x:any)=>x.dealId===p.dealId);
    if(!open){p.status='confirmed';p.error='Avstämd i efterhand: positionen finns inte längre i IG.';persist(mode);}
    else if(now()-(p.submittedAt??0)>120000){p.status='failed';p.error='Avstämd i efterhand: positionen är fortfarande öppen i IG. Stäng den med Sälj nu.';persist(mode);}
  }
  function lateAccepted(mode:IgEnvironment,d:Draft){if(d.status!=='accepted'||!d.dealId||!d.timedExitSec||d.lateExitAdded||!lateAcceptedHook)return;d.lateExitAdded=true;persist(mode);try{lateAcceptedHook(mode,{dealId:d.dealId,epic:d.epic,size:d.size,timedExitSec:d.timedExitSec,submittedAt:d.submittedAt??d.createdAt});}catch{/* tidsstängningen visas som saknad */}}
  async function close(mode:IgEnvironment,dealId:string,expectedBinding?:string){modeGuard(mode);if(!enabled(mode))throw Error(execution(mode).reason);if(busy.has(mode))throw Error('IG-order behandlas redan');busy.add(mode);
    try{const id=binding(mode),s=state(mode);if(expectedBinding&&expectedBinding!==id)throw Error('IG-kontot ändrades sedan granskningen');if(s.plans.some(p=>p.dealId===dealId&&['submitted','unknown'].includes(p.status)))throw Error('IG tidigare stängningsutfall måste avstämmas');let plan=s.plans.find(p=>p.dealId===dealId&&p.binding===id);if(plan&&['submitted','unknown','confirmed'].includes(plan.status))throw Error('IG-stängning är redan begärd; invänta bekräftelse');
      const ps=await positions(mode),p=ps.positions?.find((p:any)=>p.dealId===dealId);if(ps.status!=='ready'&&isIgTemporaryRateError(ps.error))throw Error(IG_READ_RATE_ERROR);if(ps.status!=='ready'||!p||!finite(p.size)||p.size<=0||!['BUY','SELL'].includes(p.direction??''))throw Error('IG-positionen kunde inte verifieras');const m=await market(mode,p.epic!);if(!fresh(m))throw Error('IG-stängning kräver färsk ofördröjd kvot');stable(mode,id);
      if(!plan){plan={dealId,binding:id,closeAt:now(),status:'scheduled'};s.plans.push(plan);}plan.status='submitted';plan.submittedAt=now();plan.accountRef=accountRef(mode);plan.retryAt=undefined;plan.dealReference=undefined;plan.error=undefined;persist(mode);
      try{const r=await call(mode,'positions/otc','POST','1',{dealId,direction:p.direction==='BUY'?'SELL':'BUY',size:p.size,orderType:'MARKET',timeInForce:'FILL_OR_KILL'},{_method:'DELETE'});stable(mode,id);if(typeof r.dealReference!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(r.dealReference))throw Error('confirmation');plan.dealReference=r.dealReference;persist(mode);await reconcileClose(mode,plan);}catch{plan.status='unknown';plan.error='IG-stängningsutfallet är okänt; positionen antas fortsatt öppen';persist(mode);}return {...plan};
    }finally{busy.delete(mode);}}
  async function reconcileClose(mode:IgEnvironment,p:ExitPlan){if(!p.dealReference)return;stable(mode,p.binding);const result=await call(mode,`confirms/${p.dealReference}`,'GET','1');stable(mode,p.binding);if(result.dealStatus==='ACCEPTED'&&result.affectedDeals?.some((d:any)=>d.dealId===p.dealId&&d.status==='DELETED')){p.status='confirmed';p.error=undefined;}else if(result.dealStatus==='REJECTED'){p.status='failed';p.error='IG avvisade stängningen';}else{p.status='unknown';p.error='IG saknar verifierad stängningsbekräftelse';}persist(mode);}
  async function rollover(mode:IgEnvironment,dealId:string,minutes:number,expectedBinding?:string){const id=binding(mode);if(expectedBinding&&id!==expectedBinding)throw Error('IG-kontot ändrades sedan granskningen');if(!enabled(mode))throw Error(execution(mode).reason);if(!finite(minutes)||minutes<=0||minutes>120)throw Error('Ogiltig IG-förlängning');const plan=state(mode).plans.find(p=>p.dealId===dealId&&p.binding===id);if(!plan||plan.status!=='scheduled')throw Error('IG-positionen har ingen aktiv tidsstängning att förlänga');if(state(mode).drafts.some(d=>d.dealId===dealId&&d.sessionId))throw Error('Sessionspositionens 1–5 minuters tidsgräns får inte förlängas');const ps=await positions(mode);if(!ps.positions?.some((p:any)=>p.dealId===dealId))throw Error('IG-positionen saknas');stable(mode,id);plan.closeAt=Math.max(now(),plan.closeAt)+minutes*60000;persist(mode);return {...plan};}
  async function tick(){for(const mode of ['demo','live'] as const){if(busy.has(mode))continue;const s=state(mode);for(const d of s.drafts.filter(d=>d.dealReference&&['submitted','unknown'].includes(d.status))){if(d.nextCheckAt&&now()<d.nextCheckAt)continue;try{await reconcileLate(mode,d);}catch{/* En okänd order skickas aldrig på nytt. */}if(['submitted','unknown'].includes(d.status)){d.nextCheckAt=now()+60000;persist(mode);}}for(const p of s.plans){try{if(p.dealReference&&['submitted','unknown'].includes(p.status)){if(p.nextCheckAt&&now()<p.nextCheckAt)continue;await reconcileCloseLate(mode,p).finally(()=>{if(['submitted','unknown'].includes(p.status)){p.nextCheckAt=now()+60000;persist(mode);}});}else if(p.status==='scheduled'){if(status().environments[mode].connectionGeneration!==p.binding){p.status='interrupted';p.error='Tidsplan avbruten av kontobyte';persist(mode);}else if(enabled(mode)&&now()>=p.closeAt&&(!p.retryAt||now()>=p.retryAt))await close(mode,p.dealId,p.binding);}}catch(error){if(p.status==='scheduled'){if(isIgTemporaryRateError(error)){p.retryAt=now()+60000;p.error='IG-läsgräns nådd · tidsstängning inväntar nytt verifierat underlag';}else{p.status='failed';p.error='Tidsstängning kunde inte verifieras; positionen lämnas öppen';}persist(mode);}}}}}
  function snapshot(mode:IgEnvironment,verifiedPositions?:readonly {dealId:string|null}[]|null){let changed=false;for(const d of state(mode).drafts)if(d.status==='accepted'&&!d.positionObserved&&verifiedPositions?.some(p=>p.dealId===d.dealId)){d.positionObserved=true;changed=true;}if(changed)persist(mode);const id=status().environments[mode].connectionGeneration;const policy=(deps.sessionPolicy??getIgSessionPolicy)(mode);return {sessionOrdersUsed:policy?state(mode).drafts.filter(d=>d.sessionId===policy.id&&d.status!=='draft').length:0,execution:execution(mode),pendingOrders:state(mode).drafts.filter(d=>d.status!=='draft'&&!d.positionObserved&&(d.binding===id||['submitted','unknown'].includes(d.status)||d.status==='accepted')).map(({body,binding,...d})=>({...d,previousConnection:binding!==id})),exitPlans:state(mode).plans.filter(p=>p.binding===id||['submitted','unknown'].includes(p.status)).map(({binding,...p})=>({...p,previousConnection:binding!==id}))};}
  async function brokerPending(mode:IgEnvironment,expectedBinding?:string){
    if(status().environments[mode].status!=='connected')return {orders:[],status:'unavailable'};
    const id=binding(mode);if(expectedBinding&&id!==expectedBinding)return {orders:[],status:'unavailable'};
    const key=`${mode}:${id}`,copy=(value:any)=>JSON.parse(JSON.stringify(value));
    const cached=pendingDisplay.get(key);if(cached&&now()-cached.at<30000)return copy(cached.value);
    const running=pendingDisplayJobs.get(key);if(running)return copy(await running);
    const job=(async()=>{try{
      const data=await call(mode,'workingorders','GET','2');stable(mode,id);if(!Array.isArray(data.workingOrders))throw Error('shape');
      const value={status:'ready',updatedAt:now(),orders:data.workingOrders.map((w:any)=>({id:w.workingOrderData?.dealId,dealId:w.workingOrderData?.dealId,epic:w.marketData?.epic,direction:w.workingOrderData?.direction,size:w.workingOrderData?.size,entry:w.workingOrderData?.level,status:'pending',reason:'Verifierad väntande IG-order'}))};
      pendingDisplay.set(key,{at:now(),value});return value;
    }catch{return {orders:[],status:'unavailable'};}})();
    pendingDisplayJobs.set(key,job);try{return copy(await job);}finally{pendingDisplayJobs.delete(key);}
  }
  /** Manuell avstämning ("Stäm av") av ett okänt utfall, med eller utan IG-referens. Skickar aldrig något.
   *  Med dealReference: confirms/ eller IG-aktivitet med samma referens avgör. Utan referens (t.ex. timeout på
   *  POST): en position som öppnats efter att ordern skickades, med samma EPIC/riktning/storlek och som ingen
   *  annan order äger. "Avvisad" sätts bara när IG-aktiviteten saknar ordern och det gått mer än 2 minuter. */
  async function resolveUnknown(mode:IgEnvironment,id:string){
    modeGuard(mode);const s=state(mode);
    if(busy.has(mode))throw Error('En IG-order behandlas just nu; stäm av när den är klar');
    const d=s.drafts.find(x=>x.id===id&&['unknown','submitted'].includes(x.status));
    const p=d?undefined:s.plans.find(x=>x.dealId===id&&['unknown','submitted'].includes(x.status));
    if(!d&&!p)throw Error('Inget okänt utfall med det id:t');
    if(p){
      if(!sameAccount(mode,p.accountRef))throw Error('Ett annat IG-konto är inloggat; logga in på kontot där stängningen gjordes');
      // Manuell avstämning: positionsläsningen avgör direkt (ingen 2-minutersväntan).
      p.submittedAt=Math.min(p.submittedAt??0,now()-120001);await reconcileCloseLate(mode,p);
      return {kind:'close',status:p.status,note:p.error??null};
    }
    if(!sameAccount(mode,d!.accountRef))throw Error('Ett annat IG-konto är inloggat; logga in på kontot där ordern skickades');
    if(d!.dealReference){
      await reconcileLate(mode,d!);
      if(d!.status!=='unknown'&&d!.status!=='submitted')return {kind:'order',status:d!.status,dealId:d!.dealId??null,note:d!.error??null};
    }
    const ps=await positions(mode);if(ps.status!=='ready'||!Array.isArray(ps.positions)){if(isIgTemporaryRateError(ps.error))throw Error(IG_READ_RATE_ERROR);throw Error('IG-positionerna kunde inte läsas; avstämningen görs inte');}
    const sent=d!.submittedAt??d!.createdAt;
    const since=new Date(sent-120000).toISOString().slice(0,19);
    const act=await call(mode,'history/activity','GET','3',undefined,{query:new URLSearchParams({from:since,detailed:'true',pageSize:'50'}).toString()});
    if(!Array.isArray(act.activities))throw Error('IG-aktiviteten kunde inte läsas; avstämningen görs inte');
    const opened=(x:any)=>{const t=typeof x.createdDateUTC==='string'?Date.parse(x.createdDateUTC.endsWith('Z')?x.createdDateUTC:x.createdDateUTC+'Z'):NaN;return Number.isFinite(t)&&t>=sent-60000;};
    const candidates=ps.positions.filter((x:any)=>x.epic===d!.epic&&x.direction===d!.direction&&Math.abs(Number(x.size)-d!.size)<1e-9&&opened(x)&&!s.drafts.some(o=>o!==d&&o.dealId===x.dealId));
    const acts=act.activities.filter((a:any)=>a.epic===d!.epic&&String(a.details?.direction??a.direction??'')===d!.direction&&Date.parse(String(a.date).endsWith('Z')?a.date:a.date+'Z')>=sent-60000);
    if(candidates.length===1){d!.status='accepted';d!.dealId=candidates[0]!.dealId??undefined;d!.positionObserved=true;d!.error='Manuellt avstämd: en ny position med samma EPIC, riktning och storlek hittades i IG.';persist(mode);lateAccepted(mode,d!);}
    else if(candidates.length>1)throw Error('Flera nya positioner matchar ordern; stäm av själv i IG (ingenting ändrades)');
    else if(acts.some((a:any)=>String(a.status).toUpperCase()==='REJECTED')){d!.status='rejected';d!.error='Manuellt avstämd: IG-aktiviteten visar att ordern avvisades.';persist(mode);}
    else if(now()-sent<=120000)throw Error('För tidigt att avgöra: IG kan ligga efter. Försök igen om en minut.');
    else{d!.status='rejected';d!.error=acts.length?'Manuellt avstämd: IG visar aktivitet men ingen ny öppen position (stängd eller avvisad).':'Manuellt avstämd: ingen ny position och ingen IG-aktivitet för ordern.';persist(mode);}
    return {kind:'order',status:d!.status,dealId:d!.dealId??null,note:d!.error??null};
  }
  return {preview,confirm,close,rollover,tick,snapshot,brokerPending,resolveUnknown};
}
const orders=createIgOrders();
export const previewIgOrder=orders.preview,confirmIgOrder=orders.confirm,closeIgPosition=orders.close,rolloverIgPosition=orders.rollover,tickIgOrders=orders.tick,getIgOrderState=orders.snapshot,resolveIgUnknown=orders.resolveUnknown,getIgBrokerPending=orders.brokerPending;
