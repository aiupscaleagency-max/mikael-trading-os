import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,mkdirSync,readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createIgConnection,getIgStatus,withIgPriority} from "../src/integrations/igConnection.js";
const directory=mkdtempSync(path.join(os.tmpdir(),"ig-readonly-"));
const credentialPath=path.join(directory,"credentials.json");process.env.IG_CREDENTIALS_FILE=credentialPath;
writeFileSync(credentialPath,JSON.stringify({demo:{apiKey:"fixture-demo-key"},live:{apiKey:"fixture-live-key"}}),{mode:0o600});
assert.equal(getIgStatus().environments.demo.configured,true);assert.equal(getIgStatus().environments.demo.credentialsComplete,false);
chmodSync(credentialPath,0o644);assert.equal(getIgStatus().environments.demo.configured,false);chmodSync(credentialPath,0o600);
const link=path.join(directory,"symlink.json");symlinkSync(credentialPath,link);process.env.IG_CREDENTIALS_FILE=link;
assert.equal(getIgStatus().environments.demo.status,"missing");process.env.IG_CREDENTIALS_FILE=credentialPath;
let readable=true;
let calls=0, clock=1000;
let credentials={demo:{apiKey:"fixture-demo-key",identifier:"fixture-demo-id",password:"fixture-demo-password"},live:{apiKey:"fixture-live-key",identifier:"fixture-live-id",password:"fixture-live-password"}};
const mock=(async(url:string,options:RequestInit)=>{
  calls++;const environment=url.includes("demo-api")?"demo":"live";
  const headers=options.headers as Record<string,string>;
  assert.equal(headers["X-IG-API-KEY"],credentials[environment].apiKey);
  if(url.endsWith("/session")) {
    assert.equal(options.method,"POST");assert.equal(headers.Version,"2");
    const body=JSON.parse(options.body as string);assert.equal(body.identifier,credentials[environment].identifier);assert.equal(body.password,credentials[environment].password);
    await Promise.resolve();
    return new Response(JSON.stringify({currentAccountId:`full-${environment}-account`}),{status:200,headers:{CST:`secret-${environment}-cst`,"X-SECURITY-TOKEN":`secret-${environment}-xst`}});
  }
  assert.equal(options.method,"GET");assert.equal(headers.CST,`secret-${environment}-cst`);assert.equal(headers["X-SECURITY-TOKEN"],`secret-${environment}-xst`);
  if(url.endsWith("/accounts"))return new Response(JSON.stringify({accounts:[{accountId:`full-${environment}-account`,accountType:"CFD",currency:"SEK",balance:{balance:environment==="demo"?100000:250,available:null,profitLoss:0}}]}));
  assert.ok(url.endsWith("/positions"));return new Response(JSON.stringify({positions:[{position:{size:2,level:100},market:{epic:"IX.D.TEST",bid:null}}]}));
}) as typeof fetch;
const connection=createIgConnection({loadCredentials:()=>{if(!readable)throw Error("private file unavailable");return credentials;},fetch:mock,now:()=>clock});
const [demo1,demo2]=await Promise.all([connection.testConnection("demo"),connection.testConnection("demo")]);
assert.deepEqual(demo1,demo2);assert.equal(calls,2,"Demo login och accounts körs bara en gång vid samtidiga starter");
assert.equal(demo1.status,"connected");assert.equal(demo1.account?.balance,100000);assert.equal(demo1.account?.available,null);assert.equal(demo1.account?.deposit,null);assert.equal(demo1.account?.profitLoss,0);
assert.equal(connection.getStatus().environments.live.status,"configured");
const live=await connection.testConnection("live");assert.equal(live.account?.balance,250);assert.equal(connection.getStatus().environments.demo.account?.balance,100000);
const positions=await connection.getPositions("demo");assert.equal(positions.positions?.[0]?.bid,null);assert.equal(positions.positions?.[0]?.size,2);
assert.equal((await connection.getAccounts("live")).accounts?.[0]?.available,null);
const serialized=JSON.stringify({demo1,live,positions,status:connection.getStatus()});
for(const secret of ["fixture-demo-key","fixture-live-key","fixture-demo-id","fixture-demo-password","secret-demo-cst","secret-live-xst","full-demo-account"])assert.ok(!serialized.includes(secret),"Publik retur får inte innehålla credentials, tokens eller fullständiga konto-ID");
readable=false;assert.equal(connection.getStatus().environments.demo.status,"missing");
readable=true;assert.equal(connection.getStatus().environments.demo.status,"configured","Återställd credentialsfil är inte en återställd kontosession");
assert.equal(connection.getStatus().environments.demo.account,null);
await connection.testConnection("demo");
clock+=3_600_001;assert.equal(connection.getStatus().environments.demo.status,"configured");assert.equal((await connection.getAccounts("demo")).accounts,null);
const denied=createIgConnection({loadCredentials:()=>credentials,fetch:(async()=>new Response("fixture-demo-password",{status:401})) as typeof fetch});
assert.equal((await denied.testConnection("demo")).error,"IG nekade inloggning eller API-behörighet");assert.equal(denied.getStatus().environments.live.status,"configured");
const network=createIgConnection({loadCredentials:()=>credentials,fetch:(async()=>{throw Error("url key=fixture-demo-key secret-demo-cst");}) as typeof fetch});
assert.ok(!JSON.stringify(await network.testConnection("demo")).includes("fixture-demo-key"));
const incomplete=createIgConnection({loadCredentials:()=>({demo:{apiKey:"only-key"}}),fetch:(async()=>{throw Error("must not fetch");}) as typeof fetch});
assert.equal((await incomplete.testConnection("demo")).status,"missing");
await assert.rejects(connection.testConnection("other" as never),/Ogiltig/);
const source=readFileSync(new URL("../src/integrations/igConnection.ts",import.meta.url),"utf8");assert.ok(source.includes('write && !igOrderExecutionEnabled(mode)'));assert.ok(source.includes('"IG_ORDER_EXECUTION_ENABLED_LIVE":"IG_ORDER_EXECUTION_ENABLED_DEMO"'),'Per-miljö-flaggor (port: ersätter globala IG_ORDER_EXECUTION_ENABLED)');
const savedOrderFlag=process.env.IG_ORDER_EXECUTION_ENABLED;delete process.env.IG_ORDER_EXECUTION_ENABLED;
await assert.rejects(connection.callAuthenticated("demo","positions/otc","POST","2",{epic:"TEST",size:1}),/avstängd/);
await assert.rejects(connection.callAuthenticated("demo","https://fake/orders","GET","1"),/tillåtna/);
if(savedOrderFlag!==undefined)process.env.IG_ORDER_EXECUTION_ENABLED=savedOrderFlag;
console.log("PASS: IG demo/live isolation, session singleflight, Token memory-only, read-only accounts/positions, null missing metrics, permissions/symlink, expiry, missing credentials and sanitized errors; no real IG requests/orders");

