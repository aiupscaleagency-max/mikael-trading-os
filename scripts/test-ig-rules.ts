import assert from 'node:assert/strict';
import {igCalculationRules,igQuoteTimestamp,igSnapshotQuote,igUsdSekFx,igFxIsFresh} from '../src/integrations/igRules.js';
const instrument={type:'CURRENCIES',unit:'CONTRACTS',contractSize:'100000',onePipMeans:'0.0001 USD/EUR',valueOfOnePip:'10',currencies:[{code:'USD',isDefault:true}],marginFactor:3.33,marginFactorUnit:'PERCENTAGE',marginDepositBands:[{margin:3.33}]};
assert.equal(igCalculationRules(instrument,{scalingFactor:10000},'USD').pointValue,100000);
assert.equal(igCalculationRules(instrument,{scalingFactor:10000},'SEK').pointValue,null);
assert.equal(igCalculationRules(instrument,{scalingFactor:null},'USD').pointValue,null);
assert.equal(igCalculationRules({...instrument,marginDepositBands:[{margin:3.33},{margin:5}]},{scalingFactor:10000},'USD').marginRate,.05);
const now=Date.parse('2026-10-07T00:00:15Z');
assert.equal(igQuoteTimestamp('23:59:50',now),now-25000);
assert.equal(igQuoteTimestamp('00:00:10',now),now-5000);
assert.equal(igQuoteTimestamp('99:99:99',now),null);
assert.equal(igQuoteTimestamp(null,now),null);
console.log('PASS: IG punktvärde med pip/scaling, okänd valuta/tiermarginal och UTC-kvot över midnatt');

const v4={updateTimestampUTC:now-2000,priceLadder:[{bid:'100.5',ask:'101.5'}],marketStatus:'TRADEABLE',delayTime:0};
assert.equal(igSnapshotQuote(v4,now).observedAt,now-2000);assert.equal(igSnapshotQuote({...v4,updateTimestampUTC:(now-2000)/1000},now).observedAt,now-2000);
assert.equal(igSnapshotQuote(v4,now).bid,100.5);assert.equal(igSnapshotQuote({updateTime:'12:00:00',bid:1,offer:2},now).observedAt,null,'En tidszonlös V3-tid får inte gissas');
console.log('PASS: V4 UTC-epoch i sekunder/millis och prisstege; V3 utan tidszon förblir overifierad');

// Regression: verkliga native IG-forexkurser får aldrig skalas ned en andra gång.
const fxMarket={epic:'CS.D.USDSEK.CFD.IP',name:'USD/SEK ',type:'CURRENCIES',instrument:{...instrument,onePipMeans:'0.0001 SEK/USD',currencies:[{code:'SEK',isDefault:true}],scalingFactor:10000},quote:{bid:10.03389,offer:10.03639,receivedAt:now,observedAt:now-5000,marketStatus:'TRADEABLE',delayTime:0}};
const fx=igUsdSekFx(fxMarket,now)!;assert.equal(fx.bid,10.03389);assert.equal(fx.offer,10.03639);
const eur=igCalculationRules({...instrument,currencies:[{code:'USD',isDefault:false}],marginDepositBands:[{margin:3.33},{margin:15}]},{scalingFactor:10000},'SEK',fx,now);
assert.equal(eur.nativePointValue,100000);assert.equal(eur.executionCurrency,'USD');assert.equal(eur.pointCurrency,'SEK');assert.equal(eur.pointValue,100000*fx.offer);assert.equal(eur.profitPointValue,100000*fx.bid);assert.equal(eur.marginRate,.15);assert.match(eur.marginBasis,/övre gräns/);
assert.equal(igCalculationRules({...instrument,contractSize:'10000'},{scalingFactor:10000},'USD').pointValue,null,'Pipvärde och kontraktsstorlek måste stämma');
assert.equal(igCalculationRules({...instrument,onePipMeans:'0.0001 JPY/EUR'},{scalingFactor:10000},'USD').pointValue,null,'Valutaenheten får inte gissas');
assert.equal(igUsdSekFx({...fxMarket,name:'SEK/USD'},now),null);assert.equal(igUsdSekFx({...fxMarket,type:'SHARES'},now),null);assert.equal(igUsdSekFx({...fxMarket,quote:{...fxMarket.quote,observedAt:now-60001}},now),null);
assert.equal(igFxIsFresh(fx,'SEK',now+60001),false);assert.equal(igCalculationRules(instrument,{scalingFactor:10000},'SEK',fx,now+60001).verified,false);
const btc=igCalculationRules({type:'CURRENCIES',unit:'CONTRACTS',contractSize:.1,valueOfOnePip:.1,onePipMeans:'1',currencies:[{code:'USD',isDefault:false}],marginFactor:50,marginFactorUnit:'PERCENTAGE',marginDepositBands:[{margin:50},{margin:75}]},{scalingFactor:1},'SEK',fx,now);
assert.equal(btc.nativePointValue,.1);assert.equal(btc.marginRate,.75);assert.equal(btc.executionCurrency,'USD');
console.log('PASS: native EURUSD/Bitcoin-kontraktsvärde, USDSEK utan dubbel skalning, erbjuden exekveringsvaluta, SEK ask-risk/bid-vinst, högsta tiermarginal och saknad/stale/felvänd FX blockerad');
