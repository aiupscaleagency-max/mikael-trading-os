import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {saveIgCredentials,localIgCredentialRequest} from '../src/integrations/igCredentialStore.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ig-credentials-')),file=path.join(dir,'credentials.json');
fs.writeFileSync(file,JSON.stringify({live:{apiKey:'l'.repeat(40),identifier:'LIVE_USER',password:'live-test-pass',accountId:'LIVE_CFD'},demo:{apiKey:'d'.repeat(40),identifier:'DEMO_USER',password:'demo-test-pass',accountId:'DEMO_CFD'}}),{mode:0o600});
const result=saveIgCredentials({environment:'demo',identifier:'NEW_DEMO',password:'',apiKey:''},file);
assert.deepEqual(result,{environment:'demo',saved:true});const stored=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(stored.demo.password,'demo-test-pass');assert.equal(stored.demo.apiKey,'d'.repeat(40));assert.equal(stored.demo.accountId,'DEMO_CFD');assert.equal(stored.live.identifier,'LIVE_USER');assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.readdirSync(dir).length,1);
assert.throws(()=>saveIgCredentials({environment:'live',identifier:'email@example.test'},file),/användarnamn/);assert.throws(()=>saveIgCredentials({environment:'live',file:'/wrong',password:'test'},file),/okända/);assert.throws(()=>saveIgCredentials({environment:'live',password:''},file),/minst/);assert.throws(()=>saveIgCredentials({environment:'other',password:'test'},file),/Demo/);
const link=path.join(dir,'linked.json');fs.symlinkSync(file,link);assert.throws(()=>saveIgCredentials({environment:'demo',password:'changed'},link),/säkert/);fs.chmodSync(file,0o644);assert.throws(()=>saveIgCredentials({environment:'demo',password:'changed'},file),/säkert/);
const request={address:'127.0.0.1',host:'localhost:3939',origin:'http://localhost:3939',contentType:'application/json'};assert.equal(localIgCredentialRequest(request),true);for(const patch of [{address:'100.64.0.1'},{host:'localhost.evil:3939',origin:'http://localhost.evil:3939'},{origin:'https://evil.test'},{origin:undefined},{fetchSite:'cross-site'},{contentType:'text/plain'}])assert.equal(localIgCredentialRequest({...request,...patch}),false);assert.equal(localIgCredentialRequest({...request,address:'::1',host:'[::1]:3939',origin:'http://[::1]:3939'}),true);
console.log('PASS: lokala IG-uppgifter, blankfält bevarar andra miljön/nycklar/konto-ID, atomisk privat 600-fil, symlink/rättigheter, validering, inga credentials i svar och strikt loopback/samma origin; bara temporära testfiler');

const {createIgConnection}=await import('../src/integrations/igConnection.js');
let target='WRONG';const urls:string[]=[];
const conn=createIgConnection({loadCredentials:()=>({demo:{apiKey:'fixture',identifier:'DEMO_USER',password:'fixture-password',accountId:target}}),fetch:async(url)=>{urls.push(String(url));return String(url).endsWith('/session')?new Response(JSON.stringify({currentAccountId:'DEMO_CFD'}),{headers:{CST:'fixture-cst','X-SECURITY-TOKEN':'fixture-xst'}}):new Response(JSON.stringify({accounts:[{accountId:'DEMO_CFD',accountType:'CFD',currency:'SEK',balance:{balance:1000,available:1000,profitLoss:0}}]}));}});
assert.equal((await conn.testConnection('demo')).status,'error');target='DEMO_CFD';assert.equal((await conn.testConnection('demo')).status,'connected');assert.ok(urls.every(u=>u.startsWith('https://demo-api.ig.com/')));
console.log('PASS: automatisk rätt Demo-API-domän och förväntat CFD-konto; fel konto stoppas utan Live-fallback eller order');

const rateConn=createIgConnection({loadCredentials:()=>({demo:{apiKey:'fixture',identifier:'DEMO_USER',password:'fixture-password'}}),fetch:async(url)=>String(url).includes('/markets')?new Response(JSON.stringify({errorCode:'error.public-api.exceeded-account-allowance'}),{status:403}):String(url).endsWith('/session')?new Response(JSON.stringify({currentAccountId:'DEMO_CFD'}),{headers:{CST:'fixture-cst','X-SECURITY-TOKEN':'fixture-xst'}}):new Response(JSON.stringify({accounts:[{accountId:'DEMO_CFD',accountType:'CFD'}]}))});
await rateConn.testConnection('demo');await assert.rejects(rateConn.callAuthenticated('demo','markets'),/begränsade antal läsanrop/);assert.equal(rateConn.getStatus().environments.demo.status,'connected','Mäklarens läskvot får inte felmärkas som felaktig inloggning');
console.log('PASS: IG allowance-403 bevarar verifierad session och ger säkert återförsöksfel');
