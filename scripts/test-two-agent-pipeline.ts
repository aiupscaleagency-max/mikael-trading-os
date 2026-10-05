import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runTwoAgentPipeline } from "../src/orchestrator/twoAgentPipeline.js";

// JEV:s råd om extra granskning får aldrig automatiskt lägga till en tredje agent.
const trace: string[] = [];
let resolveJev!: (value: { runAdvisor: boolean }) => void;
const jevWaiting = new Promise<{runAdvisor:boolean}>(resolve=>{resolveJev=resolve;});
const run = runTwoAgentPipeline({
  jev: async()=>{trace.push("jev");return jevWaiting;},
  technical: async verdict=>{trace.push("technical");assert.equal(verdict.runAdvisor,true);return{analyses:["BTCUSDC"]};},
  head: async technical=>{trace.push("head");assert.deepEqual(technical.analyses,["BTCUSDC"]);return{decision:"HOLD"};},
});
await Promise.resolve();
assert.deepEqual(trace,["jev"],"Ingen agent börjar innan JEV-förkontrollen är färdig");
resolveJev({runAdvisor:true});
await run;
assert.deepEqual(trace,["jev","technical","head"]);
const failTrace:string[]=[];
await assert.rejects(runTwoAgentPipeline({jev:async()=>{failTrace.push("jev");return{};},technical:async()=>{failTrace.push("technical");return null;},head:async()=>{failTrace.push("head");return{};}}),/Hanna startas inte/);
assert.deepEqual(failTrace,["jev","technical"]);
await assert.rejects(runTwoAgentPipeline({jev:async()=>({}),technical:async()=>({analyses:[]}),head:async()=>{throw Error("Får inte starta");}}),/Hanna startas inte/);
const code = readFileSync(new URL("../src/orchestrator/orchestrator.ts",import.meta.url),"utf8");
assert.ok(code.includes("runTwoAgentPipeline("));
assert.ok(!/runRiskAnalyst\(|runResearcher\(|runClaudeAdvisor\(|runMacroAnalyst\(/.test(code),"Standardkedjan har inga extra LLM-roller");
assert.ok(code.includes('agentSkip("risk", "Deterministiska riskgränser, ingen separat AI-agent")'));
console.log("PASS: JEV färdig först, Teknisk → Hanna, inga automatiska extra agentroller");
