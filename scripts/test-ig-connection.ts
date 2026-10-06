import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,mkdirSync,readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createIgConnection,getIgStatus} from "../src/integrations/igConnection.js";
const directory=mkdtempSync(path.join(os.tmpdir(),"ig-readonly-"));
const credentialPath=path.join(directory,"credentials.json");process.env.IG_CREDENTIALS_FILE=credentialPath;
writeFileSync(credentialPath,JSON.stringify({demo:{apiKey:"fixture-demo-key"},live:{apiKey:"fixture-live-key"}}),{mode:0o600});
assert.equal(getIgStatus().environments.demo.configured,true);assert.equal(getIgStatus().environments.demo.credentialsComplete,false);
chmodSync(credentialPath,0o644);assert.equal(getIgStatus().environments.demo.configured,false);chmodSync(credentialPath,0o600);
const link=path.join(directory,"symlink.json");symlinkSync(credentialPath,link);process.env.IG_CREDENTIALS_FILE=link;
assert.equal(getIgStatus().environments.demo.status,"missing");process.env.IG_CREDENTIALS_FILE=credentialPath;
let readable=true;
let calls=0, clock=1000;
let credentials={demo:{apiKey:"fixture-demo-key",identifier:"fixture-demo-id",password:"fixture-demo-password"},live:{apiKey:"fixture-live-key",identifier:"fixture-live-id",password:"fixture-live-password"}};
const mock=(async(url:string,options:RequestInit)=>{
  calls++;const environment=url.includes("demo-api")?"demo":"live";
  const headers=options.headers as Record<string,string>;
  assert.equal(headers["X-IG-API-KEY"],credentials[environment].apiKey);
  if(url.endsWith("/session")) {
    assert.equal(options.method,"POST");assert.equal(headers.Version,"2");
    const body=JSON.parse(options.body as string);assert.equal(body.identifier,credentials[environment].identifier);assert.equal(body.password,credentials[environment].password);
    await Promise.resolve();
    return new Response(JSON.stringify({currentAccountId:`full-${environment}-account`}),{status:200,headers:{CST:`secret-${environment}-cst`,"X-SECURITY-TOKEN":`secret-${environment}-xst`}});
  }
  assert.equal(options.method,"GET");assert.equal(headers.CST,`secret-${environment}-cst`);assert.equal(headers["X-SECURITY-TOKEN"],`secret-${environment}-xst`);
  if(url.endsWith("/accounts"))return new Response(JSON.stringify({accounts:[{accountId:`full-${environment}-account`,accountType:"CFD",currency:"SEK",balance:{balance:environment==="demo"?100000:250,available:null,profitLoss:0}}]}));
  assert.ok(url.endsWith("/positions"));return new Response(JSON.stringify({positions:[{position:{size:2,level:100},market:{epic:"IX.D.TEST",bid:null}}]}));
}) as typeof fetch;
const connection=createIgConnection({loadCredentials:()=>{if(!readable)throw Error("private file unavailable");return credentials;},fetch:mock,now:()=>clock});
const [demo1,demo2]=await Promise.all([connection.testConnection("demo"),connection.testConnection("demo")]);
assert.deepEqual(demo1,demo2);assert.equal(calls,2,"Demo login och accounts körs bara en gång vid samtidiga starter");
assert.equal(demo1.status,"connected");assert.equal(demo1.account?.balance,100000);assert.equal(demo1.account?.available,null);assert.equal(demo1.account?.deposit,null);assert.equal(demo1.account?.profitLoss,0);
assert.equal(connection.getStatus().environments.live.status,"configured");
const live=await connection.testConnection("live");assert.equal(live.account?.balance,250);assert.equal(connection.getStatus().environments.demo.account?.balance,100000);
const positions=await connection.getPositions("demo");assert.equal(positions.positions?.[0]?.bid,null);assert.equal(positions.positions?.[0]?.size,2);
assert.equal((await connection.getAccounts("live")).accounts?.[0]?.available,null);
const serialized=JSON.stringify({demo1,live,positions,status:connection.getStatus()});
for(const secret of ["fixture-demo-key","fixture-live-key","fixture-demo-id","fixture-demo-password","secret-demo-cst","secret-live-xst","full-demo-account"])assert.ok(!serialized.includes(secret),"Publik retur får inte innehålla credentials, tokens eller fullständiga konto-ID");
readable=false;assert.equal(connection.getStatus().environments.demo.status,"missing");
readable=true;assert.equal(connection.getStatus().environments.demo.status,"configured","Återställd credentialsfil är inte en återställd kontosession");
assert.equal(connection.getStatus().environments.demo.account,null);
await connection.testConnection("demo");
clock+=3_600_001;assert.equal(connection.getStatus().environments.demo.status,"configured");assert.equal((await connection.getAccounts("demo")).accounts,null);
const denied=createIgConnection({loadCredentials:()=>credentials,fetch:(async()=>new Response("fixture-demo-password",{status:401})) as typeof fetch});
assert.equal((await denied.testConnection("demo")).error,"IG nekade inloggning eller API-behörighet");assert.equal(denied.getStatus().environments.live.status,"configured");
const network=createIgConnection({loadCredentials:()=>credentials,fetch:(async()=>{throw Error("url key=fixture-demo-key secret-demo-cst");}) as typeof fetch});
assert.ok(!JSON.stringify(await network.testConnection("demo")).includes("fixture-demo-key"));
const incomplete=createIgConnection({loadCredentials:()=>({demo:{apiKey:"only-key"}}),fetch:(async()=>{throw Error("must not fetch");}) as typeof fetch});
assert.equal((await incomplete.testConnection("demo")).status,"missing");
await assert.rejects(connection.testConnection("other" as never),/Ogiltig/);
const source=readFileSync(new URL("../src/integrations/igConnection.ts",import.meta.url),"utf8");assert.ok(!source.includes("positions/otc"));assert.ok(!source.includes("workingorders"));
console.log("PASS: IG demo/live isolation, session singleflight, Token memory-only, read-only accounts/positions, null missing metrics, permissions/symlink, expiry, missing credentials and sanitized errors; no real IG requests/orders");