// IG:s kända läskvoter är övergående och får inte radera en verifierad kontosession.
let limitedRoute='',limitedStatus=403,limitedCode:string|undefined='error.public-api.exceeded-account-allowance';let quotaLogins=0,quotaClock=1000,quotaRequests=0;
const quota=createIgConnection({loadCredentials:()=>credentials,now:()=>quotaClock,fetch:(async(url:string,options:RequestInit)=>{
 quotaRequests++;if(url.endsWith('/session'))quotaLogins++;
 if(limitedRoute&&url.endsWith('/'+limitedRoute))return new Response(limitedCode?JSON.stringify({errorCode:limitedCode}):'not-json',{status:limitedStatus});
 return mock(url,options);
}) as typeof fetch});
await quota.testConnection('demo');const quotaGeneration=quota.getStatus().environments.demo.connectionGeneration;
limitedRoute='accounts';const rateAccounts=await quota.getAccounts('demo');assert.equal(rateAccounts.status,'error');assert.equal(rateAccounts.accounts,null);assert.equal(rateAccounts.updatedAt,null);assert.match(rateAccounts.error!,/begränsade antal läsanrop/);assert.equal(quota.getStatus().environments.demo.status,'connected');assert.equal(quota.getStatus().environments.demo.connectionGeneration,quotaGeneration);
const requestsAfterQuota=quotaRequests;await assert.rejects(quota.callAuthenticated('demo','workingorders'),/begränsade antal läsanrop/);assert.equal(quotaRequests,requestsAfterQuota,'Känd IG-kvot ger 60 sekunders cooldown innan nästa nätverksanrop');
quotaClock+=61000;limitedRoute='positions';limitedStatus=429;limitedCode=undefined;const ratePositions=await quota.getPositions('demo');assert.equal(ratePositions.status,'error');assert.equal(ratePositions.positions,null);assert.match(ratePositions.error!,/begränsade antal läsanrop/);assert.equal(quota.getStatus().environments.demo.status,'connected');
quotaClock+=61000;limitedRoute='markets';limitedStatus=403;limitedCode='error.public-api.exceeded-api-key-allowance';await assert.rejects(quota.callAuthenticated('demo','markets','GET','1'),/begränsade antal läsanrop/);assert.equal(quota.getStatus().environments.demo.connectionGeneration,quotaGeneration);
quotaClock+=61000;limitedStatus=429;limitedCode=undefined;await assert.rejects(quota.callAuthenticated('demo','markets','GET','1'),/begränsade antal läsanrop/);
quotaClock+=61000;limitedRoute='';assert.equal((await quota.getAccounts('demo')).status,'ready');assert.equal(quotaLogins,1,'Kvoten återställs utan ny inloggning');
limitedRoute='positions';limitedStatus=401;limitedCode='error.security.client-token-invalid';assert.equal((await quota.getPositions('demo')).status,'error');assert.equal(quota.getStatus().environments.demo.status,'error','Verkligt autentiseringsfel raderar fortfarande sessionen');
console.log('PASS: 403 IG allowance och 429 bevarar session/generation, returnerar saknat färskt konto/positionsunderlag och återhämtar sig utan ny login; 401 spärrar fortsatt');

