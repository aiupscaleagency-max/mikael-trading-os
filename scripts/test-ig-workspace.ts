import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import os from "node:os";
const directory=mkdtempSync(path.join(os.tmpdir(),"ig-workspace-"));process.chdir(directory);
const {createIgWorkspace,normalizeIgCandles,igMarketCategory}=await import("../src/integrations/igWorkspace.js");
let now=Date.UTC(2026,9,7,12,0),demoConnected=false;
const epic="CS.D.EURUSD.CFD.IP",other="CS.D.GBPUSD.CFD.IP";
const half=(n:number)=>({bid:n-0.01,ask:n+0.01,lastTraded:null});
const bar=(time:number,value=100)=>({snapshotTimeUTC:new Date(time).toISOString().slice(0,19),snapshotTime:"not UTC",openPrice:half(value),highPrice:half(value+1),lowPrice:half(value-1),closePrice:half(value+0.2),lastTradedVolume:null});
const raw=Array.from({length:50},(_,i)=>bar(now-(50-i)*300000,100+i));
const closed=normalizeIgCandles([...raw,bar(now),{...bar(now-600000),snapshotTimeUTC:undefined},{...bar(now-900000),openPrice:{bid:null,ask:1}},raw[0]],"5m",now);
assert.equal(closed.candles.length,50);assert.equal(closed.forming,1);assert.equal(closed.rejected,3);assert.equal(closed.candles[0]?.volume,null);
assert.equal(closed.candles.at(-1)?.closeTime,now);
assert.equal(normalizeIgCandles([{...raw[0],snapshotTimeUTC:"2026-02-30T00:00:00"}],"5m",now).rejected,1,"Ogiltig kalenderdag får inte rullas fram av Date.parse");
const events:string[]=[],requests:{mode:string;route:string;method:string;version:string;extra:any}[]=[];
const status=()=>({environments:{live:{environment:"live",configured:true,credentialsComplete:true,status:"connected",error:null,account:{balance:1000,currency:"SEK"},checkedAt:1000,connectionGeneration:"fixture-live-generation"},demo:{environment:"demo",configured:true,credentialsComplete:demoConnected,status:demoConnected?"connected":"missing",error:demoConnected?null:"Demo-inloggning saknas",account:null,checkedAt:null}}});
const call=async(mode:string,route:string,method:string,version:string,_body:any,extra:any)=>{
  requests.push({mode,route,method,version,extra});assert.equal(method,"GET","Workspace får aldrig skicka order");
  if(route==="markets")return {markets:[{epic,instrumentName:"EUR/USD",instrumentType:"CURRENCIES",expiry:"-",bid:100,offer:100.1,marketStatus:"TRADEABLE"}]};
  if(route.startsWith("markets/"))return {instrument:{epic:route.slice(8),name:"EUR/USD",type:"CURRENCIES",expiry:"-",unit:"CONTRACTS",contractSize:"100000",valueOfOnePip:"1.25",onePipMeans:"0.0001",marginFactor:3.33,marginFactorUnit:"PERCENTAGE",currencies:[{code:"USD",isDefault:true}],marginDepositBands:[{min:0,max:100,margin:3.33}]},snapshot:{bid:100,offer:100.1,marketStatus:"TRADEABLE",delayTime:0,updateTimeUTC:new Date(now).toISOString().slice(11,19),scalingFactor:10000,decimalPlacesFactor:1},dealingRules:{minDealSize:{unit:"POINTS",value:0.5},minNormalStopOrLimitDistance:{unit:"POINTS",value:5}}};
  if(route.startsWith("prices/")){assert.equal(version,"3");assert.ok(extra.query.includes("MINUTE_5"));return {prices:[...raw,bar(now)],metadata:{allowance:{remainingAllowance:9900},pageData:{totalPages:1}}};}
  if(route==="history/transactions")return {transactions:[{dateUtc:"2026-10-06T10:00:00",transactionType:"DEAL",profitAndLoss:"£15.00",currency:"GBP",size:"0.5"},{transactionType:"DEPOSIT",cashTransaction:true,profitAndLoss:"£100.00"}],metadata:{pageData:{totalPages:1}}};
  if(route==="history/activity")return {activities:[{type:"POSITION",status:"ACCEPTED",epic}],metadata:{pageData:{totalPages:1}}};
  throw Error("unexpected mocked route");
};
const positions=async(mode:string)=>({environment:mode,status:"ready",error:null,positions:[{epic,size:0.5,level:100,bid:null,offer:null}],updatedAt:now});
const llm=async(role:string,context:any)=>{
  events.push(role);assert.deepEqual(context.selection.epics,[epic]);
  if(role==="technical"){assert.equal(context.observations[0].candles.length,50);assert.equal(context.observations[0].indicators.volumeSignal,null);return {analyses:[{epic,bias:"bullish",signals:["RSI"],reason:"verified"}]};}
  assert.ok(context.technical.observations);return {analyses:[{epic,action:"BUY",reason:"setup",entryLevel:150,stopLevel:145,targetLevel:160}],summary:"Förslag"};
};
const deps={directory:path.join(directory,"state"),now:()=>now,status:status as never,call:call as never,positions:positions as never,accounts:async(mode:any)=>({environment:mode,status:"ready",error:null,accounts:[],updatedAt:now}),jev:async(state:any)=>{events.push("JEV");assert.ok(!JSON.stringify(state).includes(epic));return {available:false,note:"test"};},llm:llm as never};
const w=createIgWorkspace(deps);
await assert.rejects(w.searchMarkets("demo","EUR"),/inte ansluten/);
assert.equal((await w.searchMarkets("live","EUR")).markets[0].epic,epic);
const selected=await w.setSelection("live",{epics:[epic],timeframe:"5m",percent:1,horizonMinutes:15});
assert.equal(selected.epics[0],epic);
const detail=await w.market("live",epic);assert.equal(detail.instrument.contractSize,100000);assert.equal(detail.instrument.valueOfOnePip,1.25);
const candles=await w.candles("live",epic,"5m");assert.equal(candles.priceBasis,"mid");assert.equal(candles.candles.length,50);
await w.candles("live",epic,"5m");assert.equal(requests.filter(r=>r.route.startsWith("prices/")).length,1,"Historik cache skyddar IG-kvot");
const analysis=await w.analyze("live");assert.equal(analysis.status,"completed");assert.deepEqual(events,["JEV","technical","head"]);
const view=await w.workspace("live");assert.equal(view.positions[0].bid,100);assert.equal(view.positions[0].profitLoss,null,"Saknad positionsvaluta ger aldrig fabricerad P/L");assert.equal(view.history.transactions[1].cashTransaction,true);assert.equal(view.pendingOrders[0].quantity,null);assert.equal(view.pendingOrders[0].status,"manual_review_blocked");assert.equal(view.transport,"REST polling");
assert.equal((await w.workspace("demo")).analysis,null,"Liveanalys får inte läcka till demomiljön");
const session=await w.startSession("live",{...selected,durationMinutes:15,intervalMinutes:5});
await w.setSelection("live",{epics:[other],timeframe:"5m",percent:2,horizonMinutes:30});
await w.tickSessions();const after=await w.workspace("live");assert.equal(after.session.analyses,1);assert.deepEqual(after.analysis.selection.epics,[epic],"Sessionens urval är fryst även när dashboarden byter par");
const restart=createIgWorkspace(deps);assert.equal((await restart.workspace("live")).session.status,"interrupted");
await restart.tickSessions();assert.equal((await restart.workspace("live")).session.analyses,1,"Omstart återupptar inte AI-anrop");
w.stopSession("live");assert.equal((await w.workspace("live")).session.status,"stopped");
const failed=createIgWorkspace({...deps,directory:path.join(directory,"failed"),llm:async(role)=>{events.push(`failure-${role}`);return {analyses:[]};}});
await failed.setSelection("live",selected);await assert.rejects(failed.analyze("live"),/Analys saknas/);assert.ok(!events.includes("failure-head"));
await assert.rejects(w.setSelection("live",{epics:["https://fake/epic"],timeframe:"5m"}),/Ogiltig/);
assert.ok(requests.every(r=>r.mode==="live"&&r.method==="GET"));
console.log("PASS: IG actual schema search/details, closed UTC mid OHLC/null volume, quote/allowance cache, history cash separation, JEV→technical→head, proposals without orders, live/demo isolation, immutable sessions and no restart auto-resume");

