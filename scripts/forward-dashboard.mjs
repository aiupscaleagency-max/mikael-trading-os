import http from 'node:http';
import https from 'node:https';
import {pathToFileURL} from 'node:url';
// Dator2 delar dator1:s backend. Ingen lokal handelsmotor startas.
export function createDashboardForwarder({upstream=new URL('https://aiupscale-dator1.tail64d627.ts.net:9443'),port=3939}={}) {
 if(typeof upstream==='string')upstream=new URL(upstream);
 if(!['http:','https:'].includes(upstream.protocol)||upstream.username||upstream.password)throw Error('Ogiltig upstream');
 const frameOrigins=new Set(['https://agentic-os.tail64d627.ts.net','https://aiupscale-dator1.tail64d627.ts.net']);
 const transport=upstream.protocol==='https:'?https:http;
 const actualPort=()=>{const a=server.address();return a&&typeof a==='object'?a.port:port;};
 const localOrigins=()=>new Set([`http://localhost:${actualPort()}`,`http://127.0.0.1:${actualPort()}`]);
 function allowed(req,upgrade=false){
  if(!new Set([`localhost:${actualPort()}`,`127.0.0.1:${actualPort()}`]).has(String(req.headers.host??'').toLowerCase()))return false;
  if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//'))return false;
  const origin=req.headers.origin;if(origin&&!localOrigins().has(origin))return false;
  if(upgrade&&(!origin||req.method!=='GET'||new URL(req.url,'http://localhost').pathname!=='/api/ig/realtime'))return false;
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!origin)return false;
  if(req.headers['sec-fetch-site']==='cross-site'){try{if(!['GET','HEAD'].includes(req.method)||req.headers['sec-fetch-mode']!=='navigate'||!frameOrigins.has(new URL(req.headers.referer).origin))return false;}catch{return false;}}
  return true;
 }
 function headers(incoming){const result={...incoming,host:upstream.host,origin:upstream.origin};for(const key of Object.keys(result))if(key.startsWith('x-forwarded-')||key.startsWith('tailscale-')||key.startsWith('x-ts-'))delete result[key];if(result.referer)result.referer=upstream.origin+'/';return result;}
 const options=req=>({hostname:upstream.hostname,port:upstream.port||undefined,path:req.url,method:req.method,headers:headers(req.headers)});
 const server=http.createServer((req,res)=>{
  if(!allowed(req)){res.writeHead(403);res.end('Otillåten lokal källa.');return;}
  const outgoing=transport.request(options(req),response=>{outgoing.setTimeout(0);res.writeHead(response.statusCode??502,response.headers);response.pipe(res);response.on('error',()=>res.destroy());});
  outgoing.setTimeout(15000,()=>outgoing.destroy(new Error('timeout')));outgoing.on('error',()=>{if(!res.headersSent){res.writeHead(502);res.end('Trading-OS på dator1 kan inte nås.');}else res.destroy();});req.on('aborted',()=>outgoing.destroy());res.on('close',()=>outgoing.destroy());req.pipe(outgoing);
 });
 const tunnels=new Set();
 server.on('upgrade',(req,socket,head)=>{
  if(!allowed(req,true)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  let remote=null;const outgoing=transport.request(options(req));outgoing.setTimeout(15000,()=>outgoing.destroy(new Error('timeout')));
  const close=()=>{tunnels.delete(socket);outgoing.destroy();remote?.destroy();socket.destroy();};tunnels.add(socket);socket.on('error',close);socket.on('close',close);
  outgoing.on('upgrade',(response,upstreamSocket,upstreamHead)=>{
   if(socket.destroyed){upstreamSocket.destroy();return;}if(response.statusCode!==101){upstreamSocket.destroy();socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;}
   remote=upstreamSocket;outgoing.setTimeout(0);upstreamSocket.setTimeout(0);socket.setTimeout(0);
   const lines=[];for(let i=0;i<response.rawHeaders.length;i+=2)lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i+1]}`);
   socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
   if(upstreamHead.length)socket.write(upstreamHead);if(head.length)upstreamSocket.write(head);
   upstreamSocket.on('error',close);upstreamSocket.on('close',close);socket.pipe(upstreamSocket);upstreamSocket.pipe(socket);
  });
  outgoing.on('response',response=>{response.resume();socket.end(`HTTP/1.1 ${response.statusCode??502} Upstream Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);});
  outgoing.on('error',()=>{if(!socket.destroyed)socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');});outgoing.end();
 });
 server.closeTunnels=()=>{for(const socket of tunnels)socket.destroy();tunnels.clear();};return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const port=Number(process.env.TRADING_FORWARD_PORT||3939);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Ogiltig port');const server=createDashboardForwarder({port});server.on('error',err=>{console.error(`Vidarekopplingen kunde inte starta (${err.code??'okänt fel'}).`);process.exit(1);});server.listen(port,'127.0.0.1',()=>console.log(`Trading-OS vidarekopplad på localhost:${port}`));for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.closeTunnels();server.close();setTimeout(()=>process.exit(0),3000).unref();});}
