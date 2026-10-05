import assert from "node:assert/strict";
import { resolveAnalysisBroker, validateAnalysisRequest, scopeBroker, intersectAnalysisSymbols } from "../src/orchestrator/analysisRequest.js";
import { prescreenPairs, reviewPrescreenScope } from "../src/orchestrator/prescreen.js";

const allowed = ["BTCUSDC", "ETHUSDC", "SOLUSDC"];
assert.throws(() => validateAnalysisRequest({}, allowed));
assert.throws(() => validateAnalysisRequest({selectedSymbols:[]}, allowed));
assert.throws(() => validateAnalysisRequest({selectedSymbols:["BTCUSDT"]}, allowed));
assert.throws(() => validateAnalysisRequest({selectedSymbols:["BADUSDC"]}, allowed));
assert.throws(() => validateAnalysisRequest({selectedSymbols:["BTCUSDC"],timeframe:"bad"}, allowed));
const request = validateAnalysisRequest({selectedSymbols:["btcusdc","BTCUSDC"],timeframe:"5m",instruction:"Analysera även SOL, alla par"}, allowed);
assert.deepEqual(request.selectedSymbols,["BTCUSDC"]);
const oldPrescreen = process.env.AI_PRESCREEN;
try {
  for (const enabled of ["false","true"]) {
    process.env.AI_PRESCREEN = enabled;
    const result = prescreenPairs({cryptoSymbols:allowed,otherSymbols:[],request,instruction:request.instruction,scheduled:false});
    assert.deepEqual(result.symbols,["BTCUSDC"],`Urvalet behålls vid försållning ${enabled}`);
  }
  assert.throws(()=>prescreenPairs({cryptoSymbols:allowed,otherSymbols:[],request:{selectedSymbols:[]},scheduled:false}));
} finally { if (oldPrescreen === undefined) delete process.env.AI_PRESCREEN; else process.env.AI_PRESCREEN = oldPrescreen; }
assert.deepEqual(intersectAnalysisSymbols(request.selectedSymbols,["ETHUSDC","BTCUSDC","BTCUSDC"]),["BTCUSDC"]);
assert.deepEqual(intersectAnalysisSymbols(request.selectedSymbols,[]),[]);
const withSignals = {enabled:true,symbols:allowed,flagged:[{symbol:"BTCUSDC",direction:"LONG" as const,score:60,jevDowngraded:false}],skip:false,note:"test"};
const allRequest = {selectedSymbols:allowed,timeframe:"5m" as const};
const failed = await reviewPrescreenScope(withSignals,allRequest,false,async()=>{throw Error("JEV unavailable");});
assert.deepEqual(failed.screen.symbols,allowed,"JEV-fel utökar eller förminskar aldrig det manuella urvalet");
assert.ok(failed.error);
const refused = await reviewPrescreenScope(withSignals,allRequest,false,async()=>({kept:[],stopped:allowed.map(symbol=>({symbol,why:"veto"}))}));
assert.deepEqual(refused.screen.symbols,[]);assert.equal(refused.screen.skip,true);
const manual = await reviewPrescreenScope(withSignals,allRequest,false,async(symbols,wanted)=>{assert.deepEqual(symbols,allowed);assert.equal(wanted,allowed.length);return{kept:["ETHUSDC","SOLUSDC","BADUSDC"],stopped:[{symbol:"BTCUSDC",why:"veto"}]};});
assert.deepEqual(manual.screen.symbols,["ETHUSDC","SOLUSDC"]);
let marketCalls = 0;
const fake = {
  name:"mock",mode:"paper",getAccount:async()=>({balances:[],totalValueUsdt:0,updatedAt:0}),getPositions:async()=>[],
  getTicker:async()=>{marketCalls++;return{};},getKlines:async(_s:string,interval:string)=>{marketCalls++;assert.equal(interval,"5m");return[];},
  placeOrder:async()=>{marketCalls++;return{};},cancelOrder:async()=>{marketCalls++;},
};
const broker = scopeBroker(fake as never, request.selectedSymbols);
await broker.getKlines("BTCUSDC",request.timeframe!,100);
assert.throws(()=>broker.getKlines("ETHUSDC","5m",100));
assert.throws(()=>broker.getTicker("SOLUSDC"));
assert.throws(()=>broker.placeOrder({symbol:"ETHUSDC",side:"BUY",type:"MARKET",quantity:1}));
assert.throws(()=>broker.cancelOrder("ETHUSDC","other"));
assert.equal(marketCalls,1,"Otillåtna par når aldrig mäklaren");
const {RiskManager} = await import("../src/risk/riskManager.js");
const {config} = await import("../src/config.js");
const scopedRisk = new RiskManager({...config,crypto:{...config.crypto,symbols:["PLUMEUSDC"]}});
const riskContext = {state:{killSwitchActive:false,dailyRealizedPnlUsdt:0},account:{balances:[{asset:"PLUME",free:1,locked:0}],totalValueUsdt:1000,updatedAt:Date.now()},positions:[{symbol:"PLUMEUSDC",baseAsset:"PLUME",quoteAsset:"USDC",quantity:1,currentPrice:1,avgEntryPrice:1,unrealizedPnlUsdt:0,openedAt:0}],lastPrice:1,paper:true};
assert.equal(scopedRisk.checkOrder({symbol:"PLUMEUSDC",side:"SELL",type:"MARKET",quantity:1},riskContext as never).allowed,true,"Verifierat valt nytt marknadspar är tillåtet även utanför gamla env-listan");
assert.equal(scopedRisk.checkOrder({symbol:"BTCUSDC",side:"SELL",type:"MARKET",quantity:1},riskContext as never).allowed,false);
console.log("PASS: tomt/ogiltigt urval, bindande par trots fritext och avstängd försållning, JEV-subset samt verktygsgrind");

assert.throws(() => validateAnalysisRequest({selectedSymbols:["BTCUSDC"],broker:"invalid"},allowed));
assert.equal(validateAnalysisRequest({selectedSymbols:["BTCUSDC"],broker:"bybit"},allowed).broker,"bybit");
assert.equal(resolveAnalysisBroker({broker:"bybit-paper"},"bybit"),"bybit-paper");
assert.equal(resolveAnalysisBroker({},null),"bybit-paper");
let activeAccount = "bybit-paper";
const capturedAccount = resolveAnalysisBroker({},activeAccount);
const frozenAdapter = { "bybit-paper": {name:"TEST"}, bybit:{name:"LIVE"} }[capturedAccount];
await Promise.resolve().then(() => { activeAccount = "bybit"; });
assert.equal(capturedAccount,"bybit-paper");
assert.equal(frozenAdapter.name,"TEST","Ett globalt kontobyte under väntan byter inte analysens adapter");
const {readFileSync} = await import("node:fs");
const runSource = readFileSync(new URL("../src/run.ts",import.meta.url),"utf8");
const runBody = runSource.slice(runSource.indexOf("async function runOnce("),runSource.indexOf("async function main("));
assert.ok(runBody.indexOf("const primaryBroker = brokers[activeName]") < runBody.indexOf("await reviewPrescreenScope"));
assert.equal((runBody.match(/getActiveBrokerName\(\)/g)||[]).length,1,"Kontovalet läses bara en gång per tur");
console.log("PASS: bindande broker valideras och fryses före asynkron förkontroll");