await w.setSelection("live",{epics:[],timeframe:"5m"});
assert.deepEqual((await w.workspace("live")).selection.epics,[]);
await assert.rejects(w.analyze("live"),/Välj/);

let guardedCalls=0;
const capped=createIgWorkspace({...deps,directory:path.join(directory,"capped"),guard:async()=>({allowed:false,killSwitchActive:false}),llm:async()=>{guardedCalls++;return {analyses:[]};}});
await capped.setSelection("live",selected);await assert.rejects(capped.analyze("live"),/budgetgränsen/);assert.equal(guardedCalls,0);
const killed=createIgWorkspace({...deps,directory:path.join(directory,"killed"),guard:async()=>({allowed:true,killSwitchActive:true}),llm:async()=>{guardedCalls++;return {analyses:[]};}});
await killed.setSelection("live",selected);await assert.rejects(killed.analyze("live"),/kill-switch/);assert.equal(guardedCalls,0);
let permit=true;const intermediate=createIgWorkspace({...deps,directory:path.join(directory,"intermediate"),guard:async()=>({allowed:permit,killSwitchActive:false}),llm:async(role,context)=>{if(role==="technical")permit=false;return llm(role,context);}});
await intermediate.setSelection("live",selected);await assert.rejects(intermediate.analyze("live"),/budgetgränsen/);
console.log("PASS: shared budget/kill-switch before JEV and both existing agents, including budget exhausted after technical");
let generation="account-A";
const changedStatus=()=>{const value=status();return {...value,environments:{...value.environments,live:{...value.environments.live,connectionGeneration:generation}}};};
const isolated=createIgWorkspace({...deps,directory:path.join(directory,"account-binding"),status:changedStatus as never,positions:async()=>({status:"ready",error:null,positions:[{epic,level:generation==="account-A"?111:222}],updatedAt:now}) as never});
await isolated.setSelection("live",selected);await isolated.analyze("live");await isolated.startSession("live",{...selected,durationMinutes:15,intervalMinutes:5});
assert.equal((await isolated.workspace("live")).positions[0].level,111);
generation="account-B";
const rebound=await isolated.workspace("live");
assert.equal(rebound.positions[0].level,222,"Reconnect till B får aldrig använda konto A:s cache");
assert.equal(rebound.session.status,"interrupted");assert.equal(rebound.analysis.status,"stale");assert.ok(rebound.pendingOrders.every((p:any)=>p.status==="stale"));
let releaseRace!:(v:any)=>void,enteredRace!:()=>void;
const startedRace=new Promise<void>(r=>enteredRace=r);
const race=createIgWorkspace({...deps,directory:path.join(directory,"race"),status:changedStatus as never,call:async(...args:any[])=>{if(args[1]==="markets"){enteredRace();return new Promise(r=>releaseRace=r);}return call(...args as [string,string,string,string,any,any]);}});
const waiting=race.searchMarkets("live","EUR");await startedRace;generation="account-C";
releaseRace({markets:[{epic,instrumentName:"old-account-market"}]});
await assert.rejects(waiting,/kontosessionen ändrades/);
console.log("PASS: connection generation invalidates cached account data and old proposals/sessions; prior account response cannot populate new account cache");

