// Aggregate only received, broker-derived subcandles; never call an incomplete bucket closed.
export function mergeStreamCandle(prior,data,seconds,sourceSeconds,state=new Map()){
 const bucket=Math.floor(data.openTime/(seconds*1000))*seconds*1000;
 if(prior?.closed)return {...prior};
 if(!state.has(bucket))state.set(bucket,new Map());
 const parts=state.get(bucket),old=parts.get(data.openTime);
 if(!old?.closed||data.closed)parts.set(data.openTime,{...data});
 const rows=[...parts.values()].sort((a,b)=>a.openTime-b.openTime),first=rows[0],last=rows.at(-1);
 const count=seconds/sourceSeconds;
 const complete=rows.length===count&&rows.every((r,i)=>r.openTime===bucket+i*sourceSeconds*1000&&r.closed);
 return {...last,openTime:bucket,open:first.open,high:Math.max(...rows.map(r=>r.high)),low:Math.min(...rows.map(r=>r.low)),close:last.close,closed:complete,partial:!complete&&seconds!==sourceSeconds};
}
