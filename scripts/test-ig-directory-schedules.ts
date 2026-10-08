import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createIgWorkspace} from '../src/integrations/igWorkspace.js';
import {createIgConnection} from '../src/integrations/igConnection.js';
import {createIgSchedules,stockholmSlot} from '../src/integrations/igSchedules.js';
import {createIgMarketDirectory,enrichIgDirectoryMarket} from '../src/integrations/igMarketDirectory.js';
let now=Date.parse('2026-10-07T07:00:00Z'),generation='one',starts=0;
const status=()=>({environments:{demo:{status:'connected',connectionGeneration:generation},live:{status:'disconnected'}}}) as any;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ig-schedule-test-'));
const deps={status,now:()=>now,directory,guard:async()=>true,start:async()=>{starts++;return {} as any;}};
const service=createIgSchedules(deps);
const input={name:'Morgon',epics:['CS.D.EURUSD.CFD.IP'],timeframe:'5m' as const,percent:1,horizonMinutes:15,durationMinutes:15,intervalMinutes:5,localTime:'09:00',weekdays:[3],enabled:true};
const schedule=service.save('demo',input);
await service.tick();await service.tick();assert.equal(starts,1,'Dubbletter startar inte igen');
now+=60000;await service.tick();assert.equal(starts,1);
generation='two';await service.tick();assert.equal(service.list('demo')[0]?.enabled,false,'Ny anslutning pausar');
service.enable('demo',schedule.id,true);assert.equal(createIgSchedules(deps).list('demo')[0]?.enabled,false,'Omstart kräver aktivering');
assert.equal(stockholmSlot(Date.parse('2026-10-25T00:30:00Z')).time,'02:30');assert.equal(stockholmSlot(Date.parse('2026-10-25T01:30:00Z')).time,'02:30');
assert.equal(enrichIgDirectoryMarket({bid:3,offer:2,percentageChange:-2}).spread,null);assert.equal(enrichIgDirectoryMarket({percentageChange:-2}).movementPercent,2);
// Reservkällans progression och verifierade fullständighet får inte försvinna.
const partialDirectory=createIgMarketDirectory({status,now:()=>now,budget:()=>({remaining:0,used:10}) as any,fallback:async()=>({markets:[],complete:false,remainingSearches:7,source:'IG kontosökning',note:'Återuppta'}) as any});
assert.equal((await partialDirectory.catalogue('demo','crypto')).remainingSearches,7);
const completeDirectory=createIgMarketDirectory({status,now:()=>now,budget:()=>({remaining:0,used:10}) as any,fallback:async()=>({markets:[],complete:true,remainingSearches:0,source:'IG aktiverade kontokategorier',note:'Tom men komplett'}) as any});
assert.equal((await completeDirectory.catalogue('demo','crypto')).complete,true);
let calls=0;
const catalog=createIgMarketDirectory({status,now:()=>now,budget:()=>({remaining:10,used:0}) as any,call:async()=>{throw Error('Ingen andra traversal får starta');},fallback:(async()=>{calls++;return {markets:[{epic:'A',name:'EUR/USD',type:'CURRENCIES'}],note:'Delvis'};}) as any});
const result=await catalog.catalogue('demo','forex');assert.equal(result.complete,false);assert.equal(result.markets.length,1);assert.equal(result.rankings.mostBought.available,false);await catalog.catalogue('demo','forex');assert.equal(calls,1);generation='three';await catalog.catalogue('demo','forex');assert.equal(calls,2,'Cache isoleras per kontoanslutning');
const officialWorkspace=createIgWorkspace({directory:path.join(directory,'official'),status,now:()=>now,call:async(_mode,endpoint)=>endpoint==='categories'?{categories:[{code:'CURRENCIES'}]}:{instruments:[{epic:'EUR',instrumentName:'EUR/USD',instrumentType:'CURRENCIES',bid:1,offer:1.1,percentageChange:2}],metadata:{pageNumber:0,pageSize:1000}}});
const official=createIgMarketDirectory({status,now:()=>now,fallback:officialWorkspace.catalogue});
const all=await official.catalogue('demo','forex');assert.equal(all.complete,true);assert.equal(all.markets[0].changePercent,2);assert.equal(all.rankings.gainers.available,true);
// Stor kategori fortsätter efter budgetgränsen. Ingen andra traversal får svälta cursorn.
let pageClock=now;const pageReads:{at:number;route:string;page:number}[]=[];
const progressiveWorkspace=createIgWorkspace({directory:path.join(directory,'progressive'),status,now:()=>pageClock,call:async(_mode,route,_method,_version,_body,extra)=>{
 const page=Number(new URLSearchParams(extra?.query).get('pageNumber'));pageReads.push({at:pageClock,route,page});
 if(route==='categories')return {categories:[{code:'CURRENCIES'}]};
 return {instruments:page<12?Array.from({length:1000},(_,i)=>({epic:`PAGE.${page}.${i}`,instrumentName:i%2?'Bitcoin / USD':'EUR/USD',instrumentType:'CURRENCIES'})):[],metadata:{pageNumber:page,pageSize:1000}};
}});
let duplicateTraversals=0;const progressive=createIgMarketDirectory({status,now:()=>pageClock,fallback:progressiveWorkspace.catalogue,call:async()=>{duplicateTraversals++;throw Error('Dubbel traversal');}});
let pf=await progressive.catalogue('demo','forex'),pc=await progressive.catalogue('demo','crypto');assert.equal(pf.complete,false);assert.ok(pf.markets.length>0);assert.ok(pc.remainingSearches!>0);
for(let i=0;i<3&&!pf.complete;i++){pageClock+=61000;pf=await progressive.catalogue('demo','forex');pc=await progressive.catalogue('demo','crypto');}
assert.equal(duplicateTraversals,0,'Directory får inte starta en andra kategoritraversal');assert.equal(pf.complete,true);assert.equal(pc.complete,false,'Demo-krypto kan inte bekräftas komplett enbart från kategoriindex');assert.equal(pf.markets.length,6000);assert.equal(pc.markets.length,6000);assert.equal(pageReads.filter(x=>x.route==='categories').length,1);
for(const at of new Set(pageReads.map(x=>x.at)))assert.ok(pageReads.filter(x=>x.at===at).length<=10,'Katalogen håller minutbudgeten');
let releaseDirectory!:()=>void;const blockedDirectory=new Promise<void>(r=>{releaseDirectory=r;});const directoryRace=createIgMarketDirectory({status,now:()=>now,fallback:(async()=>{await blockedDirectory;return {markets:[],complete:true,remainingSearches:0};}) as any});
const staleDirectory=directoryRace.catalogue('demo','forex');generation='directory-new-account';releaseDirectory();await assert.rejects(staleDirectory,/kontoanslutningen ändrades/);
now=Date.parse('2026-10-25T00:30:00Z');
service.save('demo',{...input,localTime:'02:30',weekdays:[7]});await service.tick();const afterFirst=starts;now=Date.parse('2026-10-25T01:30:00Z');await service.tick();assert.equal(starts,afterFirst,'DST-hösttimmen körs endast en gång');
const enriched=createIgMarketDirectory({status,now:()=>now,budget:()=>({remaining:10,used:0}) as any,call:async(_mode,endpoint)=>endpoint.startsWith('markets/')?{instrument:{epic:'EUR',marketId:'EURUSD'}}:{marketId:'EURUSD',longPositionPercentage:60,shortPositionPercentage:40},candles:async()=>({candles:Array.from({length:50},(_,i)=>({openTime:now-(50-i)*3600000,closeTime:now-(49-i)*3600000,close:100+i}))}) as any});
const metrics=await enriched.enrich('demo','EUR');assert.equal(metrics.sentimentLongPercent,60);assert.ok(metrics.trendScore!>0);
const emptyOfficial=createIgMarketDirectory({status,now:()=>now,budget:()=>({remaining:10,used:0}) as any,call:async(_mode,endpoint)=>endpoint==='categories'?{categories:[{code:'CURRENCIES'}]}:{instruments:[],metadata:{pageNumber:0,pageSize:1000}},fallback:async()=>({markets:[],note:'Sökreserv'}) as any});assert.equal((await emptyOfficial.catalogue('demo','forex')).complete,false);
const raceDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'ig-race-test-'));let release!:()=>void;const blocked=new Promise<void>(r=>{release=r;});let raceStarts=0;
const race=createIgSchedules({...deps,directory:raceDirectory,start:async()=>{raceStarts++;await blocked;return {} as any;}});
now=Date.parse('2026-10-07T07:00:00Z');race.save('demo',input);const second=race.save('demo',{...input,name:'Andra'});const ticking=race.tick();await new Promise(r=>setImmediate(r));race.enable('demo',second.id,false);release();await ticking;assert.equal(raceStarts,1,'Pausat schema återstartas inte av stale snapshot');assert.equal(race.list('demo').find(x=>x.id===second.id)?.enabled,false);
now=Date.parse('2027-03-27T10:00:00Z');const spring=race.save('demo',{...input,recurrence:'once',date:'2027-03-28',localTime:'02:30'});now=Date.parse('2027-03-28T01:00:00Z');await race.tick();assert.equal(race.list('demo').find(x=>x.id===spring.id)?.enabled,false,'Vårhopp hoppas över och förfallet engångsschema pausas');
fs.rmSync(raceDirectory,{recursive:true,force:true});
const endpointCalls:string[]=[];const connection=createIgConnection({loadCredentials:()=>({demo:{apiKey:'fixture',identifier:'fixture',password:'fixture'}}),fetch:(async(url:string)=>{endpointCalls.push(url);return url.endsWith('/session')?new Response(JSON.stringify({currentAccountId:'account'}),{headers:{CST:'fixture','X-SECURITY-TOKEN':'fixture'}}):url.endsWith('/accounts')?new Response(JSON.stringify({accounts:[{accountId:'account',accountType:'CFD'}]})):new Response('{}');}) as typeof fetch});await connection.testConnection('demo');await connection.callAuthenticated('demo','categories');await connection.callAuthenticated('demo','categories/CURRENCIES/instruments','GET','1',undefined,{query:'pageNumber=0&pageSize=1000'});await connection.callAuthenticated('demo','client-sentiment/EURUSD');assert.ok(endpointCalls.some(x=>x.endsWith('/categories/CURRENCIES/instruments?pageNumber=0&pageSize=1000')));
const allowedCalls=endpointCalls.length;await assert.rejects(connection.callAuthenticated('demo','categories/CURRENCIES/instruments','GET','1',undefined,{query:'pageSize=1001'}));await assert.rejects(connection.callAuthenticated('demo','categories/CURRENCIES/instruments','GET','1',undefined,{query:'referenceEpic=private'}));await assert.rejects(connection.callAuthenticated('demo','client-sentiment/EURUSD','POST','1'));assert.equal(endpointCalls.length,allowedCalls,'Otillåtna kategorianrop blockeras före nätverket');
let sessionAllowed=true,finishMarket!:()=>void;let enteredMarket!:()=>void;const entered=new Promise<void>(r=>enteredMarket=r);const waitingMarket=new Promise<void>(r=>finishMarket=r);const cancelWorkspace=createIgWorkspace({status,now:()=>now,directory:path.join(directory,'cancel-start'),call:async(_mode,route)=>{enteredMarket();await waitingMarket;return {instrument:{epic:'EUR',type:'CURRENCIES'},snapshot:{},dealingRules:{}};}});
const pendingStart=cancelWorkspace.startSession('demo',{...input,epics:['EUR']},()=>sessionAllowed);await entered;sessionAllowed=false;finishMarket();await assert.rejects(pendingStart,/start avbruten/);assert.equal((await cancelWorkspace.workspace('demo')).session,null,'Paus under metadatahämtning skapar ingen session');
fs.rmSync(directory,{recursive:true,force:true});console.log('IG directory + schedules: alla kontroller godkända');

