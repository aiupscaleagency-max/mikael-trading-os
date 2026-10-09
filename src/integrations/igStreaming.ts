import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {getIgStreamingSession,type IgEnvironment} from './igConnection.js';
const require=createRequire(import.meta.url);
export interface StreamingIdentity {endpoint:string;accountId:string;password:string;generation:string}
// IG:s fördröjningsflagga kan kodas som 0/1 eller explicit boolean.
// Saknat/okänt värde förblir okänt; det får aldrig behandlas som realtid.
export function normalizeIgDelayFlag(value:unknown):number|null{
 if(value===false||value===0)return 0;if(value===true||value===1)return 1;
 if(typeof value!=='string')return null;
 const flag=value.trim().toLowerCase();
 return flag==='0'||flag==='false'?0:flag==='1'||flag==='true'?1:null;
}
export interface IgDelayEvidence {epic:string;streamingPricesAvailable:boolean;quote:{delayTime:number|null;marketStatus:string|null;receivedAt:number;observedAt:number|null}}
export function createIgStreaming(deps:{verifyPrice?:(mode:IgEnvironment,epic:string)=>Promise<IgDelayEvidence>;identity?:(mode:IgEnvironment)=>StreamingIdentity|null;sdk?:any;now?:()=>number}={}){
 const identity=deps.identity??getIgStreamingSession,now=deps.now??Date.now;
 const events=new EventEmitter();const states=new Map<IgEnvironment,any>();
 function verifiedQuote(s:any,q:any){
  const proof=s.proofs.get(q.epic),at=now();
  if(q.delayTime!==null||!proof||at<proof.verifiedAt||at>=proof.validUntil)return q;
  return {...q,delayTime:0,delayVerification:{...proof,source:'IG REST · separat fördröjningskontroll'}};
 }
 function revokeProof(mode:IgEnvironment,s:any,epic:string){s.proofs.delete(epic);const q=s.quotes.get(epic);if(q)events.emit('quote',mode,q);}
 function verifyCharts(mode:IgEnvironment,s:any){
  if(!deps.verifyPrice||s.status!=='CONNECTED:WS-STREAMING')return;
  // Endast öppna diagram verifieras här; inga REST-anrop per marknadstick eller katalograd.
  for(const epic of s.chartEpics as Set<string>){
   const at=now(),last=s.attempts.get(epic);
   if(s.pending.has(epic)||(last!==undefined&&at-last<30000))continue;
   s.attempts.set(epic,at);s.pending.add(epic);const epoch=s.epoch;
   void deps.verifyPrice(mode,epic).then(e=>{
    if(states.get(mode)!==s||identity(mode)?.generation!==s.generation||s.epoch!==epoch||s.status!=='CONNECTED:WS-STREAMING'||!s.chartEpics.has(epic))return;
    const q=e.quote,t=now(),observed=q.observedAt;
    if(e.epic!==epic||e.streamingPricesAvailable!==true||q.delayTime!==0||q.marketStatus!=='TRADEABLE'||!Number.isFinite(q.receivedAt)||t-q.receivedAt<0||t-q.receivedAt>=60000||typeof observed!=='number'||!Number.isFinite(observed)||t-observed<0||t-observed>=60000){revokeProof(mode,s,epic);return;}
    s.proofs.set(epic,{verifiedAt:q.receivedAt,validUntil:Math.min(q.receivedAt+60000,observed+60000),generation:s.generation});
    const current=s.quotes.get(epic);if(current)events.emit('quote',mode,verifiedQuote(s,current));
   }).catch(()=>{if(states.get(mode)===s&&s.epoch===epoch)revokeProof(mode,s,epic);}).finally(()=>{if(s.epoch===epoch)s.pending.delete(epic);});
  }
 }
 function stop(mode:IgEnvironment){const old=states.get(mode);states.delete(mode);old?.client.disconnect();}
 function ensure(mode:IgEnvironment,epics:string[],charts:{epic:string;scale:string}[]=[],maxCharts=4){
  const auth=identity(mode);let s=states.get(mode);if(!auth){if(s)stop(mode);return;}
  if(!s||s.generation!==auth.generation){if(s)stop(mode);const sdk=deps.sdk??require('lightstreamer-client-node');const client=new sdk.LightstreamerClient(auth.endpoint);
   client.connectionDetails.setUser(auth.accountId);client.connectionDetails.setPassword(auth.password);
   client.connectionOptions.setForcedTransport('WS-STREAMING');client.connectionOptions.setRetryDelay(3000);client.connectionOptions.setStalledTimeout(5000);
   s={client,sdk,generation:auth.generation,status:'CONNECTING',quotes:new Map(),lastPriceAt:null,subscriptions:new Map(),lastError:null,proofs:new Map(),attempts:new Map(),pending:new Set(),chartEpics:new Set(),epoch:0};states.set(mode,s);const own=s;
   client.addListener({onStatusChange:(status:string)=>{if(states.get(mode)!==own)return;own.status=status;if(status!=='CONNECTED:WS-STREAMING'){own.quotes.clear();own.proofs.clear();own.attempts.clear();own.pending.clear();own.epoch++;}else verifyCharts(mode,own);events.emit('status',mode,summary(mode));},onServerError:()=>{if(states.get(mode)!==own)return;own.lastError='IG avvisade streaminganslutningen';events.emit('status',mode,summary(mode));}});client.connect();
  }
  const current=s;const wanted=new Map<string,{mode:string;items:string[];fields:string[];adapter?:string;kind:string}>();
  const list=[...new Set(epics)].filter(e=>/^[A-Za-z0-9._-]{1,100}$/.test(e)).slice(0,30);
  for(const epic of list)wanted.set(`price:${epic}`,{mode:'MERGE',items:[`PRICE:${auth.accountId}:${epic}`],fields:['BIDPRICE1','ASKPRICE1','TIMESTAMP','DLG_FLAG','NET_CHG_PCT','MID_OPEN','HIGH','LOW','DELAY'],adapter:'Pricing',kind:'quote'});
  wanted.set('account',{mode:'MERGE',items:[`ACCOUNT:${auth.accountId}`],fields:['PNL','AVAILABLE_CASH','FUNDS','MARGIN','EQUITY'],kind:'account'});
  wanted.set('trade',{mode:'DISTINCT',items:[`TRADE:${auth.accountId}`],fields:['CONFIRMS','OPU','WOU'],kind:'trade'});
  for(const c of charts.slice(0,Math.min(Math.max(1,maxCharts),4))){if(!/^[A-Za-z0-9._-]{1,100}$/.test(c.epic)||!['1MINUTE','5MINUTE','HOUR'].includes(c.scale))continue;wanted.set(`chart:${c.epic}:${c.scale}`,{mode:'MERGE',items:[`CHART:${c.epic}:${c.scale}`],fields:['UTM','BID_OPEN','BID_HIGH','BID_LOW','BID_CLOSE','OFR_OPEN','OFR_HIGH','OFR_LOW','OFR_CLOSE','CONS_END'],kind:'candle'});}
  current.chartEpics=new Set([...wanted.keys()].filter(k=>k.startsWith('chart:')).map(k=>k.split(':')[1]));
  for(const epic of current.proofs.keys())if(!current.chartEpics.has(epic))current.proofs.delete(epic);
  for(const [key,sub] of current.subscriptions){if(!wanted.has(key)){current.client.unsubscribe(sub);current.subscriptions.delete(key);if(key.startsWith('price:'))current.quotes.delete(key.slice(6));}}
  for(const [key,w] of wanted){if(current.subscriptions.has(key))continue;const sub=new current.sdk.Subscription(w.mode,w.items,w.fields);if(w.adapter)sub.setDataAdapter(w.adapter);sub.setRequestedSnapshot('yes');
   sub.addListener({onSubscriptionError:()=>{if(states.get(mode)!==current)return;current.lastError='En IG-prenumeration kunde inte verifieras';events.emit('status',mode,summary(mode));},onItemUpdate:(update:any)=>{
    if(states.get(mode)!==current||identity(mode)?.generation!==current.generation)return;
    const fields:Record<string,string|null>={};for(const f of w.fields)fields[f]=update.getValue(f);const receivedAt=now();
    const numeric=(v:unknown)=>typeof v==='string'&&v.trim()!==''&&Number.isFinite(Number(v))?Number(v):null;
    if(w.kind==='quote'){
     const epic=key.slice(6),bid=numeric(fields.BIDPRICE1),offer=numeric(fields.ASKPRICE1),observedAt=numeric(fields.TIMESTAMP);
     if(bid===null||offer===null||bid<=0||offer<bid||observedAt===null||observedAt>receivedAt+2000)return;
     const old=current.quotes.get(epic);if(old&&old.observedAt>observedAt)return;
     const flag=fields.DLG_FLAG?.trim();const quote={epic,bid,offer,observedAt,receivedAt,changePercent:numeric(fields.NET_CHG_PCT),delayTime:normalizeIgDelayFlag(fields.DELAY),delayFlag:typeof fields.DELAY==='string'?fields.DELAY.trim().slice(0,12):typeof fields.DELAY==='boolean'||typeof fields.DELAY==='number'?fields.DELAY:null,marketStatus:flag==='DEAL'?'TRADEABLE':flag==='CLOSED'?'CLOSED':flag??'UNKNOWN',source:'IG PRICE · WebSocket',generation:current.generation};
     current.quotes.set(epic,quote);current.lastPriceAt=receivedAt;events.emit('quote',mode,verifiedQuote(current,quote));
    }else if(w.kind==='candle'){
     const timestamp=numeric(fields.UTM);const values=['OPEN','HIGH','LOW','CLOSE'].map(f=>{const b=numeric(fields[`BID_${f}`]),a=numeric(fields[`OFR_${f}`]);return b!==null&&a!==null&&b>0&&a>=b?(a+b)/2:null;});
     if(timestamp===null||values.some(v=>v===null))return;const [open,high,low,close]=values as number[];if(high!<Math.max(open!,close!)||low!>Math.min(open!,close!))return;
     const [,epic,rawScale]=key.split(':');const scale=rawScale??'1MINUTE';events.emit('candle',mode,{epic,scale,openTime:Math.floor(timestamp/({'1MINUTE':60000,'5MINUTE':300000,'HOUR':3600000}[scale]??60000))*({'1MINUTE':60000,'5MINUTE':300000,'HOUR':3600000}[scale]??60000),open,high,low,close,closed:fields.CONS_END==='1',receivedAt,generation:current.generation});
    }else if(w.kind==='account'){
     const account={profitLoss:numeric(fields.PNL),available:numeric(fields.AVAILABLE_CASH),balance:numeric(fields.FUNDS),margin:numeric(fields.MARGIN),equity:numeric(fields.EQUITY),receivedAt,generation:current.generation};events.emit('account',mode,account);
    }else events.emit('trade',mode,{changed:true,receivedAt,generation:current.generation});
   }});current.subscriptions.set(key,sub);current.client.subscribe(sub);
  }
  verifyCharts(mode,current);
 }
 function active(mode:IgEnvironment){const s=states.get(mode);return s&&identity(mode)?.generation===s.generation?s:null;}
 function summary(mode:IgEnvironment){const s=active(mode);return {transport:'WebSocket',upstream:'IG Lightstreamer PRICE',status:s?.status??'DISCONNECTED',generation:s?.generation??null,lastPriceAt:s?.lastPriceAt??null,subscriptions:s?.subscriptions.size??0,freshPrices:s?[...s.quotes.values()].filter((q:any)=>now()-q.observedAt<=60000&&verifiedQuote(s,q).delayTime===0&&now()-q.observedAt>=0).length:0,error:s?.lastError??null};}
 function quotes(mode:IgEnvironment){const s=active(mode);return s?[...s.quotes.values()].map(q=>verifiedQuote(s,q)):[];}
 return {events,ensure,stop,summary,quotes,close:()=>{for(const mode of [...states.keys()])stop(mode);}};
}
export const igStreaming=createIgStreaming({verifyPrice:async(mode,epic)=>{const {getIgMarket}=await import('./igMarkets.js');const m=await getIgMarket(mode,epic);return {epic:m.epic,streamingPricesAvailable:m.instrument.streamingPricesAvailable,quote:m.quote};}});
