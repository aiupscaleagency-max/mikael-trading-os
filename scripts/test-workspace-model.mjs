import assert from 'node:assert/strict';
import {quoteIsFresh,mergeWorkspaceMarket,nextCatalogCategory,scenario,sizeForCapitalRisk,increaseDraft,extendDeadline,normalizeSignal} from '../src/server/ui/workspace/model.mjs';
const now=1000000,q={quote:{bid:100,offer:101,receivedAt:now,observedAt:now,delayTime:0,marketStatus:'TRADEABLE'}};
assert.equal(quoteIsFresh(q,now),true);
for(const patch of [{receivedAt:now-60001},{receivedAt:NaN},{receivedAt:now+1},{observedAt:now-60001},{observedAt:null},{delayTime:1},{offer:99},{bid:-1},{marketStatus:'CLOSED'}])assert.equal(quoteIsFresh({quote:{...q.quote,...patch}},now),false);
const base={direction:'BUY',entry:100,stop:95,target:110,size:2,pointValue:1,available:1000,currency:'USD',pointCurrency:'USD',marginRate:.2};
assert.deepEqual(scenario(base),{valid:true,risk:10,reward:20,exposure:200,margin:40,percent:10,capitalPercent:1,ratio:2,knownFees:null});
assert.equal(scenario({...base,pointCurrency:'SEK'}).valid,false);
assert.equal(scenario({...base,pointValue:null}).reward,null);
assert.equal(scenario({...base,direction:'SELL',stop:105,target:90}).risk,10);
assert.equal(scenario({...base,stop:105}).valid,false);
assert.equal(sizeForCapitalRisk({...base,percent:1,step:.1}),2);
assert.equal(sizeForCapitalRisk({...base,percent:1,pointValue:null}),null);
const position={size:2,epic:'EUR',direction:'BUY',dealId:'deal',closeAt:now+60000};
assert.equal(increaseDraft(position).size,2);assert.equal(position.size,2,'Double up är ett utkast, ändrar aldrig den öppna positionen');
assert.equal(extendDeadline(position,15,now),now+16*60000);assert.throws(()=>extendDeadline(position,Infinity));
const analysis={completedAt:now,selection:{timeframe:'5m'}};
assert.equal(normalizeSignal({action:'HOLD'},analysis,now).copyable,false);
assert.equal(normalizeSignal({action:'BUY',entryLevel:1,stopLevel:.9,targetLevel:1.2},analysis,now).copyable,true);
assert.equal(normalizeSignal({action:'BUY',entryLevel:1,stopLevel:.9,targetLevel:1.2},analysis,now+300001).copyable,false);
console.log('PASS: kontovaluta, long/short, riskandel, margin, ingen påhittad CFD-avkastning, kvotålder, signalgiltighet, double up-utkast och roll over-tid');

const sek=scenario({...base,currency:'SEK',pointCurrency:'SEK',pointValue:10.04,profitPointValue:10.03});assert.ok(Math.abs(sek.risk-100.4)<1e-9);assert.equal(Number(sek.reward.toFixed(8)),200.6,'Positiv SEK-vinst använder bid, inte riskens ask');
assert.equal(quoteIsFresh({quote:{bid:100,offer:101,marketStatus:'TRADEABLE',delayTime:0,receivedAt:Date.now()},calculationRules:{fx:{receivedAt:Date.now()-60001,observedAt:Date.now()-60001}}}),false,'Stale valutakurs blockerar även UI-granskning');

const {rankMarkets,marketMetric}=await import('../src/server/ui/workspace/model.mjs');
const rankFixture=[{epic:'missing',name:'A',changePercent:null},{epic:'down',name:'B',changePercent:-8},{epic:'up',name:'C',changePercent:3}];
assert.deepEqual(rankMarkets(rankFixture,'up').map(x=>x.epic),['up','down','missing']);
assert.deepEqual(rankMarkets(rankFixture,'movement').map(x=>x.epic),['down','up','missing']);
assert.equal(marketMetric({bid:1,offer:1.01},'sentiment'),null);
assert.equal(marketMetric({bid:2,offer:1},'spread'),null);
assert.equal(marketMetric({percentageChange:0},'up'),0);
console.log('PASS: verifierade rankningar och saknade värden utan fabricerad popularitet');