const {createIgConnection}=await import("../src/integrations/igConnection.js");
let sharedSessionPosts=0;
const sharedFixture={demo:{apiKey:"fixture-own-demo-api"},live:{apiKey:"fixture-own-live-api",identifier:"fixture-general-login",password:"fixture-general-password"}};
const sharedConnection=createIgConnection({loadCredentials:()=>sharedFixture,fetch:(async(url:string,options:RequestInit)=>{const headers=options.headers as Record<string,string>;assert.equal(headers["X-IG-API-KEY"],"fixture-own-demo-api");assert.ok(url.startsWith("https://demo-api.ig.com"));if(url.endsWith("/session")){sharedSessionPosts++;assert.equal(JSON.parse(options.body as string).identifier,"fixture-general-login");return new Response(JSON.stringify({currentAccountId:"fixture-demo-account"}),{headers:{CST:"fixture-private-cst","X-SECURITY-TOKEN":"fixture-private-xst"}});}return new Response(JSON.stringify({accounts:[{accountId:"fixture-demo-account",accountType:"CFD",currency:"SEK",balance:{balance:10000}}]}));}) as typeof fetch});
assert.equal((await sharedConnection.testConnection("demo")).status,"missing");assert.equal(sharedSessionPosts,0);
const shared=await sharedConnection.testWithSharedLogin("demo","live");assert.equal(shared.status,"connected");assert.equal(sharedSessionPosts,1);assert.equal(sharedFixture.demo.hasOwnProperty("identifier"),false,"Explicit gemensam login får aldrig mutera credentialsfil/loaderdata");
assert.equal(sharedConnection.getStatus().environments.live.status,"configured");
assert.ok(!JSON.stringify(shared).includes("fixture-general-password"));
console.log("PASS: explicit shared IG login uses target API key and hostname, memory-only identifier/password, no automatic cross-environment fallback");

const jevOffline=createIgWorkspace({...deps,directory:path.join(directory,"jev-offline"),jev:async()=>{throw Error("provider unavailable");}});
await jevOffline.setSelection("live",selected);assert.equal((await jevOffline.analyze("live")).jev.available,false);
console.log("PASS: JEV exception preserves existing two-agent routing and selected IG scope");

// Marknadsstatus och mottagningstid verifieras även när modellen föreslår BUY.
for (const scenario of ["closed","delayed","aged","fresh","nan","future"] as const) {
  const fixtureClock=now;
  const quoteCheck=createIgWorkspace({...deps,directory:path.join(directory,`quote-${scenario}`),
    call:async(...args:any[])=>{
      const value=await call(...args as [string,string,string,string,any,any]);
      if(args[1].startsWith("markets/")) {value.snapshot.marketStatus=scenario==="closed"?"CLOSED":"TRADEABLE";value.snapshot.delayTime=scenario==="delayed"?1:0;}
      return value;
    },
    llm:async(role,context)=>{
      const output=await llm(role,context);
      if(role==="head") {
        if(scenario==="aged")now+=60001;
        if(scenario==="nan")context.technical.observations[0].market.quote.receivedAt=NaN;
        if(scenario==="future")context.technical.observations[0].market.quote.receivedAt=now+1000;
      }
      return output;
    }
  });
  try {
    await quoteCheck.setSelection("live",selected);
    const decision=await quoteCheck.analyze("live");
    const view=await quoteCheck.workspace("live");
    assert.equal(decision.head.analyses[0].action,scenario==="fresh"?"BUY":"HOLD",`Fel kvotbeslut i ${scenario}`);
    assert.equal(view.pendingOrders.length,scenario==="fresh"?1:0,`Osäker kvot får inte skapa orderförslag i ${scenario}`);
    if(scenario!=="fresh") {assert.equal(decision.head.analyses[0].entryLevel,null);assert.equal(decision.head.analyses[0].stopLevel,null);assert.equal(decision.head.analyses[0].targetLevel,null);}
  } finally {now=fixtureClock;}
}
console.log("PASS: CLOSED/delayed/60001ms-old/NaN/future quotes force HOLD with no proposals; fresh TRADEABLE quote retains BUY proposal");

// Stopp under teknisk analys får inte starta Hanna eller publicera nya signaler.
let enteredStop!:()=>void,releaseStop!:(value:any)=>void;
const stopStarted=new Promise<void>(r=>enteredStop=r);
let stopHeads=0;
const stopped=createIgWorkspace({...deps,directory:path.join(directory,'stopped-analysis'),llm:async(role,context)=>{if(role==='technical'){enteredStop();return new Promise(r=>releaseStop=r);}stopHeads++;return llm(role,context);}});
const stopRun=stopped.analyze('live',selected);await stopStarted;stopped.stopSession('live');releaseStop({analyses:[{epic,bias:'bullish'}]});await assert.rejects(stopRun,/avbruten/);assert.equal(stopHeads,0);assert.equal((await stopped.workspace('live')).analysis.status,'stopped');
console.log('PASS: stopp under pågående analys stoppar Hanna och publicering');

// V3:s tidszonlösa updateTime får inte användas som UTC. V4 avstäms mot samma EPIC/scaling.
const epochWorkspace=createIgWorkspace({...deps,directory:path.join(directory,'v4'),call:(async(...args:any[])=>{
 if(args[1].startsWith('markets/')){const data=await call(...args as [string,string,string,string,any,any]);
  if(args[3]==='4')return {instrument:{epic:args[1].slice(8)},snapshot:{scalingFactor:10000,updateTimestampUTC:now,delayTime:0,marketStatus:'TRADEABLE',priceLadder:[{bid:'100',ask:'100.1'}],currencyLadders:[{currency:'USD',bidSizes:[2],askSizes:[3]}]}};
  delete (data.snapshot as any).updateTimeUTC;return data;}return call(...args as [string,string,string,string,any,any]);
 }) as never});
