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

// Kör själva flerdiagram-IIFE:n: ingen katalog får ge undefinedUSDC-anrop.
const multiScript=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('const box = document.getElementById("mcGrid")'));
class MockElement{
  constructor(){this.style={};this.classList={toggle(){}};this.nodes={};this.children=[];this.clientWidth=400;}
  set innerHTML(value){this.html=value;if(!value.includes('mc-head'))this.children=[];}
  get innerHTML(){return this.html||'';}
  querySelector(key){if(!this.nodes[key]){const node=new MockElement();node.value=key==='.mc-s'?(this.html?.match(/option value="([^"]+)" selected/)?.[1]||this.html?.match(/option value="([^"]+)"/)?.[1]):'1h';this.nodes[key]=node;}return this.nodes[key];}
  appendChild(el){this.children.push(el);}addEventListener(){}
}
const mockBox=new MockElement(),requests=[],sockets=[],events={},writes=[];
const series=()=>({setData(){},update(){}});
class MockSocket{constructor(url){this.url=url;sockets.push(this);}send(value){this.sent=value;}close(){this.onclose?.();}}
const multiContext={window:{tradingMarketSymbols:[],addEventListener:(name,fn)=>events[name]=fn},document:{getElementById:id=>id==='mcGrid'?mockBox:null,querySelectorAll:()=>[],createElement:()=>new MockElement()},localStorage:{getItem:()=>JSON.stringify({layout:'2',panes:[{b:'SOL',iv:'5m'},{b:'BTC',iv:'1h'}]}),setItem:(key,value)=>writes.push(JSON.parse(value))},LightweightCharts:{createChart:()=>({remove(){},addCandlestickSeries:series,addHistogramSeries:series,priceScale:()=>({applyOptions(){}}),subscribeCrosshairMove(){}})},WebSocket:MockSocket,setInterval:()=>1,clearInterval(){},setTimeout(){},fetch:async url=>{requests.push(url);return {ok:true,json:async()=>({klines:[]})};},console};
vm.createContext(multiContext);vm.runInContext(multiScript,multiContext);
await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,0);assert.equal(sockets.length,0);assert.equal(writes.length,0);
multiContext.window.tradingMarketSymbols=['BTCUSDC','SOLUSDC'];events['trading-market-catalog']();events['trading-market-catalog']();await new Promise(resolve=>setImmediate(resolve));
assert.equal(requests.length,2);assert(requests[0].includes('SOLUSDC&interval=5m'));assert(requests[1].includes('BTCUSDC'));assert.equal(sockets.length,1);sockets[0].onopen();assert.match(sockets[0].sent,/SOLUSDC/);assert.equal(mockBox.children[0].querySelector('.mc-s').value,'SOL');
multiContext.window.tradingMarketSymbols=['ETHUSDC'];events['trading-market-catalog']();await new Promise(resolve=>setImmediate(resolve));assert(requests.slice(-2).every(url=>url.includes('ETHUSDC')));assert.equal(mockBox.children[0].querySelector('.mc-s').value,'ETH');assert.equal(writes.at(-1).panes[0].iv,'5m');assert(!requests.some(url=>url.includes('undefined')));assert(writes.every(cfg=>cfg.panes.every(p=>p.b)));
console.log('PASS: multichart waits for catalogue, coalesces events, preserves valid saved selections and intervals, rebuilds requests/dropdowns/subscriptions');

