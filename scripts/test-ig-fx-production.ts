// Faktiskt observerade ekonomiska metadata och V4-schema; isolerad produktionskedja utan nätverk/order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.TRADING_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'ig-fx-production-'));
globalThis.fetch=(async()=>{throw Error('Nätverk förbjudet i regressionstestet');}) as typeof fetch;
const {createIgMarkets}=await import('../src/integrations/igMarkets.js');
const {igPairQuote,igCalculationRules,igSnapshotQuote}=await import('../src/integrations/igRules.js');
const start=Date.UTC(2026,9,12,12);
for(const [base,quote,contract,pipValue,scale,bid,offer,multiplier] of [
 ['USD','SEK',100000,10,10000,10.04196,10.04446,1],
 ['GBP','USD',10000,1,10000,1.32059,1.32068,1],
 ['EUR','USD',10000,1,1,11157.5,11158.4,10000],
] as const){
 let clock=start,missing=false,stale=false;const versions:string[]=[];
 const epic=`CS.D.${base}${quote}.FIXTURE.IP`;
 const instrument={epic,name:`${base}/${quote} Mini`,type:'CURRENCIES',unit:'CONTRACTS',contractSize:String(contract),lotSize:1,valueOfOnePip:String(pipValue),onePipMeans:`0.0001 ${quote}/${base}`,currencies:[{code:quote,isDefault:true}],streamingPricesAvailable:true,marginFactor:5,marginFactorUnit:'PERCENTAGE',marginDepositBands:[{margin:5}]};
 const markets=createIgMarkets({now:()=>clock,status:(()=>({environments:{demo:{status:'connected',connectionGeneration:'fx-fixture',account:{currency:quote}},live:{status:'disconnected'}}})) as never,call:(async(_mode:string,route:string,_method:string,version:string)=>{
  assert.equal(route,`markets/${epic}`);versions.push(version);
  const snapshot=version==='3'?{bid,offer,updateTime:'12:00:00'}:{updateTimestampUTC:stale?clock-61000:clock-500,priceLadder:missing?[]:[{bid:String(bid),ask:String(offer)}],currencyLadders:[{currency:quote,bidSizes:[40],askSizes:[40]}]};
  return {instrument:version==='4'?{...instrument,onePipMeans:undefined}:instrument,dealingRules:{minDealSize:{value:.1}},snapshot:{...snapshot,scalingFactor:scale,marketStatus:'TRADEABLE',delayTime:0}};
 }) as never});
 const good=await markets.rawMarket('demo',epic);
 assert.deepEqual(versions,['3','4'],'V3 utan UTC kräver V4');
 assert.equal(good.quote.bid,bid);assert.equal(good.quote.offer,offer);assert.equal(good.quote.observedAt,clock-500);
 assert.equal(good.priceUnit?.multiplier,multiplier);
 assert.equal(good.priceUnitObservations[1]?.bid,bid,'V4-strängpris visas numeriskt i observationen');
 const rate=igPairQuote(good,base,quote,clock);assert.ok(rate);assert.equal(rate.bid,bid/multiplier);
 const rules=igCalculationRules(good.instrument,{scalingFactor:scale},quote,null,clock,good.priceUnit??undefined);
 assert.equal(rules.nativePointValue,contract/multiplier);assert.equal(rules.verified,true);
 clock+=16000;missing=true;
 const absent=await markets.rawMarket('demo',epic);assert.equal(absent.quote.bid,null);assert.equal(igPairQuote(absent,base,quote,clock),null,'V3 får inte återanvändas med V4:s nya tid');
 clock+=16000;missing=false;stale=true;
 const old=await markets.rawMarket('demo',epic);assert.equal(igPairQuote(old,base,quote,clock),null,'Gammal broker-tid spärrar FX');
 console.log(`PASS: ${base}/${quote}: V3→V4-strängpris, ekonomisk enhet, observation och fail-closed bortfall/stale`);
}
assert.equal(igSnapshotQuote({priceLadder:[{bid:'fel',ask:'10.1'}]},start).bid,null);
assert.equal(igSnapshotQuote({bid:10,offer:11,updateTime:'12:00:00'},start).observedAt,null);
console.log('PASS: ogiltigt pris och tidszonlös tid förblir overifierade');
