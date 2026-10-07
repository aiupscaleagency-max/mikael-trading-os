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
  {epic:'FIX.EUR',name:'EUR / USD',type:'CURRENCIES',marketStatus:'TRADEABLE'}
 ];
 let connected=false,failConnect=false,connectGate=null,connectRequests=0,marketRequests=0,marketGate=null,workspaceMarkets=[];
 const fixtureWrites=[];
 await real.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;if(req.method()!=='GET')fixtureWrites.push(path);
  let data;
  if(path==='/api/ig/connect'){
   connectRequests++;if(connectGate)await connectGate.promise;
   if(failConnect){await route.fulfill({status:401,json:{error:'Fixture: Demo-inloggning nekad'}});return;}
   connected=true;data={environments:{demo:{status:'connected'}}};
  }else if(path==='/api/ig/workspace')data={connection:{status:connected?'connected':'missing',account:connected?{currency:'USD',balance:1000,available:900,profitLoss:0}:null},selection:{epics:[],timeframe:'5m'},positions:[],markets:workspaceMarkets,execution:{enabled:false,reason:'Fixture · order avstängda'}};
  else if(path==='/api/ig/markets'){marketRequests++;if(marketGate)await marketGate.promise;data={markets};}
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
 await real.locator('[data-category="forex"]').click();assert.match(await real.locator('#instruments').textContent(),/EUR/);assert.doesNotMatch(await real.locator('#instruments').textContent(),/Bitcoin/);
 failConnect=true;connectGate=null;await real.click('#connect');await real.waitForFunction(()=>document.querySelector('#notice').textContent.includes('inloggning nekad'));
 await real.click('#signals-refresh');await real.waitForTimeout(100);assert.match(await real.locator('#notice').textContent(),/kunde inte anslutas.*inloggning nekad/,'Anslutningsfel kvarstår efter polling');
 failConnect=false;workspaceMarkets=markets;await real.reload();marketGate=gate();const beforeMarkets=marketRequests;await real.click('#connect');
 while(marketRequests===beforeMarkets)await real.waitForTimeout(25);
 await real.click('#catalog-open');await real.locator('#catalog-content [data-chart="FIX.EUR"]').click();marketGate.release();await real.waitForFunction(()=>!document.querySelector('#connect').disabled);
 assert.match(await real.locator('#instrument-name').textContent(),/EUR/,'Anslutningen ersätter inte instrumentet som väljs under sökning');
 workspaceMarkets=[];marketGate=null;await real.reload();marketGate=gate();const beforeRace=marketRequests;await real.click('#connect');
 while(marketRequests===beforeRace)await real.waitForTimeout(25);
 await real.click('#settings-open');await real.click('#simulation-toggle');await real.click('[data-close="settings-dialog"]');marketGate.release();await real.waitForTimeout(200);
 assert.equal(await real.locator('#connect').isDisabled(),true,'Slutförd gammal anslutning återaktiverar inte knappen i designläge');assert.match(await real.locator('#notice').textContent(),/DESIGNLÄGE/);
 assert.equal(connectRequests,4);assert.deepEqual(fixtureWrites,Array(4).fill('/api/ig/connect'));await real.close();
 console.log('PASS: fyra laptopkolumner, mobil utan overflow, Krypto/Forex, kopiering utan order, oberoende tider, risksizing, simulering, väntande→accepterad→öppen, stängning, double up, roll over, session start/stopp, stale/offline/inga signaler, IG-fixture anslutning/fel/filter/polling/instrumentrace, inga externa orderanrop eller JS-fel');
}finally{await browser.close();server.close();}
