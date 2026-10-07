import assert from 'node:assert/strict';
import {evaluateIgStrategy,listIgStrategies} from '../src/integrations/igStrategies.js';
const now=Date.UTC(2026,9,7),day=86400000;
const bars=(closes:number[])=>closes.map((close,i)=>({openTime:now-(closes.length-i)*day,closeTime:now-(closes.length-i-1)*day,open:close,high:close+2,low:close-2,close,volume:null}));
const closes=Array.from({length:60},(_,i)=>100+i);
const input={epic:'fixture-bitcoin',name:'Bitcoin (USD)',timeframe:'1d',now,candles:bars(closes)};
const result=evaluateIgStrategy(input);assert.equal(result.status,'evaluated');assert.equal(result.entrySignal,true);assert.equal(result.exitCondition,false);assert.equal(result.stopDistance,8);assert.equal(result.stopLevel,null);assert.equal(result.validationStatus,'notBacktested');assert.equal(result.enabled,false);
assert.equal(evaluateIgStrategy({...input,timeframe:'1h'}).status,'not_applicable');assert.equal(evaluateIgStrategy({...input,name:'ETH/USD'}).status,'not_applicable');assert.equal(evaluateIgStrategy({...input,name:'BTC/GBP',instrumentCurrency:'USD'}).status,'not_applicable');assert.equal(evaluateIgStrategy({...input,name:'Bitcoin'}).status,'not_applicable');assert.equal(evaluateIgStrategy({...input,name:'Bitcoin',instrumentCurrency:'USD'}).status,'evaluated');
assert.equal(evaluateIgStrategy({...input,candles:bars(closes.slice(0,49))}).status,'insufficient_data');assert.equal(evaluateIgStrategy({...input,candles:bars(closes.slice(0,50))}).status,'evaluated');
const future=bars(closes);future[59]!.closeTime+=day;assert.equal(evaluateIgStrategy({...input,candles:future}).status,'invalid_data');const gap=bars(closes);gap[25]!.openTime-=day;assert.equal(evaluateIgStrategy({...input,candles:gap}).status,'invalid_data');
// Hitta första exakta EMA-korsningen; en redan bearish serie är inte en ny exit.
let cross:number[]|null=null;for(let v=158;v>1;v--){const candidate=[...closes,v];if(evaluateIgStrategy({...input,candles:bars(candidate)}).exitCondition){cross=candidate;break;}}
assert.ok(cross);assert.equal(evaluateIgStrategy({...input,candles:bars(cross!)}).exitCondition,true);assert.equal(evaluateIgStrategy({...input,candles:bars(Array.from({length:60},(_,i)=>200-i))}).exitCondition,false);
const flat=evaluateIgStrategy({...input,candles:bars(Array(60).fill(100))});assert.equal(flat.entrySignal,false,'Entry kräver strikta >, inte >=');
assert.deepEqual(evaluateIgStrategy(input),evaluateIgStrategy(input),'Utvärdering är ren och deterministisk');const registry=listIgStrategies();assert.equal(registry[0]?.entry.maxOpenPositions,1);assert.equal(registry[0]?.costs.perSideBps,6);assert.equal(registry[0]?.stop.trailing,false);
console.log('IG Luengos 12/21/50: exakta regler, BTCUSD1d scope, warmup, ATR, korsning, datakvalitet och inga order PASS');
