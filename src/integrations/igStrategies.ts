import {ema,sma,atr} from '../indicators/ta.js';
import type {IgCandle} from './igWorkspace.js';
// Avskriven från lokal, kontrollerad spec. Ingen aktivering eller prestationsuppgift.
const registry=[{
 id:'luengos-12-21-50',name:'Luengos-12/21/50',version:1,status:'notBacktested',checked:true,enabled:false,
 instrument:'BTCUSD',timeframe:'1d',direction:'long_only',warmupBars:50,
 entry:{conditions:['close > EMA(12)','EMA(12) > EMA(21)','EMA(21) > SMA(50)'],combine:'all',fill:'next_bar_open',maxOpenPositions:1,cooldownBars:0},
 exit:{condition:'EMA(12) crosses_below EMA(21)',fill:'next_bar_open',target:null,timeStopBars:null},
 stop:{type:'atr_multiple',multiple:2,atrPeriod:14,trailing:false,intrabar:true},
 sizing:{riskPerTradePercent:1,maxOpenRiskPercent:1,startingEquityUsd:100000},costs:{perSideBps:6},
 source:{json:'projects/ptqa-trading/day-1-recording-work/strategy.json',document:'projects/ptqa-trading/day-1-recording-work/STRATEGY.md',created:'2026-09-29',historyStart:'2014-01-01',dataSource:'Tiingo',session:'24h'},
 notes:['Kontrollerad specifikation; ännu inte backtestad.','Tiingo-dagsljus och IG:s dagsljus kan ha olika session/prisgrund. Reglernas utvärdering på IG är ingen verifierad strategiöverföring.','ETH/USDT 1h/VWAP-regeln är parkerad och ingår inte i denna strategi.','Stoppen är entryFill − 2×ATR(14), inte senaste stängningspris minus ATR. Nästa öppningspris är ännu okänt.']
}] as const;
export function listIgStrategies(){return structuredClone(registry);}
export interface IgStrategyInput {candles:IgCandle[];epic:string;name:string|null;timeframe:string;now:number;instrumentCurrency?:string|null}
export function evaluateIgStrategy(input:IgStrategyInput){
 const strategy=registry[0];
 const base={strategyId:strategy.id,strategyVersion:strategy.version,validationStatus:strategy.status,enabled:false,epic:input.epic,timeframe:input.timeframe,execution:'analysis_only' as const,direction:'long_only' as const,entryFill:'next_bar_open' as const,exitFill:'next_bar_open' as const,entryConditions:null as null|{closeAboveEma12:boolean;ema12AboveEma21:boolean;ema21AboveSma50:boolean},exitCondition:null as null|boolean,entrySignal:null as null|boolean,indicators:null as null|{close:number;ema12:number;ema21:number;sma50:number;atr14:number;previousEma12:number;previousEma21:number},stopDistance:null as number|null,stopLevel:null,sizing:structuredClone(strategy.sizing),costs:structuredClone(strategy.costs),notes:structuredClone(strategy.notes)};
 // EPIC ensam bevisar inte noteringsvaluta. Bitcoin i GBP/EUR får inte bli BTCUSD.
 const name=input.name??'',explicitUsd=/\bBTC\s*[/_-]?\s*USD\b|\bBitcoin[\s(/_-]+USD\b/i.test(name);
 const explicitlyOtherCurrency=/\b(?:EUR|GBP|JPY|AUD|CAD|CHF|SEK|USDT|USDC)\b/i.test(name);
 const verifiedBtcUsd=!explicitlyOtherCurrency&&(explicitUsd||input.instrumentCurrency==='USD'&&/\bBitcoin\b|\bBTC\b/i.test(name));
 if(input.timeframe!=='1d'||!verifiedBtcUsd)return {...base,status:'not_applicable' as const,reason:'Strategin gäller endast verifierat BTC/USD på stängda dagsljus; inga andra instrument eller tidsramar.'};
 const bars=input.candles;
 if(!Number.isFinite(input.now)||bars.some((b,i)=>![b.open,b.high,b.low,b.close,b.openTime,b.closeTime].every(Number.isFinite)||b.open<=0||b.close<=0||b.low<=0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.closeTime-b.openTime!==86400000||b.closeTime>input.now||(i>0&&b.openTime-bars[i-1]!.openTime!==86400000)))return {...base,status:'invalid_data' as const,reason:'Kräver giltiga, sammanhängande och stängda 1d OHLC-ljus utan framtida tider.'};
 if(bars.length<strategy.warmupBars)return {...base,status:'insufficient_data' as const,reason:'Minst 50 stängda dagsljus krävs för SMA50 och övriga indikatorer.'};
 const last=bars.at(-1)!;
 if(input.now-last.closeTime>86400000)return {...base,status:'invalid_data' as const,reason:'Det senaste stängda dagsljuset är inaktuellt.'};
 const closes=bars.map(b=>b.close),ema12=ema(closes,12),ema21=ema(closes,21),sma50=sma(closes,50),atr14=atr(bars.map(b=>b.high),bars.map(b=>b.low),closes,14),previousEma12=ema(closes.slice(0,-1),12),previousEma21=ema(closes.slice(0,-1),21);
 if([ema12,ema21,sma50,atr14,previousEma12,previousEma21].some(v=>v===null||!Number.isFinite(v))||atr14!<=0)return {...base,status:'invalid_data' as const,reason:'EMA/SMA eller en positiv ATR14 kunde inte verifieras.'};
 const entryConditions={closeAboveEma12:last.close>ema12!,ema12AboveEma21:ema12!>ema21!,ema21AboveSma50:ema21!>sma50!};
 return {...base,status:'evaluated' as const,reason:'Deterministisk regelutvärdering; ingen order, storleksberäkning eller backtest.',entryConditions,entrySignal:Object.values(entryConditions).every(Boolean),exitCondition:previousEma12!>=previousEma21!&&ema12!<ema21!,indicators:{close:last.close,ema12:ema12!,ema21:ema21!,sma50:sma50!,atr14:atr14!,previousEma12:previousEma12!,previousEma21:previousEma21!},stopDistance:strategy.stop.multiple*atr14!,signalCloseTime:last.closeTime};
}
