import assert from 'node:assert/strict';
import {createIgStreaming,normalizeIgDelayFlag} from '../src/integrations/igStreaming.js';
import {createIgConnection} from '../src/integrations/igConnection.js';

for(const value of [0,false,'0','false',' FALSE '])assert.equal(normalizeIgDelayFlag(value),0);
for(const value of [1,true,'1','true',' TRUE '])assert.equal(normalizeIgDelayFlag(value),1);
for(const value of [null,undefined,'','unknown','00',2])assert.equal(normalizeIgDelayFlag(value),null);
// Alla anslutningar och SDK-händelser simuleras; inga IG-anrop eller order.
let clock=Date.parse('2026-10-07T09:00:00Z');
let generation:string|null='first';
class Subscription {
 listener:any; adapter:string|undefined;
 constructor(public mode:string,public items:string[],public fields:string[]){}
 setDataAdapter(v:string){this.adapter=v;}setRequestedSnapshot(_v:string){}
 addListener(v:any){this.listener=v;}
 update(values:Record<string,string>){this.listener.onItemUpdate({getValue:(f:string)=>values[f]??null});}
}
class Client {
 static all:Client[]=[];listener:any;subscriptions:Subscription[]=[];disconnected=false;
 connectionDetails={setUser:(_v:string)=>{},setPassword:(_v:string)=>{}};
 connectionOptions={setForcedTransport:(_v:string)=>{},setRetryDelay:(_v:number)=>{},setStalledTimeout:(_v:number)=>{}};
 constructor(_endpoint:string){Client.all.push(this);}addListener(v:any){this.listener=v;}
 connect(){}disconnect(){this.disconnected=true;}subscribe(v:Subscription){this.subscriptions.push(v);}
 unsubscribe(v:Subscription){this.subscriptions=this.subscriptions.filter(x=>x!==v);}
}
const stream=createIgStreaming({now:()=>clock,sdk:{LightstreamerClient:Client,Subscription},identity:()=>generation?{endpoint:'https://fixture.ig.com',accountId:'fixture',password:'fixture-tokens',generation}:null});
const events:any[]=[];stream.events.on('quote',(_mode,q)=>events.push(q));
stream.ensure('demo',['EUR'],[{epic:'EUR',scale:'1MINUTE'}]);
const client=Client.all[0]!;client.listener.onStatusChange('CONNECTED:WS-STREAMING');
const price=client.subscriptions.find(x=>x.items[0]==='PRICE:fixture:EUR')!;
assert.equal(price.adapter,'Pricing');
const valid={BIDPRICE1:'1.10',ASKPRICE1:'1.11',TIMESTAMP:String(clock),DLG_FLAG:'DEAL',DELAY:'0'};
price.update(valid);assert.equal(events.length,1);assert.equal(stream.summary('demo').freshPrices,1);
price.update({...valid,TIMESTAMP:String(clock-1000)});assert.equal(events.length,1,'Gamla tickar ersätter inte färskare');
price.update({...valid,ASKPRICE1:'1.09'});assert.equal(events.length,1,'Korsad spread förkastas');
price.update({...valid,TIMESTAMP:String(clock+10000)});assert.equal(events.length,1,'Framtida tickar förkastas');
clock+=61000;assert.equal(stream.summary('demo').freshPrices,0,'Öppen anslutning betyder inte färskt pris');
generation='second';
assert.equal(stream.quotes('demo').length,0,'Kontobyte måste omedelbart dölja gamla kvoter före ensure');
assert.notEqual(stream.summary('demo').generation,'first','Status får inte visa föregående kontogeneration');
stream.ensure('demo',['GBP']);assert.equal(client.disconnected,true);
price.update({...valid,TIMESTAMP:String(clock)});assert.equal(events.length,1,'Callbacks från gammal session ignoreras');
generation=null;stream.ensure('demo',[]);assert.equal(stream.quotes('demo').length,0);
stream.close();