const epochMarket=await epochWorkspace.market('live',epic);assert.equal(epochMarket.quote.observedAt,now);assert.equal(epochMarket.quote.bid,100);assert.equal(epochMarket.quote.maxQuoteSize,2);
const missingEpoch=createIgWorkspace({...deps,directory:path.join(directory,'v4-missing'),call:(async(...args:any[])=>{if(args[3]==='4')throw Error('mock v4 unavailable');const data=await call(...args as [string,string,string,string,any,any]);if(data.snapshot)delete (data.snapshot as any).updateTimeUTC;return data;}) as never});
assert.equal((await missingEpoch.market('live',epic)).quote.observedAt,null);
console.log('PASS: riktig V3/V4-schemaseparation, UTC-epoch/prisstege och saknad V4-tid förblir blockerad');

// SEK-konto använder explicit USD/SEK-kvot, native forexpriser och verifierad positionsvaluta.
const sekEp='CS.D.EURUSD.CEEM.IP',fxEp='CS.D.USDSEK.CFD.IP';const currencyCalls:any[]=[];
let fxStale=false,fxFail=false;
const rawCurrencyCall=async(_mode:string,route:string,_method:string,version:string)=>{
 currencyCalls.push({route,version});
 if(route==='markets')return {markets:[{epic:fxEp,instrumentName:'USD/SEK ',instrumentType:'CURRENCIES',marketStatus:'TRADEABLE'}]};
 if(route.startsWith('history/'))return route==='history/transactions'?{transactions:[],metadata:{pageData:{totalPages:1}}}:{activities:[]};
 const pair=route===`markets/${fxEp}`;if(pair&&fxFail&&version==='4')throw Error('Fixture FX unavailable');
 const q={scalingFactor:10000,decimalPlacesFactor:5,updateTimestampUTC:fxStale&&pair?now-60001:now,marketStatus:'TRADEABLE',delayTime:0,priceLadder:[{bid:pair?'10.03389':'1.11848',ask:pair?'10.03639':'1.11857'}],currencyLadders:[{currency:pair?'SEK':'USD',bidSizes:[2],askSizes:[3]}]};
 const instrument={epic:route.slice(8),name:pair?'USD/SEK ':'EUR/USD Mini',type:'CURRENCIES',unit:'CONTRACTS',contractSize:pair?'100000':'10000',onePipMeans:pair?'0.0001 SEK/USD':'0.0001 USD/EUR',valueOfOnePip:pair?'10':'1',currencies:[{code:pair?'SEK':'USD',isDefault:false}],marginFactor:3.33,marginFactorUnit:'PERCENTAGE',marginDepositBands:[{margin:3.33},{margin:15}]};
 return {instrument,snapshot:version==='4'?q:{scalingFactor:10000,bid:pair?10.03389:1.11848,offer:pair?10.03639:1.11857,updateTime:'12:00:00',marketStatus:'TRADEABLE',delayTime:0},dealingRules:{minDealSize:{value:.04},minNormalStopOrLimitDistance:{unit:'POINTS',value:2}}};
};
const sekConnection=()=>({environments:{live:{...status().environments.live,account:{accountType:'CFD',accountId:'fixture-sek',currency:'SEK'}},demo:status().environments.demo}});
const sekWorkspace=createIgWorkspace({...deps,status:sekConnection as never,call:rawCurrencyCall as never,directory:path.join(directory,'currency'),positions:async()=>({status:'ready',positions:[{dealId:'fixture-position',epic:sekEp,currency:'USD',direction:'BUY',size:.1,level:1.1}]}) as never});
const sekDetail=await sekWorkspace.market('live',sekEp);assert.equal(sekDetail.calculationRules.executionCurrency,'USD');assert.equal(sekDetail.calculationRules.pointCurrency,'SEK');assert.equal(sekDetail.calculationRules.nativePointValue,10000);assert.equal(sekDetail.quote.bid,1.11848);
const sekView=await sekWorkspace.workspace('live'),profit=sekView.positions[0];assert.equal(profit.pnlCurrency,'SEK');assert.ok(Math.abs(profit.profitLoss-(1.11848-1.1)*.1*10000*10.03389)<1e-8,'Positiv P/L använder FX bid');
const metadataCount=currencyCalls.filter(c=>c.version==='3'&&c.route.startsWith('markets/')).length;
now+=16000;await sekWorkspace.market('live',sekEp);assert.equal(currencyCalls.filter(c=>c.version==='3'&&c.route.startsWith('markets/')).length,metadataCount,'V3 metadata återanvänds medan V4 quote hämtas');
fxStale=true;now+=16000;assert.equal((await sekWorkspace.market('live',sekEp)).calculationRules.verified,false,'Stale FX ger inga kontovalutebelopp');
fxStale=false;fxFail=true;now+=16000;assert.equal((await sekWorkspace.accountFx('live')),null,'V4-fel återanvänder inte gammal V3-kvot som färsk');
console.log('PASS: SEK-scenario/positions-P-L med native forex, konservativ FX-riktning, V3-metadatacache+färsk V4 och stale/missing FX blockerad');

