import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {createDashboardForwarder} from './forward-dashboard.mjs';
const upstream=http.createServer((_req,res)=>res.end('ok'));
const wss=new WebSocketServer({server:upstream});let upstreamOrigin=null,spoofHeader=null;
wss.on('connection',(ws,req)=>{upstreamOrigin=req.headers.origin;spoofHeader=req.headers['tailscale-user-login'];ws.on('message',data=>ws.send(data));});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const upstreamPort=upstream.address().port;
const forward=createDashboardForwarder({upstream:`http://127.0.0.1:${upstreamPort}`,port:0});forward.listen(0,'127.0.0.1');await once(forward,'listening');const port=forward.address().port,url=`ws://127.0.0.1:${port}/api/ig/realtime?environment=demo`,origin=`http://127.0.0.1:${port}`;
try{
 const ws=new WebSocket(url,{origin,headers:{'tailscale-user-login':'spoof'}});await once(ws,'open');const message=once(ws,'message');ws.send('synkat');assert.equal(String((await message)[0]),'synkat');assert.equal(upstreamOrigin,`http://127.0.0.1:${upstreamPort}`);assert.equal(spoofHeader,undefined);ws.close();await once(ws,'close');
 async function rejected(options){const candidate=new WebSocket(url,options);let status=null;candidate.on('error',()=>{});candidate.on('unexpected-response',(_req,res)=>{status=res.statusCode;res.resume();candidate.terminate();});await new Promise(resolve=>candidate.once('close',resolve));assert.equal(status,403);}
 await rejected({origin:'https://evil.example'});await rejected({});await rejected({origin,headers:{host:'evil.example'}});
 const response=await fetch(`http://127.0.0.1:${port}/`);assert.equal(await response.text(),'ok');console.log('Dashboard forwarder: HTTP, WebSocket echo, origin/host gates och identitetssanering PASS');
}finally{forward.closeTunnels();for(const ws of wss.clients)ws.terminate();await new Promise(r=>forward.close(r));await new Promise(r=>wss.close(r));await new Promise(r=>upstream.close(r));}