// REST intygar endast fördröjning/rättighet; bid/ask och prisets klocka kommer från PRICE.
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
let proofClock=clock,proofGeneration='proof-first',proofCalls=0;
let evidence:any={epic:'EUR',streamingPricesAvailable:true,quote:{delayTime:0,marketStatus:'TRADEABLE',receivedAt:proofClock,observedAt:proofClock}};
let resolveEvidence:((v:any)=>void)|null=null;
let deferred=false;
const verified=createIgStreaming({now:()=>proofClock,sdk:{LightstreamerClient:Client,Subscription},identity:()=>({endpoint:'https://fixture.ig.com',accountId:'fixture',password:'fixture',generation:proofGeneration}),verifyPrice:async()=>{proofCalls++;return deferred?new Promise(resolve=>{resolveEvidence=resolve;}):evidence;}});
const chart=[{epic:'EUR',scale:'1MINUTE'}];
verified.ensure('demo',['EUR'],chart);const pc=Client.all.at(-1)!;
pc.listener.onStatusChange('CONNECTED:WS-STREAMING');await flush();
const pp=pc.subscriptions.find(x=>x.items[0]==='PRICE:fixture:EUR')!;
const tick=()=>({...valid,TIMESTAMP:String(proofClock),DELAY:''});
pp.update(tick());let v:any=verified.quotes('demo')[0];
assert.equal(v.delayTime,0);assert.equal(v.delayFlag,'');assert.equal(v.bid,1.1,'REST får aldrig ersätta streampris');
assert.equal(v.delayVerification.validUntil,proofClock+60000);
verified.ensure('demo',['EUR'],chart);await flush();assert.equal(proofCalls,1,'Inga REST-anrop per tick eller heartbeat');
pp.update({...tick(),DELAY:'1'});assert.equal(verified.quotes('demo')[0].delayTime,1,'Explicit streamfördröjning vinner över REST');
pp.update(tick());proofClock+=60000;assert.equal(verified.quotes('demo')[0].delayTime,null,'Proof får inte förlängas av nya tickar');
pp.update(tick());assert.equal(verified.summary('demo').freshPrices,0);
for(const patch of [{epic:'GBP'},{streamingPricesAvailable:false},{quote:{...evidence.quote,delayTime:1}},{quote:{...evidence.quote,observedAt:proofClock-60001}},{quote:{...evidence.quote,observedAt:proofClock+1}}]){
 evidence={epic:'EUR',streamingPricesAvailable:true,quote:{delayTime:0,marketStatus:'TRADEABLE',receivedAt:proofClock,observedAt:proofClock},...patch};
 verified.ensure('demo',['EUR'],chart);await flush();pp.update(tick());assert.equal(verified.quotes('demo')[0].delayTime,null,'Ofullständig/felaktig REST-kontroll förkastas');proofClock+=30000;
}
evidence={epic:'EUR',streamingPricesAvailable:true,quote:{delayTime:0,marketStatus:'TRADEABLE',receivedAt:proofClock,observedAt:proofClock}};
verified.ensure('demo',['EUR'],chart);await flush();pp.update(tick());assert.equal(verified.quotes('demo')[0].delayTime,0);
proofClock+=30000;deferred=true;verified.ensure('demo',['EUR'],chart);await flush();
const oldResolver=resolveEvidence!;
pc.listener.onStatusChange('STALLED');pc.listener.onStatusChange('CONNECTED:WS-STREAMING');await flush();
const newResolver=resolveEvidence!;
oldResolver({...evidence,quote:{...evidence.quote,receivedAt:proofClock,observedAt:proofClock}});await flush();pp.update(tick());
assert.equal(verified.quotes('demo')[0].delayTime,null,'Sen REST-respons från före avbrott får inte verifiera återansluten ström');
newResolver({...evidence,quote:{...evidence.quote,receivedAt:proofClock,observedAt:proofClock}});await flush();pp.update(tick());
assert.equal(verified.quotes('demo')[0].delayTime,0,'Ny anslutning kan få egen kontroll');
proofClock+=30000;verified.ensure('demo',['EUR'],chart);await flush();const accountResolver=resolveEvidence!;
proofGeneration='proof-second';accountResolver({...evidence,quote:{...evidence.quote,receivedAt:proofClock,observedAt:proofClock}});await flush();
proofGeneration='proof-second';assert.equal(verified.quotes('demo').length,0);
verified.close();
console.log('PASS: separat REST-kontroll, explicit fördröjning, TTL, rättigheter och anslutningsbindning');

async function endpointSession(endpoint:string){
 const credentials={demo:{apiKey:'fixture',identifier:'fixture',password:'fixture'}};
 const connection=createIgConnection({loadCredentials:()=>credentials,fetch:(async(url:string)=>url.endsWith('/session')?new Response(JSON.stringify({currentAccountId:'fixture',lightstreamerEndpoint:endpoint}),{headers:{CST:'fixture-cst','X-SECURITY-TOKEN':'fixture-xst'}}):new Response(JSON.stringify({accounts:[{accountId:'fixture',accountType:'CFD',currency:'SEK',balance:{balance:100}}]}))) as typeof fetch});
 await connection.testConnection('demo');return connection.getStreamingSession('demo');
}
assert.equal(await endpointSession('http://stream.ig.com'),null);
assert.equal(await endpointSession('https://ig.com.evil.invalid'),null);
assert.equal(await endpointSession('https://evil.invalid'),null);
assert.equal((await endpointSession('https://stream.ig.com'))?.password,'CST-fixture-cst|XST-fixture-xst');
console.log('IG streaming review: DI, tidsstämplar, generationsbyte och endpoint-validering godkända');