// Katalogen får inte begränsas till EUR/Bitcoin eller blanda aktier med kryptokontrakt.
{
 let clock=now,id='catalog-account-a';const reads:string[]=[];
 const rows=[{epic:'FX.GBPUSD',instrumentName:'GBP/USD',instrumentType:'CURRENCIES'},{epic:'FX.AUDJPY',instrumentName:'AUD/JPY',instrumentType:'CURRENCIES'},{epic:'FX.USDNOK',instrumentName:'USD/NOK',instrumentType:'CURRENCIES'},{epic:'CR.ADA',instrumentName:'Cardano ($1)',instrumentType:'CURRENCIES'},{epic:'CR.TRON',instrumentName:'TRON ($1)',instrumentType:'CURRENCIES'},{epic:'SH.BTC',instrumentName:'Bitcoin ETF',instrumentType:'SHARES'}];
 const current=()=>({environments:{live:{...status().environments.live,connectionGeneration:id},demo:{...status().environments.live,environment:'demo',connectionGeneration:'demo-catalog'}}});
 const w=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-catalog-')),now:()=>clock,status:current as any,call:async(mode,route,method,version,body,extra)=>{if(route==='categories')throw Error('IG svarade HTTP 404');assert.equal(route,'markets');assert.equal(method,'GET');reads.push(new URLSearchParams(extra?.query).get('searchTerm')!);return {markets:[...rows,...rows]};}});
 const [a,b]=await Promise.all([w.catalogue('live','forex'),w.catalogue('live','forex')]);
 assert.equal(a.status,'partial');assert.equal(a.complete,false,'Sökresultat bevisar inte en fullständig mäklarkatalog');assert.ok(a.remainingSearches>0);assert.deepEqual(a.markets.map(m=>m.epic).sort(),['FX.AUDJPY','FX.GBPUSD','FX.USDNOK']);assert.deepEqual(a,b);assert.equal(reads.length,4);await w.searchMarkets('live','ReservedMarketRead');assert.equal(reads.length,5,'Katalogen lämnar kapacitet för pris-/FX-läsningar');assert.equal(new Set(reads).size,reads.length,'Parallella kataloganrop delar sökning');
 const c=await w.catalogue('live','crypto');assert.equal(c.status,'partial');assert.ok(c.remainingSearches>0,'Minutbudget ger återupptagbart delresultat');assert.equal(c.markets.length,2,'Forex lämnar separat läsutrymme åt krypto samma minut');
 clock+=61000;let d=await w.catalogue('live','crypto');while(d.remainingSearches){clock+=61000;d=await w.catalogue('live','crypto');}assert.equal(d.remainingSearches,0);assert.equal(d.status,'ready');assert.equal(d.markets.length,2);assert.ok(d.markets.every(m=>m.category==='crypto'));
 clock+=61000;let finished=await w.catalogue('live','forex');while(finished.remainingSearches){clock+=61000;finished=await w.catalogue('live','forex');}const count=reads.length;await w.catalogue('live','forex');assert.equal(reads.length,count,'Samma konto återanvänder kategoriresultatet');
 clock+=61000;id='catalog-account-b';await w.catalogue('live','forex');assert.ok(reads.length>count,'Nytt konto återanvänder inte tidigare katalog');
 assert.equal(igMarketCategory(rows[4]!),'crypto');assert.equal(igMarketCategory(rows[5]!),null);
 await assert.rejects(w.catalogue('live','stocks'),/Välj Forex/);
 let switched=false;
 const race=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-catalog-race-')),now:()=>clock,status:()=>({...current(),environments:{...current().environments,live:{...current().environments.live,connectionGeneration:switched?'new':'old'}}}) as any,call:async(_mode,route)=>{if(route==='categories')throw Error('IG svarade HTTP 404');switched=true;return {markets:rows};}});
 await assert.rejects(race.catalogue('live','forex'),/IG-kontosessionen ändrades/);
 console.log('PASS: bred Forex/kryptokatalog, Cardano/TRON, aktiefilter, deduplicering, singleflight, faktisk minutbudget med återupptagning och kontoisolering; bara mockade läsanrop');
}

// Verklig 5s UI-pollprofil ska lämna central läskapacitet till interaktion och riskkontroller.
{
 const {createIgConnection}=await import('../src/integrations/igConnection.js');
 const {createIgOrders}=await import('../src/integrations/igOrders.js');
 let pollNow=Date.UTC(2026,9,7,15,0),networkReads=0;const readsByRoute=new Map<string,number>();
 const fxEpic='CS.D.USDSEK.CFD.IP';
 const connection=createIgConnection({now:()=>pollNow,loadCredentials:()=>({demo:{apiKey:'fixture',identifier:'fixture',password:'fixture'}}),fetch:(async(url:string,options:RequestInit)=>{
  const route=url.split('/gateway/deal/')[1]!.split('?')[0]!;
  if(route==='session')return new Response(JSON.stringify({currentAccountId:'demo-cfd'}),{headers:{CST:'fixture-cst','X-SECURITY-TOKEN':'fixture-xst'}});
  networkReads++;readsByRoute.set(route,(readsByRoute.get(route)??0)+1);
  if(route==='accounts')return new Response(JSON.stringify({accounts:[{accountId:'demo-cfd',accountType:'CFD',currency:'SEK',balance:{balance:100000,available:100000,profitLoss:0}}]}));
  if(route==='positions')return new Response(JSON.stringify({positions:[]}));
  if(route==='workingorders')return new Response(JSON.stringify({workingOrders:[]}));
  if(route==='markets')return new Response(JSON.stringify({markets:[{epic:fxEpic,instrumentName:'USD/SEK',instrumentType:'CURRENCIES',marketStatus:'TRADEABLE'}]}));
  now=pollNow;
  const value=await call('demo',route,'GET',(options.headers as Record<string,string>).Version,undefined,{query:new URL(url).search.slice(1)});
  if(route===`markets/${fxEpic}`)value.instrument.name='USD/SEK';
  return new Response(JSON.stringify(value));
 }) as typeof fetch});
 await connection.testConnection('demo');
 const poll=createIgWorkspace({now:()=>pollNow,directory:path.join(directory,'poll-profile'),status:connection.getStatus,call:connection.callAuthenticated,accounts:connection.getAccounts,positions:connection.getPositions});
 const pending=createIgOrders({now:()=>pollNow,directory:path.join(directory,'poll-orders'),status:connection.getStatus,call:connection.callAuthenticated});
 await poll.setSelection('demo',{epics:[epic],timeframe:'5m',percent:1,horizonMinutes:15});
 const baseline=pollNow;
 for(let t=0;t<60000;t+=5000){pollNow=baseline+t;await Promise.all([poll.workspace('demo'),pending.brokerPending('demo'),poll.candles('demo',epic,'5m')]);}
 assert.equal(connection.getStatus().environments.demo.status,'connected');
 assert.ok(networkReads<=20,`Normal pollprofil ska lämna utrymme: ${networkReads} läsanrop`);
 assert.ok(connection.getReadBudget('demo').remaining>=4,'Diagram med USD/SEK-FX lämnar minst fyra läsanrop denna minut');
 assert.equal(readsByRoute.get('positions'),2);assert.equal(readsByRoute.get('workingorders'),2);assert.equal(readsByRoute.get('accounts'),3,'Initial verifiering plus två visningsläsningar');
 assert.ok(readsByRoute.has(`markets/${fxEpic}`),'Testet omfattar riktig FX-läsväg');
 assert.equal(poll.positionLimit('demo'),1,'Utan aktiv session är standardgränsen en position');
 assert.equal((await poll.startSession('demo',{epics:[epic],timeframe:'5m',percent:1,horizonMinutes:15,durationMinutes:15,intervalMinutes:5})).maxPositions,1,'Ny session börjar med en position');
 console.log(`PASS: 60s 5s UI-pollning med diagram, kontohistorik, arbetsorder och SEK-FX använder ${networkReads}/24 GET; standard en position`);
}