// Kör verkliga tabellrenderare: kostnader och netto får inte ersättas med noll.
const sharedScript=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function position(p)'));
const sharedCtx={current:{mode:'TEST'}};vm.createContext(sharedCtx);
const helperPart=sharedScript.slice(sharedScript.indexOf('  const esc='),sharedScript.indexOf("  let activeTradeTab="));
const rowsPart=sharedScript.slice(sharedScript.indexOf('  function position(p)'),sharedScript.indexOf('  function render(){'));
vm.runInContext(helperPart+'\n'+rowsPart,sharedCtx);
const row=vm.runInContext('position({symbol:"BTCUSDC",tradeId:"lot1",costBasisRemaining:10000,entryPrice:100,currentPrice:101,unrealizedNet:80,unrealizedPct:.8,potentialNet:150,potentialPct:1.5,exitAt:1700000000000,remainingQty:100})',sharedCtx);
assert(row.startsWith('<tr>'));assert(row.includes('data-shared-chart="BTCUSDC"'));assert(row.includes('data-shared-trade="lot1"'));assert(row.includes('data-shared-countdown="1700000000000"'));assert(row.includes('0.80 %'));assert(row.includes('1.50 %'));
const unknown=vm.runInContext('position({symbol:"<img>",costBasisRemaining:null,entryPrice:null,unrealizedNet:null,potentialNet:null})',sharedCtx);assert(unknown.includes('okänt'));assert(!unknown.includes('<img>'));
assert(vm.runInContext('history({coin:"BTC",side:"BUY",at:0,qty:2,price:100,usd:200,fee:.5})',sharedCtx).includes('KÖPT'));
assert(vm.runInContext('history({coin:"BTC",side:"SELL",at:0,pnl:null,pnlPct:null})',sharedCtx).includes('SÅLT'));
assert(html.includes('table([\'Par\',\'Investerat\''));assert(html.includes("host('shared-trade-column',document.querySelector('#page-trade main'))"));
for(const area of ['positions','controls','side','advanced'])assert(html.includes('grid-area:'+area));
console.log('PASS: real position/history rows, chart/lot-close/countdown actions, net/potential percentages, unknown cost and escaping; explicit grid areas');

// DOM-fixture kör den verkliga renderfunktionen genom TEST → LIVE → TEST.
// Samma order-/analysnoder och deras handlers måste överleva även laddningsvyn.
class MountNode{
  constructor(id){this.id=id;this.children=[];this.mounts={};this.hidden=false;this.html='';}
  appendChild(node){if(!node)return;if(node.parent)node.parent.children=node.parent.children.filter(n=>n!==node);node.parent=this;this.children.push(node);return node;}
  set innerHTML(value){this.children.forEach(node=>node.parent=null);this.children=[];this.mounts={};this.html=value;if(value.includes('data-pending-mount'))this.mounts['[data-pending-mount]']=this.appendChild(new MountNode('pending-mount'));if(value.includes('data-analysis-mount'))this.mounts['[data-analysis-mount]']=this.appendChild(new MountNode('analysis-mount'));}
  get innerHTML(){return this.html;}querySelector(selector){return this.mounts[selector]||null;}
}
const pageFixture=new MountNode('page-trade'),primaryFixture=new MountNode('shared-trade-column'),secondaryFixture=new MountNode('shared-trades-page'),approvalFixture=new MountNode('pendingBox'),analysisFixture=new MountNode('analysisBox');
const approvalHandler=()=> 'approve';approvalFixture.onclick=approvalHandler;
const renderCode=sharedScript.slice(sharedScript.indexOf('  function render(){'),sharedScript.indexOf('  function renderLegacyTargets(){'));
const fixtureState=mode=>({mode,broker:mode==='LIVE'?'bybit':'bybit-paper',serverNow:Date.now(),account:{status:mode==='LIVE'?'unavailable':'ready',equity:1000000,available:999000},sizing:{percent:1,amount:10000},positions:[],pendingOrders:[],selectedSymbols:['BTCUSDC'],marketSymbols:['BTCUSDC'],results:null,analysis:{status:'done'}});
Object.assign(sharedCtx,{document:{getElementById:id=>id==='page-trade'?pageFixture:id==='shared-trade-column'?primaryFixture:null},approvalNode:approvalFixture,analysisNode:analysisFixture,hosts:[primaryFixture,secondaryFixture],activeTradeTab:'pending',filters:{period:'all',symbol:'all',status:'all',count:5},lastError:'',source:()=>'',select:()=>'',filter:()=>true,renderSelection(){},countdown(){},renderLegacyTargets(){}});
vm.runInContext(renderCode,sharedCtx);
for(const mode of ['TEST','LIVE','TEST']){sharedCtx.current=null;vm.runInContext('render()',sharedCtx);assert.equal(approvalFixture.parent,pageFixture);sharedCtx.current=fixtureState(mode);vm.runInContext('render()',sharedCtx);assert.equal(approvalFixture.parent,primaryFixture.querySelector('[data-pending-mount]'));assert.equal(analysisFixture.parent,primaryFixture.querySelector('[data-analysis-mount]'));assert.equal(approvalFixture.onclick,approvalHandler);assert.equal(approvalFixture.hidden,false);assert.match(secondaryFixture.querySelector('[data-pending-mount]').innerHTML,/Öppna godkännande på Trade/);for(const tab of ['open','closed','pending','signals'])assert(primaryFixture.innerHTML.includes('data-trade-tab="'+tab+'"'));}
assert.equal((html.match(/id="trade-session-top"/g)||[]).length,0);assert(html.includes("start.id='trade-session-top'"));assert(html.includes("session.appendChild(sessionCard)"));assert(html.includes("search.oninput=apply"));
console.log('PASS: TEST/LIVE/TEST preserve original approval and analysis nodes/handlers, all four tabs, secondary navigation, session and instrument controls');

