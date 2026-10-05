import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolerad ledger: tester får aldrig läsa eller ändra användarens kontodata.
process.chdir(mkdtempSync(path.join(os.tmpdir(), "trading-state-")));
const { paperPositions, getTradingState, invalidateTradingState } = await import("../src/server/tradingState.js");
const { setAnalysisSelection, getAnalysisSelection } = await import("../src/server/analysisSelection.js");
const { analysisStart } = await import("../src/server/agentActivity.js");
const now = Date.now();
const snap = { initialCapital: 1_000_000, feeRate: 0.001, usdc: 900_000,
  holdings: {BTC: {qty:3,avg:100,openedAt:now}},
  lots: {a:{base:"BTC",remaining:1,entryPrice:100,entryFee:0.1,costBasisRemaining:100.1,openedAt:now-1000},
    b:{base:"BTC",remaining:1,entryPrice:200,entryFee:0.2,costBasisRemaining:200.2,openedAt:now-500}},
  open:[{base:"BTC",kind:"TP",price:120,group:"a"}] };
const exits = [{id:"exit-a",broker:"bybit-paper",symbol:"BTCUSDC",qty:1,live:false,openedAt:now-1000,exitAt:now+1000,baseline:0,paperGroup:"a"}];
const positions = paperPositions(snap,exits,now,()=>({price:110,ts:now}));
assert.equal(positions.length,3,"Äldre innehav utan lott får inte försvinna");
assert.equal(positions[0]?.tradeId,"a");
assert.equal(positions[0]?.exitAt,now+1000);
assert.equal(positions[1]?.exitAt,null,"Sluttid får inte hittas på");
assert.ok(Math.abs((positions[0]?.unrealizedNet ?? 0)-9.79)<1e-9);
assert.ok((positions[1]?.unrealizedNet ?? 0)<0,"Två ingångspriser ska ge skilda resultat");
assert.equal(positions[2]?.costBasisRemaining,null);
assert.equal(positions[2]?.unrealizedNet,null);
assert.equal(paperPositions(snap,exits,now,()=>({price:110,ts:now-61000}))[0]?.currentPrice,null);
assert.throws(()=>setAnalysisSelection("TEST",{selectedSymbols:[],timeframe:"5m"}));
setAnalysisSelection("TEST",{selectedSymbols:["BTCUSDC"],timeframe:"15m"});
assert.deepEqual(getAnalysisSelection("LIVE").selectedSymbols,[]);
analysisStart("manuell",undefined,{broker:"bybit-paper",selectedSymbols:["BTCUSDC"]});
const fake = {name:"bybit",mode:"live",getAccount:async()=>{throw Error("offline");}};
const live = await getTradingState({bybit:fake} as never,"bybit");
assert.equal(live.account.equity,null);
assert.equal(live.account.status,"unavailable");
assert.equal(live.totals,null);
assert.equal(live.analysis,null,"TEST-analys får inte presenteras som LIVE");
assert.equal(live.completeness.positions,false);
const second = await getTradingState({bybit:fake} as never,"bybit");
assert.equal(second.revision,live.revision);
invalidateTradingState();
console.log("PASS: separata lotter, avgifter, okänd historik, inaktuella priser, kontoseparation och stabil revision");
