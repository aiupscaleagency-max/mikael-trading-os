import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
// Verkliga filterfunktioner körs med samma markerings-Set; ingen order eller API används.
const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,textContent:''});return nodes.get(id);};
const selected=new Set(['A']);const markets=[{epic:'A',name:'Euro',category:'forex'},{epic:'B',name:'Bitcoin',category:'crypto'}];
let predicate=()=>true;
const ctx={$,MK:{sel:selected,visible:cat=>markets.filter(m=>m.category===cat).filter(predicate),setFilter:f=>{predicate=f;},setSort(){}},fav:{list:new Set()},enr:{},regions:()=>[],document:{querySelectorAll:()=>[]}};
vm.createContext(ctx);
const start=html.indexOf('  const F = ()=>({ cat:$("mkf-cat")');const end=html.indexOf('  ["mkf-cat","mkf-fav","mkf-selected"',start);
vm.runInContext(html.slice(start,end),ctx);
vm.runInContext('apply()',ctx);assert.equal(predicate(markets[0]),true);
$('mkf-cat').value='crypto';vm.runInContext('filterStatus()',ctx);assert.match($('mkf-state').textContent,/Ändrade filter/);assert.equal(predicate(markets[0]),true);
vm.runInContext('apply()',ctx);assert.equal(predicate(markets[0]),false);assert.equal(predicate(markets[1]),true);assert.deepEqual([...selected],['A']);
$('mkf-cat').value='';$('mkf-selected').checked=true;vm.runInContext('apply()',ctx);assert.equal(predicate(markets[0]),true);assert.equal(predicate(markets[1]),false);
selected.add('B');vm.runInContext('filterStatus()',ctx);assert.match($('mkf-state').textContent,/2 matchande · 2 markerade/);
const ppStart=html.indexOf('  function filtered(){',html.indexOf('let filter = "crypto", draftFilter'));const ppEnd=html.indexOf('  function colHtml(',ppStart);
const ppFns=html.slice(ppStart,ppEnd)+html.slice(html.indexOf('  function filterStatus(){',html.indexOf('let filter = "crypto", draftFilter')),html.indexOf('  $("pp-filter").addEventListener("click"',ppStart));
const pp={$,filter:'all',draftFilter:'all',query:'',selectedOnly:false,shown:24,S:()=>selected,listFor:f=>markets.filter(m=>f==='all'||m.category===f),render(){}};vm.createContext(pp);vm.runInContext(ppFns,pp);
$('pp-q').value='Bitcoin';vm.runInContext('filterStatus()',pp);assert.equal(vm.runInContext('filtered().length',pp),2);assert.match($('pp-filter-state').textContent,/Ändrade filter/);
vm.runInContext('applyPairFilters()',pp);assert.equal(vm.runInContext('filtered()[0].epic',pp),'B');assert.deepEqual([...selected],['A','B']);
$('pp-q').value='';$('pp-selected-only').checked=true;selected.delete('B');vm.runInContext('applyPairFilters()',pp);assert.equal(vm.runInContext('filtered()[0].epic',pp),'A');assert.equal(vm.runInContext('filtered().length',pp),1);
// Nollställ får bara ändra filter, aldrig analys-/sessionsurvalet.
const mkReset=html.split('$("mkf-reset").addEventListener("click",()=>{')[1].split('});')[0];
vm.runInContext(mkReset,ctx);assert.equal($('mkf-selected').checked,false);assert.equal($('mkf-cat').value,'');assert.deepEqual([...selected],['A']);
const ppReset=html.split('$("pp-reset").addEventListener("click",()=>{')[1].split('});')[0];
pp.document={querySelectorAll:()=>[]};vm.runInContext(ppReset,pp);assert.equal(pp.filter,'all');assert.equal(pp.selectedOnly,false);assert.equal(vm.runInContext('filtered().length',pp),2);assert.deepEqual([...selected],['A']);
for(const id of ['mkf-search' ,'mkf-reset','pp-search','pp-reset'])assert(html.includes('id="'+id+'"'));
assert(html.includes('ev.key==="Enter"'));assert(!ppFns.includes('fetch('));
console.log('PASS: inline syntax; draft filters wait for Sök; applied category/search/selected-only; live counts; independent preserved selection; Enter/reset controls');

// Enter i textfält söker; Enter på knappar måste behålla native aktivering.
for(const [container,input] of [["pp-filter","pp-q"],["mk-filters","mkf-q"]]){const line=html.split("\n").find(l=>l.includes(`$("${container}").addEventListener("keydown"`));const code=line.slice(line.indexOf("ev=>"),line.lastIndexOf(");"));let applied=0;const handler=vm.runInNewContext("("+code+")",{apply:()=>applied++,applyPairFilters:()=>applied++});let prevented=0;handler({key:"Enter",target:{id:input},preventDefault(){prevented++;}});handler({key:"Enter",target:{id:"reset-button"},preventDefault(){prevented++;}});assert.equal(applied,1);assert.equal(prevented,1);}

// Demo-katalogreferenser måste följa samma filter som handelsbara kort.
const refsLine=html.split('\n').find(l=>l.includes('const refs = ((d && d.liveReferences)'));
const refCtx=vm.createContext({d:{liveReferences:markets},filterFn:m=>m.name==='Bitcoin'});
vm.runInContext(refsLine+';globalThis.filteredRefs=refs;',refCtx);
assert.deepEqual(Array.from(refCtx.filteredRefs,m=>m.epic),['B']);
console.log('PASS: Demo-referenser följer samma instrumentfilter');
