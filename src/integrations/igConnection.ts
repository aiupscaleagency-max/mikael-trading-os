import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {createHash,randomUUID} from "node:crypto";
import {AsyncLocalStorage} from "node:async_hooks";

// ── Prioritet i läsbudgeten ──
// Order (granskning, bekräftelse, stängning) och tidsstyrda stängningar körs i withIgPriority och får
// hela minutbudgeten. Allt annat (diagramverifiering, katalog, resultat, saldo-polling) måste lämna
// IG_READ_RESERVE_PER_ENV läsningar (standard IG_ORDER_READ_NEED = 12) kvar, så att en order aldrig stoppas av bakgrundsläsningar.
const priorityContext=new AsyncLocalStorage<boolean>();
export function withIgPriority<T>(fn:()=>Promise<T>):Promise<T>{return priorityContext.run(true,fn);}
export function igPriorityActive():boolean{return priorityContext.getStore()===true;}
/** Läsningar som INTE får använda orderns förtur (t.ex. Demo-simuleringens Live-priser), även om anroparen kör i withIgPriority. */
export function withoutIgPriority<T>(fn:()=>Promise<T>):Promise<T>{return priorityContext.run(false,fn);}
/** B1: läsningar en godkänd order behöver i värsta fall (granskning: konto, positioner, arbetsorder,
 *  transaktioner, marknad, valuta + marknad per position; bekräftelsen återanvänder granskningens läsningar
 *  under 5 s). confirms/ räknas inte mot spärren. */
export const IG_ORDER_READ_NEED=12;
export const readReservePerEnv=()=>Math.max(0,Math.min(Math.max(1,Number(process.env.IG_READ_BUDGET_PER_ENV)||24)-1,Number.isFinite(Number(process.env.IG_READ_RESERVE_PER_ENV))&&process.env.IG_READ_RESERVE_PER_ENV!==undefined&&process.env.IG_READ_RESERVE_PER_ENV!==""?Number(process.env.IG_READ_RESERVE_PER_ENV):IG_ORDER_READ_NEED));

export type IgEnvironment = "demo" | "live";
interface Credentials {apiKey?:string;identifier?:string;password?:string;accountId?:string}
interface CredentialFile {demo?:Credentials;live?:Credentials}
export interface IgAccountSummary {
  accountId: string | null; accountType: string | null; currency: string | null;
  balance: number | null; available: number | null; deposit: number | null; profitLoss: number | null; updatedAt: number;
}
export interface IgEnvironmentStatus {
  environment: IgEnvironment; configured: boolean; credentialsComplete: boolean;
  status: "missing" | "configured" | "connected" | "error"; error: string | null;
  account: IgAccountSummary | null; checkedAt: number | null; connectionGeneration?: string | null;
}
interface Session {cst:string;xst:string;apiKey:string;accountId:string;createdAt:number;fingerprint:string;streamingEndpoint?:string}
const endpoints = {demo:"https://demo-api.ig.com/gateway/deal",live:"https://api.ig.com/gateway/deal"};
/** Orderexekvering per miljö: Demo och Live har var sin flagga, båda av som standard.
 *  Den gamla gemensamma IG_ORDER_EXECUTION_ENABLED slår inte på något här. */
export function igOrderExecutionEnabled(mode:IgEnvironment):boolean{return process.env[mode==="live"?"IG_ORDER_EXECUTION_ENABLED_LIVE":"IG_ORDER_EXECUTION_ENABLED_DEMO"]==="true";}
/** Samma regel som liveAllowedByServer() (src/server/orderGate.ts), läst direkt ur miljön för att undvika cirkulära importer:
 *  servern är startad för riktiga pengar bara med MODE=live och LIVE_TRADING_CONFIRMED=true i .env. */
export function igLiveConfirmedByServer():boolean{return process.env.MODE?.trim()==="live"&&process.env.LIVE_TRADING_CONFIRMED?.trim().toLowerCase()==="true";}
/** Får IG Live ta emot skrivande anrop (order, stängning, ändring)? Kräver BÅDE live-läget i .env och Live-orderflaggan. */
export function igLiveWritesUnlocked():boolean{return igLiveConfirmedByServer()&&igOrderExecutionEnabled("live");}
/** Orderläget per miljö som det faktiskt gäller: Demo = Demo-flaggan, Live = Live-flaggan OCH live-läget i .env.
 *  Används som standard av mäklaren och orderflödet så att Live aldrig visas eller körs som "på" när Live bara läses. */