// Central budget får inte kringgås via arbetsorder, konto eller direkta positionsläsningar.
let budgetClock=1000,budgetRequests=0,budgetLogins=0;
const budgetConnection=createIgConnection({loadCredentials:()=>credentials,now:()=>budgetClock,fetch:(async(url:string,options:RequestInit)=>{
 budgetRequests++;if(url.endsWith('/session'))budgetLogins++;
 if(url.endsWith('/workingorders')||url.endsWith('/markets'))return new Response('{}');
 return mock(url,options);
}) as typeof fetch});
await budgetConnection.testConnection('demo');const initialBudgetGeneration=budgetConnection.getStatus().environments.demo.connectionGeneration;
await budgetConnection.testConnection('demo');assert.equal(budgetLogins,1,'Återanslutningsknappen återanvänder en giltig verifierad session');
assert.equal(budgetConnection.getStatus().environments.demo.connectionGeneration,initialBudgetGeneration);
await budgetConnection.getAccounts('demo');await budgetConnection.getPositions('demo');
// Bakgrundsläsningar lämnar reserven (12 = en orders värsta fall, granskning 2) åt order/stängningar.
for(let i=0;i<9;i++)await budgetConnection.callAuthenticated('demo','workingorders');
assert.equal(budgetConnection.getReadBudget('demo').used,12);
await assert.rejects(budgetConnection.callAuthenticated('demo','markets'),/begränsade antal läsanrop/,'Bakgrund stoppas vid reserven');
await withIgPriority(async()=>{for(let i=0;i<12;i++)await budgetConnection.callAuthenticated('demo','workingorders');});
assert.equal(budgetConnection.getReadBudget('demo').used,24);
const requestsAtLimit=budgetRequests;
await assert.rejects(budgetConnection.callAuthenticated('demo','markets'),/begränsade antal läsanrop/);
assert.equal((await budgetConnection.getAccounts('demo')).status,'error');assert.equal((await budgetConnection.getPositions('demo')).status,'error');
assert.equal(budgetRequests,requestsAtLimit,'Samtliga GET-vägar stoppas lokalt innan IG-anrop');
assert.equal(budgetConnection.getStatus().environments.demo.status,'connected','Lokal budget kastar inte verifierad session');
await budgetConnection.testConnection('live');assert.equal(budgetConnection.getReadBudget('live').used,1,'Demo och Live har separata kontobudgetar');
await withIgPriority(async()=>{for(let i=0;i<23;i++)await budgetConnection.callAuthenticated('live','workingorders');});assert.equal(budgetConnection.getReadBudget('live').appUsed,48);await assert.rejects(withIgPriority(()=>budgetConnection.callAuthenticated('live','markets')),/begränsade antal läsanrop/,'Även prioritet stoppas när hela budgeten är slut');
budgetClock+=60001;assert.equal((await budgetConnection.getAccounts('demo')).status,'ready');assert.equal(budgetLogins,2,'Återhämtning behöver inte ny Demo-login');
assert.equal(budgetConnection.getStatus().environments.demo.connectionGeneration,initialBudgetGeneration);
const initialLimited=createIgConnection({loadCredentials:()=>credentials,fetch:(async(url:string,options:RequestInit)=>url.endsWith('/accounts')?new Response(JSON.stringify({errorCode:'error.public-api.exceeded-account-allowance'}),{status:403}):mock(url,options)) as typeof fetch});
assert.equal((await initialLimited.testConnection('demo')).status,'error');assert.equal(initialLimited.getStatus().environments.demo.account,null,'Ny login utan verifierat kontounderlag är aldrig connected');
console.log('PASS: central rullande 24/min-kontobudget över alla GET-vägar, separata miljöer, session reuse, quota-resume och initial konto-verifiering');

