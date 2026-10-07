import {localIgCredentialRequest,saveIgCredentials} from '../integrations/igCredentialStore.js';
import {previewIgOrder,confirmIgOrder,closeIgPosition,rolloverIgPosition,getIgOrderState,getIgBrokerPending} from "../integrations/igOrders.js";
import type http from "node:http";
import {getIgStatus,testIgConnection} from "../integrations/igConnection.js";
import {getIgCatalogue,searchIgMarkets,getIgMarket,getIgCandles,getIgWorkspace,setIgSelection,runIgAnalysis,startIgSession,stopIgSession,type IgTimeframe} from "../integrations/igWorkspace.js";
// Auth-gate körs i api.ts innan denna modul; mutationer kräver även samma origin.
export async function handleIgRoutes(url:URL,method:string,req:http.IncomingMessage,res:http.ServerResponse,readBody:(req:http.IncomingMessage)=>Promise<string>,isLocalNoLogin:(req:http.IncomingMessage)=>boolean):Promise<boolean> {
 const json=(res:http.ServerResponse,data:unknown)=>{res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(data));};
 const jsonStatus=(res:http.ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(data));};
      if(url.pathname==='/api/ig/credentials'&&method==='POST'){
        res.setHeader('Cache-Control','no-store');
        if(!localIgCredentialRequest({address:req.socket.remoteAddress,host:req.headers.host,origin:req.headers.origin,contentType:req.headers['content-type'],fetchSite:String(req.headers['sec-fetch-site']??'')})){jsonStatus(res,403,{error:'IG-uppgifter kan bara sparas från localhost på denna dator'});return true;}
        try{const raw=await readBody(req);if(raw.length>4096)throw Error('IG-begäran är för stor');const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw Error('IG-begäran är ogiltig');const saved=saveIgCredentials(body);const result=await testIgConnection(saved.environment);json(res,{...getIgStatus(),test:{ok:result.status==='connected',error:result.error}});}
        catch(e){jsonStatus(res,400,{error:e instanceof Error&&e.message.startsWith('IG')?e.message:'IG-uppgifterna kunde inte sparas säkert'});}return true;
      }
      // IG verifieras separat. Inga nycklar eller handel skickas från dessa rutter.
      if (url.pathname === "/api/ig/status" && method === "GET") {
        res.setHeader("Cache-Control", "no-store");
        json(res, await getIgStatus());
        return true;
      }
      if (url.pathname === "/api/ig/connect" && method === "POST") {
        res.setHeader("Cache-Control", "no-store");
        const origin = req.headers.origin;
        let sameOrigin = !origin && isLocalNoLogin(req);
        try {
          if (origin) {
            const parsed = new URL(origin);
            const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
            sameOrigin = parsed.host === req.headers.host && (parsed.protocol === "https:" || (loopback && parsed.protocol === "http:"));
          }
        } catch { sameOrigin = false; }
        if (req.headers["sec-fetch-site"] === "cross-site") sameOrigin = false;
        if (!sameOrigin || !(req.headers["content-type"] ?? "").startsWith("application/json")) {
          jsonStatus(res, 403, { error: "Anslutningen kräver samma webbplats och JSON." });
          return true;
        }
        let body: Record<string, unknown>;
        try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; }
        catch { jsonStatus(res, 400, { error: "Ogiltig anslutningsbegäran." }); return true; }
        if (!body || (body.environment !== "demo" && body.environment !== "live") || Object.keys(body).some(key => key !== "environment")) {
          jsonStatus(res, 400, { error: "Välj Demo eller Live. Inloggningsuppgifter anges endast lokalt." });
          return true;
        }
        await testIgConnection(body.environment);
        json(res, await getIgStatus());
        return true;
      }
      // IG använder egna instrument, konton och sessioner; Bybits tillstånd ändras inte.
      if (url.pathname.startsWith("/api/ig/")) {
        res.setHeader("Cache-Control", "no-store");
        let body: Record<string, unknown> = {};
        if (method === "POST" || method === "DELETE") {
          let sameOrigin = !req.headers.origin && isLocalNoLogin(req);
          try {
            if (req.headers.origin) {
              const origin = new URL(req.headers.origin);
              sameOrigin = origin.host === req.headers.host && (origin.protocol === "https:" || (origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)));
            }
          } catch { sameOrigin = false; }
          if (!sameOrigin || req.headers["sec-fetch-site"] === "cross-site" || !(req.headers["content-type"] ?? "").startsWith("application/json")) {
            jsonStatus(res, 403, {error:"IG-ändringar kräver samma webbplats och JSON."}); return true;
          }
          try { body = JSON.parse(await readBody(req)); }
          catch { jsonStatus(res, 400, {error:"Ogiltig IG-begäran."}); return true; }
          if (!body || Array.isArray(body) || typeof body !== "object") { jsonStatus(res, 400, {error:"Ogiltig IG-begäran."}); return true; }
        }
        const environment = method === "GET" ? url.searchParams.get("environment") : body.environment;
        if (environment !== "demo" && environment !== "live") { jsonStatus(res, 400, {error:"Välj IG Demo eller Live."}); return true; }
        const tradingFields:Record<string,string[]>={
          "/api/ig/order-preview":["environment","epic","direction","size","entry","stopLevel","targetLevel","orderType","holdingMinutes","autoClose"],
          "/api/ig/order-confirm":["environment","draftId"],
          "/api/ig/close":["environment","dealId","connectionGeneration"],
          "/api/ig/rollover":["environment","dealId","minutes","connectionGeneration"],
        };
        const allowed = tradingFields[url.pathname]??(url.pathname === "/api/ig/session" && method === "POST" ? ["environment","epics","timeframe","percent","horizonMinutes","durationMinutes","intervalMinutes","maxPositions"] : ["environment","epics","timeframe","percent","horizonMinutes"]);
        if (Object.keys(body).some(key => !allowed.includes(key))) { jsonStatus(res, 400, {error:"Okända fält i IG-begäran."}); return true; }
        try {
          const selection = {epics:body.epics as string[],timeframe:body.timeframe as IgTimeframe,percent:body.percent as number|undefined,horizonMinutes:body.horizonMinutes as number|undefined};
          if (url.pathname === "/api/ig/workspace" && method === "GET") {const w=await getIgWorkspace(environment),o=getIgOrderState(environment,w.positions),b=await getIgBrokerPending(environment,w.connection.connectionGeneration??undefined);if(getIgStatus().environments[environment].connectionGeneration!==w.connection.connectionGeneration)throw Error('IG-kontot ändrades under hämtningen; hämta om handelsytan');json(res,{...w,...o,pendingOrders:[...o.pendingOrders.filter(d=>!b.orders.some((p:any)=>p.dealId===d.dealId)),...b.orders],pendingOrderStatus:b.status,signalProposals:w.pendingOrders,positions:w.positions?.map((p:any)=>{const plan=o.exitPlans.find(x=>x.dealId===p.dealId);return {...p,closeAt:plan?.closeAt,closing:plan?.status==="submitted"||plan?.status==="unknown",closeError:plan?.error,closeStatus:plan?.status};})});}
          else if (url.pathname === "/api/ig/catalog" && method === "GET") json(res, await getIgCatalogue(environment,url.searchParams.get("category")));
          else if (url.pathname === "/api/ig/markets" && method === "GET") json(res, await searchIgMarkets(environment,url.searchParams.get("searchTerm") ?? ""));
          else if (url.pathname === "/api/ig/market" && method === "GET") json(res, await getIgMarket(environment,url.searchParams.get("epic") ?? ""));
          else if (url.pathname === "/api/ig/candles" && method === "GET") json(res, await getIgCandles(environment,url.searchParams.get("epic") ?? "",url.searchParams.get("timeframe") as IgTimeframe,Number(url.searchParams.get("limit") ?? 100)));
          else if (url.pathname === "/api/ig/selection" && method === "POST") json(res, await setIgSelection(environment,selection));
          else if (url.pathname === "/api/ig/analysis" && method === "POST") json(res, await runIgAnalysis(environment,selection));
          else if (url.pathname === "/api/ig/session" && method === "POST") json(res, await startIgSession(environment,{...selection,durationMinutes:body.durationMinutes as number,intervalMinutes:body.intervalMinutes as number,maxPositions:body.maxPositions as number}));
          else if (url.pathname === "/api/ig/session" && method === "DELETE") json(res, {session:stopIgSession(environment)});
          else if(url.pathname==="/api/ig/order-preview"&&method==="POST")json(res,await previewIgOrder(environment,body));
          else if(url.pathname==="/api/ig/order-confirm"&&method==="POST")json(res,await confirmIgOrder(environment,String(body.draftId??"")));
          else if(url.pathname==="/api/ig/close"&&method==="POST")json(res,await closeIgPosition(environment,String(body.dealId??""),String(body.connectionGeneration??"missing")));
          else if(url.pathname==="/api/ig/rollover"&&method==="POST")json(res,await rolloverIgPosition(environment,String(body.dealId??""),Number(body.minutes),String(body.connectionGeneration??"missing")));
          else jsonStatus(res,404,{error:"IG-rutten finns inte."});
        } catch (error) {
          const message = error instanceof Error && /^(IG|Ogiltig|Välj|Session|Analys)/.test(error.message) ? error.message : "IG-underlaget kunde inte verifieras.";
          jsonStatus(res,400,{error:message});
        }
        return true;
      }

 return false;
}
