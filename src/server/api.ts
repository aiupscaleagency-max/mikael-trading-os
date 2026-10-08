import {igCourse} from '../integrations/igCourse.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {attachIgRealtime} from './igRealtime.js';
import {handleIgRoutes} from './igRoutes.js';
import {tickIgSchedules} from '../integrations/igSchedules.js';
import {tickIgOrders} from '../integrations/igOrders.js';
import {tickIgSessions} from '../integrations/igWorkspace.js';
import {tickIgCatalogues} from '../integrations/igMarketDirectory.js';
import {getTiingoStatus} from '../data/tiingoHistory.js';
import {verifyAccessToken,signInWithPassword} from '../auth/supabase.js';
import {loadState,saveState} from '../memory/store.js';
import {getCostSummary} from '../cost/tracker.js';
import {config} from '../config.js';
import {log} from '../logger.js';
const SESSION_COOKIE='tos_session';
const AUTH_EXEMPT_PATHS=new Set(['/api/auth/login','/api/auth/logout','/api/auth/mode']);
function isLocalNoLogin(req: http.IncomingMessage): boolean {
  if (process.env.DASHBOARD_NO_LOGIN !== "true") return false;
  const ip = req.socket.remoteAddress ?? "";
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") return false;
  if (req.headers["x-forwarded-for"] || req.headers["forwarded"]) return false;
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (host !== "localhost" && host !== "127.0.0.1") return false;
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return false;
  return true;
}

// Tailscale: samma "utan inloggning" även via Mikes tailnet (mobil, andra datorn).
// Bara när DASHBOARD_TAILNET_HOSTS anger värdnamnet, anslutningen kommer från
// `tailscale serve` på den här datorn (127.0.0.1) och avsändaren har en
// Tailscale-adress (100.64.0.0/10 eller fd7a:115c:a1e0::/48). Funnel/internet nekas.
function isTailnetNoLogin(req: http.IncomingMessage): boolean {
  if (process.env.DASHBOARD_NO_LOGIN !== "true") return false;
  const hosts = (process.env.DASHBOARD_TAILNET_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length) return false;
  const ip = req.socket.remoteAddress ?? "";
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") return false;
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!hosts.includes(host)) return false;
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() ?? "";
  const tailnetIp = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(fwd) || /^fd7a:115c:a1e0:/i.test(fwd);
  if (!tailnetIp) return false;
  const origin = req.headers.origin;
  if (origin) {
    const o = origin.toLowerCase().replace(/:\d+$/, "");
    if (!hosts.some((h) => o === `https://${h}`)) return false;
  }
  return true;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// json() svarar alltid 200 — den här behövs för fel-koder.
function jsonStatus(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}