const proofQuote={...q.quote,generation:'session',delayVerification:{generation:'session',verifiedAt:now,validUntil:now+1000}};
assert.equal(quoteIsFresh({quote:proofQuote},now),true);
assert.equal(quoteIsFresh({quote:proofQuote},now+1000),false,'REST-verifiering löper ut även med färskt streampris');
assert.equal(quoteIsFresh({quote:{...proofQuote,generation:'other'}},now),false,'REST-verifiering får inte byta konto');

const {chartSubscriptions,shouldRefreshChart}=await import('../src/server/ui/workspace/multiCharts.mjs');
assert.deepEqual(chartSubscriptions({epic:'EUR',frame:'15m'},[{epic:'EUR',frame:'1m'},{epic:'GBP',frame:'1h'},{epic:'BTC',frame:'1d'}]),[{epic:'EUR',scale:'1MINUTE'},{epic:'GBP',scale:'HOUR'}]);
const extra={loading:false,lastLoad:now-60000,frame:'1m',bars:[{receivedAt:now}],error:null};
assert.equal(shouldRefreshChart(extra,now,true),false,'Frisk WS med nytt ljus ska inte REST-pollas');
assert.equal(shouldRefreshChart(extra,now,false),true,'Laddat extradiagram måste ha REST-reserv efter WS-avbrott');
assert.equal(shouldRefreshChart({...extra,lastLoad:now},now,false),false,'Reservläge respekterar 60s-budget');
assert.equal(shouldRefreshChart({...extra,bars:[{receivedAt:now-60000}]},now,true),true,'Öppen transport utan färska candles kräver avstämning');

const retainedMarket={epic:'EUR',name:'EUR/USD',instrument:{unit:'CFD'},calculationRules:{verified:true},quote:q.quote,workspaceBinding:'same-account'};
const unavailable=mergeWorkspaceMarket(retainedMarket,{epic:'EUR',status:'unavailable',error:'Minutkvot'},'same-account');
assert.equal(unavailable.name,'EUR/USD');assert.deepEqual(unavailable.instrument,retainedMarket.instrument);assert.equal(unavailable.quote,retainedMarket.quote);assert.equal(unavailable.quote.observedAt,now);assert.equal(quoteIsFresh(unavailable,now+60001),false,'Bevarad identitet förnyar inte gammalt pris');
assert.equal(mergeWorkspaceMarket(retainedMarket,{epic:'EUR',status:'unavailable'},'another-account').name,undefined,'Metadata får inte återanvändas över kontoanslutningar');
assert.equal(mergeWorkspaceMarket(retainedMarket,{epic:'GBP',status:'unavailable'},'same-account').name,undefined,'Metadata får inte läcka över instrument');
assert.equal(mergeWorkspaceMarket(retainedMarket,{epic:'EUR',quote:{...q.quote,observedAt:now-1}},'same-account').quote,retainedMarket.quote,'Äldre kvot ersätter inte streampris');
const catalogStates={forex:{status:'partial',remainingSearches:20,lastAttemptAt:200},crypto:{status:'partial',remainingSearches:29,lastAttemptAt:100}};
assert.equal(nextCatalogCategory(catalogStates,['forex','crypto']),'crypto','Krypto svälts inte av Forex');catalogStates.crypto.lastAttemptAt=300;assert.equal(nextCatalogCategory(catalogStates,['forex','crypto']),'forex');catalogStates.forex.remainingSearches=0;assert.equal(nextCatalogCategory(catalogStates,['forex','crypto']),'crypto');
