import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createIgOrders} from '../src/integrations/igOrders.js';
let now=Date.parse('2026-10-07T10:00:00Z'),generation='account-A',enabled=false,killed=false,timeout=false,marketStale=false;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ig-orders-test-'));
const ps:any[]=[];const calls:any[]=[];
const environment=(mode:string)=>({environment:mode,status:'connected',connectionGeneration:`${generation}-${mode}`,account:{accountType:'CFD',available:1000,profitLoss:0,currency:'USD'}});
const status=()=>({environments:{demo:environment('demo'),live:environment('live')}});
const market=async(_mode:string,epic:string)=>({epic,expiry:'-',instrument:{currencies:[{code:'USD'}],scalingFactor:1},quote:{bid:100,offer:101,receivedAt:now,observedAt:marketStale?now-60001:now,delayTime:0,marketStatus:'TRADEABLE'},calculationRules:{verified:true,pointValue:1,pointCurrency:'USD',executionCurrency:'USD',priceScalingFactor:1,marginRate:.1},dealingRules:{minDealSize:{value:.1},minNormalStopOrLimitDistance:{unit:'POINTS',value:1}}});
let n=0;const call=async(mode:string,route:string,method:string,_version:string,body:any,extra:any)=>{
 calls.push({mode,route,method,body,extra});
 if(route==='workingorders')return {workingOrders:[]};
 if(route==='history/transactions')return {transactions:[],metadata:{pageData:{totalPages:1}}};
 if(method==='POST'){if(timeout)throw Error('mock timeout');n++;return {dealReference:`ref-${n}`};}
 if(route.startsWith('confirms/'))return {dealStatus:'ACCEPTED',dealId:'opened-deal',affectedDeals:[{dealId:'opened-deal',status:'DELETED'}]};
 throw Error('Unexpected mock call');
};
const deps={status:status as never,accounts:async()=>({status:'ready'}) as never,positions:async()=>({status:'ready',positions:ps}) as never,market,call:call as never,guard:async()=>({killSwitchActive:killed}),now:()=>now,directory,enabled:()=>enabled,positionLimit:()=>3,limits:{maxPositionUsd:1000,maxTotalExposureUsd:3000,maxDailyLossUsd:100,maxOpenPositions:3}};
const orders=createIgOrders(deps),ticket={epic:'CS.D.EURUSD.MINI.IP',direction:'BUY',size:1,entry:101,stopLevel:95,targetLevel:110,orderType:'MARKET',holdingMinutes:15,autoClose:true};
const draft=await orders.preview('demo',ticket);assert.equal(draft.risk,6);assert.equal(calls.some(c=>c.method==='POST'),false,'Granskning skickar aldrig order');
await assert.rejects(orders.confirm('demo',draft.id),/avstängd|avstängt/);enabled=true;
const order=await orders.confirm('demo',draft.id);assert.equal(order.status,'accepted');assert.equal(calls.filter(c=>c.method==='POST').length,1);
await assert.rejects(orders.confirm('demo',draft.id),/redan behandlat/);assert.equal(calls.filter(c=>c.method==='POST').length,1,'Dubbelklick omsänder aldrig order');
assert.equal(orders.snapshot('live').pendingOrders.length,0,'IG Demo blandas aldrig med Live');
ps.push({dealId:'opened-deal',epic:ticket.epic,direction:'BUY',size:1,level:101,currency:'USD'});
assert.equal(orders.snapshot('demo',ps).pendingOrders.length,0,'Accepterad order blir position endast via mäklarens positionslista');
const previous=orders.snapshot('demo').exitPlans[0]!.closeAt;
const roll=await orders.rollover('demo','opened-deal',15);assert.equal(roll.closeAt,previous+15*60000);
const closed=await orders.close('demo','opened-deal');assert.equal(closed.status,'confirmed');assert.equal(calls.at(-2).extra._method,'DELETE');
await assert.rejects(orders.close('demo','opened-deal'),/redan begärd/);
marketStale=true;await assert.rejects(orders.preview('demo',ticket),/inaktuell/);marketStale=false;
killed=true;await assert.rejects(orders.preview('demo',ticket),/kill switch/);killed=false;
const changed=await orders.preview('demo',ticket);generation='account-B';await assert.rejects(orders.confirm('demo',changed.id),/ändrades/);
const unknown=await orders.preview('demo',ticket);timeout=true;const result=await orders.confirm('demo',unknown.id);assert.equal(result.status,'unknown');await assert.rejects(orders.confirm('demo',unknown.id),/redan behandlat/);timeout=false;
await assert.rejects(orders.preview('demo',ticket),/avstämmas/);
const clean=createIgOrders({...deps,directory:path.join(directory,'clean')});
const limit=await clean.preview('demo',{...ticket,orderType:'LIMIT',entry:99,autoClose:false});await clean.confirm('demo',limit.id);assert.ok(calls.some(c=>c.route==='workingorders/otc'&&c.method==='POST'));
const restart=createIgOrders({...deps,directory});assert.equal(restart.snapshot('demo').exitPlans.some(p=>p.status==='scheduled'),false,'Ingen automatisk tidsstängning återupptas efter omstart');
console.log('PASS: serverräknad risk, befintliga gränser, kill switch, färska priser, preview utan order, explicit flagga, bekräftelse, idempotens, okänt utfall utan omsändning, Demo/Live, limit, stängningsbekräftelse och rollover; enbart mockade IG-anrop');