// Officiella kategorier pagineras utan detaljanrop per instrument; API-procent bevaras utan inferens.
{
 let categoryNow=now,readCount=0;const categoryRows=[{epic:'FX.EURGBP',instrumentName:'EUR/GBP',instrumentType:'CURRENCIES',percentageChange:-0.75,netChange:-0.006,high:0.88,low:0.86,updateTimeUTC:'12:00:00'},{epic:'CR.BTC',instrumentName:'Bitcoin ($1)',instrumentType:'CURRENCIES',percentageChange:2.5,netChange:1234,high:65000,low:62000},{epic:'CR.ADA',instrumentName:'Cardano ($1)',instrumentType:'CURRENCIES',percentageChange:'5',netChange:NaN}];
 const categoryWork=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-enabled-categories-')),now:()=>categoryNow,status:status as any,call:async(_mode,route,_method,_version,_body,extra)=>{
   readCount++;
   if(route==='categories')return {categories:[{code:'CURRENCIES'},{code:'SHARES'}]};
   if(route==='categories/CURRENCIES/instruments'){
     const page=Number(new URLSearchParams(extra?.query).get('pageNumber'));
     return {instruments:page===0?Array.from({length:1000},(_,i)=>categoryRows[i%categoryRows.length]):categoryRows,metadata:{pageNumber:page,pageSize:1000}};
   }
   if(route==='markets')return {markets:categoryRows};
   if(route.startsWith('markets/'))return {instrument:{epic:route.slice(8),marketId:'EURGBP',name:'EUR/GBP',type:'CURRENCIES',currencies:[]},snapshot:{},dealingRules:{}};
   if(route==='client-sentiment/EURGBP')return {marketId:'EURGBP',longPositionPercentage:65,shortPositionPercentage:35};
   throw Error('unexpected category route');
 }});
 const [forex,crypto]=await Promise.all([categoryWork.catalogue('live','forex'),categoryWork.catalogue('live','crypto')]);
 assert.equal(readCount,3,'En kategorihämtning plus två instrumentsidor delas av båda kategorierna');assert.equal(forex.complete,true);assert.equal(crypto.complete,true);assert.equal(forex.markets.length,1);assert.equal(crypto.markets.length,2);
 assert.equal(forex.markets[0].percentageChange,-0.75);assert.equal(forex.markets[0].netChange,-0.006);assert.equal(forex.markets[0].high,0.88);assert.equal(forex.markets[0].low,0.86);
 assert.equal(crypto.markets.find(m=>m.epic==='CR.ADA')!.percentageChange,null,'Sträng/NaN fabriceras inte som verifierade API-värden');assert.equal(crypto.markets.find(m=>m.epic==='CR.BTC')!.observedAt,null,'Lokal tid blir inte UTC');
 const overview=await categoryWork.marketOverview('live',['FX.EURGBP']);assert.equal(overview.selected[0].sentiment.longPositionPercentage,65);assert.equal(overview.selected[0].sentiment.shortPositionPercentage,35);assert.equal(readCount,6,'Sentiment hämtar endast uttryckligt valt instrument');await categoryWork.marketOverview('live',['FX.EURGBP']);assert.equal(readCount,6,'Valt sentiment och metadata cachelagras');
 const searched=await categoryWork.searchMarkets('live','EUR');assert.equal(searched.markets[0].percentageChange,-0.75);assert.equal(searched.markets[2].netChange,null);
 console.log('PASS: aktiverade IG-valutakategorier pagineras/delas utan bulkdetaljer; riktiga dagliga procent/high/low och valt kundsentiment utan vinstinferens');
}

