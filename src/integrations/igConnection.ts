import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {createHash} from "node:crypto";

export type IgEnvironment = "demo" | "live";
interface Credentials {apiKey?:string;identifier?:string;password?:string}
interface CredentialFile {demo?:Credentials;live?:Credentials}
export interface IgAccountSummary {
  accountId: string | null; accountType: string | null; currency: string | null;
  balance: number | null; available: number | null; deposit: number | null; profitLoss: number | null; updatedAt: number;
}
export interface IgEnvironmentStatus {
  environment: IgEnvironment; configured: boolean; credentialsComplete: boolean;
  status: "missing" | "configured" | "connected" | "error"; error: string | null;
  account: IgAccountSummary | null; checkedAt: number | null;
}
interface Session {cst:string;xst:string;apiKey:string;accountId:string;createdAt:number;fingerprint:string}
const endpoints = {demo:"https://demo-api.ig.com/gateway/deal",live:"https://api.ig.com/gateway/deal"};
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
export function createIgConnection(deps:{loadCredentials?:()=>CredentialFile;fetch?:typeof fetch;now?:()=>number}={}) {
  const load=deps.loadCredentials ?? readCredentials, request=deps.fetch ?? ((...args:Parameters<typeof fetch>)=>fetch(...args)), now=deps.now ?? Date.now;
  const sessions=new Map<IgEnvironment,Session>(), states=new Map<IgEnvironment,IgEnvironmentStatus>();
  const inFlight=new Map<IgEnvironment,Promise<IgEnvironmentStatus>>();
  function credentials(mode:IgEnvironment):Credentials {
    const data=load(), row=data?.[mode];
    return {apiKey:typeof row?.apiKey==="string"?row.apiKey.trim():undefined,identifier:typeof row?.identifier==="string"?row.identifier.trim():undefined,password:typeof row?.password==="string"?row.password:undefined};
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
    const current=status(mode), failed={...current,status:"error" as const,error,account:null,checkedAt:now()};states.set(mode,failed);return {...failed};
  }
  async function call(mode:IgEnvironment,route:"session"|"accounts"|"positions",c:Credentials,session?:Session) {
    const response=await request(`${endpoints[mode]}/${route}`,{
      method:route==="session"?"POST":"GET",signal:AbortSignal.timeout(8000),
      headers:{"X-IG-API-KEY":c.apiKey!,Version:route==="accounts"?"1":"2",Accept:"application/json","Content-Type":"application/json; charset=UTF-8",...(session?{CST:session.cst,"X-SECURITY-TOKEN":session.xst}:{})},
      ...(route==="session"?{body:JSON.stringify({identifier:c.identifier,password:c.password,encryptedPassword:false})}:{}),
    });
    if(!response.ok) throw Error(response.status===401||response.status===403?"IG nekade inloggning eller API-behörighet":response.status===429?"IG begränsade antal anrop":`IG svarade HTTP ${response.status}`);
    return {response,data:await response.json() as Record<string,any>};
  }
  function accountSummary(a:Record<string,any>):IgAccountSummary {
    return {accountId:typeof a.accountId==="string" ? `••••${a.accountId.slice(-4)}` : null,accountType:["CFD","SPREADBET","PHYSICAL"].includes(a.accountType)?a.accountType:null,currency:typeof a.currency==="string"&&/^[A-Z]{3}$/.test(a.currency)?a.currency:null,balance:number(a.balance?.balance),available:number(a.balance?.available),deposit:number(a.balance?.deposit),profitLoss:number(a.balance?.profitLoss),updatedAt:now()};
  }
  async function connect(mode:IgEnvironment):Promise<IgEnvironmentStatus> {
    const initial=status(mode);if(!initial.credentialsComplete) return initial;
    try {
      const c=credentials(mode), {response,data}=await call(mode,"session",c);
      const cst=response.headers.get("CST"),xst=response.headers.get("X-SECURITY-TOKEN"),accountId=text(data.currentAccountId);
      if(!cst || !xst || !accountId) return fail(mode,"IG returnerade ingen verifierbar kontosession");
      const session={cst,xst,apiKey:c.apiKey!,accountId,createdAt:now(),fingerprint:fingerprint(c)};
      const accounts=await call(mode,"accounts",c,session);
      if(!Array.isArray(accounts.data.accounts)) return fail(mode,"IG returnerade inget verifierbart kontounderlag");
      const active=accounts.data.accounts.find((a:unknown)=>a&&typeof a==="object"&&(a as Record<string,unknown>).accountId===accountId);
      if(!active) return fail(mode,"IG-sessionens konto saknas i verifierat kontounderlag");
      // Credentials får inte bytas under en pågående anslutning och är alltid miljöspecifika.
      if(fingerprint(credentials(mode))!==session.fingerprint) return fail(mode,"IG-credentials ändrades under anslutningen; anslut igen");
      sessions.set(mode,session);
      const result:IgEnvironmentStatus={...initial,status:"connected",error:null,account:accountSummary(active),checkedAt:now()};states.set(mode,result);return {...result,account:{...result.account!}};
    } catch(err) {
      const allowed=["IG nekade inloggning eller API-behörighet","IG begränsade antal anrop"];
      const message=err instanceof Error&&allowed.includes(err.message)?err.message:err instanceof Error&&/^IG svarade HTTP [1-5][0-9]{2}$/.test(err.message)?err.message:"IG kunde inte anslutas inom tidsgränsen eller returnerade ogiltiga data";
      return fail(mode,message);
    }
  }
  async function testConnection(mode:IgEnvironment):Promise<IgEnvironmentStatus> {
    validMode(mode);const current=inFlight.get(mode);if(current)return current;
    const job=connect(mode);inFlight.set(mode,job);try{return await job;}finally{inFlight.delete(mode);}
  }
  async function readAccounts(mode:IgEnvironment) {
    const current=status(mode),session=sessions.get(mode);
    if(!session || current.status!=="connected") return {environment:mode,status:current.status,error:current.error??"Anslut IG först",accounts:null,updatedAt:null};
    try {
      const {data}=await call(mode,"accounts",{apiKey:session.apiKey},session);
      if(!Array.isArray(data.accounts))throw Error("format");
      if(sessions.get(mode)!==session || fingerprint(credentials(mode))!==session.fingerprint) throw Error("session changed");
      return {environment:mode,status:"ready",error:null,accounts:data.accounts.map(accountSummary),updatedAt:now()};
    } catch {fail(mode,"IG-kontounderlaget kunde inte verifieras; anslut igen");return {environment:mode,status:"error",error:"IG-kontounderlaget kunde inte verifieras; anslut igen",accounts:null,updatedAt:null};}
  }
  async function readPositions(mode:IgEnvironment) {
    const current=status(mode),session=sessions.get(mode);
    if(!session || current.status!=="connected")return {environment:mode,status:current.status,error:current.error??"Anslut IG först",positions:null,updatedAt:null};
    try {
      const {data}=await call(mode,"positions",{apiKey:session.apiKey},session);if(!Array.isArray(data.positions))throw Error("format");
      if(sessions.get(mode)!==session || fingerprint(credentials(mode))!==session.fingerprint)throw Error("session changed");
      const positions=data.positions.map((row:Record<string,any>)=>({dealId:text(row.position?.dealId),epic:text(row.market?.epic),instrumentName:text(row.market?.instrumentName),direction:text(row.position?.direction),currency:text(row.position?.currency),size:number(row.position?.size),level:number(row.position?.level),stopLevel:number(row.position?.stopLevel),limitLevel:number(row.position?.limitLevel),bid:number(row.market?.bid),offer:number(row.market?.offer),marketStatus:text(row.market?.marketStatus)}));
      return {environment:mode,status:"ready",error:null,positions,updatedAt:now()};
    } catch {fail(mode,"IG-positionerna kunde inte verifieras; anslut igen");return {environment:mode,status:"error",error:"IG-positionerna kunde inte verifieras; anslut igen",positions:null,updatedAt:null};}
  }
  return {getStatus:()=>({environments:{demo:status("demo"),live:status("live")}}),testConnection,getAccounts:readAccounts,getPositions:readPositions};
}
const connection=createIgConnection();
export const getIgStatus=connection.getStatus;
export const testIgConnection=connection.testConnection;
export const getIgAccounts=connection.getAccounts;
export const getIgPositions=connection.getPositions;
