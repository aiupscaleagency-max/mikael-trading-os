#!/usr/bin/env node
// Endast publika Bybit EU-data. Verifieringen skickar aldrig ordrar.
import assert from "node:assert/strict";
import { startKlineStream, subscribeClosedCandles, getFormingCandle, getClosedCandles, getKlineStreamStatus, stopKlineStream } from "../dist/server/klineStream.js";
import { buildSignal } from "../dist/server/signalEngine.js";
const symbol=(process.argv[2] || "BTCUSDC").toUpperCase();
const interval=process.argv[3] || "1m";
const iv={"1m":"1","5m":"5","15m":"15","30m":"30","1h":"60","4h":"240","1d":"D","1w":"W"}[interval];
assert.ok(iv && symbol.endsWith("USDC"),"Välj Bybit EU USDC-par och giltigt candle-intervall");
const base="https://api.bybit.eu";
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(15000)});assert.ok(r.ok,`HTTP ${r.status}`);const d=await r.json();assert.equal(d.retCode,0,d.retMsg);return d;}
try {
  await json(base+'/v5/market/time');
  console.log('PASS: Bybit EU REST tillgängligt');
  await startKlineStream([symbol],interval);
  const candle=await new Promise(resolve=>{
    let timer; const unsub=subscribeClosedCandles((s,i,c)=>{if(s===symbol && i===interval){clearTimeout(timer);unsub();resolve(c);}});
    timer=setTimeout(()=>{unsub();resolve(null);},90000);
  });
  assert.ok(getKlineStreamStatus().connected,'Bybit EU WebSocket ej ansluten');
  assert.ok(candle,'Inget stängt ljus inom 90 sekunder');
  const d=await json(`${base}/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&start=${candle.openTime}&end=${candle.closeTime}&limit=1`);
  const rest=d.result.list[0];assert.ok(rest,'REST-ljus saknas');
  assert.deepEqual([candle.open,candle.high,candle.low,candle.close],rest.slice(1,5).map(Number));
  const history=getClosedCandles(symbol,interval),forming=getFormingCandle(symbol,interval);
  assert.ok(history.every(c=>c.closed && c.closeTime<Date.now()));
  assert.ok(!forming || !history.some(c=>c.openTime===forming.openTime));
  assert.ok(history.length>=50,'Otillräcklig historik');
  const signal=buildSignal(symbol,interval,history);
  if(signal)assert.ok(signal.stopLoss>0 && Number.isFinite(signal.stopLoss));
  console.log(`PASS: ${symbol} ${interval} WebSocket OHLC exakt lika med Bybit EU REST; ${history.length} stängda ljus; forming separerat; signal med stop-loss`);
}catch(err){console.error('FAIL:',err.message);process.exitCode=1;}
finally{stopKlineStream();process.exit(process.exitCode || 0);}
