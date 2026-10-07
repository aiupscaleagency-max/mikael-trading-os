import {askJev,type JevVerdict} from '../server/jevClient.js';

const enums={regime:['trending','ranging','volatile','unknown'],direction:['up','down','neutral','unknown'],strategy_fit:['aligned','mixed','contradicted','not_applicable','unknown']} as const;
const finite=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
const bounded=(v:unknown)=>{const n=finite(v);return n!==null&&n>=0&&n<=1?n:null;};
const identifier=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9._/-]{1,100}$/.test(v)?v:null;
type Observation=Record<string,any>;
const indicatorKeys=['open','high','low','close','volume','vol_sma20','rsi14','rsi7','sma20','sma50','sma200','ema9','ema12','ema20','ema21','ema50','ema200','macd','macd_signal','macd_hist','bb_upper','bb_mid','bb_lower','atr14','atr_pct','change_pct','high20','low20'] as const;
function derivedIndicators(raw:any){return Object.fromEntries(indicatorKeys.map(key=>[key,finite(raw?.[key])]));}
function ruleResults(raw:any){if(!Array.isArray(raw))return null;return raw.slice(0,20).map(result=>({pass:typeof result?.pass==='boolean'?result.pass:null,leftValue:finite(result?.left),rightValue:finite(result?.right),rule:{left:indicatorKeys.includes(result?.rule?.left)?result.rule.left:null,op:['>','<','>=','<=','crosses_above','crosses_below'].includes(result?.rule?.op)?result.rule.op:null,right:typeof result?.rule?.right==='number'?finite(result.rule.right):indicatorKeys.includes(result?.rule?.right)?result.rule.right:null,factor:finite(result?.rule?.factor)}}));}
function comparison(raw:any){if(!raw||typeof raw!=='object')return null;return {strategyId:identifier(raw.strategyId??raw.id),version:finite(raw.strategyVersion??raw.version),status:['evaluated','not_applicable','invalid_data','insufficient_data','blocked_missing_verified_volume'].includes(raw.status)?raw.status:'unknown',validationStatus:['notBacktested','backtested','paper_verified'].includes(raw.validationStatus)?raw.validationStatus:'unknown',entrySignal:typeof raw.entrySignal==='boolean'?raw.entrySignal:null,exitCondition:typeof raw.exitCondition==='boolean'?raw.exitCondition:null,indicators:derivedIndicators(raw.indicators),entryConditions:Array.isArray(raw.entryConditions)?ruleResults(raw.entryConditions):raw.entryConditions?{closeAboveEma12:typeof raw.entryConditions.closeAboveEma12==='boolean'?raw.entryConditions.closeAboveEma12:null,ema12AboveEma21:typeof raw.entryConditions.ema12AboveEma21==='boolean'?raw.entryConditions.ema12AboveEma21:null,ema21AboveSma50:typeof raw.entryConditions.ema21AboveSma50==='boolean'?raw.entryConditions.ema21AboveSma50:null}:null,exitConditions:ruleResults(raw.exitConditions)};}
/** Explicit projektion: konton, originaltext och oberoende agenters fria text lämnar aldrig denna modul. */
export function buildIgJevMarketRequest(observations:readonly Observation[],now:number){
 if(!Array.isArray(observations)||observations.length<1||observations.length>10||!Number.isFinite(now))throw Error('IG JEV kräver 1–10 instrument och giltig tid');
 const seen=new Set<string>();
 const markets=observations.map((o,index)=>{
  const epic=identifier(o?.epic);if(!epic||seen.has(epic))throw Error('Ogiltigt eller duplicerat IG JEV-instrument');seen.add(epic);
  const bar=Array.isArray(o.candles)?o.candles.at(-1):null,closeTime=finite(bar?.closeTime),closed=closeTime!==null&&closeTime<=now;
  const indicators=derivedIndicators(o.indicators);
  const quote=o.market?.quote??{};const observedAt=finite(quote.observedAt),delay=finite(quote.delayTime);
  const strategies=(Array.isArray(o.strategyComparisons)?o.strategyComparisons:[o.strategyContext]).slice(0,20).map(comparison).filter(Boolean);
  const frame=o.timeframe??o.strategyContext?.timeframe;const timeframe=['1m','3m','5m','15m','30m','1h','4h','1d'].includes(frame)?frame:'unknown';
  return {instrumentIndex:index,epic,timeframe,forecastHorizon:'next_complete_bar',lastClosedBar:{close:closed?finite(bar?.close):null,closeTime:closed?closeTime:null,ageMs:closed?now-closeTime!:null},indicators,quoteQuality:{marketStatus:['TRADEABLE','CLOSED','OFFLINE','SUSPENDED'].includes(quote.marketStatus)?quote.marketStatus:'UNKNOWN',delayMinutes:delay,ageMs:observedAt!==null&&observedAt<=now?now-observedAt:null},strategyComparisons:strategies};
 });
 const questions:Record<string,unknown>={};for(const market of markets){const prefix=`instrument_${market.instrumentIndex}`;
  for(const kind of ['regime','direction','strategy_fit'] as const)questions[`${prefix}_${kind}`]={type:'choice',instructions:`Assess ${kind} for instrumentIndex ${market.instrumentIndex} only. Use the supplied derived data; choose unknown if unsupported. Direction horizon is the next complete ${market.timeframe} bar. Strategy fit is advisory; untested rules provide no performance evidence.`,criteria:Object.fromEntries(enums[kind].map(value=>[value,null]))};
  questions[`${prefix}_missing_data`]={type:'noul',instructions:`Does instrumentIndex ${market.instrumentIndex} lack sufficient current data for the requested assessment? No order-book or flow evidence is supplied; do not infer either.`};
 }
 return {state:{task:'Advisory probabilistic market assessment before two existing analysis agents',constraints:['no orders','cannot create or upgrade deterministic signals','no calibrated win probabilities','untested strategies remain untested'],asOf:now,markets},questions};
}
export function createIgJevMarket(deps:{ask?:typeof askJev;now?:()=>number}={}){
 const ask=deps.ask??askJev,now=deps.now??Date.now;
 async function assess(observations:readonly Observation[]){
  const base={available:false,mode:'rules_only',route:'rules_only',model:null as string|null,latencyMs:null as number|null,calibrated:false,advisoryOnly:true,canCreateSignal:false,canUpgradeSignal:false,assessments:[] as Array<{epic:string;regime:string;direction:string;strategyFit:string;missingData:number;confidence:{regime:number;direction:number;strategyFit:number}}>};
  let request:ReturnType<typeof buildIgJevMarketRequest>;try{request=buildIgJevMarketRequest(observations,now());}catch{return {...base,note:'IG JEV-underlaget kunde inte verifieras; analys fortsätter utan marknadsbedömning'};}
  let verdict:JevVerdict;try{verdict=await ask(request.state,8000,request.questions);}catch{return {...base,note:'JEV-marknadsbedömning otillgänglig; befintliga två agentroller fortsätter'};}
  const route=['gateway','direct','openrouter','rules_only'].includes(verdict?.mode)?verdict.mode:'rules_only';
  const metadata={route,model:typeof verdict?.model==='string'&&/^[A-Za-z0-9._:/ -]{1,120}$/.test(verdict.model)?verdict.model:null,latencyMs:finite(verdict?.latencyMs)!==null&&verdict.latencyMs!>=0?verdict.latencyMs:null};
  if(verdict?.available!==true||route==='rules_only')return {...base,...metadata,note:'JEV-marknadsbedömning otillgänglig; befintliga två agentroller fortsätter'};
  const assessments:typeof base.assessments=[];
  try{for(const market of request.state.markets){const prefix=`instrument_${market.instrumentIndex}`,choices:Record<string,{value:string;confidence:number}>={};
    for(const kind of ['regime','direction','strategy_fit'] as const){const answer=verdict.answers?.[`${prefix}_${kind}`],confidence=bounded(answer?.confidence);if(answer?.type!=='choice'||!enums[kind].includes(answer.choice as never)||confidence===null)throw Error('answer');choices[kind]={value:answer.choice!,confidence};}
    const missing=verdict.answers?.[`${prefix}_missing_data`],probability=bounded(missing?.noul);if(missing?.type!=='noul'||probability===null)throw Error('answer');
    assessments.push({epic:market.epic,regime:choices.regime!.value,direction:choices.direction!.value,strategyFit:choices.strategy_fit!.value,missingData:probability,confidence:{regime:choices.regime!.confidence,direction:choices.direction!.confidence,strategyFit:choices.strategy_fit!.confidence}});
   }}catch{return {...base,...metadata,note:'JEV gav ogiltiga eller ofullständiga bedömningar; inga svar används'};}
  return {...base,...metadata,mode:route,available:true,assessments,note:'JEV:s marknadsbedömning är rådgivande och inte en kalibrerad vinstsannolikhet'};
 }
 return {assess};
}
const market=createIgJevMarket();export const assessIgJevMarket=market.assess;