// En äldre tidsplan får inte återaktiveras efter en ny IG-kontosession.
const reconnect=createIgOrders({...deps,directory:path.join(directory,'reconnect')});
const rcDraft=await reconnect.preview('demo',ticket);await reconnect.confirm('demo',rcDraft.id);
const countBefore=calls.filter(c=>c.method==='POST').length;generation='account-C';now+=16*60000;await reconnect.tick();assert.equal(calls.filter(c=>c.method==='POST').length,countBefore,'Reconnect skickar ingen gammal tidsstängning');
assert.ok(JSON.parse(fs.readFileSync(path.join(directory,'reconnect/demo.json'),'utf8')).plans.every((p:any)=>p.status==='interrupted'));
console.log('PASS: reconnect avbryter gamla tidsplaner utan stängningsanrop');

// Ett okänt orderutfall förblir spärrat även efter en ny anslutning.
generation='account-D';assert.ok(orders.snapshot('demo').pendingOrders.some(d=>d.status==='unknown'&&d.previousConnection));await assert.rejects(orders.preview('demo',ticket),/avstämmas/);
// Tidsgränsen kontrolleras efter en långsam riskvalidering.
let slow=false;const expiry=createIgOrders({...deps,directory:path.join(directory,'expiry'),accounts:(async()=>{if(slow)now+=31000;return {status:'ready'};}) as never});
const exp=await expiry.preview('demo',ticket);slow=true;const beforeExpiry=calls.filter(c=>c.method==='POST').length;await assert.rejects(expiry.confirm('demo',exp.id),/hann gå ut/);assert.equal(calls.filter(c=>c.method==='POST').length,beforeExpiry);
console.log('PASS: okänt orderutfall spärrar efter reconnect och utgånget underlag skickas inte');

await assert.rejects(clean.preview('demo',{...ticket,orderType:'LIMIT',entry:99}),/manuell stängning/);

assert.equal((await clean.brokerPending('demo','older-binding')).status,'unavailable','Workingorders får inte blandas mellan anslutningsgenerationer');

