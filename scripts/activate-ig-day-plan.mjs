// Aktiverar de fyra godkända analysfönstren; ändrar inga orderflaggor eller nycklar.
const base='https://aiupscale-dator1.tail64d627.ts.net:9443';
async function request(path,body){const r=await fetch(base+path,{signal:AbortSignal.timeout(15000),headers:body?{'Content-Type':'application/json',Origin:base}:{},...(body?{method:'POST',body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(`IG-plan: HTTP ${r.status}; inga fler ändringar görs`);return r.json();}
let ready=false;for(let attempt=0;attempt<8;attempt++){try{const html=await fetch(base,{signal:AbortSignal.timeout(5000)}).then(r=>r.text());if(html.includes('session-margin')){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}if(!ready)throw Error('Nya tjänsten är ännu inte igång; kör detta skript efter uppdateringen');
const status=await request('/api/ig/status');let activated=0;
for(const environment of ['demo','live']){
 if(status.environments?.[environment]?.status!=='connected'){console.log(`${environment}: inte anslutet; inget schema aktiverat`);continue;}
 const epics=new Set();for(const category of ['forex','crypto']){const result=await request(`/api/ig/directory?environment=${environment}&category=${category}`);for(const m of result.markets??[])if(typeof m.epic==='string')epics.add(m.epic);if(!result.complete)console.log(`${environment}/${category}: partiell katalog, endast hämtade instrument ingår`);}
 if(!epics.size||epics.size>300)throw Error(`${environment}: 60-minutersplanen kräver 1–300 instrument; välj ett mindre urval`);
 const schedules=await request(`/api/ig/schedules?environment=${environment}`);
 for(const [name,localTime] of [['Morgon','08:00'],['Lunch','12:00'],['Eftermiddag','15:00'],['Kväll','19:00']]){const old=schedules.schedules?.find(s=>s.name===name&&s.localTime===localTime);await request('/api/ig/schedules',{environment,id:old?.id,name,localTime,timezone:'Europe/Stockholm',recurrence:'weekly',weekdays:[1,2,3,4,5,6,7],epics:[...epics],timeframe:'1m',percent:1,marginPercent:1,maxTrades:5,horizonMinutes:5,durationMinutes:60,intervalMinutes:1,maxPositions:1,enabled:true});activated++;console.log(`${environment}: ${name} ${localTime} Stockholm aktiverat för analys och manuella orderförslag`);}
}
if(!activated)throw Error('Ingen ansluten miljö kunde aktiveras');
console.log('Separat SL-risktak 1 %, marginaltak 1 % (justerbart 1–3 %), max fem nya orderförsök/session. Automatisk orderhandel har inte aktiverats.');
