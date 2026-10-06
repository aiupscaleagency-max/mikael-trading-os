import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import os from "node:os";
const directory=mkdtempSync(path.join(os.tmpdir(),"ig-workspace-"));process.chdir(directory);
const {createIgWorkspace,normalizeIgCandles}=await import("../src/integrations/igWorkspace.js");
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
  if(route.startsWith("markets/"))return {instrument:{epic:route.slice(8),name:"EUR/USD",type:"CURRENCIES",expiry:"-",unit:"CONTRACTS",contractSize:"100000",valueOfOnePip:"1.25",onePipMeans:"0.0001",marginFactor:3.33,marginFactorUnit:"PERCENTAGE",currencies:[{code:"USD",isDefault:true}],marginDepositBands:[{min:0,max:100,margin:3.33}]},snapshot:{bid:100,offer:100.1,marketStatus:"TRADEABLE",delayTime:0,updateTimeUTC:"12:00:00",scalingFactor:10000,decimalPlacesFactor:1},dealingRules:{minDealSize:{unit:"POINTS",value:0.5},minNormalStopOrLimitDistance:{unit:"POINTS",value:5}}};
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
const view=await w.workspace("live");assert.equal(view.positions[0].bid,null);assert.equal(view.history.transactions[1].cashTransaction,true);assert.equal(view.pendingOrders[0].quantity,null);assert.equal(view.pendingOrders[0].status,"manual_review_blocked");assert.equal(view.transport,"REST polling");
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