// SEK-konto med faktisk native EUR/USD Mini-prisnivå; inga verkliga mäklaranrop.
let fxAge=0;const fxRate={baseCurrency:'USD' as const,accountCurrency:'SEK',bid:10.03389,offer:10.03639,source:'Fixture · verifierad USD/SEK'};
const sekStatus=()=>({environments:{demo:{...environment('demo'),account:{accountType:'CFD',available:20000,profitLoss:0,currency:'SEK'}},live:environment('live')}});
const fx=async()=>({...fxRate,receivedAt:now,observedAt:now-fxAge});
const {igCalculationRules}=await import('../src/integrations/igRules.js');
const eurInstrument={type:'CURRENCIES',unit:'CONTRACTS',contractSize:10000,valueOfOnePip:1,onePipMeans:'0.0001 USD/EUR',currencies:[{code:'USD',isDefault:false}],marginFactor:3.33,marginFactorUnit:'PERCENTAGE',marginDepositBands:[{margin:3.33},{margin:15}]};
const sekMarket=async(_mode:string,epic:string)=>({epic,expiry:'-',instrument:{...eurInstrument,scalingFactor:10000},quote:{bid:1.11848,offer:1.11857,receivedAt:now,observedAt:now,delayTime:0,marketStatus:'TRADEABLE',source:'IG REST v4 · Fixture',maxQuoteSize:1,quoteSizeCurrency:'USD'},calculationRules:igCalculationRules(eurInstrument,{scalingFactor:10000},'SEK',await fx(),now),dealingRules:{minDealSize:{value:.04},minNormalStopOrLimitDistance:{unit:'POINTS',value:2}}});
const sekDeps={...deps,status:sekStatus as never,positions:async()=>({status:'ready',positions:[]}) as never,market:sekMarket,fx,directory:path.join(directory,'sek')};
const sekOrders=createIgOrders(sekDeps),sekTicket={...ticket,size:.04,stopLevel:1.115,targetLevel:1.125};
const sekDraft=await sekOrders.preview('demo',sekTicket);assert.equal(sekDraft.currency,'SEK');assert.equal(sekDraft.executionCurrency,'USD');assert.equal(sekDraft.body.currencyCode,'USD');
assert.ok(Math.abs(sekDraft.exposure-1.11857*.04*10000*fxRate.offer)<1e-8);assert.ok(Math.abs(sekDraft.risk-(1.11857-1.115)*.04*10000*fxRate.offer)<1e-8);assert.ok(Math.abs(sekDraft.margin-sekDraft.exposure*.15)<1e-8);
assert.ok(Math.abs((sekDraft as any).reward-(1.125-1.11857)*.04*10000*fxRate.bid)<1e-8,'Positiv vinst använder bid');
await assert.rejects(sekOrders.preview('demo',{...sekTicket,stopLevel:1.11847}),/stop-\/målavstånd/,'POINTS 2 betyder .0002 i native kurs');
await assert.rejects(sekOrders.preview('demo',{...sekTicket,size:1000*.9999/(1.11857*10000)}),/positionsgräns/,'Ask-exponering och bid-konverterad USD-gräns ger konservativ spärr');
fxAge=60001;await assert.rejects(sekOrders.preview('demo',sekTicket),/färsk verifierad USD\/SEK/);fxAge=0;
const noFx=createIgOrders({...sekDeps,fx:async()=>null,directory:path.join(directory,'no-fx')});await assert.rejects(noFx.preview('demo',sekTicket),/färsk verifierad USD\/SEK/);
const badCurrency=createIgOrders({...sekDeps,market:async(...args:Parameters<typeof sekMarket>)=>({...await sekMarket(...args),calculationRules:{...(await sekMarket(...args)).calculationRules,executionCurrency:'SEK'}}),directory:path.join(directory,'bad-currency')});await assert.rejects(badCurrency.preview('demo',sekTicket),/erbjuden instrumentvaluta|prisnivå i prisstegen/,'Prisstegens storlek måste matcha exekveringsvalutan');
const sekAccepted=await sekOrders.confirm('demo',sekDraft.id);assert.equal(sekAccepted.status,'accepted');assert.equal(calls.filter(c=>c.method==='POST').at(-1).body.currencyCode,'USD');
console.log('PASS: SEK-nativekonto, native EURUSD Mini/stoppip-avstånd, ask-risk/bid-vinst, konservativa USD-gränser, erbjuden USD i brokerbody, prisstegevaluta och saknad/stale FX; endast mocks');

// Accepterad order reserverar faktisk entry efter tillåten kursrörelse, inte previewkursen.
let moved=false;const repricedMarket=async(mode:string,epic:string)=>{const m=await market(mode,epic);return {...m,quote:{...m.quote,bid:moved?101:100,offer:moved?102.01:101}};};
const repriced=createIgOrders({...deps,status:(()=>({environments:{demo:{...environment('demo'),account:{accountType:'CFD',available:2000,profitLoss:0,currency:'USD'}},live:environment('live')}})) as never,positions:async()=>({status:'ready',positions:[]}) as never,market:repricedMarket,directory:path.join(directory,'repriced'),limits:{...deps.limits,maxTotalExposureUsd:204.01}});
const rp=await repriced.preview('demo',{...ticket,stopLevel:50,targetLevel:200});assert.equal(rp.entry,101);moved=true;
const acceptedRepriced=await repriced.confirm('demo',rp.id);assert.equal(acceptedRepriced.status,'accepted');assert.equal(acceptedRepriced.entry,102.01);assert.equal(acceptedRepriced.exposure,102.01);assert.ok(Math.abs(acceptedRepriced.margin-10.201)<1e-9);assert.ok(Math.abs(acceptedRepriced.risk-52.01)<1e-9);
assert.equal(repriced.snapshot('demo').pendingOrders[0]!.entry,102.01);assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'repriced/demo.json'),'utf8')).drafts[0].entry,102.01);
await assert.rejects(repriced.preview('demo',{...ticket,stopLevel:50,targetLevel:200}),/totalexponering/,'102.01 accepterat + 102.01 nytt överskrider 204.01; previewkurs 101 hade felaktigt tillåtit ordern');
console.log('PASS: accepterad order och pending-reservation lagrar omvaliderad entry/risk/marginal vid 1 % tillåten kursrörelse');

