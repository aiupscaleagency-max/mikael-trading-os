// Isolerade regressionstester: urval får aldrig läcka mellan Demo och Live.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const start = html.indexOf('window.IGS = (function(){');
const end = html.indexOf('// ── Valutapar: urvalsknappar', start);
function fixture(){
  const timers = new Map(), requests = [], events = {}, listeners = {};
  const panel = { textContent: "gammal session", innerHTML: "" }, button = { disabled: false, textContent: "Starta" };
  let id = 0;
  const IG = { st: { env: 'demo' }, esc: x=>x, on: (name, fn)=>{ events[name] = fn; } };
  const MK = { _selLoaded: false, sel: new Set(), render(){} };
  const context = { IG, MK, window: { MK }, document: { querySelectorAll: selector=>selector.includes("start-saved") ? [button] : selector.includes("igs-session") ? [panel] : [], addEventListener: (name, fn)=>{ (listeners[name] ||= []).push(fn); } }, confirm: ()=>true,
    setTimeout: fn=>{ timers.set(++id, fn); return id; }, clearTimeout: n=>timers.delete(n), setInterval(){}, alert: text=>{ throw new Error(text); },
    fetch: (url, options)=>new Promise(resolve=>requests.push({ url, options, answer: data=>resolve({ json: async()=>data }) })) };
  vm.runInNewContext(html.slice(start, end), context);
  timers.clear(); // Startens automatiska hämtning styrs manuellt i testet.
  return { api: context.window.IGS, IG, MK, timers, requests, panel, button, listeners,
    change(env){ IG.st.env = env; MK.sel.clear(); events.env(); },
    flushTimers(){ for(const [n, fn] of [...timers]){ timers.delete(n); fn(); } } };
}
const settle = async()=>{ for(let n=0;n<8;n++) await Promise.resolve(); };
const state = (env, epic)=>({ ok:true, env, selection:{ epics:[epic] }, session:null, history:[], schedule:[] });
{
  const f=fixture(); f.api.saveSelection(['DEMO']); f.change('live'); f.flushTimers();
  assert.equal(f.requests.filter(r=>r.options?.method==='POST').length,0);
  f.requests[0].answer(state('live','LIVE')); await settle();
  assert.deepEqual([...f.MK.sel],['LIVE']);
}
{
  const f=fixture(); f.api.load(); f.change('live');
  f.requests[1].answer(state('live','LIVE')); await settle();
  f.requests[0].answer(state('demo','DEMO')); await settle();
  assert.deepEqual([...f.MK.sel],['LIVE']); assert.equal(f.api.state().env,'live');
}
{
  const f=fixture(); f.api.load(); f.change('live'); f.change('demo');
  f.requests[2].answer(state('demo','NEW')); await settle();
  f.requests[0].answer(state('demo','OLD')); f.requests[1].answer(state('live','LIVE')); await settle();
  assert.deepEqual([...f.MK.sel],['NEW']);
}
{
  const f=fixture(), list=['ONE']; f.api.saveSelection(list); list.push('TWO'); f.flushTimers();
  assert.deepEqual(JSON.parse(f.requests[0].options.body).epics,['ONE']);
  f.requests[0].answer({ok:true,env:'demo'}); await settle();
  assert.equal(f.requests[1].url,'/api/ig/session');
}
{
  const f=fixture(); f.change('live');
  assert.equal(f.button.disabled,true);
  assert.equal(f.panel.textContent,'Hämtar agentsession för aktiv miljö…');
}
{
  const f=fixture(), pending=f.api.startSession(['DEMO']);
  f.change('live'); f.requests[0].answer({sessionMinutes:60}); await pending; await settle();
  assert.equal(f.requests.filter(r=>r.options?.method==='POST').length,0);
}
{
  const f=fixture(); f.api.load(); f.requests[0].answer(state('demo','DEMO')); await settle();
  const stale = {dataset:{igs:'stop',igsEnv:'demo'}};
  f.change('live');
  for(const listener of f.listeners.click) listener({target:{closest: selector=>selector==='[data-igs]' ? stale : null}});
  assert.equal(f.requests.filter(r=>r.options?.method==='POST').length,0);
}
{
  const f=fixture(); f.api.load();
  f.requests[0].answer({ ...state('demo','DEMO'), session:{ env:'demo', status:'running', trigger:'manuell', epics:['DEMO'], items:[], attempts:[], analysisInterval:'1m', durationMinutes:60, orderAttempts:0, maxOrderAttempts:5 } });
  await settle();
  assert.match(f.panel.innerHTML,/data-igs-env="demo"/);
  assert.doesNotMatch(f.panel.innerHTML,/\$\{esc/);
}
console.log('IG-urval: 8 miljö-, sessions- och debouncekontroller godkända');
