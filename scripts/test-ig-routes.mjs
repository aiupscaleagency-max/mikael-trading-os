import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source=fs.readFileSync('src/server/api.ts','utf8');
const start=source.indexOf('      if (url.pathname === "/api/ig/status"');
const end=source.indexOf('      if (await handleLiveRoutes',start);
const handler=ts.transpile('(async()=>{'+source.slice(start,end)+'})()', {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None});
let calls=0;
async function invoke({method='POST',headers={},body={environment:'demo'},local=false,path='/api/ig/connect'}={}){
 const result={};
 const context={req:{headers},res:{setHeader(k,v){result[k]=v;}},url:new URL(path,'https://example.ts.net:9443'),method,URL,Object,JSON,
 isLocalNoLogin:()=>local,readBody:async()=>JSON.stringify(body),
 getIgStatus:()=>({environments:{demo:{configured:true,credentialsComplete:false},live:{configured:true,credentialsComplete:false}}}),
 testIgConnection:async(mode)=>{calls++;assert(['demo','live'].includes(mode));},
 getIgWorkspace:async(mode)=>({environment:mode}),searchIgMarkets:async(mode,term)=>({environment:mode,term}),getIgMarket:async(mode,epic)=>({environment:mode,epic}),getIgCandles:async(mode,epic,timeframe,limit)=>({environment:mode,epic,timeframe,limit}),setIgSelection:async(mode,selection)=>({environment:mode,selection}),runIgAnalysis:async(mode,selection)=>({environment:mode,selection}),startIgSession:async(mode,selection)=>({environment:mode,selection}),stopIgSession:mode=>({environment:mode}),
 json:(_r,d)=>{result.code=200;result.data=d;},jsonStatus:(_r,c,d)=>{result.code=c;result.data=d;}};
 await vm.runInNewContext(handler,context);return result;
}
const normal={host:'example.ts.net:9443',origin:'https://example.ts.net:9443','content-type':'application/json'};
assert.equal((await invoke({headers:normal})).code,200);
const before=calls;
for(const headers of [{...normal,origin:'https://evil.example'}, {...normal,origin:'http://example.ts.net:9443'},{...normal,'sec-fetch-site':'cross-site'},{...normal,origin:undefined},{...normal,'content-type':'text/plain'},{...normal,origin:'https://example.ts.net'}]) assert.equal((await invoke({headers})).code,403);
assert.equal(calls,before);
for(const body of [{environment:'other'},null,{environment:'demo',apiKey:'never-accept'}]) assert.equal((await invoke({headers:normal,body})).code,400);
assert.equal(calls,before);
assert.equal((await invoke({local:true,headers:{host:'localhost:3939','content-type':'application/json'}})).code,200);
const count=calls;const status=await invoke({method:'GET',path:'/api/ig/status'});assert.equal(status.code,200);assert.equal(status['Cache-Control'],'no-store');assert.equal(calls,count);
assert(source.indexOf('// ── AUTH-GATE')<start);
console.log('PASS: IG routes auth order, HTTPS/exact host, cross-site/missing Origin guards, JSON/environment only, no-store and status without login');

assert.equal((await invoke({method:'GET',path:'/api/ig/workspace?environment=live'})).data.environment,'live');
assert.equal((await invoke({method:'GET',path:'/api/ig/workspace?environment=invalid'})).code,400);
for(const endpoint of ['selection','analysis','session']) {
 assert.equal((await invoke({path:'/api/ig/'+endpoint,headers:normal,body:{environment:'demo',epics:['CS.D.EURUSD.CEE.IP'],timeframe:'5m',percent:1,horizonMinutes:15}})).code,200);
 assert.equal((await invoke({path:'/api/ig/'+endpoint,headers:{...normal,origin:'https://evil.example'}})).code,403);
 assert.equal((await invoke({path:'/api/ig/'+endpoint,headers:normal,body:{environment:'demo',apiKey:'never'}})).code,400);
}
assert.equal((await invoke({method:'DELETE',path:'/api/ig/session',headers:normal})).code,200);
assert.equal((await invoke({method:'DELETE',path:'/api/ig/session',headers:{...normal,origin:undefined}})).code,403);
console.log('PASS: IG workspace/analysis/session dispatch, strict environments and mutation protection');
