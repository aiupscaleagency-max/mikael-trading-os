// Kör de verkliga chattfunktionerna i isolerad VM med fördröjda svar, utan nätverk.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
const between=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
const functions=between('function beginTeamChatRequest(){','// ── Intent-klassificering')+between('async function sendFromFloating(){','function toggleFloatingChat');
for(const sender of ['sendTeamChat','sendFromFloating'])for(const scenario of ['success','switch','revision','clear','error-switch','parallel']){
 const releases=[],saved=new Map(),els=new Map();
 for(const id of ['team-chat-text','team-chat-send','fc-text','fc-send'])els.set(id,{value:'Analysera',disabled:false});
 const c=vm.createContext({console,Date,JSON,document:{getElementById:id=>els.get(id)},window:{},localStorage:{setItem:(k,v)=>saved.set(k,v)},requireTradingKeys:()=>true,renderTeamChatLog:()=>{},setTimeout:()=>{},fetch:()=>new Promise((resolve,reject)=>releases.push({resolve,reject}))});
 vm.runInContext(`let chatLogTestnet=[],chatLogLive=[],teamChatLog=chatLogTestnet,currentUiMode='paper',chatEnvironmentRevision=0;const IG={st:{env:'demo'}};function activeChatKey(){return currentUiMode==='live'?'live':'demo';}${functions}`,c);
 const job=vm.runInContext(`${sender}()`,c);
 assert.equal(releases.length,1);
 if(scenario==='switch'||scenario==='error-switch')vm.runInContext(`IG.st.env='live';currentUiMode='live';chatEnvironmentRevision++;teamChatLog=chatLogLive;teamChatLog.push({role:'user',text:'ny miljö'});`,c);
 if(scenario==='revision')vm.runInContext(`chatEnvironmentRevision++;`,c);
 if(scenario==='clear')vm.runInContext(`chatLogTestnet=[];teamChatLog=chatLogTestnet;`,c);
 let other;
 if(scenario==='parallel')other=vm.runInContext(`${sender==='sendTeamChat'?'sendFromFloating':'sendTeamChat'}()`,c);
 if(scenario==='error-switch')releases[0].reject(Error('offline'));else releases[0].resolve({json:async()=>({ok:true,reply:'svar'})});
 await job;
 if(other){assert.equal(vm.runInContext(`teamChatLog.filter(m=>m.text?.startsWith('⏳')).length`,c),1,'Ta bara bort egen väntemarkör');releases[1].resolve({json:async()=>({ok:true,reply:'andra'})});await other;}
 const log=JSON.parse(vm.runInContext('JSON.stringify(teamChatLog)',c));
 assert.equal(log.filter(m=>m.role==='team').length,scenario==='success'?1:scenario==='parallel'?2:0,`${sender}:${scenario}`);
 assert.ok(log.every(m=>!m.text?.startsWith('⏳')));
 if(scenario==='switch'||scenario==='error-switch')assert.deepEqual(log,[{role:'user',text:'ny miljö'}]);
 if(scenario==='clear')assert.equal(saved.has('demo'),false,'Rensad logg får inte återställas');
}
// Den verkliga lägesrenderaren håller IG i Godkänn, andra mäklare behåller AUTO.
const exec=between('  function showExecMode(mode) {','  var execSw =');
for(const name of ['ig','ig-demo','other']){
 const buttons=[{dataset:{exec:'approve'},classList:{toggle(){}}},{dataset:{exec:'auto'},classList:{toggle(){}}}];
 const hint={};const sw={querySelectorAll:()=>buttons,classList:{toggle(){}}};
 const c=vm.createContext({brokerInfo:{name,mode:'test'},document:{getElementById:id=>id==='execSwitch'?sw:hint}});
 vm.runInContext(`${exec};showExecMode('auto')`,c);
 assert.equal(buttons[1].disabled,name!=='other');assert.equal(hint.innerHTML.includes('AUTO är på'),name==='other');
}
console.log('PASS: båda chattvägarnas byte/revision/rensning/fel/parallellitet och IG Godkänn-läge, utan nätverk/order');
