import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync('src/server/api.ts','utf8');
const start=source.indexOf('      if (url.pathname === "/api/ig/status"');
const end=source.indexOf('      if (await handleLiveRoutes',start);
const handler=source.slice(start,end).replace('let body: Record<string, unknown>;','let body;').replace(' as Record<string, unknown>','');
let calls=0;
async function invoke({method='POST',headers={},body={environment:'demo'},local=false,path='/api/ig/connect'}={}){
 const result={};
 const context={req:{headers},res:{setHeader(k,v){result[k]=v;}},url:{pathname:path},method,URL,Object,JSON,
 isLocalNoLogin:()=>local,readBody:async()=>JSON.stringify(body),
 getIgStatus:()=>({environments:{demo:{configured:true,credentialsComplete:false},live:{configured:true,credentialsComplete:false}}}),
 testIgConnection:async(mode)=>{calls++;assert(['demo','live'].includes(mode));},
 json:(_r,d)=>{result.code=200;result.data=d;},jsonStatus:(_r,c,d)=>{result.code=c;result.data=d;}};
 await vm.runInNewContext('(async()=>{'+handler+'})()',context);return result;
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
