// Isolerad webbserver: testet får aldrig anropa IG, AI eller den körande servern.
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let playwright;try{playwright=require(process.env.PLAYWRIGHT_PATH??'playwright');}catch{playwright=require(`${process.env.HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`);}const {chromium}=playwright;
const root=new URL('../',import.meta.url);const writes=[];
const server=http.createServer(async(req,res)=>{try{
  let path=req.url.split('?')[0],file=path==='/'?'dashboard.html':path.startsWith('/workspace/')?`src/server/ui/workspace/${path.slice(11)}`:path==='/vendor/lightweight-charts.js'?'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js':null;
  if(path.startsWith('/api/')){if(req.method!=='GET')writes.push(path);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({environment:'demo',connection:{status:'missing'},selection:{epics:[],timeframe:'5m'},positions:[],execution:{enabled:false,reason:'Fixture · inga order'}}));return;}
  if(!file){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'text/javascript');res.end(await fs.readFile(new URL(file,root)));
}catch(e){res.writeHead(500);res.end(e.message);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.click('#settings-open');await page.click('#simulation-toggle');await page.click('[data-close="settings-dialog"]');
 await page.waitForSelector('.signal-card');assert.match(await page.locator('#notice').textContent(),/DEMODATA|DESIGNLÄGE/);
 await page.screenshot({path:'/tmp/trading-workspace-desktop.png',fullPage:true});
 const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,panels:[...document.querySelectorAll('.workspace>.panel')].map(p=>({x:p.getBoundingClientRect().x,width:p.getBoundingClientRect().width}))}));assert.equal(geometry.overflow,false);assert.equal(geometry.panels.length,4);
 await page.locator('[data-category="forex"]').click();assert.match(await page.locator('#instruments').textContent(),/EUR/);await page.locator('[data-chart="DEMO.EUR.USD"]').first().click();assert.match(await page.locator('#instrument-name').textContent(),/EUR/);
 await page.locator('[data-copy="DEMO.BTC.USD"]').click();assert.match(await page.locator('#instrument-name').textContent(),/Bitcoin/);assert.equal(await page.locator('#holding').inputValue(),'15');
 const originalStop=await page.locator('#stop').inputValue();await page.locator('[data-frame="5m"]').click();assert.equal(await page.locator('#stop').inputValue(),originalStop,'Diagramintervall ändrar inte orderutkastet');
 await page.locator('[data-percent="1"]').click();assert.match(await page.locator('#scenario-note').textContent(),/risk 1|risk 0,9/);
 const positions=await page.locator('.trade-card').count();await page.click('#review-order');assert.equal(await page.locator('.trade-card').count(),positions);await page.click('#confirm-order');assert.equal(await page.locator('.trade-card').count(),positions+1);
 await page.locator('[data-double="demo-eur"]').click();assert.equal(await page.locator('#size').inputValue(),'2');assert.equal(await page.locator('.trade-card').count(),positions+1);
 await page.locator('[data-roll="demo-eur"]').click();assert.match(await page.locator('#review-content').textContent(),/ingen fast utgångstid/);await page.click('#confirm-order');
 await page.locator('[data-close-position="demo-eur"]').click();await page.click('#confirm-order');await page.waitForTimeout(550);assert.equal(await page.locator('.trade-card').count(),positions);await page.locator('[data-trades="closed"]').click();assert.match(await page.locator('#trades').textContent(),/Manuell stängning/);
 await page.locator('[data-trades="pending"]').click();await page.locator('[data-fill="demo-limit"]').click();await page.waitForTimeout(450);assert.match(await page.locator('#trades').textContent(),/Ethereum/);
 await page.click('#session-open');await page.locator('#session-form button[type="submit"]').click();await page.waitForTimeout(1400);assert.match(await page.locator('#session-status').textContent(),/Aktiv/);await page.click('#session-stop');assert.match(await page.locator('#session-status').textContent(),/Stoppad/);
 await page.click('#settings-open');await page.selectOption('#demo-state','stale');await page.click('[data-close="settings-dialog"]');assert.equal(await page.locator('#review-order').isDisabled(),true);
 await page.click('#settings-open');await page.selectOption('#demo-state','disconnected');await page.click('[data-close="settings-dialog"]');assert.equal(await page.locator('#analyze').isDisabled(),true);
 await page.click('#settings-open');await page.selectOption('#demo-state','empty');await page.click('[data-close="settings-dialog"]');assert.equal(await page.locator('.signal-card').count(),0);
 await page.click('#settings-open');await page.selectOption('#demo-state','ready');await page.click('[data-close="settings-dialog"]');
 await page.setViewportSize({width:1180,height:760});await page.screenshot({path:'/tmp/trading-workspace-laptop.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.setViewportSize({width:390,height:844});await page.locator('button[data-panel="chart"]').click();await page.screenshot({path:'/tmp/trading-workspace-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const selected=await page.locator('#instrument-name').textContent();await page.locator('button[data-panel="order"]').click();assert.equal(await page.locator('#order-symbol').textContent(),selected);await page.locator('button[data-panel="activity"]').click();assert.equal(await page.locator('.signals-section').isVisible(),true);assert.equal(await page.locator('.trades-section').isVisible(),true);
 await page.locator('[data-mode="live"]').click();assert.match(await page.locator('#notice').textContent(),/DESIGNLÄGE/);assert.deepEqual(writes,[],'Designläge skickar inga API-mutationer');assert.deepEqual(errors,[]);
 // Verkligt UI-flöde med helt lokala API-fixtures; ingen anslutning till IG görs.
 const real=await browser.newPage({viewport:{width:1440,height:900}});real.on('pageerror',e=>errors.push(e.message));
 const markets=[
  {epic:'FIX.STOCK',name:'Bitcoin Mining Aktie',type:'SHARES',marketStatus:'TRADEABLE'},
  {epic:'FIX.ETF',name:'Bitcoin ETF',type:'ETF',marketStatus:'TRADEABLE'},
  {epic:'FIX.UNKNOWN',name:'Bitcoin okänd typ',marketStatus:'TRADEABLE'},
  {epic:'FIX.CLOSED',name:'Bitcoin stängd',type:'CURRENCIES',marketStatus:'CLOSED'},
  {epic:'FIX.BTC',name:'Bitcoin / USD',type:'CURRENCIES',marketStatus:'TRADEABLE'},
  {epic:'FIX.EUR',name:'EUR / USD',type:'CURRENCIES',marketStatus:'TRADEABLE'},
  {epic:'FIX.GBP',name:'GBP / AUD',type:'CURRENCIES',category:'forex',marketStatus:'TRADEABLE'},
  {epic:'FIX.NOK',name:'NOK / SEK',type:'CURRENCIES',category:'forex',marketStatus:'TRADEABLE'},
  {epic:'FIX.CARDANO',name:'Cardano',type:'CURRENCIES',category:'crypto',marketStatus:'TRADEABLE'},
  {epic:'FIX.TRON',name:'TRON',type:'CURRENCIES',category:'crypto',marketStatus:'TRADEABLE'},
  ...['USD / JPY','GBP / JPY','AUD / JPY','EUR / GBP','CAD / CHF','USD / CHF','USD / NOK','EUR / SEK'].map((name,i)=>({epic:`FIX.FOREX.${i}`,name,type:'CURRENCIES',category:'forex',marketStatus:'TRADEABLE'}))
 ];
 let catalogComplete=true,catalogFailure=false,fixtureSelection=[],fixtureAnalysis=null;const discovery=[],credentialRequests=[];let credentialAuthFails=false;
 let connected=false,failConnect=false,connectGate=null,connectRequests=0,marketRequests=0,marketGate=null,workspaceMarkets=[];
 const fixtureWrites=[];
 await real.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;if(req.method()!=='GET')fixtureWrites.push(path);
  let data;
  if(path==='/api/ig/status')data={environments:{demo:{status:connected?'connected':'missing',credentialsComplete:false}}};
  else if(path==='/api/ig/connect'){
   connectRequests++;if(connectGate)await connectGate.promise;
   if(failConnect){await route.fulfill({status:401,json:{error:'Fixture: Demo-inloggning nekad'}});return;}
   connected=true;data={environments:{demo:{status:'connected'}}};
  }else if(path==='/api/ig/workspace')data={connection:{status:connected?'connected':'missing',account:connected?{currency:'USD',balance:1000,available:900,profitLoss:0}:null},selection:{epics:fixtureSelection,timeframe:'5m'},analysis:fixtureAnalysis,positions:[],markets:workspaceMarkets,execution:{enabled:false,reason:'Fixture · order avstängda'}};
  else if(path==='/api/ig/catalog'){if(catalogFailure){await route.fulfill({status:503,json:{error:'Fixture katalog offline'}});return;}marketRequests++;if(marketGate)await marketGate.promise;const category=new URL(req.url()).searchParams.get('category');data={markets:markets.filter(m=>m.type==='CURRENCIES'&&(m.category??(/Bitcoin/.test(m.name)?'crypto':'forex'))===category).map(m=>({...m,category})),status:catalogComplete?'ready':'partial',complete:catalogComplete,category,updatedAt:Date.now()};}
  else if(path==='/api/ig/credentials'){credentialRequests.push(req.postDataJSON());data={environments:{demo:{status:credentialAuthFails?'error':'connected',error:credentialAuthFails?'Fixture API-inloggning nekad':null}},test:{ok:!credentialAuthFails,error:credentialAuthFails?'Fixture API-inloggning nekad':null}};}
  else if(path==='/api/ig/selection'){fixtureSelection=req.postDataJSON().epics;data={ok:true};}
  else if(path==='/api/ig/analysis'){fixtureAnalysis={status:'completed',selection:req.postDataJSON(),completedAt:Date.now(),head:{analyses:[]}};data=fixtureAnalysis;}
  else if(path==='/api/ig/markets'){discovery.push(new URL(req.url()).searchParams.get('searchTerm'));data={markets:[{epic:'FIX.EXTRA',name:'MXN / NOK',type:'CURRENCIES',category:'forex',marketStatus:'TRADEABLE'}]};}
  else if(path==='/api/ig/market'){const epic=new URL(req.url()).searchParams.get('epic');data={...markets.find(m=>m.epic===epic),quote:{bid:100,offer:101,receivedAt:Date.now(),observedAt:Date.now(),marketStatus:'TRADEABLE',delayTime:0},instrument:{decimalPlacesFactor:2}};}
  else if(path==='/api/ig/candles')data={candles:[]};
  else throw Error(`Otillåtet fixture-anrop: ${path}`);
  await route.fulfill({json:data});
 });
 const gate=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};
 await real.goto(`http://127.0.0.1:${server.address().port}/`);
 connectGate=gate();await real.click('#connect');await real.waitForFunction(()=>document.querySelector('#connect').textContent.includes('Ansluter'));
 await real.click('#signals-refresh');await real.waitForTimeout(100);assert.equal(await real.locator('#connect').isDisabled(),true,'Polling återaktiverar inte anslutningsknappen');
 connectGate.release();await real.waitForFunction(()=>document.querySelector('#instrument-name').textContent.includes('Bitcoin / USD'));
 await real.waitForFunction(()=>!document.querySelector('#connect').disabled);
 assert.equal(await real.locator('[data-chart="FIX.STOCK"]').count(),0);assert.equal(await real.locator('[data-chart="FIX.ETF"]').count(),0);assert.equal(await real.locator('[data-chart="FIX.UNKNOWN"]').count(),0);
 assert.match(await real.locator('#notice').textContent(),/ansluten.*Diagrammet/);
 // Hela kategoriurvalet, separat dialogsökning, favoriter och synkat analysurval.
 assert.match(await real.locator('#instruments').textContent(),/Cardano/);assert.match(await real.locator('#instruments').textContent(),/TRON/);
 await real.click('#catalog-open');await real.locator('#catalog-content [data-chart="FIX.CARDANO"]').click();await real.waitForFunction(()=>document.querySelector('#instrument-name').textContent.includes('Cardano'));assert.match(await real.locator('#market-kind').textContent(),/KRYPTO/);await real.click('#catalog-open');await real.fill('#catalog-search','TRON');assert.equal(await real.locator('#catalog-content .catalog-row').count(),1);await real.locator('#catalog-content [data-star="FIX.TRON"]').click();
 await real.locator('[data-catalog-category="favorites"]').click();await real.waitForFunction(()=>document.querySelector('#catalog-content').textContent.includes('TRON'));assert.equal(await real.locator('#catalog-content .catalog-row').count(),1);
 await real.locator('[data-catalog-category="forex"]').click();await real.waitForFunction(()=>document.querySelector('#catalog-content').textContent.includes('NOK'));assert.equal(await real.locator('#catalog-search').inputValue(),'');assert.match(await real.locator('#catalog-content').textContent(),/GBP \/ AUD/);await real.screenshot({path:'/tmp/trading-workspace-catalog.png'});await real.setViewportSize({width:390,height:844});assert.equal(await real.locator('#catalog-dialog').evaluate(d=>d.scrollWidth>d.clientWidth),false);await real.screenshot({path:'/tmp/trading-workspace-catalog-mobile.png'});await real.setViewportSize({width:1440,height:900});
 await real.click('[data-close="catalog-dialog"]');await real.fill('#search','GBP');await real.click('#catalog-open');await real.fill('#catalog-search','NOK');assert.match(await real.locator('#catalog-content').textContent(),/NOK/);assert.doesNotMatch(await real.locator('#catalog-content').textContent(),/GBP/);assert.equal(await real.locator('#search').inputValue(),'GBP','Dialogsökningen är oberoende av sidopanelen');
 await real.locator('#catalog-content [data-select="FIX.NOK"]').check();await real.waitForFunction(()=>document.querySelector('#selection-list').textContent.includes('NOK'));assert.match(await real.locator('#catalog-selection-count').textContent(),/1 \/ 10/);
 await real.click('#catalog-analyze');await real.waitForFunction(()=>document.querySelector('#analysis-status').textContent.includes('Analys klar'));assert.ok(fixtureWrites.includes('/api/ig/analysis'));assert.deepEqual(fixtureSelection,['FIX.NOK']);
 await real.click('#catalog-open');await real.fill('#catalog-search','');await real.locator('#catalog-content [data-chart="FIX.GBP"]').click();await real.waitForFunction(()=>document.querySelector('#instrument-name').textContent.includes('GBP'));assert.equal(await real.locator('#catalog-dialog').evaluate(d=>d.open),false,'Visa diagram stänger väljaren');
 await real.click('#catalog-open');await real.click('#catalog-select-results');assert.match(await real.locator('#toast').textContent(),/Max 10/);assert.match(await real.locator('#catalog-selection-count').textContent(),/1 \/ 10/,'Gränsen återställer inte det befintliga urvalet');catalogComplete=false;await real.click('#catalog-reload');await real.waitForFunction(()=>document.querySelector('#catalog-status').textContent.includes('ofullständig'));assert.match(await real.locator('#catalog-content').textContent(),/NOK/);
 await real.fill('#catalog-search','MXN');await real.waitForFunction(()=>document.querySelector('#catalog-content').textContent.includes('MXN'));assert.deepEqual(discovery,['MXN'],'Okänd lokal träff kompletteras genom IG-sökning');
 catalogFailure=true;await real.click('#catalog-reload');await real.waitForFunction(()=>document.querySelector('#catalog-status').textContent.includes('offline'));catalogFailure=false;catalogComplete=true;await real.click('#catalog-reload');await real.waitForFunction(()=>document.querySelector('#catalog-status').textContent.includes('Hela kategorin'));await real.click('[data-close="catalog-dialog"]');
 await real.fill('#search','');fixtureSelection=[];fixtureAnalysis=null;
 // Inloggningsformuläret använder bara inskrivna fixturevärden och visar aldrig sparade hemligheter.
 await real.click('#settings-open');assert.equal(await real.locator('#ig-password').inputValue(),'');assert.equal(await real.locator('#ig-api-key').inputValue(),'');
 await real.fill('#ig-identifier','fixture-user');await real.fill('#ig-password','fixture-password');await real.fill('#ig-api-key','fixture-api-key');await real.click('#ig-credentials-submit');await real.waitForFunction(()=>document.querySelector('#ig-credentials-feedback').textContent.includes('verifierat'));
 assert.deepEqual(credentialRequests[0],{environment:'demo',identifier:'fixture-user',password:'fixture-password',apiKey:'fixture-api-key'});assert.equal(await real.locator('#ig-password').inputValue(),'');assert.equal(await real.locator('#ig-api-key').inputValue(),'');
 credentialAuthFails=true;await real.fill('#ig-password','fixture-rejected-password');await real.click('#ig-credentials-submit');await real.waitForFunction(()=>document.querySelector('#ig-credentials-feedback').textContent.includes('nekad'));assert.match(await real.locator('#ig-credentials-feedback').textContent(),/sparades lokalt/);assert.equal(await real.locator('#ig-password').inputValue(),'');assert.equal(await real.locator('#ig-api-key').inputValue(),'');assert.equal(credentialRequests[1].apiKey,undefined,'Tomt nyckelfält skickas inte');await real.click('[data-close="settings-dialog"]');


 await real.locator('[data-category="forex"]').click();await real.waitForFunction(()=>document.querySelector('#instruments').textContent.includes('EUR'));assert.match(await real.locator('#instruments').textContent(),/EUR/);assert.doesNotMatch(await real.locator('#instruments').textContent(),/Bitcoin/);
 failConnect=true;connectGate=null;await real.click('#connect');await real.waitForFunction(()=>document.querySelector('#notice').textContent.includes('inloggning nekad'));
 await real.click('#signals-refresh');await real.waitForTimeout(100);assert.match(await real.locator('#notice').textContent(),/kunde inte anslutas.*inloggning nekad/,'Anslutningsfel kvarstår efter polling');
 failConnect=false;connected=false;workspaceMarkets=markets;await real.reload();marketGate=gate();const beforeMarkets=marketRequests;await real.click('#connect');
 while(marketRequests===beforeMarkets)await real.waitForTimeout(25);
 await real.click('#catalog-open');await real.locator('[data-catalog-category="forex"]').click({noWaitAfter:true});await real.locator('#catalog-content [data-chart="FIX.EUR"]').click();marketGate.release();await real.waitForFunction(()=>!document.querySelector('#connect').disabled);
 assert.match(await real.locator('#instrument-name').textContent(),/EUR/,'Anslutningen ersätter inte instrumentet som väljs under sökning');
 workspaceMarkets=[];marketGate=null;connected=false;await real.reload();marketGate=gate();const beforeRace=marketRequests;await real.click('#connect');
 while(marketRequests===beforeRace)await real.waitForTimeout(25);
 await real.click('#settings-open');await real.click('#simulation-toggle');await real.click('[data-close="settings-dialog"]');marketGate.release();await real.waitForTimeout(200);
 assert.equal(await real.locator('#connect').isDisabled(),true,'Slutförd gammal anslutning återaktiverar inte knappen i designläge');assert.match(await real.locator('#notice').textContent(),/DESIGNLÄGE/);assert.equal(await real.locator('[data-chart="FIX.CARDANO"]').count(),0,'Gammalt katalogsvar läcker inte över kontogenerationer');
 assert.equal(connectRequests,4);assert.equal(fixtureWrites.filter(p=>p==='/api/ig/connect').length,4);assert.ok(fixtureWrites.every(p=>['/api/ig/connect','/api/ig/selection','/api/ig/analysis','/api/ig/credentials'].includes(p)),'Fixture skickar inga orderanrop');await real.close();

 // Explicit Demo/Live-byte ansluter med befintliga uppgifter en gång; 401 ger ingen dold retry.
 const modePage=await browser.newPage();const modeConnections={demo:false,live:false},modeCounts={demo:0,live:0};let liveRejected=false;
 const modeState=environment=>({configured:true,credentialsComplete:true,status:modeConnections[environment]?'connected':environment==='live'&&liveRejected?'error':'configured',error:environment==='live'&&liveRejected?'Fixture Live nekad':null,account:modeConnections[environment]?{currency:'USD',balance:1000,available:900,profitLoss:0}:null});
 await modePage.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),environment=url.searchParams.get('environment')??'demo';let data;
  if(url.pathname==='/api/ig/status')data={environments:{demo:modeState('demo'),live:modeState('live')}};
  else if(url.pathname==='/api/ig/connect'){const mode=req.postDataJSON().environment;modeCounts[mode]++;modeConnections[mode]=!(mode==='live'&&liveRejected);data={environments:{demo:modeState('demo'),live:modeState('live')}};}
  else if(url.pathname==='/api/ig/workspace')data={connection:modeState(environment),selection:{epics:[],timeframe:'5m'},positions:[],execution:{enabled:false}};
  else if(url.pathname==='/api/ig/catalog'){const category=url.searchParams.get('category');data={markets:markets.filter(m=>category==='forex'?m.epic==='FIX.EUR':m.category==='crypto'||m.epic==='FIX.BTC').map(m=>({...m,category})),status:'ready',complete:true};}
  else if(url.pathname==='/api/ig/market')data={...markets.find(m=>m.epic===url.searchParams.get('epic')),quote:{bid:100,offer:101,receivedAt:Date.now(),observedAt:Date.now(),marketStatus:'TRADEABLE',delayTime:0},instrument:{decimalPlacesFactor:2}};
  else if(url.pathname==='/api/ig/candles')data={candles:Array.from({length:30},(_,i)=>({openTime:Date.UTC(2026,9,7,10,i),open:100,high:102,low:99,close:101}))};else throw Error(`Otillåtet mode-fixture-anrop: ${url.pathname}`);
  await route.fulfill({json:data});
 });
 await modePage.goto(`http://127.0.0.1:${server.address().port}/`);await modePage.waitForFunction(()=>document.querySelector('#connection').textContent.includes('IG Demo'));assert.equal(modeCounts.demo,1,'Starten återansluter endast vald Demo med färdiga uppgifter');await modePage.locator('[data-mode="demo"]').click();await modePage.waitForFunction(()=>document.querySelector('#connection').textContent.includes('IG Demo'));await modePage.waitForFunction(()=>!document.querySelector('#connect').disabled);assert.equal(modeCounts.demo,1,'Klick på aktiv men frånkopplad Demo ansluter exakt en gång');await modePage.locator('[data-mode="demo"]').click();assert.equal(modeCounts.demo,1,'Aktiv ansluten Demo återanvänds');await modePage.locator('[data-mode="live"]').click();await modePage.waitForFunction(()=>document.querySelector('#connection').textContent.includes('IG Live'));await modePage.waitForFunction(()=>!document.querySelector('#connect').disabled);assert.equal(modeCounts.live,1);
 await modePage.locator('[data-mode="demo"]').click();await modePage.waitForFunction(()=>document.querySelector('#connection').textContent.includes('IG Demo'));await modePage.waitForFunction(()=>!document.querySelector('#connect').disabled);assert.equal(modeCounts.demo,1);
 await modePage.locator('[data-mode="live"]').click();await modePage.waitForFunction(()=>document.querySelector('#connection').textContent.includes('IG Live'));assert.equal(modeCounts.live,1,'En befintlig anslutning återanvänds');
 await modePage.locator('[data-mode="demo"]').click();await modePage.waitForFunction(()=>document.querySelector('#connection').textContent.includes('IG Demo'));modeConnections.live=false;liveRejected=true;
 await modePage.locator('[data-mode="live"]').click();await modePage.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Live nekad'));assert.equal(modeCounts.live,2);await modePage.click('#signals-refresh');await modePage.waitForTimeout(5200);assert.equal(modeCounts.live,2,'Polling gör inget nytt inloggningsförsök efter nekad autentisering');assert.equal(modeCounts.demo,1);modeConnections.live=true;await modePage.reload();await modePage.waitForFunction(()=>document.querySelector('#instrument-name')?.textContent.includes('Bitcoin'));assert.equal(modeCounts.demo,1,'Omladdning återanvänder Demo och återställer diagraminstrument utan ny inloggning');assert.equal(await modePage.locator('#chart-empty').isVisible(),false,'Riktiga fixture-ljus visas efter omladdning');await modePage.locator('[data-category="forex"]').click();await modePage.locator('[data-chart="FIX.EUR"]').first().click();await modePage.waitForFunction(()=>document.querySelector('#instrument-name')?.textContent.includes('EUR'));await modePage.reload();await modePage.waitForFunction(()=>document.querySelector('#instrument-name')?.textContent.includes('EUR'));assert.equal(await modePage.locator('#chart-empty').isVisible(),false,'Forex-diagram återställs även utanför startkategorin');assert.equal(await modePage.locator('#session-max').inputValue(),'1');await modePage.close();
 console.log('PASS: fyra laptopkolumner, mobil utan overflow, Krypto/Forex, kopiering utan order, oberoende tider, risksizing, simulering, väntande→accepterad→öppen, stängning, double up, roll over, session start/stopp, stale/offline/inga signaler, IG-fixture katalogkategorier/sök/favoriter/urval/analys/partial/offline, anslutning/fel/filter/polling/instrumentrace, inga externa orderanrop eller JS-fel');
}finally{await browser.close();server.close();}