function json(res:http.ServerResponse,data:unknown){jsonStatus(res,200,data);}
async function readBody(req:http.IncomingMessage):Promise<string>{let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>65536)throw Error('Begäran är för stor');}return body;}
export function startServer(port:number):http.Server{
 const uiDir=path.resolve(import.meta.dirname,'ui');
 const igTimer=setInterval(()=>{void tickIgSchedules().catch(()=>log.warn('IG-schemabevakningen misslyckades'));void tickIgSessions().catch(()=>log.warn('IG-sessionsbevakningen misslyckades'));},1000);igTimer.unref();
 const orderTimer=setInterval(()=>void tickIgOrders().catch(()=>log.warn('IG-orderbevakningen misslyckades')),15000);orderTimer.unref();
 const catalogueTimer=setInterval(()=>void tickIgCatalogues().catch(()=>log.warn('IG-katalogbevakningen misslyckades')),5000);catalogueTimer.unref();
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url??'/','http://localhost'),method=req.method??'GET';
   res.setHeader('Cache-Control','no-store');
   if(url.pathname.startsWith('/api/')&&!AUTH_EXEMPT_PATHS.has(url.pathname)&&!(isLocalNoLogin(req)||isTailnetNoLogin(req))){
    const session=await verifyAccessToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if(!session){jsonStatus(res,401,{error:'unauthorized'});return;}
    if(session.status!=='active'){jsonStatus(res,403,{error:'account_not_active'});return;}
   }
   if(url.pathname.startsWith('/api/')&&!['GET','HEAD'].includes(method)){
    const origin=req.headers.origin;
    if(!origin||new URL(origin).host!==req.headers.host||req.headers['sec-fetch-site']==='cross-site'){jsonStatus(res,403,{error:'Otillåten källa'});return;}
   }
   if(await handleIgRoutes(url,method,req,res,readBody,isLocalNoLogin))return;
   if(url.pathname==='/api/reference-status'&&method==='GET'){json(res,getTiingoStatus());return;}
   if(url.pathname==='/api/course'&&method==='GET'){json(res,igCourse.view());return;}
   if(url.pathname==='/api/course/backtest'&&method==='POST'){try{if(!req.headers['content-type']?.startsWith('application/json'))throw Error('JSON krävs');const body=JSON.parse(await readBody(req));if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw Error('Backtest tar inga ändringar av strategi eller sökväg via HTTP');json(res,await igCourse.run());}catch(e){jsonStatus(res,400,{error:e instanceof Error?e.message:'Backtest kunde inte startas'});}return;}
   if(url.pathname==='/api/cost'&&method==='GET'){json(res,await getCostSummary({dailyCapUsd:config.costCap.dailyUsd,weeklyCapUsd:config.costCap.weeklyUsd}));return;}
   if(url.pathname==='/api/state'&&method==='GET'){const s=await loadState();json(res,{killSwitchActive:s.killSwitchActive});return;}
   if(url.pathname==='/api/kill-switch'&&method==='POST'){const {active}=JSON.parse(await readBody(req));if(typeof active!=='boolean'){jsonStatus(res,400,{error:'Ogiltig kill-switch'});return;}const s=await loadState();s.killSwitchActive=active;await saveState(s);json(res,{ok:true,active});return;}
      if (url.pathname === "/api/auth/login" && method === "POST") {
        let email = "", password = "";
        try {
          ({ email, password } = JSON.parse(await readBody(req)) as { email: string; password: string });
        } catch {
          jsonStatus(res, 400, { error: "invalid_body" });
          return;
        }
        if (!email || !password) {
          jsonStatus(res, 400, { error: "email + password krävs" });
          return;
        }
        const signed = await signInWithPassword(email, password);
        if (!signed) {
          // Medvetet ospecifikt: avslöja inte om adressen finns.
          log.warn(`Misslyckad inloggning för ${email.slice(0, 3)}***`);
          jsonStatus(res, 401, { error: "invalid_credentials" });
          return;
        }
        // Token går ALDRIG ut i bodyn — bara som cookie JavaScript inte når.
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie":
            `${SESSION_COOKIE}=${encodeURIComponent(signed.accessToken)}` +
            `; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${signed.expiresIn}`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Talar om för dashboarden om inloggningsskärmen ska hoppas över.
      // Samma kontroll som släpper igenom API-anropen, så svaret är bara
      // true från den egna datorn med DASHBOARD_NO_LOGIN=true.
      if (url.pathname === "/api/auth/mode" && method === "GET") {
        json(res, { noLogin: isLocalNoLogin(req) || isTailnetNoLogin(req) });
        return;
      }

      if (url.pathname === "/api/auth/logout" && method === "POST") {
        igRealtime.revoke(req.headers.cookie);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/vendor/lightweight-charts.js" && method === "GET") {
        try {
          const libPath = path.resolve(
            import.meta.dirname,
            "../../node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js",
          );
          const js = await fs.readFile(libPath, "utf8");
          res.writeHead(200, {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=86400",
          });
          res.end(js);
        } catch {
          res.writeHead(404);
          res.end("// lightweight-charts saknas — kör npm install");
        }
        return;
      }

      // Endast dessa lokala UI-filer kan serveras, aldrig godtyckliga filvägar.
      const workspaceFiles:Record<string,[string,string]>={
        "/workspace/style.css":["style.css","text/css"],
        "/workspace/app.mjs":["app.mjs","text/javascript"],
        "/workspace/research.mjs":["research.mjs","text/javascript"],
        "/workspace/model.mjs":["model.mjs","text/javascript"],
        "/workspace/marketViews.mjs":["marketViews.mjs","text/javascript"],
        "/workspace/instrumentIcons.mjs":["instrumentIcons.mjs","text/javascript"],
        "/workspace/multiCharts.mjs":["multiCharts.mjs","text/javascript"],
        "/workspace/streamCandles.mjs":["streamCandles.mjs","text/javascript"],
      };
      const iconName=url.pathname.match(/^\/workspace\/icons\/(btc|eth|sol|ltc|xrp|ada|doge|dot|link|uni|avax|bch|xlm|atom|trx|eos|etc|neo|xtz|aave|algo|generic)\.svg$/)?.[1];
      const asset=workspaceFiles[url.pathname]??(iconName?[`icons/${iconName}.svg`,"image/svg+xml"]:undefined);
      if(asset&&method==="GET") {
        const file=await fs.readFile(path.join(uiDir,"workspace",asset[0]),"utf8");
        res.writeHead(200,{"Content-Type":asset[1],"Cache-Control":"no-store"});res.end(file);return;
      }
      // ── Dashboard HTML ──
      // Servera root-dashboard.html (single source of truth) framför gamla ui/index.html
      if ((url.pathname === "/" || url.pathname === "/dashboard.html") && method === "GET") {
        try {
          const rootDashboard = path.resolve(import.meta.dirname, "../../dashboard.html");
          const html = await fs.readFile(rootDashboard, "utf8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch {
          res.writeHead(500);
          res.end("Trading-workspace kunde inte laddas");
        }
        return;
      }


   res.writeHead(404);res.end('Not found');
  }catch{if(!res.headersSent)jsonStatus(res,500,{error:'Begäran kunde inte behandlas'});else res.end();}
 });
 const igRealtime=attachIgRealtime(server,{authorize:async req=>{
  try{const origin=new URL(req.headers.origin??'');if(origin.host!==req.headers.host||!(origin.protocol==='https:'||(origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname)))||req.headers['sec-fetch-site']==='cross-site')return false;}catch{return false;}
  if(isLocalNoLogin(req)||isTailnetNoLogin(req))return true;
  return (await verifyAccessToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]))?.status==='active';
 }});
 server.on('close',()=>{clearInterval(igTimer);clearInterval(orderTimer);clearInterval(catalogueTimer);igRealtime.close();});
 server.on('error',(err:NodeJS.ErrnoException)=>{log.error(err.code==='EADDRINUSE'?'Porten används redan. Ingen andra handelsmotor startas.':'IG-servern kunde inte starta');});
 server.listen(port,()=>log.ok(`IG Trading OS: http://localhost:${port}`));return server;
}
