import assert from 'node:assert/strict';
import {createIgStreaming} from '../src/integrations/igStreaming.js';
import {createIgConnection} from '../src/integrations/igConnection.js';

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
