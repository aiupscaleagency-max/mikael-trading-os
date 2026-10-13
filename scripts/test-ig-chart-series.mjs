import assert from 'node:assert/strict';
import { chartClosedSeries } from '../dist/server/igChartSeries.js';
const hour=3600000, minute=60000,start=Date.UTC(2026,9,12,8);
const bars=Array.from({length:180},(_,i)=>({openTime:start+i*minute,closeTime:start+(i+1)*minute,open:100+i,high:102+i,low:99+i,close:101+i,volume:1,quoteVolume:2,trades:3,closed:true}));
const run=(rows,native=[],now=start+3*hour)=>chartClosedSeries('1h',iv=>iv==='1m'?rows:iv==='1h'?native:[],now);
let result=run(bars);assert.equal(result.candles.length,3);assert.deepEqual(result.aggregatedFrom,['1m']);assert.equal(result.candles[0].open,100);assert.equal(result.candles[0].close,160);assert.equal(result.candles[0].high,161);assert.equal(result.candles[0].low,99);assert.equal(result.candles[0].volume,60);
assert.equal(run(bars.filter((_,i)=>i!==20)).candles.length,2);assert.equal(run(bars.slice(1)).candles.length,2);assert.equal(run(bars,[],start+2*hour+30*minute).candles.length,2);
assert.equal(run([...bars,bars[0]]).candles.length,3);
const native={...bars[0],closeTime:start+hour,close:999};assert.equal(run(bars,[native]).candles[0].close,999);
assert.equal(run(bars.map((b,i)=>i===20?{...b,closed:false}:b)).candles.length,2);
assert.equal(chartClosedSeries('1h',()=>[],start+hour).candles.length,0);
console.log('PASS: 180 cached native IG 1m → 3 complete 1h OHLC; gaps/partial/forming excluded; duplicates deduplicated; native interval wins; no fabricated candles');

// Native IG 08:30–09:30 överlappar två UTC-timmar: båda aggregaten måste utelämnas.
const shifted={...native,openTime:start+30*minute,closeTime:start+90*minute};
const overlap=run(bars,[shifted]);assert.deepEqual(overlap.candles.map(b=>b.openTime),[start+30*minute,start+2*hour]);assert.equal(overlap.candles[0].close,999);
// Kant mot kant är inte överlapp: native 09:00 lämnar aggregatet 08:00 orört.
const boundary=run(bars,[{...native,openTime:start+hour,closeTime:start+2*hour}]);assert.equal(boundary.candles.length,3);assert.equal(boundary.candles[0].openTime,start);
console.log("PASS: shifted native candle owns full interval; overlapping aggregates rejected, adjacent candles preserved");