// Bakgrundsladdningen fortsätter även utan öppen handelsflik, i båda miljöer.
{
 let clock=now,gen='scan-a',connected=true;const scans:string[]=[];
 const scanner=createIgMarketDirectory({now:()=>clock,status:()=>({environments:{demo:{status:connected?'connected':'disconnected',connectionGeneration:gen},live:{status:'connected',connectionGeneration:'scan-live'}}}) as any,fallback:async(mode,category)=>{scans.push(`${mode}:${category}`);return {markets:[],complete:false,remainingSearches:20,progress:{reason:'budget'},error:'IG-kategorifel',source:'fixture'} as any;}});
 await Promise.all([scanner.tickCatalogues(),scanner.tickCatalogues()]);
 assert.deepEqual(scans,['demo:forex','demo:crypto','live:forex','live:crypto'],'Singleflight, endast läskataloger och båda miljöerna');
 const result=await scanner.catalogue('demo','forex');assert.equal(result.progress.reason,'budget');assert.equal(result.error,'IG-kategorifel','Diagnosen bevaras till UI');
 clock+=64000;await scanner.tickCatalogues();assert.equal(scans.length,4,'Ingen tät katalogpollning');
 clock+=1000;await scanner.tickCatalogues();assert.deepEqual(scans.slice(4),['demo:crypto','demo:forex','live:crypto','live:forex'],'Nästa kategori får första budgetchansen');
 gen='scan-b';await scanner.tickCatalogues();assert.deepEqual(scans.slice(-2),['demo:forex','demo:crypto'],'Ny kontobindning laddas direkt, inte gammal cache');
 connected=false;clock+=65000;const before=scans.length;await scanner.tickCatalogues();assert.deepEqual(scans.slice(before),['live:forex','live:crypto'],'Frånkopplad miljö hoppas över');
 console.log('PASS: kontobunden automatisk katalogladdning i Demo/Live, rotation, cooldown, diagnoser och singleflight');
}

