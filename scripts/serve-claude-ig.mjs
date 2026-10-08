import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Endast frontend och proxy: inga mäklarbibliotek, nyckelfiler eller handelsmotorer laddas.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const routes=new Map([
 ['/api/auth/mode',['GET']],['/api/auth/login',['POST']],['/api/auth/logout',['POST']],
 ['/api/cost',['GET']],['/api/state',['GET']],['/api/kill-switch',['POST']],['/api/reference-status',['GET']],['/api/course',['GET']],['/api/course/backtest',['POST']],
 ['/api/ig/status',['GET']],['/api/ig/connect',['POST']],['/api/ig/workspace',['GET']],
 ['/api/ig/directory',['GET']],['/api/ig/directory/enrichment',['GET']],['/api/ig/catalog',['GET']],
 ['/api/ig/markets',['GET']],['/api/ig/market',['GET']],['/api/ig/candles',['GET']],
 ['/api/ig/selection',['POST']],['/api/ig/analysis',['POST']],['/api/ig/session',['POST','DELETE']],
 ['/api/ig/schedules',['GET','POST','DELETE']],['/api/ig/strategies',['GET']],['/api/ig/memory',['GET']],
 ['/api/ig/preferences',['POST']],['/api/ig/imported-signals',['GET','POST','DELETE']],
 ['/api/ig/research',['GET','POST']],['/api/ig/research/chat',['POST']],['/api/ig/research/test',['POST']],
 ['/api/ig/order-preview',['POST']],['/api/ig/order-confirm',['POST']],['/api/ig/close',['POST']],['/api/ig/rollover',['POST']],
 ['/vendor/lightweight-charts.js',['GET','HEAD']],
]);
const frameOrigins=new Set(['https://agentic-os.tail64d627.ts.net','https://aiupscale-dator1.tail64d627.ts.net','https://aiupscale-dator2.tail64d627.ts.net','https://aiupscale-dator2.tail64d627.ts.net:3737','http://localhost:3737','http://127.0.0.1:3737']);
export function createClaudeIgGateway({upstream='https://aiupscale-dator1.tail64d627.ts.net:9443',port=3938,publicOrigin='https://aiupscale-dator2.tail64d627.ts.net:9444',dashboard=path.join(root,'dashboard.html'),assetDirectory=path.join(root,'src/server/ui/claude')}={}){
 upstream=new URL(upstream);if(upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash||upstream.protocol!=='https:'&&!(upstream.protocol==='http:'&&['localhost','127.0.0.1'].includes(upstream.hostname)))throw Error('Ogiltig IG-upstream');
 const publicUrl=publicOrigin?new URL(publicOrigin):null;if(publicUrl&&(publicUrl.protocol!=='https:'||!publicUrl.hostname.endsWith('.ts.net')||publicUrl.username||publicUrl.password||publicUrl.pathname!=='/'||publicUrl.search||publicUrl.hash))throw Error('Ogiltig offentlig origin');
 const transport=upstream.protocol==='https:'?https:http,tunnels=new Set();
 const actualPort=()=>{const a=server.address();return a&&typeof a==='object'?a.port:port;};
 const origins=()=>new Set([`http://localhost:${actualPort()}`,`http://127.0.0.1:${actualPort()}`,...publicUrl?[publicUrl.origin]:[]]);
 const hosts=()=>new Set([`localhost:${actualPort()}`,`127.0.0.1:${actualPort()}`,...publicUrl?[publicUrl.host]:[]]);
 function allowed(req,upgrade=false){
  if(!hosts().has(String(req.headers.host??'').toLowerCase())||typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')||req.url.length>4096)return false;
  const origin=req.headers.origin;if(origin&&!origins().has(origin))return false;
  if(upgrade&&(!origin||req.method!=='GET'||new URL(req.url,'http://localhost').pathname!=='/api/ig/realtime'))return false;
  if((upgrade||!['GET','HEAD','OPTIONS'].includes(req.method))&&(!origin||new URL(origin).host!==req.headers.host))return false;
  if(req.headers['sec-fetch-site']==='cross-site'){try{if(!['GET','HEAD'].includes(req.method)||req.headers['sec-fetch-mode']!=='navigate'||!frameOrigins.has(new URL(req.headers.referer).origin))return false;}catch{return false;}}
  return true;
 }
 function headers(incoming){const result={...incoming,host:upstream.host,origin:upstream.origin};for(const key of Object.keys(result))if(key.startsWith('x-forwarded-')||key.startsWith('tailscale-')||key.startsWith('x-ts-')||key==='forwarded')delete result[key];if(result.referer)result.referer=upstream.origin+'/';return result;}
 const options=req=>({hostname:upstream.hostname,port:upstream.port||undefined,path:req.url,method:req.method,headers:headers(req.headers)});
 function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
 function staticHeaders(type){return {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://agentic-os.tail64d627.ts.net https://aiupscale-dator2.tail64d627.ts.net https://aiupscale-dator2.tail64d627.ts.net:3737 http://localhost:3737 http://127.0.0.1:3737; object-src 'none'; base-uri 'self'"};}
 const server=http.createServer(async(req,res)=>{try{
  if(!allowed(req)){json(res,403,{error:'Otillåten källa för Claude IG.'});return;}
  const url=new URL(req.url,'http://localhost'),method=req.method??'GET';
  if(url.pathname==='/healthz'&&method==='GET'){json(res,200,{role:'claude-ig-frontend-gateway',tradingEngine:false,upstream:upstream.origin});return;}
  let localFile=null,type=null;if(['GET','HEAD'].includes(method)){
   if(url.pathname==='/'||url.pathname==='/dashboard.html'){localFile=dashboard;type='text/html; charset=utf-8';}
   else {const match=url.pathname.match(/^\/claude\/([A-Za-z0-9_-]+\.(?:mjs|js|css|svg))$/);if(match){localFile=path.join(assetDirectory,match[1]);type=match[1].endsWith('.css')?'text/css; charset=utf-8':match[1].endsWith('.svg')?'image/svg+xml':'text/javascript; charset=utf-8';}}
  }
  if(localFile){try{const body=await fs.readFile(localFile);res.writeHead(200,staticHeaders(type));res.end(method==='HEAD'?undefined:body);}catch{json(res,404,{error:'Claude IG-filen finns inte.'});}return;}
  if(!routes.get(url.pathname)?.includes(method)){json(res,404,{error:'Funktionen ingår inte i denna IG-yta.'});return;}
  if(!['GET','HEAD'].includes(method)&&!String(req.headers['content-type']??'').startsWith('application/json')){json(res,415,{error:'JSON krävs.'});return;}
  const outgoing=transport.request(options(req),response=>{outgoing.setTimeout(0);res.writeHead(response.statusCode??502,{...response.headers,'Cache-Control':'no-store'});response.pipe(res);response.on('error',()=>res.destroy());});
  // Analys och historiska tester kan ta längre än en enkel marknadsfråga.
  outgoing.setTimeout(url.pathname==='/api/course/backtest'?600000:['/api/ig/analysis','/api/ig/research/chat','/api/ig/research/test'].includes(url.pathname)?180000:30000,()=>outgoing.destroy(new Error('timeout')));
  outgoing.on('error',()=>{if(!res.headersSent)json(res,502,{error:'Den gemensamma IG-backenden kan inte nås.'});else res.destroy();});req.on('aborted',()=>outgoing.destroy());res.on('close',()=>outgoing.destroy());req.pipe(outgoing);
 }catch{if(!res.headersSent)json(res,400,{error:'Ogiltig gatewaybegäran.'});else res.destroy();}});
 server.on('upgrade',(req,socket,head)=>{
  if(!allowed(req,true)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  let remote=null;const outgoing=transport.request(options(req));outgoing.setTimeout(30000,()=>outgoing.destroy(new Error('timeout')));
  const close=()=>{tunnels.delete(socket);outgoing.destroy();remote?.destroy();socket.destroy();};tunnels.add(socket);socket.on('error',close);socket.on('close',close);
  outgoing.on('upgrade',(response,upstreamSocket,upstreamHead)=>{if(socket.destroyed){upstreamSocket.destroy();return;}if(response.statusCode!==101){upstreamSocket.destroy();socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;}remote=upstreamSocket;outgoing.setTimeout(0);upstreamSocket.setTimeout(0);socket.setTimeout(0);const lines=[];for(let i=0;i<response.rawHeaders.length;i+=2)lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i+1]}`);socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);if(upstreamHead.length)socket.write(upstreamHead);if(head.length)upstreamSocket.write(head);upstreamSocket.on('error',close);upstreamSocket.on('close',close);socket.pipe(upstreamSocket);upstreamSocket.pipe(socket);});
  outgoing.on('response',response=>{response.resume();socket.end(`HTTP/1.1 ${response.statusCode??502} Upstream Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);});outgoing.on('error',()=>{if(!socket.destroyed)socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');});outgoing.end();
 });
 server.closeTunnels=()=>{for(const socket of tunnels)socket.destroy();tunnels.clear();};return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const port=Number(process.env.CLAUDE_IG_PORT||3938);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Ogiltig port');const server=createClaudeIgGateway({port,upstream:process.env.CLAUDE_IG_UPSTREAM||undefined,publicOrigin:process.env.CLAUDE_IG_PUBLIC_ORIGIN||undefined});server.on('error',err=>{console.error(`Claude IG-gateway kunde inte starta (${err.code??'okänt fel'}).`);process.exit(1);});server.listen(port,'127.0.0.1',()=>console.log(`Claude IG frontend på localhost:${port}; gemensam IG-backend används.`));for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.closeTunnels();server.close();setTimeout(()=>process.exit(0),3000).unref();});}
