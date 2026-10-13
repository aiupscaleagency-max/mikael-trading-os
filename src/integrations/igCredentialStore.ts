import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

/** Uppgifter kan endast lämnas från datorns lokala handelsyta. */
export function localIgCredentialRequest(input:{address?:string;host?:string;origin?:string;contentType?:string;fetchSite?:string}) {
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(input.address??'')||input.fetchSite==='cross-site'||!input.contentType?.startsWith('application/json')||!input.origin)return false;
 try{const origin=new URL(input.origin),host=new URL(`http://${input.host}`);return ['localhost','127.0.0.1','[::1]'].includes(host.hostname)&&origin.host===host.host&&['http:','https:'].includes(origin.protocol)&&!origin.username&&!origin.password;}catch{return false;}
}

/** Tomma fält bevarar befintliga uppgifter. Inget lösenord eller nyckel returneras. */
export function saveIgCredentials(input:Record<string,unknown>,file=process.env.IG_CREDENTIALS_FILE||path.join(os.homedir(),'.config/aiupscale/trading-ig.json')) {
 const {environment}=input;if(environment!=='live'&&environment!=='demo')throw Error('IG kräver Demo eller Live');
 if(Object.keys(input).some(k=>!['environment','identifier','password','apiKey'].includes(k)))throw Error('IG-begäran innehåller okända fält');
 const update:Record<string,string>={};
 for(const key of ['identifier','password','apiKey'] as const){
  const raw=input[key];if(raw===undefined||raw==='')continue;if(typeof raw!=='string')throw Error('IG-inloggningsfält måste vara text');
  const value=key==='password'?raw:raw.trim();if(!value)continue;
  if(key==='identifier'&&!/^[A-Za-z0-9_-]{1,30}$/.test(value))throw Error('IG API kräver användarnamn, inte e-postadress');
  if(key==='password'&&(value.length>350||/[\r\n\x00]/.test(value)))throw Error('IG-lösenordet har ogiltigt format');
  if(key==='apiKey'&&!/^[A-Za-z0-9]{16,100}$/.test(value))throw Error('IG API-nyckeln har ogiltigt format');
  update[key]=value;
 }
 if(!Object.keys(update).length)throw Error('IG kräver minst ett nytt inloggningsfält');
 const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});const parent=fs.lstatSync(dir);
 if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o022)!==0||(process.getuid&&parent.uid!==process.getuid()))throw Error('IG-katalogen måste ägas av användaren och skyddas mot ändringar');
 let data:Record<string,any>={};
 try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw Error('IG-filen måste ägas av användaren och ha privata rättigheter');data=JSON.parse(fs.readFileSync(file,'utf8'));if(!data||Array.isArray(data)||typeof data!=='object')throw Error('format');}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('IG-uppgifterna kunde inte läsas säkert');}
 const row=data[environment];if(row!==undefined&&(!row||typeof row!=='object'||Array.isArray(row)))throw Error('IG-miljön har ogiltigt lagringsformat');
 data[environment]={...row,...update};const temp=path.join(dir,`.ig-${randomUUID()}.tmp`);let fd:number|undefined;
 try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);}
 catch{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{/* Ingen temporär fil att städa. */}throw Error('IG-uppgifterna kunde inte sparas säkert');}
 return {environment:environment as 'demo'|'live',saved:true};
}