// En aktiv kryptoflik kommer alltid före bakgrunden: Forex ska ändå göra framsteg.
{
 let clock=now;const requests:{mode:string;at:number;term:string|null}[]=[];
 const both=()=>({environments:{demo:{status:'connected',connectionGeneration:'fair-demo'},live:{status:'connected',connectionGeneration:'fair-live'}}}) as any;
 const work=createIgWorkspace({directory:path.join(directory,'fair'),status:both,now:()=>clock,call:async(mode,route,_method,_version,_body,extra)=>{
  const term=new URLSearchParams(extra?.query).get('searchTerm');requests.push({mode,at:clock,term});
  if(route==='categories')throw Error('IG svarade HTTP 404');
  return {markets:[{epic:`FX.${term}`,instrumentName:'EUR/USD',instrumentType:'CURRENCIES'},{epic:`CR.${term}`,instrumentName:'Bitcoin',instrumentType:'CURRENCIES'}]};
 }});
 const dir=createIgMarketDirectory({status:both,now:()=>clock,fallback:work.catalogue});
 const previous=new Map<string,number>();
 for(let round=0;round<4;round++){
  for(const mode of ['demo','live'] as const){
   // Vanlig kontoläsning konkurrerar; två kryptoklienter får inte dubblera budgeten.
   for(let i=0;i<5;i++)await work.searchMarkets(mode,`ordinary-${round}-${i}`);
   await Promise.all([dir.catalogue(mode,'crypto'),dir.catalogue(mode,'crypto')]);
  }
  clock+=6000;
  for(const mode of ['demo','live'] as const){
   const forex=await dir.catalogue(mode,'forex');
   assert.ok(forex.markets.length>0,'Kryptofliken får inte lämna Forex tom');
   assert.ok(forex.remainingSearches!<(previous.get(mode)??36),'Forex går framåt varje minut trots tidigare kryptoklienter');
   previous.set(mode,forex.remainingSearches!);
  }
  await dir.tickCatalogues();
  for(const mode of ['demo','live'])assert.ok(requests.filter(r=>r.mode===mode&&r.at>=clock-6000).length<=14,'Vanliga läsningar plus katalog håller central reserv');
  clock+=61000;
 }
 console.log('PASS: två kryptoklienter, bakgrundshämtning och vanliga GET kan inte svälta Forex i Demo/Live');
}