// En bevarad kontosession innebär inte att ett gammalt saldo får användas för en ny order.
let accountRate=false;const quotaAccounts=createIgOrders({...deps,directory:path.join(directory,'quota-accounts'),accounts:(async()=>accountRate?{status:'error',error:'IG begränsade antal läsanrop; försök igen om en minut',accounts:null}:{status:'ready'}) as never,positions:async()=>({status:'ready',positions:[]}) as never});
const quotaDraft=await quotaAccounts.preview('demo',ticket);accountRate=true;const beforeQuotaOrders=calls.filter(c=>c.method==='POST').length;
await assert.rejects(quotaAccounts.preview('demo',ticket),/begränsade antal läsanrop/);await assert.rejects(quotaAccounts.confirm('demo',quotaDraft.id),/begränsade antal läsanrop/);assert.equal(calls.filter(c=>c.method==='POST').length,beforeQuotaOrders,'Stale konto används aldrig för order efter kontokvot');
const unavailableAccounts=createIgOrders({...deps,directory:path.join(directory,'unavailable-accounts'),accounts:async()=>({status:'error',error:'Fixture unavailable'}) as never});await assert.rejects(unavailableAccounts.preview('demo',ticket),/färskt verifierat kontounderlag/);
// Kvot före stängning ger en 60-sekunders retryplan, aldrig omsändning av en redan skickad order.
let positionRate=false;const retryPositions=[{dealId:'opened-deal',epic:ticket.epic,direction:'BUY',size:1,level:101,currency:'USD'}];
const closingRate=createIgOrders({...deps,directory:path.join(directory,'quota-close'),positions:(async()=>positionRate?{status:'error',error:'IG begränsade antal läsanrop; försök igen om en minut',positions:null}:{status:'ready',positions:retryPositions}) as never});
const timed=await closingRate.preview('demo',ticket);await closingRate.confirm('demo',timed.id);positionRate=true;now+=16*60000;
const beforeQuotaClose=calls.filter(c=>c.method==='POST').length;await closingRate.tick();assert.equal(calls.filter(c=>c.method==='POST').length,beforeQuotaClose);assert.equal(closingRate.snapshot('demo').exitPlans[0]!.status,'scheduled');assert.match(closingRate.snapshot('demo').exitPlans[0]!.error!,/läsgräns/);
await closingRate.tick();assert.equal(calls.filter(c=>c.method==='POST').length,beforeQuotaClose,'Ingen tät kvotretry');positionRate=false;now+=60001;await closingRate.tick();assert.equal(closingRate.snapshot('demo').exitPlans[0]!.status,'confirmed');assert.equal(calls.filter(c=>c.method==='POST').length,beforeQuotaClose+1);
console.log('PASS: fresh accounts krävs för preview/confirm; planerad stängning bevaras vid läskvot och återförsöks först efter 60 s med nytt verifierat underlag');

// Även serverns lokala läsbudget under kvothämtning är ett återförsökbart läsfel.
let quoteRate=false;const closeBudget=createIgOrders({...deps,directory:path.join(directory,'budget-close'),positions:async()=>({status:'ready',positions:retryPositions}) as never,market:async(mode:string,epic:string)=>{if(quoteRate)throw Error('IG-läsbudgeten är slut för denna minut');return market(mode,epic);}});
const budgetTimed=await closeBudget.preview('demo',ticket);await closeBudget.confirm('demo',budgetTimed.id);now+=16*60000;quoteRate=true;const budgetPosts=calls.filter(c=>c.method==='POST').length;
await closeBudget.tick();assert.equal(closeBudget.snapshot('demo').exitPlans[0]!.status,'scheduled');assert.equal(calls.filter(c=>c.method==='POST').length,budgetPosts);quoteRate=false;now+=60001;await closeBudget.tick();assert.equal(closeBudget.snapshot('demo').exitPlans[0]!.status,'confirmed');
console.log('PASS: lokal kvotbudget bevarar tidsplan utan POST och tillåter senare verifierad stängning');

