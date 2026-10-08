import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createIgCourse} from '../src/integrations/igCourse.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ig-course-')),bundle=fileURLToPath(new URL('../reference/academy/ptqa-runtime-14758cc73bc9.zip',import.meta.url));
try{
 const workspace=path.join(root,'course');fs.mkdirSync(workspace);const python=path.join(root,'python');fs.writeFileSync(python,'fixture');
 const spec={name:'Saved rules',unresolved:[],instrument:{symbol:'btcusd',data_source:'tiingo'},timeframe:{bar:'1d'}};fs.writeFileSync(path.join(workspace,'strategy.json'),JSON.stringify(spec));
 const blocked=createIgCourse({workspace,python,bundle,ready:()=>false});assert.equal(blocked.view().canRun,false);await assert.rejects(blocked.run(),/Tiingo/);
 let writeResult=true;const calls:string[][]=[];const run=async(_file:string,args:string[])=>{calls.push(args);if(args[0]==='-c')return {stdout:'a'.repeat(64)};
  if(args[0]?.endsWith('run_backtest.py')&&writeResult)fs.writeFileSync(path.join(workspace,'backtest-result.json'),JSON.stringify({specName:spec.name,metrics:{trades:12},inputIdentity:{specSha256:'a'.repeat(64),barsSha256:'b'.repeat(64)}}));return {stdout:''};};
 const course=createIgCourse({workspace,python,bundle,runtime:path.join(root,'engine/runtime'),ready:()=>true,run});assert.equal(course.view().canRun,true);
 await course.run();await assert.rejects(course.run(),/redan/);await course.wait();assert.equal(course.view().status,'completed');assert.equal(course.view().metrics.trades,12);assert.ok(calls.some(args=>args.includes('--spec')));assert.ok(calls.every(args=>!args.includes('--ticker')&&!args.includes('--timeframe')));
 fs.writeFileSync(path.join(workspace,'strategy.json'),JSON.stringify({...spec,name:'Changed'}));assert.equal(course.view().metrics,null,'Ändrad strategi visar inte gammalt resultat');fs.writeFileSync(path.join(workspace,'strategy.json'),JSON.stringify(spec));
 writeResult=false;await course.run();await course.wait();assert.equal(course.view().status,'failed');assert.equal(course.view().metrics,null,'Motorn utan nytt resultat får inte återgodkänna föregående fil');assert.ok(fs.readdirSync(path.join(workspace,'backups')).length>=2);
 const bad=path.join(root,'bad.zip');fs.writeFileSync(bad,'wrong');await assert.rejects(createIgCourse({workspace,python,bundle:bad,ready:()=>true,run}).run(),/checksumma/);
 console.log('PASS: officiell kursbundle verifieras, privat miljö/Tiingo krävs, regler bevaras, singleflight, backup, nytt resultat och ändrad strategi spärrar gammal evidens; bara fixtures');
}finally{fs.rmSync(root,{recursive:true,force:true});}
