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

const {evaluateIgStrategies,getIgStrategyRequirements}=await import('../src/integrations/igStrategies.js');
const {computeSeries,evalAll}=await import('../src/strategies/ruleEngine.js');
const {ema:legacyEma,atr:legacyAtr}=await import('../src/indicators/ta.js');
// Oberoende sluten EMA-formel för pandas adjust=False; varierande TR skiljer SMA från Wilder.
const varied=bars(Array.from({length:60},(_,i)=>100+(i%7)*3+i/10));varied.forEach((b,i)=>{b.high=b.close+1+(i%5);b.low=b.close-1-(i%3);});
const course=evaluateIgStrategy({...input,candles:varied});assert.equal(course.status,'evaluated');
const weightedEma=(period:number)=>{const k=2/(period+1),values=varied.map(b=>b.close);return values[0]!*(1-k)**(values.length-1)+values.slice(1).reduce((sum,v,j)=>sum+k*v*(1-k)**(values.length-j-2),0);};
assert.ok(Math.abs(course.indicators!.ema12-weightedEma(12))<1e-10);assert.ok(Math.abs(course.indicators!.ema21-weightedEma(21))<1e-10);
const trueRanges=varied.map((b,i)=>i?Math.max(b.high-b.low,Math.abs(b.high-varied[i-1]!.close),Math.abs(b.low-varied[i-1]!.close)):b.high-b.low),expectedAtr=trueRanges.slice(-14).reduce((sum,v)=>sum+v,0)/14;
assert.equal(course.indicators!.atr14,expectedAtr);assert.ok(Math.abs(course.indicators!.atr14-legacyAtr(varied.map(b=>b.high),varied.map(b=>b.low),varied.map(b=>b.close),14)!)>0.01);assert.ok(Math.abs(course.indicators!.ema12-legacyEma(varied.map(b=>b.close),12)!)>1e-8);
assert.equal(listIgStrategies().length,7);assert.equal(getIgStrategyRequirements('15m').requiredCandles,200);assert.equal(getIgStrategyRequirements('4h').requiredCandles,200);
for(const timeframe of ['5m','15m','1h','4h']){
 const ms={'5m':300000,'15m':900000,'1h':3600000,'4h':14400000}[timeframe]!;
 const candles=Array.from({length:220},(_,i)=>{const close=100+i/5+Math.sin(i/4)*10;return {open:close,high:close+2,low:close-2,close,openTime:now-(220-i)*ms,closeTime:now-(219-i)*ms,volume:null};});
 const comparisons=evaluateIgStrategies({...input,candles,timeframe,name:'EUR/USD',category:'forex',instrumentType:'CURRENCIES'});
 assert.equal(comparisons.length,7);const sourceSeries=computeSeries(candles.map(b=>({...b,volume:Number.NaN})));
 for(const metadata of listIgStrategies().filter(s=>s.timeframe===timeframe)){
  const comparison=comparisons.find(s=>s.strategyId===metadata.id)!;
  assert.equal(comparison.enabled,false);assert.equal(comparison.validationStatus,'notBacktested');
  if(metadata.id==='ig-volume-breakout-1h'){assert.equal(comparison.status,'blocked_missing_verified_volume');assert.equal(comparison.entrySignal,null);continue;}
  assert.equal(comparison.status,'evaluated');assert.equal(comparison.entrySignal,evalAll(sourceSeries,metadata.entry.conditions as any,candles.length-1).pass);assert.equal(comparison.exitCondition,evalAll(sourceSeries,(metadata.exit as any).conditions,candles.length-1).pass);
 }
 assert.ok(comparisons.filter(s=>s.requiredTimeframe!==timeframe).every(s=>s.status==='not_applicable'));
 const insufficient=evaluateIgStrategies({...input,candles:candles.slice(-19),timeframe,name:'EUR/USD',category:'forex'});assert.ok(insufficient.filter(s=>listIgStrategies().find(m=>m.id===s.strategyId)?.timeframe===timeframe).every(s=>s.status==='insufficient_data'));
}
assert.ok(evaluateIgStrategies({...input,timeframe:'15m',name:'Bitcoin ETF',instrumentType:'SHARES',category:'crypto'}).every(s=>s.status==='not_applicable'));
console.log('IG multi-strategy: 7 versions, legacy rule parity, course EMA/rollingATR parity, warmup200, blocked volume och no orders PASS');
