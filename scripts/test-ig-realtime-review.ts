import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter,once} from 'node:events';
import {WebSocket} from 'ws';
import {attachIgRealtime} from '../src/server/igRealtime.js';

// Lokal socket med injicerad auth/snapshot/stream; inga credentials eller IG-anrop.
let authorized=true,throws=false;
const subscriptions:any[]=[];
const fakeStream={events:new EventEmitter(),ensure:(...args:any[])=>subscriptions.push(args),summary:()=>({status:'CONNECTED:WS-STREAMING'}),quotes:()=>[],close:()=>{},stop:()=>{}};
const server=http.createServer((_req,res)=>res.end());
const realtime=attachIgRealtime(server,{authorize:async req=>{if(throws)throw Error('fixture auth unavailable');return authorized&&req.headers.origin==='http://fixture.local'&&req.headers.cookie==='fixture=valid';},snapshot:async mode=>({environment:mode,fixture:true}),stream:fakeStream as any,intervalMs:100});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert.ok(address&&typeof address!=='string');const base=`ws://127.0.0.1:${address.port}/api/ig/realtime`;
const sockets:WebSocket[]=[];
async function connect(environment='demo',origin='http://fixture.local',cookie='fixture=valid'){
 const ws=new WebSocket(`${base}?environment=${environment}`,{headers:{Origin:origin,Cookie:cookie}});sockets.push(ws);
 const received:any[]=[];ws.on('message',raw=>received.push(JSON.parse(raw.toString())));await once(ws,'open');return {ws,received};
}
async function until(check:()=>boolean){const end=Date.now()+2500;while(!check()){if(Date.now()>end)throw Error('Timeout vid lokal testavstämning');await new Promise(r=>setTimeout(r,10));}}
async function denied(environment:string,origin:string,cookie:string){
 const ws=new WebSocket(`${base}?environment=${environment}`,{headers:{Origin:origin,Cookie:cookie}});sockets.push(ws);
 const outcome=await new Promise<string>(resolve=>{ws.on('open',()=>resolve('open'));ws.on('unexpected-response',(_req,response)=>{response.resume();ws.terminate();resolve(String(response.statusCode));});ws.on('error',()=>resolve('error'));});
 assert.notEqual(outcome,'open');
}
try{
 await denied('demo','http://evil.local','fixture=valid');await denied('demo','http://fixture.local','fixture=invalid');await denied('bad','http://fixture.local','fixture=valid');
 const a=await connect();const b=await connect('live');await until(()=>a.received.some(x=>x.type==='snapshot'));
 a.ws.send(JSON.stringify({type:'subscribe',epics:['EUR']}));await until(()=>subscriptions.some(x=>x[0]==='demo'&&x[1].includes('EUR')));
 fakeStream.events.emit('quote','demo',{epic:'EUR',bid:1});await until(()=>a.received.some(x=>x.type==='quote'));
 assert.equal(b.received.some(x=>x.type==='quote'),false,'Demo-kvoter får inte sändas till live-klient');
 a.ws.send(JSON.stringify({type:'subscribe',epics:['EUR','GBP','BTC','ETH'],charts:[{epic:'EUR',scale:'1MINUTE'},{epic:'GBP',scale:'5MINUTE'},{epic:'BTC',scale:'HOUR'},{epic:'ETH',scale:'1MINUTE'}]}));
 await until(()=>subscriptions.some(x=>x[0]==='demo'&&x[2].length===4));
 const chartPool=await connect();chartPool.ws.send(JSON.stringify({type:'subscribe',epics:['EUR'],charts:[{epic:'EUR',scale:'HOUR'}]}));await until(()=>chartPool.received.some(x=>x.type==='subscription-error'));
 assert.equal(subscriptions.some(x=>x[0]==='demo'&&x[2].length>4),false,'Femte diagrammet får inte mutera poolen');
 chartPool.ws.close();await once(chartPool.ws,'close');
 a.ws.send(JSON.stringify({type:'subscribe',epics:['EUR'],chart:{epic:'EUR',scale:'1MINUTE'}}));await until(()=>subscriptions.some(x=>x[0]==='demo'&&x[2].length===1&&x[2][0].epic==='EUR'));
 const pool=await connect();a.ws.send(JSON.stringify({type:'subscribe',epics:Array.from({length:30},(_,i)=>`EPIC${i}`)}));
 await until(()=>subscriptions.some(x=>x[0]==='demo'&&x[1].length===30));
 pool.ws.send(JSON.stringify({type:'subscribe',epics:['OVERFLOW']}));await until(()=>pool.received.some(x=>x.type==='subscription-error'));
 assert.equal(subscriptions.some(x=>x[0]==='demo'&&x[1].includes('OVERFLOW')),false,'Poolgräns ska neka före prenumerationsmutation');
 const invalid=await connect();invalid.ws.send(JSON.stringify({type:'subscribe',epics:['invalid/epic']}));const [badCode]=await once(invalid.ws,'close');assert.equal(badCode,1008);
 const revoked=once(a.ws,'close');realtime.revoke('fixture=valid');const [code]=await revoked;assert.equal(code,1008,'Logout stänger tillhörande socket');
 const fault=await connect();throws=true;const [faultCode]=await once(fault.ws,'close');assert.equal(faultCode,1008,'Auth-fel ska stänga befintlig socket');throws=false;
 const expired=await connect();authorized=false;const [expiryCode]=await once(expired.ws,'close');assert.equal(expiryCode,1008,'Återkontroll nekar återkallad behörighet');
 console.log('IG realtime review: auth, miljöisolering, schema-validering, logout och auth-fel godkända');
}finally{for(const ws of sockets)if(ws.readyState!==WebSocket.CLOSED)ws.terminate();realtime.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
