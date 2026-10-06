import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');const code=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('selectionQueues=new Map()'));
let account='bybit-paper',posts=[],gets=[];const ctx={window:{},document:{getElementById:()=>({value:account})},location:{origin:'http://localhost'},URL,fetch:(url,opts)=>new Promise(resolve=>{(opts?posts:gets).push({url,opts,resolve});})};vm.createContext(ctx);vm.runInContext(code,ctx);const ui=ctx.window.TradingUI;const response=data=>({ok:true,json:async()=>data});const tick=()=>new Promise(r=>setImmediate(r));
const start='2026-10-05T18:00:00Z',now=Date.parse('2026-10-05T18:02:00Z');const realOrder={id:'p1',status:'pending',source:'agent',venue:'broker:bybit-paper',createdAt:'2026-10-05T18:01:00Z',expiresAt:'2026-10-05T18:05:00Z'};assert(ui.proposalMatches(realOrder,{startedAt:start},'bybit-paper',now));assert(!ui.proposalMatches(realOrder,{startedAt:start},'bybit',now));assert(!ui.proposalMatches(realOrder,{startedAt:start},'bybit-paper',now+300000));assert(!ui.proposalMatches({...realOrder,requestId:'other'},{startedAt:start,requestId:'this'},'bybit-paper',now));assert(!ui.proposalMatches(realOrder,{startedAt:start,endedAt:'2026-10-05T18:00:30Z'},'bybit-paper',now));const stake=10000,fee=.001,entry=100,exit=101;const qty=stake/(1+fee)/entry,net=qty*exit*(1-fee)-stake;assert(Math.abs(ui.scenarioPct(entry,exit,fee)*stake/100-net)<1e-8);assert(ui.scenarioPct(100,100.1,.001)<0);console.log('PASS: real PendingOrder venue, expiry, cross-account rejection, exact backend fee basis and negative target net');
(async()=>{const old=ui.state().catch(e=>e.message);ui.invalidate();gets.shift().resolve(response({schemaVersion:1,selectedSymbols:['OLD']}));assert.match(await old,/ändrades/);const a=ui.select(['BTCUSDC'],'5m');await tick();const b=ui.select(['ETHUSDC'],'15m');await tick();assert.equal(posts.length,1);posts[0].resolve(response({ok:true}));await a;await tick();assert.equal(posts.length,2);assert.deepEqual(JSON.parse(posts[1].opts.body).selectedSymbols,['ETHUSDC']);posts[1].resolve(response({ok:true}));await b;assert.equal(ctx.window.getAnalysisSymbols()[0],'ETHUSDC');assert.equal(ctx.window.getAnalysisTimeframe(),'15m');const pending=ui.state().catch(e=>e.message);account='bybit';ui.resetSelection();gets.shift().resolve(response({schemaVersion:1,selectedSymbols:['WRONG']}));assert.match(await pending,/ändrades/);assert.throws(()=>ctx.window.getAnalysisSymbols(),/Välj/);console.log('PASS: stale snapshots rejected, selection POST serialized, latest selection retained, broker reset cannot restore old symbols');})().catch(e=>{console.error(e);process.exit(1)});

// Syntax samt frånvaro av det tidigare fabricerade HOLD-köpet.
for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new Function(m[1]);
assert(!html.includes('async function bestBuy'));assert(!html.includes('data-am="anyway"'));assert(!html.includes('VÄNTA – agenterna föreslår inget köp'));assert(html.includes("o.status==='skickad'"));
assert(html.includes('current.marketSymbols||[]'));assert(html.includes('trading-market-catalog'));
assert(html.includes('tidigare valt'));assert(html.includes('executionMode!=="approve"'));
console.log('PASS: inline syntax, HOLD without synthetic buy, shared catalogue and manual session guard');

// Historikstatusens UI får inte likställa en konfigurerad nyckel med hämtad data.
const historyScript=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function renderHistory(data)'));
const renderSource=historyScript.slice(historyScript.indexOf('  const esc='),historyScript.indexOf('  // Ren renderingsfunktion'));
const historyContext={window:{}};vm.createContext(historyContext);vm.runInContext(renderSource+'\nwindow.render=renderHistory;',historyContext);
assert.match(historyContext.window.render({configured:false}),/Tiingo-nyckel saknas i Trading-OS/);
assert.match(historyContext.window.render({configured:true,years:3,symbols:[]}),/efter att den tekniska agenten har hämtat/);
const historyHtml=historyContext.window.render({configured:true,years:3,symbols:[{symbol:'BTCUSDC',ticker:'btcusd',source:'Tiingo',status:'partial',from:'2023-10-06',to:'2026-10-06',count:900,missingDays:100,rejectedBars:2,cached:true,error:'<script>alert(1)</script>'}]});
assert.match(historyHtml,/Ofullständig historik/);assert.match(historyHtml,/900 dagscandles/);assert.match(historyHtml,/saknade dagar 100/);assert(!historyHtml.includes('<script>'));assert.match(historyHtml,/order använder Bybit EU spot i USDC/);
console.log('PASS: missing-key, no-cache, partial history coverage and escaped error status');

assert.match(historyContext.window.render({configured:true,years:3,symbols:[{symbol:'BTCUSDC',status:'ready',count:1000,cached:false}]}),/Fullständig historik/);
assert(!historyContext.window.render({configured:true,years:3,symbols:[{symbol:'BTCUSDC',status:'ready',count:1000,cached:false}]}).includes('Verifierad cache'));
console.log('PASS: complete history label does not claim cached data');
