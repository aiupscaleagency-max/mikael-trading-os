import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
const dir=mkdtempSync(path.join(os.tmpdir(),"tiingo-test-"));process.chdir(dir);
process.env.PTQ_ACADEMY_HOME=path.join(dir,"no-key");process.env.PTQA_COURSE_HOME=path.join(dir,"course");
// Testet blockerar även standardhemmets riktiga nyckelfil utan att läsa eller skriva den.
const originalHome=os.homedir;os.homedir=()=>dir;
delete process.env.TIINGO_API_KEY;
const {getHistoricalContext,getTiingoStatus,summarizeHistory}=await import("../src/data/tiingoHistory.js");
let calls=0;const originalFetch=globalThis.fetch;
try {
  globalThis.fetch=(async()=>{calls++;throw Error("should not fetch");}) as typeof fetch;
  assert.equal(getTiingoStatus().configured,false);
  assert.equal((await getHistoricalContext("BTCUSDC")).status,"unavailable");assert.equal(calls,0);
  mkdirSync(process.env.PTQA_COURSE_HOME,{recursive:true});writeFileSync(path.join(process.env.PTQA_COURSE_HOME,"keys.json"),JSON.stringify({tiingo:"fixture-token"}));
  assert.equal(getTiingoStatus().configured,true,"Befintlig kursfil stöds utan migrering");
  const now=Date.now(),today=Math.floor(now/86400000)*86400000;
  const bar=(time:number,close:number)=>({date:new Date(time).toISOString(),open:close,high:close+1,low:close-1,close,volume:10});
  const bars=[bar(today-3*86400000,100),bar(today-2*86400000,120),bar(today-86400000,90),bar(today,999)];
  globalThis.fetch=(async(url:URL,options:RequestInit)=>{
    calls++;assert.equal(url.hostname,"api.tiingo.com");assert.equal(url.searchParams.get("tickers"),"btcusd");
    assert.equal(url.searchParams.get("resampleFreq"),"1day");assert.equal(url.searchParams.has("token"),false);
    assert.equal((options.headers as Record<string,string>).Authorization,"Token fixture-token");
    return {ok:true,json:async()=>[{ticker:"btcusd",baseCurrency:"btc",quoteCurrency:"usd",priceData:bars}]};
  }) as typeof fetch;
  const [a,b]=await Promise.all([getHistoricalContext("BTCUSDC"),getHistoricalContext("BTCUSDC")]);
  assert.equal(calls,1,"Samtidiga identiska requests samordnas");assert.deepEqual(a,b);
  assert.equal(a.count,3);assert.equal(a.to,new Date(today-86400000).toISOString().slice(0,10));
  assert.equal(a.status,"partial");assert.ok(a.missingDays>1000);assert.ok(Math.abs(a.returnPct!+10)<1e-9);assert.equal(a.maxDrawdownPct,-25);
  assert.equal((await getHistoricalContext("BTCUSDC")).cached,true);assert.equal(calls,1);
  const cache=JSON.parse(readFileSync("data/tiingo-history/btcusd.json","utf8"));assert.equal(cache.ticker,"btcusd");
  const q=summarizeHistory("BTCUSDC",[...bars,bar(today-86400000,90),{...bar(today-4*86400000,50),high:10},bar(today-6*86400000+1000,60)],now,now);
  assert.equal(q.rejectedBars,3);assert.equal(q.count,3);
  const start=Date.parse(`${a.requestedFrom}T00:00:00Z`),end=Date.parse(`${a.requestedTo}T00:00:00Z`);
  const complete=Array.from({length:Math.round((end-start)/86400000)+1},(_,i)=>bar(start+i*86400000,100+i));
  const full=summarizeHistory("BTCUSDC",complete,now,now);
  assert.equal(full.status,"ready");assert.equal(full.missingDays,0);assert.equal(full.maxDrawdownPct,0);
  assert.equal(full.from,a.requestedFrom);assert.equal(full.to,a.requestedTo);
  assert.equal((await getHistoricalContext("EURUSD")).status,"unavailable");assert.equal(calls,1);
  globalThis.fetch=(async()=>({ok:false,status:401})) as typeof fetch;
  const denied=await getHistoricalContext("ETHUSDC");assert.equal(denied.error,"Tiingo nekade behörighet");
  globalThis.fetch=(async()=>{throw Error("secret fixture-token URL ?token=fixture-token");}) as typeof fetch;
  assert.ok(!(await getHistoricalContext("SOLUSDC")).error!.includes("fixture-token"));
  globalThis.fetch=(async()=>({ok:false,status:429})) as typeof fetch;
  assert.equal((await getHistoricalContext("XRPUSDC")).error,"Tiingo begränsade antal anrop");
  globalThis.fetch=(async()=>{throw Error("must not retry");}) as typeof fetch;
  assert.match((await getHistoricalContext("ADAUSDC")).error!,/pausas/);
  assert.ok(!JSON.stringify(getTiingoStatus()).includes("fixture-token"));
} finally {globalThis.fetch=originalFetch;os.homedir=originalHome;}
console.log("PASS: Tiingo course-key fallback, unavailable, Token header, daily USD reference, closed UTC bars, gaps, invalid/duplicate bars, cache, concurrent fetch, 401/429/network sanitization; no production requests/orders");

const specialistSource=readFileSync(new URL("../src/orchestrator/specialists.ts",import.meta.url),"utf8");
assert.ok(specialistSource.includes('...parsed, historicalReference, rawText: text'),"Verifierad adapterhistorik ska överstyra modellens eventuella egna historikfält");
const headSource=readFileSync(new URL("../src/orchestrator/headTrader.ts",import.meta.url),"utf8");
assert.ok(headSource.includes('JSON.stringify(technical.historicalReference ?? [])'),"Hanna ska få historik direkt och deterministiskt");
assert.ok(headSource.includes('inte Bybits USDC-orderpris, backtest eller modellträning'));
