import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
const original=process.cwd(),directory=mkdtempSync(path.join(os.tmpdir(),'ig-server-'));
process.chdir(directory);delete process.env.SUPABASE_URL;delete process.env.SUPABASE_SERVICE_ROLE_KEY;process.env.DASHBOARD_NO_LOGIN='false';
const {startServer}=await import('../src/server/api.js');
const server=startServer(0);await once(server,'listening');const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
try{
 assert.equal((await fetch(base+'/api/ig/status')).status,401);
 process.env.DASHBOARD_NO_LOGIN='true';
 assert.equal((await fetch(base+'/api/ig/status')).status,200);
 assert.ok([401,403].includes((await fetch(base+'/api/kill-switch',{method:'POST',headers:{origin:'https://foreign.example','content-type':'application/json'},body:'{"active":true}'})).status));
 assert.equal((await fetch(base+'/api/kill-switch',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{"active":true}'})).status,200);
 assert.equal((await (await fetch(base+'/api/state')).json() as any).killSwitchActive,true);
 for(const url of ['/workspace/app.mjs','/workspace/marketViews.mjs','/workspace/streamCandles.mjs','/vendor/lightweight-charts.js','/'])assert.equal((await fetch(base+url)).status,200,url);
 assert.equal((await fetch(base+'/api/live/account')).status,404);
 const socket=new WebSocket(base.replace('http:','ws:')+'/api/ig/realtime?environment=demo',{origin:base});
 const message=await Promise.race([once(socket,'message'),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('WebSocket saknas')),3000).unref())]);
 assert.equal(JSON.parse(message[0].toString()).type,'hello');socket.close();await once(socket,'close');
 console.log('PASS: IG-only HTTP/static/WebSocket101, auth fail-closed, same-origin mutation och kill-switch; inga externa anrop/order');
}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));process.chdir(original);rmSync(directory,{recursive:true,force:true});}
