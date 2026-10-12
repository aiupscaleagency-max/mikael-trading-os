// Isolerade regressionskontroller utan IG-anrop eller order.
import assert from 'node:assert/strict';
const {createIgMarkets}=await import('../src/integrations/igMarkets.ts');
const {IG_HISTORY_RATE_ERROR}=await import('../src/integrations/igConnection.ts');
let calls=0;
const market=createIgMarkets({now:()=>1000,historyBlockedUntil:()=>2000,call:async()=>{calls++;throw Error('Otillåtet testanrop');},status:()=>({environments:{demo:{status:'connected',connectionGeneration:'test',account:{currency:'SEK'}},live:{status:'disconnected'}}})});
await assert.rejects(market.candles('demo','TEST','1m'),e=>e.message===IG_HISTORY_RATE_ERROR);
assert.equal(calls,0,'Global historikspärr måste kontrolleras före instrumentmetadata');
assert.equal(await market.accountFx('demo','USD'),null);
assert.match(market.accountFxError('demo','USD'),/prisrepresentation/);
assert.equal(calls,0,'Saknat FX-underlag ska blockera före IG-läsning');
console.log('PASS: historikspärr före metadata och produktionslik FX utan representationsbevis blockerad');