export function igWritesEnabled(mode:IgEnvironment):boolean{return igOrderExecutionEnabled(mode)&&(mode!=="live"||igLiveConfirmedByServer());}
export const IG_LIVE_WRITE_LOCKED="IG Live: order låsta. Live får bara läsas (saldo, kurser, positioner, historik); inget skickades till IG. Order kräver MODE=live, LIVE_TRADING_CONFIRMED=true och IG_ORDER_EXECUTION_ENABLED_LIVE=true i .env och omstart.";
const budgetPerEnv=()=>Math.max(1,Number(process.env.IG_READ_BUDGET_PER_ENV)||24),budgetTotal=()=>Math.max(1,Number(process.env.IG_READ_BUDGET_TOTAL)||48);
function validMode(mode: unknown): asserts mode is IgEnvironment {if(mode!=="demo"&&mode!=="live") throw Error("Ogiltig IG-miljö");}
function number(value:unknown):number|null {return typeof value==="number"&&Number.isFinite(value)?value:null;}
function text(value:unknown):string|null {return typeof value==="string"&&value.length<=200?value:null;}
function readCredentials(): CredentialFile {
  const file=process.env.IG_CREDENTIALS_FILE || path.join(os.homedir(),".config/aiupscale/trading-ig.json");
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)!==0 || (process.getuid && stat.uid!==process.getuid())) throw Error("IG-filen måste ägas av användaren och ha privata filrättigheter (600)");
  return JSON.parse(fs.readFileSync(file,"utf8")) as CredentialFile;
}
/** Bara lokala credentials och explicita läsanrop; inga orderfunktioner finns. */
// IG:s veckokvot för historiska priser (error.public-api.exceeded-account-historical-data-allowance) fylls på löpande inom 7 dagar.
// Vi frågar IG igen högst en gång i timmen; under tiden byggs diagrammet vidare från strömmens stängda ljus.
export const IG_HISTORY_RATE_ERROR="IG:s veckokvot för historiska priser är slut på kontot. Diagrammet byggs från livepriserna tills IG fyller på kvoten (inom 7 dagar)";
export const IG_HISTORY_BLOCK_MS=60*60*1000;
export const IG_READ_RATE_ERROR="IG begränsade antal läsanrop; försök igen om en minut";
export function isIgTemporaryRateError(error:unknown){const message=error instanceof Error?error.message:error;return message===IG_READ_RATE_ERROR||message==="IG begränsade antal anrop"||message==="IG svarade HTTP 429"||message==="IG-läsbudgeten är slut för denna minut";}
export function createIgConnection(deps:{loadCredentials?:()=>CredentialFile;fetch?:typeof fetch;now?:()=>number;liveWritesUnlocked?:()=>boolean}={}) {
  const load=deps.loadCredentials ?? readCredentials, rawRequest=deps.fetch ?? ((...args:Parameters<typeof fetch>)=>fetch(...args)), now=deps.now ?? Date.now;
  const liveWritesUnlocked=deps.liveWritesUnlocked ?? igLiveWritesUnlocked;
  // ── Hårt skrivstopp för IG Live (sista utgången ur processen) ──
  // Varje anrop mot IG går genom request(). Mot Live släpps bara GET utan _method-huvud och sessionsinloggningen
  // (POST /session) igenom, om inte Live-order är upplåsta i .env. Täcker alla vägar: orderpanel, Godkänn, Sälj allt,
  // Sälj nu, AUTO-agenten, tidsstängning, TP/SL, strategier, chatten, Double Up/Roll-Over och avstämning.
  function liveWriteBlocked(url:string,init:RequestInit|undefined):boolean{
    if(!url.startsWith(endpoints.live+"/")&&url!==endpoints.live)return false;
    const method=String(init?.method??"GET").toUpperCase(),headers=(init?.headers??{}) as Record<string,string>;
    const override=Object.keys(headers).some(k=>k.toLowerCase()==="_method");
    if(method==="GET"&&!override)return false;
    // Undantag: sessionens inloggning/utloggning/förnyelse (inte kontobyte via PUT, inte order).
    if((method==="POST"||method==="DELETE")&&!override&&(url===`${endpoints.live}/session`||url===`${endpoints.live}/session/refresh-token`))return false;
    return !liveWritesUnlocked();
  }
  const request=((input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
    const url=typeof input==="string"?input:input instanceof URL?input.href:(input as Request).url;
    if(liveWriteBlocked(url,init)){console.warn(`[ig] live ${String(init?.method??"GET")} stoppad: ${IG_LIVE_WRITE_LOCKED}`);return Promise.reject(Error(IG_LIVE_WRITE_LOCKED));}
    return rawRequest(input,init);
  }) as typeof fetch;
  const sessions=new Map<IgEnvironment,Session>(), states=new Map<IgEnvironment,IgEnvironmentStatus>();
  const inFlight=new Map<IgEnvironment,Promise<IgEnvironmentStatus>>();
  // Samtliga GET-vägar delar rullande minutbudget, även orderkontroller och kontopollning.
  const reads:{environment:IgEnvironment;at:number}[]=[];
  const readBlockedUntil=new Map<IgEnvironment,number>();
  const historyBlockedUntil=new Map<IgEnvironment,number>();
  function readBudget(mode:IgEnvironment){
    validMode(mode);while(reads.length&&now()-reads[0]!.at>=60000)reads.shift();
    const used=reads.filter(r=>r.environment===mode).length;
    const remaining=now()<(readBlockedUntil.get(mode)??0)?0:Math.max(0,Math.min(budgetPerEnv()-used,budgetTotal()-reads.length));
    return {used,appUsed:reads.length,remaining,reserve:readReservePerEnv(),backgroundRemaining:Math.max(0,remaining-readReservePerEnv())};
  }
  // B1 (granskning 2): utfallskontrollen confirms/{dealReference} efter en skickad order får ALDRIG stoppas
  // av vår egen budget; den räknas men spärras inte. (IG:s egen 429 gäller fortfarande.)
  function consumeRead(mode:IgEnvironment,outcomeCheck=false){const b=readBudget(mode);if(!outcomeCheck&&(b.remaining===0||(!igPriorityActive()&&b.backgroundRemaining===0)))throw Error(IG_READ_RATE_ERROR);reads.push({environment:mode,at:now()});}
  const sharedLogins=new Map<IgEnvironment,{identifier:string;password:string;source:IgEnvironment;sourceFingerprint:string}>();
  function credentials(mode:IgEnvironment):Credentials {
    const data=load(), row=data?.[mode];
    const shared=sharedLogins.get(mode);
    if(shared) {
      const source=data?.[shared.source];
      const current=createHash("sha256").update(JSON.stringify({identifier:source?.identifier,password:source?.password})).digest("hex");
      if(current!==shared.sourceFingerprint)sharedLogins.delete(mode);
    }
    const login=sharedLogins.get(mode);
    return {accountId:typeof row?.accountId==="string"?row.accountId:undefined,apiKey:typeof row?.apiKey==="string"?row.apiKey.trim():undefined,identifier:typeof row?.identifier==="string"&&row.identifier.trim()?row.identifier.trim():login?.identifier,password:typeof row?.password==="string"&&row.password?row.password:login?.password};
  }
  const fingerprint=(c:Credentials)=>createHash("sha256").update(JSON.stringify(c)).digest("hex");
  function status(mode:IgEnvironment):IgEnvironmentStatus {
    validMode(mode);
    let c:Credentials;
    try {c=credentials(mode);} catch {sessions.delete(mode);states.delete(mode);return {environment:mode,configured:false,credentialsComplete:false,status:"missing",error:"IG-credentials saknas eller filen har osäkra rättigheter",account:null,checkedAt:null};}
    const configured=!!c.apiKey, complete=configured&&!!c.identifier&&!!c.password;
    const session=sessions.get(mode);
    if(session && (session.fingerprint!==fingerprint(c) || now()-session.createdAt>=3_600_000)) {sessions.delete(mode);states.delete(mode);}
    const previous=states.get(mode);
    return previous ? {...previous,account:previous.account?{...previous.account}:null,configured,credentialsComplete:complete} : {
      environment:mode,configured,credentialsComplete:complete,status:complete?"configured":"missing",error:complete?null:"IG kräver API-nyckel, identifier och lösenord för denna miljö",account:null,checkedAt:null};
  }
  function fail(mode:IgEnvironment,error:string):IgEnvironmentStatus {
    sessions.delete(mode);
    const current=status(mode), failed={...current,status:"error" as const,error,connectionGeneration:null,account:null,checkedAt:now()};states.set(mode,failed);return {...failed};
  }
  async function call(mode:IgEnvironment,route:"session"|"accounts"|"positions",c:Credentials,session?:Session) {
    if(route!=="session")consumeRead(mode);
    const response=await request(`${endpoints[mode]}/${route}`,{
      method:route==="session"?"POST":"GET",signal:AbortSignal.timeout(8000),
      headers:{"X-IG-API-KEY":c.apiKey!,Version:route==="accounts"?"1":"2",Accept:"application/json","Content-Type":"application/json; charset=UTF-8",...(session?{CST:session.cst,"X-SECURITY-TOKEN":session.xst}:{})},
      ...(route==="session"?{body:JSON.stringify({identifier:c.identifier,password:c.password,encryptedPassword:false})}:{}),
    });
    if(!response.ok){
      let code:unknown;try{code=(await response.json() as Record<string,unknown>).errorCode;}catch{/* Privat felbody läses aldrig tillbaka. */}
      if(response.status===429||typeof code==='string'&&/^error\.public-api\.exceeded-[a-z-]+-allowance$/.test(code)){readBlockedUntil.set(mode,now()+60000);throw Error(IG_READ_RATE_ERROR);}
      throw Error(response.status===401||response.status===403?"IG nekade inloggning eller API-behörighet":`IG svarade HTTP ${response.status}`);
    }
    return {response,data:await response.json() as Record<string,any>};
  }
  function accountSummary(a:Record<string,any>):IgAccountSummary {
    return {accountId:typeof a.accountId==="string" ? `••••${a.accountId.slice(-4)}` : null,accountType:["CFD","SPREADBET","PHYSICAL"].includes(a.accountType)?a.accountType:null,currency:typeof a.currency==="string"&&/^[A-Z]{3}$/.test(a.currency)?a.currency:null,balance:number(a.balance?.balance),available:number(a.balance?.available),deposit:number(a.balance?.deposit),profitLoss:number(a.balance?.profitLoss),updatedAt:now()};
  }
  async function connect(mode:IgEnvironment):Promise<IgEnvironmentStatus> {
    const initial=status(mode);if(!initial.credentialsComplete || initial.status==="connected") return initial;
    try {
      const c=credentials(mode), {response,data}=await call(mode,"session",c);
      const cst=response.headers.get("CST"),xst=response.headers.get("X-SECURITY-TOKEN"),accountId=text(data.currentAccountId);
      if(!cst || !xst || !accountId) return fail(mode,"IG returnerade ingen verifierbar kontosession");
      const session={cst,xst,apiKey:c.apiKey!,accountId,createdAt:now(),fingerprint:fingerprint(c),streamingEndpoint:typeof data.lightstreamerEndpoint==="string"?data.lightstreamerEndpoint:undefined};
      const accounts=await call(mode,"accounts",c,session);
      if(!Array.isArray(accounts.data.accounts)) return fail(mode,"IG returnerade inget verifierbart kontounderlag");
      const active=accounts.data.accounts.find((a:unknown)=>a&&typeof a==="object"&&(a as Record<string,unknown>).accountId===accountId);
      if(!active) return fail(mode,"IG-sessionens konto saknas i verifierat kontounderlag");
      if(c.accountId&&(accountId!==c.accountId||active.accountType!=="CFD"))return fail(mode,"IG-sessionen matchar inte det konfigurerade CFD-kontot; välj rätt standardkonto hos IG");
      // Credentials får inte bytas under en pågående anslutning och är alltid miljöspecifika.
      if(fingerprint(credentials(mode))!==session.fingerprint) return fail(mode,"IG-credentials ändrades under anslutningen; anslut igen");
      sessions.set(mode,session);
      const result:IgEnvironmentStatus={...initial,status:"connected",error:null,connectionGeneration:randomUUID(),account:accountSummary(active),checkedAt:now()};states.set(mode,result);return {...result,account:{...result.account!}};
    } catch(err) {
      const allowed=["IG nekade inloggning eller API-behörighet","IG begränsade antal anrop",IG_READ_RATE_ERROR];
      const message=err instanceof Error&&allowed.includes(err.message)?err.message:err instanceof Error&&/^IG svarade HTTP [1-5][0-9]{2}$/.test(err.message)?err.message:"IG kunde inte anslutas inom tidsgränsen eller returnerade ogiltiga data";
      return fail(mode,message);
    }
  }
  async function testConnection(mode:IgEnvironment):Promise<IgEnvironmentStatus> {
    validMode(mode);const current=inFlight.get(mode);if(current)return current;
    const job=connect(mode);inFlight.set(mode,job);try{return await job;}finally{inFlight.delete(mode);}
  }
  async function testWithSharedLogin(target:IgEnvironment,source:IgEnvironment):Promise<IgEnvironmentStatus> {
    validMode(target);validMode(source);
    if(target===source)return testConnection(target);
    try {
      const file=load(),from=file?.[source],to=file?.[target];
      if(!to?.apiKey || !from?.identifier || !from?.password)return status(target);
      sharedLogins.set(target,{identifier:from.identifier,password:from.password,source,sourceFingerprint:createHash("sha256").update(JSON.stringify({identifier:from.identifier,password:from.password})).digest("hex")});
      sessions.delete(target);states.delete(target);
      return await testConnection(target);
    } catch {return fail(target,"IG:s gemensamma inloggning kunde inte verifieras");}
  }
  async function readAccounts(mode:IgEnvironment) {
    const current=status(mode),session=sessions.get(mode);
    if(!session || current.status!=="connected") return {environment:mode,status:current.status,error:current.error??"Anslut IG först",accounts:null,updatedAt:null};
    try {
      const {data}=await call(mode,"accounts",{apiKey:session.apiKey},session);
      if(!Array.isArray(data.accounts))throw Error("format");
      if(sessions.get(mode)!==session || fingerprint(credentials(mode))!==session.fingerprint) throw Error("session changed");
      const active=data.accounts.find((a:Record<string,unknown>)=>a.accountId===session.accountId);
      if(!active)throw Error("active account missing");
      const previous=states.get(mode);if(previous)states.set(mode,{...previous,account:accountSummary(active)});
      return {environment:mode,status:"ready",error:null,accounts:data.accounts.map(accountSummary),updatedAt:now()};
    } catch(error) {if(isIgTemporaryRateError(error))return {environment:mode,status:"error",error:IG_READ_RATE_ERROR,accounts:null,updatedAt:null};fail(mode,"IG-kontounderlaget kunde inte verifieras; anslut igen");return {environment:mode,status:"error",error:"IG-kontounderlaget kunde inte verifieras; anslut igen",accounts:null,updatedAt:null};}
  }
  async function readPositions(mode:IgEnvironment) {
    const current=status(mode),session=sessions.get(mode);
    if(!session || current.status!=="connected")return {environment:mode,status:current.status,error:current.error??"Anslut IG först",positions:null,updatedAt:null};
    try {
      const {data}=await call(mode,"positions",{apiKey:session.apiKey},session);if(!Array.isArray(data.positions))throw Error("format");
      if(sessions.get(mode)!==session || fingerprint(credentials(mode))!==session.fingerprint)throw Error("session changed");
      const positions=data.positions.map((row:Record<string,any>)=>({dealId:text(row.position?.dealId),epic:text(row.market?.epic),instrumentName:text(row.market?.instrumentName),direction:text(row.position?.direction),currency:text(row.position?.currency),size:number(row.position?.size),level:number(row.position?.level),stopLevel:number(row.position?.stopLevel),limitLevel:number(row.position?.limitLevel),createdDateUTC:text(row.position?.createdDateUTC),bid:number(row.market?.bid),offer:number(row.market?.offer),marketStatus:text(row.market?.marketStatus)}));
      return {environment:mode,status:"ready",error:null,positions,updatedAt:now()};
    } catch(error) {if(isIgTemporaryRateError(error))return {environment:mode,status:"error",error:IG_READ_RATE_ERROR,positions:null,updatedAt:null};fail(mode,"IG-positionerna kunde inte verifieras; anslut igen");return {environment:mode,status:"error",error:"IG-positionerna kunde inte verifieras; anslut igen",positions:null,updatedAt:null};}
  }
  async function authenticated(mode:IgEnvironment,route:string,method:"GET"|"POST"="GET",version="1",body?:Record<string,unknown>,extra?:Record<string,string>):Promise<Record<string,any>> {
    validMode(mode);
    // Skrivstopp lager A: Live-order låsta → inget skrivande anrop byggs ens (före läsbudget och utanför try,
    // så att det aldrig blir ett "okänt utfall" för något som aldrig skickades).
    if(mode==="live"&&(method!=="GET"||extra?._method!==undefined)&&!liveWritesUnlocked()){console.warn(`[ig] live ${method} ${route.replace(/[^A-Za-z0-9._/-]/g,'')} stoppad: ${IG_LIVE_WRITE_LOCKED}`);throw Error(IG_LIVE_WRITE_LOCKED);}
    const readOnly = route === "categories" || /^categories\/[A-Za-z0-9._-]{1,100}\/instruments$/.test(route) || /^client-sentiment\/[A-Za-z0-9._-]{1,100}$/.test(route) || route === "accounts" || route === "positions" || route === "workingorders" || route === "markets" || route === "history/activity" || route === "history/transactions" || /^(markets|prices)\/[A-Za-z0-9._-]{1,100}$/.test(route) || /^confirms\/[A-Za-z0-9_-]{1,100}$/.test(route);
    const write = (route === "positions/otc" || route === "workingorders/otc") && method === "POST";
    if((method === "GET" && !readOnly) || (method === "POST" && !write) || !( ["1","2","3"].includes(version) || (version==="4"&&method==="GET"&&/^markets\/[A-Za-z0-9._-]{1,100}$/.test(route)) )) throw Error("IG-anropet ingår inte i tillåtna endpoints");
    if(write && !igOrderExecutionEnabled(mode)) throw Error("IG-orderexekvering är avstängd på servern");
    const current=status(mode),session=sessions.get(mode);
    if(!session || current.status !== "connected") throw Error("IG-miljön är inte ansluten");
    const headers:Record<string,string>={"X-IG-API-KEY":session.apiKey,CST:session.cst,"X-SECURITY-TOKEN":session.xst,Version:version,Accept:"application/json","Content-Type":"application/json; charset=UTF-8"};
    if(extra) {
      const allowedQuery = extra.query;
      if(Object.keys(extra).some(k=>k!=="query"&&k!=="_method") || (extra._method!==undefined&&extra._method!=="DELETE") || (extra._method && !write)) throw Error("Otillåtna IG-anropsparametrar");
      if(extra._method) headers._method="DELETE";
      if(allowedQuery && method!=="GET") throw Error("IG-order får inte innehålla frågeparametrar");
    }
    const query=new URLSearchParams(extra?.query || "");
    const allowedParams=new Set(route === "markets"?["searchTerm"]:/^categories\/[A-Za-z0-9._-]{1,100}\/instruments$/.test(route)?["pageNumber","pageSize"]:route.startsWith("prices/")?["resolution","max","from","to","pageSize","pageNumber"]:route.startsWith("history/")?["from","to","detailed","pageSize","pageNumber","type"]:[]);
    for(const [name,value] of query) if(!allowedParams.has(name) || value.length>200) throw Error("Ogiltiga IG-frågeparametrar");
    if(route==='categories'||route.startsWith('categories/')||route.startsWith('client-sentiment/')){if(version!=='1')throw Error('Ogiltig IG-kategoriversion');for(const [name,value] of query){if(!/^\d{1,6}$/.test(value)||name==='pageSize'&&(Number(value)<1||Number(value)>1000))throw Error('Ogiltig IG-katalogpaginering');}}
    if(method==="GET"&&route.startsWith("prices/")&&now()<(historyBlockedUntil.get(mode)??0))throw Error(IG_HISTORY_RATE_ERROR);
    if(method==="GET")consumeRead(mode,/^confirms\//.test(route));
    try {
      const response=await request(`${endpoints[mode]}/${route}${query.size?`?${query}`:""}`,{method,headers,signal:AbortSignal.timeout(8000),...(body?{body:JSON.stringify(body)}:{})});
      if(!response.ok) {
        let code:unknown;try{code=(await response.json() as Record<string,unknown>).errorCode;}catch{/* Okänt felsvar behandlas utan privata detaljer. */}
        // Diagnostik: IG:s egen felkod (inga nycklar eller tokens) i serverloggen, så att läsgräns och historikkvot går att skilja åt.
        console.warn(`[ig] ${mode} ${method} ${route.replace(/[^A-Za-z0-9._/-]/g,'')} → HTTP ${response.status} ${typeof code==='string'?code.slice(0,120):'utan felkod'}`);
        // Historiska datapunkter har en egen kvot och får inte stoppa katalog, konton eller prisverifiering.
        if(code==='error.public-api.exceeded-account-historical-data-allowance'&&route.startsWith('prices/')){historyBlockedUntil.set(mode,now()+IG_HISTORY_BLOCK_MS);throw Error(IG_HISTORY_RATE_ERROR);}
        if(response.status===429||typeof code==='string'&&/^error\.public-api\.exceeded-[a-z-]+-allowance$/.test(code)){readBlockedUntil.set(mode,now()+60000);throw Error(IG_READ_RATE_ERROR);}
        if(code==='endpoint.unavailable.for.api-key'&&(route==='categories'||route.startsWith('categories/')||route.startsWith('client-sentiment/')))throw Error(`IG svarade HTTP ${response.status}`);
        if(response.status===401 || response.status===403)fail(mode,"IG-sessionen eller behörigheten kunde inte verifieras; anslut igen");throw Error(`IG svarade HTTP ${response.status}`);
      }
      const data=await response.json();
      if(!data || typeof data!=="object" || Array.isArray(data)) throw Error("format");
      if(sessions.get(mode)!==session || fingerprint(credentials(mode))!==session.fingerprint)throw Error("session changed");
      return data;
    } catch(error) {throw Error(error instanceof Error && (error.message===IG_HISTORY_RATE_ERROR||error.message===IG_LIVE_WRITE_LOCKED||/^(?:IG svarade HTTP [1-5][0-9]{2}|IG begränsade antal läsanrop; försök igen om en minut)$/.test(error.message))?error.message:"IG-anropet kunde inte verifieras; utfallet kan vara okänt");}
  }
  // Endast serverintern åtkomst. Returneras aldrig av status-/HTTP-rutterna.
  function streamingSession(mode:IgEnvironment){const current=status(mode),s=sessions.get(mode);if(current.status!=="connected"||!s?.streamingEndpoint)return null;let endpoint:URL;try{endpoint=new URL(s.streamingEndpoint);}catch{return null;}if(endpoint.protocol!=="https:"||!/(^|\.)(ig\.com|marketdatasystems\.com)$/.test(endpoint.hostname))return null;return {endpoint:endpoint.href,accountId:s.accountId,password:`CST-${s.cst}|XST-${s.xst}`,generation:current.connectionGeneration!};}
  return {getAccountIdentity:(mode:IgEnvironment)=>{const current=status(mode),session=sessions.get(mode);return current.status==="connected"&&session&&current.connectionGeneration?{accountId:session.accountId,generation:current.connectionGeneration}:null;},getStreamingSession:streamingSession,getReadBudget:readBudget,getStatus:()=>({environments:{demo:status("demo"),live:status("live")}}),testConnection,testWithSharedLogin,callAuthenticated:authenticated,getAccounts:readAccounts,getPositions:readPositions};
}
const connection=createIgConnection();
export const getIgStatus=connection.getStatus;
export const testIgConnection=connection.testConnection;
export const getIgAccounts=connection.getAccounts;
export const getIgPositions=connection.getPositions;

export const callIgAuthenticated=connection.callAuthenticated;

export const testIgConnectionWithSharedLogin=connection.testWithSharedLogin;

export const getIgReadBudget=connection.getReadBudget;

export const getIgStreamingSession=connection.getStreamingSession;

/** Endast serverintern identitet för isolerad analysjournal. Exponeras aldrig av status-API. */
export const getIgAccountIdentity=connection.getAccountIdentity;