// Nya katalog-/sentimentvägar är endast GET och delar befintlig centralbudget.
let optionalCalls=0;
const optional=createIgConnection({loadCredentials:()=>credentials,fetch:(async(url:string,options:RequestInit)=>{
 if(url.includes('/categories')||url.includes('/client-sentiment/')){optionalCalls++;assert.equal(options.method,'GET');return new Response(JSON.stringify({errorCode:'endpoint.unavailable.for.api-key'}),{status:403});}
 return mock(url,options);
}) as typeof fetch});
await optional.testConnection('demo');const optionalGeneration=optional.getStatus().environments.demo.connectionGeneration;
await assert.rejects(optional.callAuthenticated('demo','categories'),/HTTP 403/);
await assert.rejects(optional.callAuthenticated('demo','categories/CURRENCIES/instruments','GET','1',undefined,{query:'pageNumber=0&pageSize=1000'}),/HTTP 403/);
await assert.rejects(optional.callAuthenticated('demo','client-sentiment/EURUSD'),/HTTP 403/);
assert.equal(optional.getStatus().environments.demo.status,'connected');assert.equal(optional.getStatus().environments.demo.connectionGeneration,optionalGeneration);assert.equal(optional.getReadBudget('demo').used,4);
await assert.rejects(optional.callAuthenticated('demo','categories','POST'),/tillåtna/);
await assert.rejects(optional.callAuthenticated('demo','categories/..%2F/instruments'),/tillåtna/);
await assert.rejects(optional.callAuthenticated('demo','categories/CURRENCIES/instruments','GET','1',undefined,{query:'referenceEpic=unsafe'}),/frågeparametrar/);
assert.equal(optionalCalls,3);
console.log('PASS: kategorier/sentiment endast tillåtna GET med centralquota; saknad endpointbehörighet behåller annan verifierad kontofunktion');

// Historikkvoten är fristående: stängda ljus kan saknas utan att katalogen slutar fungera.
{
 let clock=1000,exhausted=true,priceCalls=0;
 const history=createIgConnection({loadCredentials:()=>credentials,now:()=>clock,fetch:(async(url:string,options:RequestInit)=>{
  if(url.includes('/prices/')){priceCalls++;if(exhausted)return new Response(JSON.stringify({errorCode:'error.public-api.exceeded-account-historical-data-allowance'}),{status:403});return new Response(JSON.stringify({prices:[]}),{status:200});}
  if(url.endsWith('/markets'))return new Response(JSON.stringify({markets:[]}),{status:200});
  return mock(url,options);
 }) as typeof fetch});
 await history.testConnection('demo');await history.testConnection('live');const generation=history.getStatus().environments.demo.connectionGeneration;
 await assert.rejects(history.callAuthenticated('demo','prices/EURUSD','GET','3'),/veckokvot för historiska priser/);
 assert.ok(history.getReadBudget('demo').remaining>0,'Historikfelet blockerar inte vanlig läsbudget');
 assert.deepEqual((await history.callAuthenticated('demo','markets')).markets,[]);
 assert.equal((await history.getAccounts('demo')).status,'ready');assert.equal((await history.getPositions('demo')).status,'ready');
 await assert.rejects(history.callAuthenticated('demo','prices/GBPUSD','GET','3'),/veckokvot för historiska priser/);assert.equal(priceCalls,1,'Cooldown gäller alla historikserier i samma miljö utan nya nätverksanrop');
 exhausted=false;await history.callAuthenticated('live','prices/EURUSD','GET','3');assert.equal(priceCalls,2,'Live har en separat historikkvot');
 clock+=61000;await assert.rejects(history.callAuthenticated('demo','prices/EURUSD','GET','3'),/veckokvot/);assert.equal(priceCalls,2,'veckokvoten: ingen ny IG-fråga efter en minut');assert.equal(history.getStatus().environments.demo.connectionGeneration,generation,'Historikfel byter inte kontosession');clock+=60*60*1000;await history.testConnection('demo');await history.callAuthenticated('demo','prices/EURUSD','GET','3');assert.equal(priceCalls,3,'nytt försök efter en timme');
 console.log('PASS: historikkvot stoppar endast nya historikförsök, marknadskatalog/konto/positioner fungerar och Demo/Live är separata');
}