// IG kan svara med tom kategori trots att kontosökning returnerar Forex.
{
 let clock=now;const reads:string[]=[];
 const w=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-empty-category-')),now:()=>clock,status:status as any,call:async(_mode,route)=>{
 reads.push(route);if(route==='categories')return {categories:[{code:'CURRENCIES'}]};if(route.startsWith('categories/'))return {instruments:[],metadata:{pageNumber:0,pageSize:150,totalPages:0}};
 if(route==='markets')return {markets:[{epic:'REAL.EUR',instrumentName:'EUR/USD',instrumentType:'CURRENCIES'},{epic:'STOCK.BTC',instrumentName:'Bitcoin Mining',instrumentType:'SHARES'}]};throw Error('Oväntad endpoint');
 }});
 let r=await w.catalogue('live','forex');assert.ok(r.markets.some(m=>m.epic==='REAL.EUR'));assert.ok(r.markets.every(m=>m.type==='CURRENCIES'));assert.equal(r.complete,false);assert.equal(r.source,'IG kontosökning');assert.ok(r.remainingSearches>0);
 for(let i=0;i<10&&r.remainingSearches;i++){clock+=61000;r=await w.catalogue('live','forex');}
 assert.equal(r.remainingSearches,0);assert.equal(reads.filter(r=>r==='categories').length,2,'Kategorin omprövas efter fem minuter medan den begränsade sökningen fortsätter');
}
// IG:s faktiskt rapporterade sidstorlek styr fortsättningen, även om 1000 begärdes.
{
 const pages:number[]=[];const w=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-page-size-')),now:()=>now,status:status as any,call:async(_mode,route,_method,_version,_body,extra)=>{
 if(route==='categories')return {categories:[{code:'CURRENCIES'}]};const page=Number(new URLSearchParams(extra?.query).get('pageNumber'));pages.push(page);return {instruments:page===0?[{epic:'SMALL.BTC',instrumentName:'Bitcoin',instrumentType:'CURRENCIES'},{epic:'SMALL.ETH',instrumentName:'Ethereum',instrumentType:'CURRENCIES'}]:[{epic:'SMALL.EUR',instrumentName:'EUR/USD',instrumentType:'CURRENCIES'}],metadata:{pageNumber:page,pageSize:2,totalPages:2}};
 }});const r=await w.catalogue('live','forex');assert.deepEqual(pages,[0,1]);assert.equal(r.markets[0]?.epic,'SMALL.EUR');assert.equal(r.complete,true);
}
// Okänd valuta på en färdig kategorisida ger sökreserv; kända rader bevaras.
{
 const w=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-unclassified-')),now:()=>now,status:status as any,call:async(_mode,route)=>route==='categories'?{categories:[{code:'CURRENCIES'}]}:route.startsWith('categories/')?{instruments:[{epic:'KNOWN.EUR',instrumentName:'EUR/USD',instrumentType:'CURRENCIES'},{epic:'UNCLASSIFIED',instrumentName:'Okänd valuta',instrumentType:'CURRENCIES'}],metadata:{pageNumber:0,pageSize:150}}:{markets:[{epic:'FOUND.GBP',instrumentName:'GBP/USD',instrumentType:'CURRENCIES'}]}});
 const r=await w.catalogue('live','forex');assert.equal(r.complete,false);assert.ok(r.markets.some(m=>m.epic==='KNOWN.EUR'));assert.ok(r.markets.some(m=>m.epic==='FOUND.GBP'));assert.equal(r.unclassifiedInstruments,1);
}
console.log('PASS: tom IG-kategori använder progressiv sökreserv, aktier utesluts, faktisk sidstorlek pagineras och klassificeringsbortfall döljs inte');

{
 let categoryReads=0;const w=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-page-mismatch-')),now:()=>now,status:status as any,call:async(_mode,route)=>{if(route==='categories')return {categories:[{code:'CURRENCIES'}]};if(route.startsWith('categories/')){categoryReads++;return {instruments:[],metadata:{pageNumber:99,pageSize:150}};}return {markets:[{epic:'SAFE.EUR',instrumentName:'EUR/USD',instrumentType:'CURRENCIES'}]};}});
 const r=await w.catalogue('live','forex');assert.equal(r.source,'IG kontosökning');assert.ok(r.markets.some(m=>m.epic==='SAFE.EUR'));await w.catalogue('live','crypto');assert.equal(categoryReads,1,'Felaktig sidmetadata ger ingen upprepad kategoriloop');
}

// Diagram- och kontoläsningar får inte permanent svälta katalogen.
{
 let clock=now;const calls:{mode:string;route:string}[]=[];
 const both=()=>({environments:{live:{...status().environments.live,connectionGeneration:'fair-live'},demo:{...status().environments.live,environment:'demo',connectionGeneration:'fair-demo'}}});
 const w=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-catalog-contention-')),now:()=>clock,status:both as any,call:async(mode,route)=>{calls.push({mode,route});if(route==='categories')return {categories:[{code:'CURRENCIES'}]};if(route.startsWith('categories/'))return {instruments:[{epic:'FX.EUR',instrumentName:'EUR/USD',instrumentType:'CURRENCIES'},{epic:'CR.BTC',instrumentName:'Bitcoin',instrumentType:'CURRENCIES'}],metadata:{pageNumber:0,pageSize:150}};return {markets:[]};}});
 for(const mode of ['live','demo'] as const){for(let i=0;i<10;i++)await w.searchMarkets(mode,`ordinary-${i}`);const r=await w.catalogue(mode,'forex');assert.equal(r.markets.length,1,'Tio övriga läsningar blockerar inte katalogen');assert.equal(r.complete,true);const c=await w.catalogue(mode,'crypto');assert.equal(c.markets[0].epic,'CR.BTC');}
 assert.equal(calls.filter(c=>c.route==='categories').length,2);assert.ok(calls.length<=36,'Appreserven bevaras');
 // Upprepade nätfel får synlig diagnos och sökreserv, med återförsök av kategorin.
 let attempts=0;const failing=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-catalog-errors-')),now:()=>clock,status:both as any,call:async(_mode,route)=>{if(route==='categories'){attempts++;throw Error('IG-anropet kunde inte verifieras; utfallet kan vara okänt');}return {markets:[{epic:'FX.RECOVERED',instrumentName:'EUR/USD',instrumentType:'CURRENCIES'}]};}});
 const first=await failing.catalogue('demo','forex');assert.equal(first.progress?.reason,'endpoint_error');assert.match(first.error!,/IG-kategorin/);await failing.catalogue('demo','crypto');assert.equal(attempts,1,'Ingen retryloop under cooldown');
 clock+=61000;const second=await failing.catalogue('demo','forex');assert.equal(attempts,2);assert.equal(second.markets[0].epic,'FX.RECOVERED');assert.equal(second.complete,false,'Sökreserven utger sig aldrig för fullständig');assert.equal(second.progress?.category?.failures,2);
 clock+=61000;await failing.catalogue('demo','forex');assert.equal(attempts,3,'Kategorivägen återförsöks även med fungerande sökreserv');
 console.log('PASS: konkurrerande läsanrop, båda miljöer, global reserv, synliga kategorifel, begränsad retry och sökreserv');
}

