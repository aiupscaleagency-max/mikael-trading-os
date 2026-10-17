// IG:s egna listor (Populära marknader, Större valutapar …): bara läsning, rätt adress och rätt kategorier.
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {createIgConnection} from "../src/integrations/igConnection.js";
import {createIgMarkets,igMarketCategory} from "../src/integrations/igMarkets.js";
const ok=(m:string)=>console.log(`  ✓ ${m}`);
const dir=mkdtempSync(path.join(os.tmpdir(),"ig-watchlists-"));process.env.IG_CREDENTIALS_FILE=path.join(dir,"c.json");
writeFileSync(process.env.IG_CREDENTIALS_FILE,"{}",{mode:0o600});
const credentials={demo:{apiKey:"k",identifier:"i",password:"p"},live:{apiKey:"k2",identifier:"i2",password:"p2"}};
const urls:string[]=[];
const fetchMock=(async(url:string,options:RequestInit)=>{
  if(url.endsWith("/session"))return new Response(JSON.stringify({currentAccountId:"acc"}),{status:200,headers:{CST:"c",["X-SECURITY-TOKEN"]:"x"}});
  if(url.endsWith("/accounts"))return new Response(JSON.stringify({accounts:[{accountId:"acc",accountType:"CFD",currency:"SEK",balance:{balance:1,available:1,profitLoss:0}}]}));
  urls.push(url);assert.equal(options.method,"GET");
  if(url.endsWith("/watchlists"))return new Response(JSON.stringify({watchlists:[{id:"Popular Markets",name:"Populära marknader",editable:false,deleteable:false,defaultSystemWatchlist:true},{id:"1234",name:"Min lista",editable:true},{id:"",name:"tom"}]}));
  if(url.endsWith("/watchlists/Popular%20Markets"))return new Response(JSON.stringify({markets:[
    {epic:"CS.D.EURUSD.MINI.IP",instrumentName:"EUR/USD Mini",instrumentType:"CURRENCIES",bid:1.1,offer:1.1002,percentageChange:0.12,marketStatus:"TRADEABLE",updateTimeUTC:"10:00:00"},
    {epic:"CS.D.BITCOIN.CFD.IP",instrumentName:"Bitcoin",instrumentType:"CURRENCIES",bid:60000,offer:60050,percentageChange:-1.5,marketStatus:"TRADEABLE"},
    {epic:"IX.D.DAX.DAILY.IP",instrumentName:"Tyskland 40",instrumentType:"INDICES",bid:19000,offer:19001,percentageChange:0.3,marketStatus:"EDITS_ONLY"},
    {epic:"bad epic!",instrumentName:"x",instrumentType:"CURRENCIES"}]}));
  return new Response("{}",{status:404});
}) as typeof fetch;
const conn=createIgConnection({loadCredentials:()=>credentials,fetch:fetchMock});
await conn.testConnection("demo");
const mk=createIgMarkets({call:conn.callAuthenticated,status:conn.getStatus,readStats:null,crawlFile:null});
const lists=await mk.watchlists("demo");
assert.deepEqual(lists.lists.map(l=>l.id),["Popular Markets","1234"]);assert.equal(lists.lists[0]!.name,"Populära marknader");
ok("IG-listorna hämtas med IG:s namn; tomma id hoppas över");
const wl=await mk.watchlist("demo","Popular Markets");
assert.ok(urls.some(u=>u.endsWith("/watchlists/Popular%20Markets")),"id med mellanslag URL-kodas");
assert.deepEqual(wl.markets.map(m=>m.epic),["CS.D.EURUSD.MINI.IP","CS.D.BITCOIN.CFD.IP","IX.D.DAX.DAILY.IP"]);
assert.equal(wl.markets[0]!.bid,1.1);assert.equal(wl.markets[0]!.percentageChange,0.12);assert.equal(wl.markets[0]!.marketStatus,"TRADEABLE");
assert.deepEqual(wl.markets.map(m=>igMarketCategory({name:m.name,type:m.type})),["forex","crypto",null]);
ok("listans instrument: IG:s kurs/förändring/status, Forex/Krypto klassas, index blir utanför (null), ogiltig EPIC tas bort");
const before=urls.length;await mk.watchlist("demo","Popular Markets");await mk.watchlists("demo");assert.equal(urls.length,before,"cache: inga nya IG-läsningar");
ok("cachas (lista 60 s, listor 10 min): inga extra IG-läsningar");
await assert.rejects(()=>mk.watchlist("demo",""));await assert.rejects(()=>mk.watchlist("demo","x".repeat(101)));
await assert.rejects(()=>conn.callAuthenticated("demo","watchlists","POST","1",{name:"x"}),/tillåtna endpoints/);
await assert.rejects(()=>conn.callAuthenticated("demo","watchlists/a/b","GET","1"),/tillåtna endpoints/);
ok("bara läsning: POST till watchlists och andra vägar nekas");
console.log("test-ig-watchlists: ok");
