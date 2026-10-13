import type { Candle } from './igMarketData.js';

const INTERVALS: Record<string, number> = { '1m':60_000, '3m':180_000, '5m':300_000, '15m':900_000, '30m':1_800_000, '1h':3_600_000, '4h':14_400_000, '1d':86_400_000 };
/** Endast diagram: hela, sammanhängande grupper av stängda IG-ljus. Ingen fyllning av luckor. */
export function chartClosedSeries(interval: string, read: (iv: string) => Candle[], now: number): { candles: Candle[]; aggregatedFrom: string[] } {
  const dst=INTERVALS[interval];
  const native=read(interval).filter(bar=>bar.closed&&Number.isFinite(bar.openTime)&&(!dst||bar.openTime+dst<=now));
  const merged=new Map<number,Candle>();
  const aggregatedFrom:string[]=[];
  if(dst){
    // Minsta intervall först; större/native ljus har företräde vid samma öppningstid.
    for(const [iv,src] of Object.entries(INTERVALS).sort((a,b)=>a[1]-b[1])){
      if(src>=dst || dst%src!==0)continue;
      const groups=new Map<number,Map<number,Candle>>();
      for(const bar of read(iv)){
        if(!bar.closed || ![bar.openTime,bar.open,bar.high,bar.low,bar.close].every(Number.isFinite) || bar.openTime%src!==0 || bar.openTime+src>now)continue;
        const start=Math.floor(bar.openTime/dst)*dst;
        const group=groups.get(start)??new Map<number,Candle>();group.set(bar.openTime,bar);groups.set(start,group);
      }
      let used=false;
      for(const [start,group] of groups){
        const need=dst/src;if(start+dst>now || group.size!==need)continue;
        // IG kan ha annan sessionsgräns än UTC. Native ljus äger hela sitt tidsfönster.
        if(native.some(bar=>start<bar.openTime+dst&&start+dst>bar.openTime))continue;
        const parts:Candle[]=[];for(let i=0;i<need;i++){const part=group.get(start+i*src);if(!part)break;parts.push(part);}
        if(parts.length!==need)continue;
        const first=parts[0],last=parts[parts.length-1];if(!first||!last)continue;
        merged.set(start,{openTime:start,closeTime:start+dst,open:first.open,high:Math.max(...parts.map(b=>b.high)),low:Math.min(...parts.map(b=>b.low)),close:last.close,volume:parts.reduce((n,b)=>n+b.volume,0),quoteVolume:parts.reduce((n,b)=>n+b.quoteVolume,0),trades:parts.reduce((n,b)=>n+b.trades,0),closed:true});used=true;
      }
      if(used)aggregatedFrom.push(iv);
    }
  }
  for(const bar of native)merged.set(bar.openTime,bar);
  return {candles:[...merged.values()].sort((a,b)=>a.openTime-b.openTime),aggregatedFrom};
}