// En trasig generisk sökterm får inte gömma fungerande Bitcoin/Ether-sökningar.
{
 let clock=now,failed=true,cryptoAttempts=0;const terms:string[]=[];
 const w=createIgWorkspace({directory:mkdtempSync(path.join(os.tmpdir(),'ig-term-retry-')),now:()=>clock,status:status as any,call:async(_mode,route,_method,_version,_body,extra)=>{
  if(route==='categories')throw Error('IG svarade HTTP 404');
  const term=new URLSearchParams(extra?.query).get('searchTerm')!;terms.push(term);
  if(term==='Crypto'){cryptoAttempts++;if(failed)throw Error('IG svarade HTTP 500');}
  return {markets:term==='Bitcoin'?[{epic:'RETRY.BTC',instrumentName:'Bitcoin',instrumentType:'CURRENCIES'}]:term==='Ether'?[{epic:'SH.ETH',instrumentName:'Ether ETF',instrumentType:'SHARES'}]:[]};
 }});
 let r=await w.catalogue('live','crypto');assert.equal(r.progress?.search?.reason,'search_error');assert.equal(cryptoAttempts,1);await w.catalogue('live','crypto');assert.equal(cryptoAttempts,1,'Cooldown även för första söktermen');
 clock+=61000;r=await w.catalogue('live','crypto');assert.equal(cryptoAttempts,2);assert.ok(r.markets.some(m=>m.epic==='RETRY.BTC'));assert.ok(!r.markets.some(m=>m.epic==='SH.ETH'));assert.ok(r.progress?.search?.failedTerms.includes('Crypto'));assert.match(r.categoryError!,/sökningar misslyckades/);assert.equal(r.complete,false);
 failed=false;for(let i=0;i<10&&r.remainingSearches;i++){clock+=61000;r=await w.catalogue('live','crypto');}
 assert.equal(r.remainingSearches,0);assert.ok(cryptoAttempts>=3);assert.deepEqual(r.progress?.search?.failedTerms,[],'Missad term återhämtas från retrykön');assert.equal(r.complete,false);
 console.log('PASS: felande första sökterm, cooldown, senare kryptoinstrument, aktiefilter och återhämtad retrykö');
}

// Hela sessionsurvalet roteras i begränsade omgångar; misslyckade försök är inte analyser.
{
 let clock=now,allow=false;const scopes:string[][]=[];
 const epics=Array.from({length:12},(_,i)=>`BATCH.${i}`);
 const w=createIgWorkspace({...deps,directory:path.join(directory,'batches'),now:()=>clock,status:()=>({environments:{live:{...status().environments.live,account:{currency:'USD'},connectionGeneration:'batch-live'},demo:{status:'missing'}}}) as any,
  guard:async()=>({allowed:allow,killSwitchActive:false}),call:async(mode,route,method,version,body,extra)=>{
   assert.equal(method,'GET');if(route.startsWith('prices/')){const last=Math.floor(clock/300000)*300000;return {prices:Array.from({length:50},(_,i)=>bar(last-(50-i)*300000)),metadata:{allowance:{remainingAllowance:9999}}};}
   const saved=now;now=clock;try{return await call(mode,route,method,version,body,extra);}finally{now=saved;}
  },llm:async(role,context)=>{if(role==='technical')scopes.push(context.selection.epics);return {analyses:context.selection.epics.map((epic:string)=>({epic,action:'HOLD',reason:'Fixture'}))};}});
 await w.startSession('live',{epics,timeframe:'5m',percent:1,horizonMinutes:15,durationMinutes:15,intervalMinutes:1});
 await w.tickSessions();let v=await w.workspace('live');assert.equal(v.session.cursor,5);assert.equal(v.session.analyses,0);assert.equal(v.session.cycles,0);assert.ok(v.session.batchReports[0].error);
 allow=true;for(let i=0;i<5;i++){clock+=61000;await w.tickSessions();}
 v=await w.workspace('live');assert.equal(v.session.cycles,1);assert.equal(v.session.attemptedCycles,2);assert.equal(v.session.analyses,5);assert.ok(scopes.every(s=>s.length<=5));assert.deepEqual(new Set(scopes.flat()),new Set(epics));assert.ok(v.selection.epics.length<=10,'Manuellt urval behåller sin gräns');
 assert.ok(v.session.batchReports.some((r:any)=>r.error));w.stopSession('live');const count=scopes.length;clock+=61000;await w.tickSessions();assert.equal(scopes.length,count,'Stopp hindrar nästa omgång');
 console.log('PASS: tolv sessionsinstrument roteras i femmor, budgetavslag märks som misslyckat försök, bara hela lyckade varv räknas och stopp hindrar nästa batch');
}

{
 const policyWorkspace=createIgWorkspace({...deps,directory:path.join(directory,'policy-default')});
 const p=await policyWorkspace.startSession('live',{epics:[epic],timeframe:'5m',percent:1,marginPercent:2,maxTrades:5,durationMinutes:60,intervalMinutes:5});
 assert.equal(p.horizonMinutes,5,'Utelämnad horisont får inte ärva legacy 15 minuter för marginalsession');assert.equal(policyWorkspace.sessionPolicy('live')?.marginPercent,2);
 policyWorkspace.stopSession('live');assert.equal(policyWorkspace.sessionPolicy('live'),null);
 await assert.rejects(policyWorkspace.startSession('live',{...p,horizonMinutes:15,durationMinutes:60}),/1–5/);
 console.log('PASS: marginalsession har fem minuters standardhorisont och stopp tar bort aktiv orderpolicy');
}