// Orderpanelens verkliga scenario måste visa nettovinst separat från slutvärde.
const orderScript=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function renderEst()'));
const estimateSource=orderScript.slice(orderScript.indexOf('  function renderEst(){'),orderScript.indexOf('  ["ot-amt","ot-price","ot-tp","ot-sl"]'));
const orderInputs={'ot-amt':{value:'10000'},'ot-tp':{value:'101'},'ot-sl':{value:'99'},'ot-tpsl':{checked:true},'ot-est':{innerHTML:'',textContent:''}};
const estimateCtx={$:id=>orderInputs[id],curPx:()=>100,configuredFee:()=>.001,baseOf:()=> 'BTC',STATE:{symbol:'BTCUSDC'},fmt:n=>Number(n).toFixed(2),window:{tradeSizing:{mode:'TEST'},TradingUI:ui}};vm.createContext(estimateCtx);vm.runInContext(estimateSource+'\nrenderEst();',estimateCtx);
assert.match(orderInputs['ot-est'].innerHTML,/netto ·/);assert.match(orderInputs['ot-est'].innerHTML,/Uppskattat slutvärde/);assert.match(orderInputs['ot-est'].innerHTML,/Ingen fast utbetalning/);
const expected=10000*ui.scenarioPct(100,101,.001)/100;assert(orderInputs['ot-est'].innerHTML.includes(expected.toFixed(2)));
estimateCtx.configuredFee=()=>NaN;vm.runInContext('renderEst()',estimateCtx);assert.match(orderInputs['ot-est'].textContent,/Avgiftsdata saknas/);
console.log('PASS: order scenario exact fee basis, separate net and final value, unknown fees stay unknown');

const feeSource=orderScript.split('\n').find(line=>line.includes('const configuredFee =')).replace('const configuredFee =','window.readFee =');
vm.runInContext(feeSource,estimateCtx);estimateCtx.window.tradeSizing.feeRate=null;assert(Number.isNaN(estimateCtx.window.readFee()));estimateCtx.window.tradeSizing.feeRate=-1;assert(Number.isNaN(estimateCtx.window.readFee()));estimateCtx.window.tradeSizing.feeRate=.001;assert.equal(estimateCtx.window.readFee(),.001);
assert.match(orderInputs['ot-est'].innerHTML,/Köpscenario/);assert.match(orderInputs['ot-est'].innerHTML,/Vid SÄLJ kräver realiserat netto/);
const card=vm.runInContext('positionCard({symbol:"BTCUSDC",tradeId:"lot7",costBasisRemaining:10000,unrealizedNet:80,unrealizedPct:.8,potentialNet:150,potentialPct:1.5,exitAt:1700000000000})',sharedCtx);assert(!card.includes('<table'));assert(card.includes('Investerat'));assert(card.includes('Netto nu'));assert(card.includes('Tid kvar'));assert(card.includes('data-shared-trade="lot7"'));
const signalSource=sharedScript.slice(sharedScript.indexOf('  function fillSignal(id){'),sharedScript.indexOf('  async function sell('));
const formNodes={};for(const id of ['sym-select','ot-amt','ot-price','ot-tp','ot-sl','ot-tpsl','ot-note','orderCard','ot-tf-custom','ot-tf-unit'])formNodes[id]={value:'',dataset:{},options:[{value:'BTCUSDC'},{value:'SOLUSDC'}],dispatchEvent(){},scrollIntoView(){}};
const formCtx={current:{serverNow:Date.now(),pendingOrders:[{id:'signal1',symbol:'SOLUSDC',side:'BUY',status:'pending',expiresAt:new Date(Date.now()+60000).toISOString(),quoteUsd:10000,refPrice:100,limitPrice:99,orderType:'LIMIT',takeProfit:105,stopLoss:95,horizonSec:300}]},epoch:value=>typeof value==='number'?value:Date.parse(value),document:{getElementById:id=>formNodes[id],querySelector:()=>({click(){}})},Event:class{constructor(type){this.type=type;}},switchPage(){},fetch(){throw Error('Signal selection must never place an order');}};
vm.createContext(formCtx);vm.runInContext(signalSource+'\nfillSignal("signal1");',formCtx);assert.equal(formNodes['sym-select'].value,'SOLUSDC');assert.equal(formNodes['ot-amt'].value,10000);assert.equal(formNodes['ot-price'].value,99);assert.equal(formNodes['ot-tp'].value,105);assert.equal(formNodes['ot-sl'].value,95);assert.match(formNodes['ot-note'].textContent,/Ingen order har lagts/);
formNodes['ot-amt'].value=7;formCtx.current.pendingOrders[0].expiresAt='2000-01-01';vm.runInContext('fillSignal("signal1")',formCtx);assert.equal(formNodes['ot-amt'].value,7);
console.log('PASS: null/negative fees unknown, explicit BUY-only scenario, compact primary lot cards, valid signal fills form without order and expired signal ignored');

