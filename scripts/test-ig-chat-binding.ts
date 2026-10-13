// Isolerad chattregression: inga nätverksanrop eller order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.TRADING_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'ig-chat-binding-'));
process.env.AGENT_TREE_TRADING_EVENTS='off';
delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO;delete process.env.IG_ORDER_EXECUTION_ENABLED_LIVE;delete process.env.LIVE_TRADING_CONFIRMED;
globalThis.fetch=(async()=>{throw Error('Nätverk förbjudet i testet');}) as typeof fetch;
const {igChat,executeIgChatTool}=await import('../src/server/igChat.js');
const {igChatEnvironmentMatches,igChatSessionSummary}=await import('../src/server/igChatContext.js');
assert.equal(igChatEnvironmentMatches({env:'live'},'demo'),false);
assert.equal(igChatEnvironmentMatches({env:'demo'},'demo'),true);
assert.equal(igChatEnvironmentMatches({},'demo'),true);
const summary=igChatSessionSummary({session:{id:'s1',status:'running',strategy:'test',orderAttempts:2,maxOrderAttempts:5,secret:'private',report:'x'.repeat(100000)}});
assert.ok(summary.includes('s1'));assert.ok(summary.includes('orderAttempts'));assert.ok(!summary.includes('private'));assert.ok(summary.length<1000);
let current=true,calls=0,queued=0;const check=()=>{if(!current)throw Error('session ändrad');};
const broker={env:'demo',mode:'testnet',name:'ig-demo',getAccount:async()=>({balance:1000,currency:'SEK'}),getPositions:async()=>{throw Error('positions saknas');},executionEnabled:()=>false} as never;
const deps={assertCurrent:check,watchlist:()=>[{epic:'CS.D.TEST.IP',name:'Test',category:'forex'}],createPending:async()=>{queued++;return {ok:true};},llm:{messages:{create:async()=>{calls++;current=false;return {content:[{type:'tool_use',id:'t1',name:'queue_ig_orders',input:{epics:['CS.D.TEST.IP'],side:'BUY'}}]};}}}} as never;
await assert.rejects(executeIgChatTool('get_account_status',{},broker,deps),/positions saknas/);
await assert.rejects(igChat('köp',[],broker,deps),/session ändrad/);assert.equal(calls,1);assert.equal(queued,0,'Sessionsbyte under LLM får aldrig skapa pending');
current=false;await assert.rejects(executeIgChatTool('queue_ig_orders',{epics:['CS.D.TEST.IP']},broker,deps),/session ändrad/);assert.equal(queued,0);
current=true;const delayedBroker={...broker as object,getAccount:async()=>{current=false;return {balance:1000,currency:'SEK'};}} as never;
await assert.rejects(igChat('status',[],delayedBroker,deps),/session ändrad/);assert.equal(calls,1,'Sessionsbyte under kontoläsning stoppar LLM');
console.log('PASS: miljömismatch, bounded sessionskontext, positionsfel, byte under konto/LLM och före verktyg blockerar pending');
const items=Array.from({length:30},(_,i)=>({epic:`CS.D.TEST${i}.IP`,status:'analyserad',action:'AVVAKTA',result:'Resultat'.repeat(1000),secret:'ska inte följa med'}));
const detail=igChatSessionSummary({session:{id:'bounded',items}},'CS.D.TEST29.IP');
assert.ok(detail.indexOf('CS.D.TEST29.IP')<detail.indexOf('CS.D.TEST0.IP'));
assert.ok(detail.length<4000);assert.ok(!detail.includes('ska inte följa med'));
const {setActiveBrokerName,effectiveExecutionMode,createIgPendingOrder}=await import('../src/server/api.js');
for(const env of ['ig','ig-demo',null]){setActiveBrokerName(env);assert.equal(effectiveExecutionMode(),'approve');}
let read=0;
const pendingBroker={...broker as object,getPositions:async()=>{read++;current=false;return [];}} as never;
current=true;
await assert.rejects(createIgPendingOrder({symbol:'CS.D.TEST.IP',side:'BUY'},pendingBroker,check),/session ändrad/);
assert.equal(read,1);
console.log('PASS: vald EPIC först i högst tio bounded resultat; IG Live/Demo/fallback approve; pending avbryts efter positions-await');

process.exit(0);
