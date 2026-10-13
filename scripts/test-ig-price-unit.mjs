// Isolerade regressionskontroller utan IG-anrop eller order.
import assert from 'node:assert/strict';
const {createIgMarkets}=await import('../src/integrations/igMarkets.ts');
const {IG_HISTORY_RATE_ERROR}=await import('../src/integrations/igConnection.ts');
let calls=0;
const market=createIgMarkets({now:()=>1000,historyBlockedUntil:()=>2000,call:async()=>{calls++;throw Error('Otillåtet testanrop');},status:()=>({environments:{demo:{status:'connected',connectionGeneration:'test',account:{currency:'SEK'}},live:{status:'disconnected'}}})});
await assert.rejects(market.candles('demo','TEST','1m'),e=>e.message===IG_HISTORY_RATE_ERROR);
assert.equal(calls,0,'Global historikspärr måste kontrolleras före instrumentmetadata');
assert.equal(await market.accountFx('demo','USD'),null);
assert.equal(calls,2,'Direkt och omvänd parsökning får göras; saknat underlag ger aldrig en växelkurs');
const {igResolvePriceUnit}=await import('../src/integrations/igRules.ts');
// Ekonomiska fält observerade från IG V3; inga konto- eller personuppgifter.
const common={type:'CURRENCIES',unit:'CONTRACTS',contractSize:10000,valueOfOnePip:1};
const gbp=igResolvePriceUnit({...common,onePipMeans:'0.0001 USD/GBP'},{scalingFactor:10000});
const eur=igResolvePriceUnit({...common,onePipMeans:'0.0001 USD/EUR'},{scalingFactor:1});
assert.equal(gbp.multiplier,1);assert.equal(eur.multiplier,10000);
assert.equal(igResolvePriceUnit({...common,contractSize:123,onePipMeans:'0.0001 USD/EUR'},{scalingFactor:1}),null);
assert.equal(igResolvePriceUnit({...common,onePipMeans:'saknas'},{scalingFactor:1}),null);
assert.equal(igResolvePriceUnit({...common,onePipMeans:'0.0001 USD/EUR'},{scalingFactor:0}),null);
console.log('PASS: historikspärr före metadata; FX utan underlag blockerad; faktiska GBP/EUR-metadata ger rätt multiplikator; motsägelsefulla metadata avvisas');
// Hela produktionskedjan råmarknad → regler: kurs/punkt, därefter V4 utan pris.
for(const [epic,name,scale,bid,expected] of [['CS.D.GBPUSD.MINI.IP','GBP/USD Mini',10000,1.32066,10000],['CS.D.EURUSD.CEEM.IP','EUR/USD Mini',1,11157.5,1]]){
  let clock=Date.UTC(2026,9,12,12),missing=false;
  const inst={...common,epic,name,onePipMeans:`0.0001 USD/${name.slice(0,3)}`,currencies:[{code:'USD'}],marginFactor:3.33,marginFactorUnit:'PERCENTAGE',marginDepositBands:[{margin:3.33}]};
  const mk=createIgMarkets({now:()=>clock,status:()=>({environments:{demo:{status:'connected',connectionGeneration:'fixture',account:{currency:'USD'}},live:{status:'disconnected'}}}),call:async(_env,route,_method,version)=>{
    assert.equal(route,`markets/${epic}`);
    return {instrument:inst,dealingRules:{minDealSize:{value:.04}},snapshot:version==='4'&&missing?{scalingFactor:scale,marketStatus:'TRADEABLE',delayTime:0,updateTimestampUTC:clock}:{scalingFactor:scale,marketStatus:'TRADEABLE',delayTime:0,updateTimeUTC:'12:00:00',bid,offer:bid+bid*.0001}};
  }});
  const good=await mk.market('demo',epic);
  assert.equal(good.calculationRules.nativePointValue,expected);assert.equal(good.calculationRules.verified,true);
  missing=true;clock+=16000;
  const bad=await mk.market('demo',epic);
  assert.equal(bad.quote.bid,null);assert.equal(bad.quote.offer,null);
  const {igPairQuote}=await import('../src/integrations/igRules.ts');
  assert.equal(igPairQuote(bad,name.slice(0,3),'USD',clock),null,'Saknad V4-kvot får aldrig användas som färsk FX');
}
console.log('PASS: market() använder verifierad GBP/EUR-representation; V4 utan kvot förblir obrukbar');