// UI-pollning återanvänder endast visningsdata; riskvalidering går förbi denna cache.
let displayNow=1000,displayGeneration='display-A',displayCalls=0;
const display=createIgOrders({...deps,now:()=>displayNow,status:(()=>({environments:{demo:{...environment('demo'),connectionGeneration:displayGeneration},live:environment('live')}})) as never,call:(async()=>{displayCalls++;await Promise.resolve();return {workingOrders:[]};}) as never});
await Promise.all([display.brokerPending('demo'),display.brokerPending('demo')]);assert.equal(displayCalls,1,'Parallella visningsanrop delar hämtning');
for(let t=5000;t<60000;t+=5000){displayNow=1000+t;assert.equal((await display.brokerPending('demo')).status,'ready');}
assert.equal(displayCalls,2,'Tolv UI-pollningar ger två workingorders-läsningar per minut');
displayGeneration='display-B';await display.brokerPending('demo');assert.equal(displayCalls,3,'Nytt konto återanvänder aldrig gammal visningscache');
console.log('PASS: arbetsorder-visning har 30s generationbunden cache/singleflight utan att ändra färsk riskvalidering');

// Sessionskvoten följer de beständigt reserverade orderförsöken, inte öppna positioner.
let sessionPolicy:any={id:'session-five',marginPercent:1,maxTrades:5,riskPercent:1,holdingMinutes:3},slowSession=false;
const sessionDir=path.join(directory,'session-policy'),sessionCalls:any[]=[];
const sessionDeps={...deps,directory:sessionDir,status:(()=>({environments:{demo:{...environment('demo'),account:{accountType:'CFD',balance:1000,available:1000,profitLoss:0,currency:'USD'}},live:environment('live')}})) as never,sessionPolicy:()=>sessionPolicy,positions:async()=>({status:'ready',positions:[]}) as never,accounts:(async()=>{if(slowSession)sessionPolicy=null;return {status:'ready'};}) as never,call:(async(...args:any[])=>{sessionCalls.push(args);if(args[2]==='POST')return {dealReference:'session-ref'};if(args[1].startsWith('confirms/'))return {dealStatus:'REJECTED'};return call(...args as Parameters<typeof call>);}) as never};
const sessionOrders=createIgOrders(sessionDeps),sessionTicket={...ticket,size:.5,holdingMinutes:3};
await assert.rejects(sessionOrders.preview('demo',{...sessionTicket,size:1}),/marginal-/);
await assert.rejects(sessionOrders.preview('demo',{...sessionTicket,stopLevel:50}),/SL-risk/);
await assert.rejects(sessionOrders.preview('demo',{...sessionTicket,autoClose:false}),/tidsstängning/);
await assert.rejects(sessionOrders.preview('demo',{...sessionTicket,orderType:'LIMIT',autoClose:false}),/marknadsorder/);
const six=await Promise.all(Array.from({length:6},()=>sessionOrders.preview('demo',sessionTicket)));
const concurrent=await Promise.allSettled(six.map(d=>sessionOrders.confirm('demo',d.id)));assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1,'Samtida confirm serialiseras');
for(const d of six.slice(1,5))await sessionOrders.confirm('demo',d.id);
await assert.rejects(sessionOrders.confirm('demo',six[5].id),/gräns/);assert.equal(sessionCalls.filter(c=>c[2]==='POST').length,5);
const sessionRestart=createIgOrders(sessionDeps);await assert.rejects(sessionRestart.preview('demo',sessionTicket),/gräns/,'Omstart nollställer inte samma sessions fem reservationer');
sessionPolicy={...sessionPolicy,id:'next-session',marginPercent:3,riskPercent:2};const newDraft=await sessionOrders.preview('demo',{...sessionTicket,size:2});assert.ok(Math.abs(newDraft.margin-20.2)<1e-9);slowSession=true;const posts=sessionCalls.filter(c=>c[2]==='POST').length;await assert.rejects(sessionOrders.confirm('demo',newDraft.id),/sessionen ändrades/);assert.equal(sessionCalls.filter(c=>c[2]==='POST').length,posts);slowSession=false;
console.log('PASS: 1–3% marginal separat från SL-risk, 3min tidsstängning, fem beständiga orderförsök inklusive avvisningar, samtidighet, omstart och stopp under validering; endast mocks');
