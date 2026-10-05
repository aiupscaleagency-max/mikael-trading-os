import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
process.chdir(mkdtempSync(path.join(os.tmpdir(),"market-catalogue-")));
mkdirSync("data",{recursive:true});
const legacy = ["ENA","PLUME","SKY","CHIP"].map(base=>({base,symbol:`${base}USDT`,usdc:true,addedAt:"2026-01-01"}));
writeFileSync("data/custom-symbols.json",JSON.stringify({symbols:legacy}));
const {getTradingState,invalidateTradingState,mergeMarketSymbols}=await import("../src/server/tradingState.js");
const {addCustomSymbol,removeCustomSymbol,listCustomSymbols}=await import("../src/server/customSymbols.js");
const {setAnalysisSelection,getAnalysisSelection}=await import("../src/server/analysisSelection.js");
assert.deepEqual(mergeMarketSymbols(["BTCUSDC","BTCUSDT","EURUSD","btcusdc"],["PLUMEUSDC"]),["BTCUSDC","PLUMEUSDC"]);
setAnalysisSelection("TEST",{selectedSymbols:["BTCUSDC"],timeframe:"5m"});
setAnalysisSelection("LIVE",{selectedSymbols:["ATOMUSDC"],timeframe:"15m"});
let release!:()=>void;
let first=true;
const fake={name:"bybit-paper",mode:"paper",getAccount:async()=>{if(first){first=false;await new Promise<void>(r=>release=r);}throw Error("offline");}};
const brokers={"bybit-paper":fake,bybit:{...fake,name:"bybit",mode:"live",getAccount:async()=>{throw Error("offline");}}};
const pending=getTradingState(brokers as never,"bybit-paper");
const oldFetch=globalThis.fetch;
globalThis.fetch=(async(url:unknown)=>{assert.ok(String(url).includes("https://api.bybit.eu/"));assert.ok(String(url).includes("ZZCATUSDC"));return {json:async()=>({retCode:0,result:{list:[{status:"Trading"}]}})};}) as typeof fetch;
try {
  const adding=addCustomSymbol("ZZCAT");
  await assert.rejects(addCustomSymbol("ZZCAT"),/följs redan/);
  await adding;
  invalidateTradingState();
  release();
  const test=await pending;
  const live=await getTradingState(brokers as never,"bybit");
  assert.ok(test.marketSymbols.includes("ZZCATUSDC"),"En äldre pågående snapshot ska inte dölja nya katalogpar");
  assert.deepEqual(test.marketSymbols,live.marketSymbols,"Katalogen är gemensam mellan kontonas vyer");
  assert.ok(test.marketSymbols.includes("ATOMUSDC"));
  for (const base of ["ENA","PLUME","SKY","CHIP"]) {
    assert.ok(test.marketSymbols.includes(`${base}USDC`),"Verifierade äldre custompar bevaras som USDC");
    assert.ok(!test.marketSymbols.includes(`${base}USDT`));
  }
  assert.equal(JSON.parse(readFileSync("data/custom-symbols.json","utf8")).symbols.find((s:{base:string})=>s.base==="PLUME").symbol,"PLUMEUSDT","Läsnormalisering får inte migrera sparad användardata");
  assert.deepEqual(getAnalysisSelection("TEST").selectedSymbols,["BTCUSDC"],"Katalogaddition får inte välja nya analyspar");
  assert.equal(listCustomSymbols().filter(s=>s.symbol==="ZZCATUSDC").length,1);
  removeCustomSymbol("ZZCAT");invalidateTradingState();
  assert.equal((await getTradingState(brokers as never,"bybit-paper")).marketSymbols.includes("ZZCATUSDC"),false);
  const api=readFileSync(new URL("../src/server/api.ts",import.meta.url),"utf8");
  assert.ok(api.includes('broadcastEvent("markets-changed", { symbol: c.symbol, action: "added" })'));
  assert.ok(api.includes('broadcastEvent("markets-changed", { symbol: c.symbol, action: "removed" })'));
  assert.ok(api.includes("addKlineSymbol(c.symbol)"));assert.ok(api.includes("addTickerBase(c.base, c.usdc)"));
} finally {globalThis.fetch=oldFetch;}
console.log("PASS: USDC-katalog, båda konton, tillägg under pågående snapshot, dubbel-add, borttagning och separat analysurval; inga orderanrop");