formCtx.current.pendingOrders[0].expiresAt=new Date(Date.now()+60000).toISOString();
formCtx.document.querySelector=selector=>selector.startsWith('#ot-tf')?(selector.includes('300')?{click(){formNodes['ot-tf-custom'].value='';}}:null):({click(){}});
for(const seconds of [1234,300,1234]){formCtx.current.pendingOrders[0].horizonSec=seconds;vm.runInContext('fillSignal("signal1")',formCtx);if(seconds===300)assert.equal(formNodes['ot-tf-custom'].value,'');else{assert.equal(formNodes['ot-tf-custom'].value,1234);assert.equal(formNodes['ot-tf-unit'].value,'1');}}
formCtx.current.pendingOrders[0].horizonSec=null;vm.runInContext('fillSignal("signal1")',formCtx);assert.equal(formNodes['ot-tf-custom'].value,'');assert.match(formNodes['ot-note'].textContent,/innehavstid är ej verifierad/);
console.log('PASS: signal custom horizon 1234 → preset 300 → custom 1234, missing horizon clearly unverified');

// IG-anrop har egen miljö, endast IG-rutter och ett generationsskydd för Demo → Live → Demo.
const igWorkspaceScript=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function createIGWorkspaceClient('));
const igClientCode=igWorkspaceScript.slice(igWorkspaceScript.indexOf('  function createIGWorkspaceClient('),igWorkspaceScript.indexOf('  window.createIGWorkspaceClient='));
const igClientContext={window:{},URL,location:{origin:'http://localhost'}};vm.createContext(igClientContext);vm.runInContext(igClientCode+'\nwindow.factory=createIGWorkspaceClient;',igClientContext);
let igEnvironment='demo',igEpoch=0;const igRequests=[];const igClient=igClientContext.window.factory(async(url,options)=>{igRequests.push({url,options});return {ok:true,json:async()=>({environment:igEnvironment,status:'ready'})};},()=>igEnvironment,()=>igEpoch);
await igClient.call('/api/ig/markets',{query:{searchTerm:'EUR/USD',environment:'live'}});assert.equal(new URL(igRequests[0].url,'http://localhost').searchParams.get('environment'),'demo');
await igClient.call('/api/ig/analysis',{method:'POST',data:{environment:'live',epics:['CS.D.EURUSD.CFD.IP'],timeframe:'5m',horizonMinutes:15,percent:1}});const igPayload=JSON.parse(igRequests[1].options.body);assert.equal(igPayload.environment,'demo');assert.deepEqual(igPayload.epics,['CS.D.EURUSD.CFD.IP']);assert.equal(igPayload.timeframe,'5m');assert(!('selectedSymbols' in igPayload));
await assert.rejects(()=>igClient.call('/api/run-agent'),/endast använda IG/);
let resolveIg;const staleClient=igClientContext.window.factory(()=>new Promise(resolve=>resolveIg=resolve),()=>igEnvironment,()=>igEpoch);const staleIg=staleClient.call('/api/ig/workspace');igEnvironment='live';igEpoch++;igEnvironment='demo';igEpoch++;resolveIg({ok:true,json:async()=>({environment:'demo'})});await assert.rejects(staleIg,/äldre svar ignorerades/);
assert(igWorkspaceScript.includes('event.stopImmediatePropagation();runAnalysis()'));assert(igWorkspaceScript.includes('REST-pollning var 60 s'));assert(!igWorkspaceScript.includes('TradingUI.read'));assert(!igWorkspaceScript.includes('USDC'));assert(igWorkspaceScript.includes('snapshot?.execution?.reason'));
console.log('PASS: IG namespace, Demo/Live payload and EPIC isolation, locked environment, ABA stale-response rejection and independent REST chart/analysis flow');

// Kör verkliga IG-knappfunktioner: ett kontobyte under selection-save får aldrig skicka analys/session.
const igActionCode=igWorkspaceScript.slice(igWorkspaceScript.indexOf('  async function runAnalysis()'),igWorkspaceScript.indexOf('  function setVenue('));
let finishSelection;const actionCalls=[];
const igActions={snapshot:{connection:{status:'connected'}},epics:['CS.D.EURUSD.CFD.IP'],analysisBusy:false,environmentEpoch:0,environment:'demo',selectedContext:()=>({epics:['CS.D.EURUSD.CFD.IP'],timeframe:'15m',percent:1,horizonMinutes:5}),renderSnapshot(){},message(){},renderTrades(){},loadWorkspace:async()=>{},client:{call:async(path,opts)=>actionCalls.push({path,opts})},saveSelection:()=>new Promise(resolve=>finishSelection=resolve),$:id=>({value:id==='ig-session-duration'?'30':'5'}),tab:'open'};
vm.createContext(igActions);vm.runInContext(igActionCode,igActions);
let action=vm.runInContext('runAnalysis()',igActions);igActions.environment='live';igActions.environmentEpoch++;finishSelection();await action;assert.equal(actionCalls.length,0);
igActions.environment='demo';action=vm.runInContext('startSession()',igActions);igActions.environment='live';igActions.environmentEpoch++;finishSelection();await action;assert.equal(actionCalls.length,0);
igActions.saveSelection=async()=>{};igActions.analysisBusy=false;igActions.environment='demo';await vm.runInContext('runAnalysis()',igActions);await vm.runInContext('startSession()',igActions);assert.deepEqual(actionCalls.map(c=>c.path),['/api/ig/analysis','/api/ig/session']);assert.equal(actionCalls[0].opts.data.timeframe,'15m');assert.equal(actionCalls[1].opts.data.durationMinutes,30);
await igClient.call('/api/ig/session',{method:'DELETE'});const stopRequest=igRequests.at(-1);assert.equal(stopRequest.options.headers['Content-Type'],'application/json');assert.equal(JSON.parse(stopRequest.options.body).environment,'demo');
assert(igWorkspaceScript.includes('timeframe:analysisTimeframe'));assert(igWorkspaceScript.includes("if(chosen!==epic||epoch!==environmentEpoch)return"));assert(!igWorkspaceScript.match(/ig-chart-timeframe[^\n]+saveSelection/));
console.log('PASS: actual IG analysis/session actions freeze selection, abort account-switch races, separate chart/analysis intervals and JSON session stop');

// Ett långsamt instrumentsvar får inte ersätta reglerna för det nyvalda instrumentet.
const marketFn=igWorkspaceScript.slice(igWorkspaceScript.indexOf('  async function loadMarket()'),igWorkspaceScript.indexOf('  async function runAnalysis()'));
const marketNodes={'ig-order-market-detail':{textContent:'B regler'},'ig-order-quote':{textContent:'B kvot'}};let finishMarket;
const marketCtx={epic:'A',environmentEpoch:0,client:{call:()=>new Promise(resolve=>finishMarket=resolve)},$:id=>marketNodes[id],num:n=>String(n??'Ej verifierat'),date:()=> 'datum'};vm.createContext(marketCtx);vm.runInContext(marketFn,marketCtx);const marketPending=vm.runInContext('loadMarket()',marketCtx);marketCtx.epic='B';finishMarket({instrument:{unit:'A unit'},quote:{bid:1}});await marketPending;assert.equal(marketNodes['ig-order-market-detail'].textContent,'B regler');assert.equal(marketNodes['ig-order-quote'].textContent,'B kvot');
console.log('PASS: late IG EPIC response cannot overwrite current instrument quote or CFD dealing rules');