const configurePath=fileURLToPath(new URL("./configure-ig.py",import.meta.url));
const scriptFile=path.join(directory,"script-credentials.json");
const noTty=spawnSync("python3",[configurePath,"--mode","demo","--file",scriptFile],{input:"must-not-be-read\n",encoding:"utf8"});
assert.equal(noTty.status,1);assert.ok(!noTty.stdout.includes("must-not-be-read"));
const scriptFixture=JSON.stringify({demo:{apiKey:"keep-demo-key"},live:{apiKey:"keep-live-key",identifier:"old-live",password:"old-live-password"}});
writeFileSync(scriptFile,scriptFixture,{mode:0o600});
const pythonTest = `import importlib.util,sys,getpass,json,os
p=${JSON.stringify(configurePath)}
f=${JSON.stringify(scriptFile)}
spec=importlib.util.spec_from_file_location('configure_ig',p)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
sys.stdin.isatty=lambda:True
values=iter(['','fixture-id','fixture-password'])
getpass.getpass=lambda prompt:next(values)
m.configure('demo',f)
d=json.load(open(f));assert d['demo']['apiKey']=='keep-demo-key';assert d['demo']['identifier']=='fixture-id';assert d['live']['identifier']=='old-live';assert os.stat(f).st_mode & 0o777==0o600
`;
const scriptOutput=execFileSync("python3",["-c",pythonTest],{encoding:"utf8"});
assert.ok(!scriptOutput.includes("fixture-password"));assert.ok(!scriptOutput.includes("keep-demo-key"));
console.log("PASS: IG credentials script refuses non-TTY, preserves existing keys/other environment and writes atomically with 600");
