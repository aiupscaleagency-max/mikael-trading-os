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
 console.log('PASS: fyra laptopkolumner, mobil utan overflow, Krypto/Forex, kopiering utan order, oberoende tider, risksizing, simulering, väntande→accepterad→öppen, stängning, double up, roll over, session start/stopp, stale/offline/inga signaler, inga externa orderanrop eller JS-fel');
}finally{await browser.close();server.close();}
