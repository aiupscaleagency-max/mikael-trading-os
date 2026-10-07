import {sma} from '../indicators/ta.js';
import {computeSeries,evalAll,type Rule,type IndicatorKey} from '../strategies/ruleEngine.js';
import type {IgCandle} from './igWorkspace.js';
// Kursens pandas ewm(span, adjust=False): första close är seed, ej SMA.
function courseEma(values:number[],period:number){if(!values.length)return null;let e=values[0]!;const k=2/(period+1);for(const v of values.slice(1))e=v*k+e*(1-k);return e;}
function courseAtr(bars:IgCandle[],period:number){if(bars.length<period)return null;const tr=bars.map((b,i)=>i?Math.max(b.high-b.low,Math.abs(b.high-bars[i-1]!.close),Math.abs(b.low-bars[i-1]!.close)):b.high-b.low);return tr.slice(-period).reduce((sum,v)=>sum+v,0)/period;}
// Avskriven från lokal, kontrollerad spec. Ingen aktivering eller prestationsuppgift.
const registry=[{
 id:'luengos-12-21-50',name:'Luengos-12/21/50',version:1,status:'notBacktested',checked:true,enabled:false,
 instrument:'BTCUSD',timeframe:'1d',direction:'long_only',warmupBars:50,
 entry:{conditions:['close > EMA(12)','EMA(12) > EMA(21)','EMA(21) > SMA(50)'],combine:'all',fill:'next_bar_open',maxOpenPositions:1,cooldownBars:0},
 exit:{condition:'EMA(12) crosses_below EMA(21)',fill:'next_bar_open',target:null,timeStopBars:null},
 stop:{type:'atr_multiple',multiple:2,atrPeriod:14,trailing:false,intrabar:true},
 sizing:{riskPerTradePercent:1,maxOpenRiskPercent:1,startingEquityUsd:100000},costs:{perSideBps:6},
 source:{json:'projects/ptqa-trading/day-1-recording-work/strategy.json',document:'projects/ptqa-trading/day-1-recording-work/STRATEGY.md',created:'2026-09-29',historyStart:'2014-01-01',dataSource:'Tiingo',session:'24h'},
 notes:['Kontrollerad specifikation; ännu inte backtestad. EMA följer kursens adjust=False med första close som seed; ATR är enkel rullande TR-medel.','Tiingo-dagsljus och IG:s dagsljus kan ha olika session/prisgrund. Reglernas utvärdering på IG är ingen verifierad strategiöverföring.','ETH/USDT 1h/VWAP-regeln är parkerad och ingår inte i denna strategi.','Stoppen är entryFill − 2×ATR(14), inte senaste stängningspris minus ATR. Nästa öppningspris är ännu okänt. Live-utvärderingen använder endast signalbarens kända ATR; kursens historiska simulator läser nästa entry-bars ATR, vilket är en separat lookahead-risk.']
}] as const;
export function listIgStrategies(){return structuredClone([...registry,...legacyRegistry]);}
export interface IgStrategyInput {candles:IgCandle[];epic:string;name:string|null;timeframe:string;now:number;instrumentCurrency?:string|null;category?:'forex'|'crypto'|null;instrumentType?:string|null}
export function evaluateIgStrategy(input:IgStrategyInput){
 const strategy=registry[0];
 const base={strategyId:strategy.id,strategyVersion:strategy.version,requiredTimeframe:strategy.timeframe,validationStatus:strategy.status,enabled:false,epic:input.epic,timeframe:input.timeframe,execution:'analysis_only' as const,direction:'long_only' as const,entryFill:'next_bar_open' as const,exitFill:'next_bar_open' as const,entryConditions:null as null|{closeAboveEma12:boolean;ema12AboveEma21:boolean;ema21AboveSma50:boolean},exitCondition:null as null|boolean,entrySignal:null as null|boolean,indicators:null as null|{close:number;ema12:number;ema21:number;sma50:number;atr14:number;previousEma12:number;previousEma21:number},stopDistance:null as number|null,stopLevel:null,sizing:structuredClone(strategy.sizing),costs:structuredClone(strategy.costs),notes:structuredClone(strategy.notes)};
 // EPIC ensam bevisar inte noteringsvaluta. Bitcoin i GBP/EUR får inte bli BTCUSD.
 const name=input.name??'',explicitUsd=/\bBTC\s*[/_-]?\s*USD\b|\bBitcoin[\s(/_-]+USD\b/i.test(name);
 const explicitlyOtherCurrency=/\b(?:EUR|GBP|JPY|AUD|CAD|CHF|SEK|USDT|USDC)\b/i.test(name);
 const verifiedBtcUsd=!explicitlyOtherCurrency&&(explicitUsd||input.instrumentCurrency==='USD'&&/\bBitcoin\b|\bBTC\b/i.test(name));
 if(input.timeframe!=='1d'||!verifiedBtcUsd||input.instrumentType&&input.instrumentType!=='CURRENCIES')return {...base,status:'not_applicable' as const,reason:'Strategin gäller endast verifierat BTC/USD på stängda dagsljus; inga andra instrument eller tidsramar.'};
 const bars=input.candles;
 if(!Number.isFinite(input.now)||bars.some((b,i)=>![b.open,b.high,b.low,b.close,b.openTime,b.closeTime].every(Number.isFinite)||b.open<=0||b.close<=0||b.low<=0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.closeTime-b.openTime!==86400000||b.closeTime>input.now||(i>0&&b.openTime-bars[i-1]!.openTime!==86400000)))return {...base,status:'invalid_data' as const,reason:'Kräver giltiga, sammanhängande och stängda 1d OHLC-ljus utan framtida tider.'};
 if(bars.length<strategy.warmupBars)return {...base,status:'insufficient_data' as const,reason:'Minst 50 stängda dagsljus krävs för SMA50 och övriga indikatorer.'};
 const last=bars.at(-1)!;
 if(input.now-last.closeTime>86400000)return {...base,status:'invalid_data' as const,reason:'Det senaste stängda dagsljuset är inaktuellt.'};
 const closes=bars.map(b=>b.close),ema12=courseEma(closes,12),ema21=courseEma(closes,21),sma50=sma(closes,50),atr14=courseAtr(bars,14),previousEma12=courseEma(closes.slice(0,-1),12),previousEma21=courseEma(closes.slice(0,-1),21);
 if([ema12,ema21,sma50,atr14,previousEma12,previousEma21].some(v=>v===null||!Number.isFinite(v))||atr14!<=0)return {...base,status:'invalid_data' as const,reason:'EMA/SMA eller en positiv ATR14 kunde inte verifieras.'};
 const entryConditions={closeAboveEma12:last.close>ema12!,ema12AboveEma21:ema12!>ema21!,ema21AboveSma50:ema21!>sma50!};
 return {...base,status:'evaluated' as const,reason:'Deterministisk regelutvärdering; ingen order, storleksberäkning eller backtest.',entryConditions,entrySignal:Object.values(entryConditions).every(Boolean),exitCondition:previousEma12!>=previousEma21!&&ema12!<ema21!,indicators:{close:last.close,ema12:ema12!,ema21:ema21!,sma50:sma50!,atr14:atr14!,previousEma12:previousEma12!,previousEma21:previousEma21!},stopDistance:strategy.stop.multiple*atr14!,signalCloseTime:last.closeTime};
}

interface LegacyDefinition {id:string;name:string;timeframe:string;warmupBars:number;entry:Rule[];exit:Rule[];stopAtr:number;targetAtr:number;originalCoins:string[];requiresVolume?:boolean}
const legacyDefinitions:LegacyDefinition[]=[
 {id:'ig-ema-cross-5m',name:'EMA-kors (trend)',timeframe:'5m',warmupBars:50,entry:[{left:'ema9',op:'crosses_above',right:'ema20'},{left:'close',op:'>',right:'sma50'}],exit:[{left:'ema9',op:'crosses_below',right:'ema20'}],stopAtr:1.5,targetAtr:3,originalCoins:['BTC','ETH','SOL']},
 {id:'ig-rsi-dip-15m',name:'RSI-studs (köp dippen i upptrend)',timeframe:'15m',warmupBars:200,entry:[{left:'rsi14',op:'<',right:30},{left:'close',op:'>',right:'sma200'}],exit:[{left:'rsi14',op:'>',right:55}],stopAtr:1.5,targetAtr:3,originalCoins:['BTC','ETH']},
 {id:'ig-bollinger-15m',name:'Rasmus · Bollinger-studs (15m)',timeframe:'15m',warmupBars:20,entry:[{left:'close',op:'<',right:'bb_lower'},{left:'rsi14',op:'<',right:35}],exit:[{left:'close',op:'>',right:'bb_mid'}],stopAtr:1.5,targetAtr:2.5,originalCoins:['AVAX','LINK']},
 {id:'ig-macd-1h',name:'Petra · MACD-vändning (1h)',timeframe:'1h',warmupBars:50,entry:[{left:'macd',op:'crosses_above',right:'macd_signal'},{left:'close',op:'>',right:'ema50'}],exit:[{left:'macd',op:'crosses_below',right:'macd_signal'}],stopAtr:1.5,targetAtr:3,originalCoins:['ADA','DOT','LTC']},
 {id:'ig-macro-trend-4h',name:'Markus · långsam trend (4h)',timeframe:'4h',warmupBars:200,entry:[{left:'ema20',op:'crosses_above',right:'ema50'},{left:'close',op:'>',right:'sma200'}],exit:[{left:'ema20',op:'crosses_below',right:'ema50'}],stopAtr:2,targetAtr:5,originalCoins:['BTC','ETH']},
 {id:'ig-volume-breakout-1h',name:'Breakout med volym',timeframe:'1h',warmupBars:21,entry:[{left:'close',op:'>',right:'high20'},{left:'volume',op:'>',right:'vol_sma20',factor:1.5}],exit:[{left:'close',op:'<',right:'ema20'}],stopAtr:2,targetAtr:4,originalCoins:['SOL','XRP','DOGE'],requiresVolume:true}
];
const legacyRegistry=legacyDefinitions.map(d=>({id:d.id,name:d.name,version:1,status:'notBacktested',checked:false,enabled:false,instrument:'IG Forex/Krypto',scope:['forex','crypto'],timeframe:d.timeframe,direction:'long_only',warmupBars:d.warmupBars,adapted:true,source:{file:'git:2eb62828d82406a87ab6519cdb327dd9ec0c72cf:src/strategies/library.ts',originalCoins:d.originalCoins},entry:{conditions:d.entry,combine:'all',fill:'source_same_bar_close_analysis_only',maxOpenPositions:1},exit:{conditions:d.exit,combine:'all',fill:'source_same_bar_close_analysis_only',targetAtr:d.targetAtr},stop:{type:'atr_multiple',multiple:d.stopAtr,atrPeriod:14,trailing:false,intrabar:true},sizing:null,costs:null,requiresVolume:!!d.requiresVolume,availability:d.requiresVolume?'blocked_missing_verified_volume':'analysis_only',notes:['Regelparametrar återanvända från tidigare spotbibliotek. Anpassad IG-v1; ingen verifierad CFD-backtest eller lönsamhet.','EMA har SMA-seed; RSI/ATR Wilder; Bollinger populationsstandardavvikelse enligt källmotorn.','Long-only: exitCondition avser stängning av long och får inte tolkas som ny short.','Belopp, mäklarkostnader och faktisk exekvering från spotbiblioteket har inte överförts.']}));
const duration:Record<string,number>={'1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000,'1d':86400000};
export function getIgStrategyRequirements(timeframe:string){const rows=listIgStrategies().filter(s=>s.timeframe===timeframe);return {timeframe,requiredCandles:Math.max(0,...rows.map(s=>s.warmupBars)),strategies:rows.map(s=>s.id),closedOnly:true};}
function legacyScope(input:IgStrategyInput){if(input.instrumentType&&input.instrumentType!=='CURRENCIES')return false;if(input.category==='forex'||input.category==='crypto')return true;const name=input.name??'';return /\b(?:Bitcoin|Ethereum|Ether|Solana|Litecoin|Cardano|Ripple|Dogecoin|BTC|ETH)\b/i.test(name)||/\b(?:USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|NOK|SEK|DKK|SGD|HKD|ZAR|TRY|PLN|MXN|CNH)\s*\/\s*(?:USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|NOK|SEK|DKK|SGD|HKD|ZAR|TRY|PLN|MXN|CNH)\b/.test(name);}
function evaluateLegacy(input:IgStrategyInput,d:LegacyDefinition){
 const metadata=legacyRegistry.find(s=>s.id===d.id)!;
 const base={strategyId:d.id,strategyVersion:1,requiredTimeframe:d.timeframe,validationStatus:'notBacktested',enabled:false,epic:input.epic,timeframe:input.timeframe,execution:'analysis_only',direction:'long_only',adapted:true,entrySignal:null as boolean|null,exitCondition:null as boolean|null,entryConditions:null as unknown,indicators:null as Record<string,number|null>|null,stopDistance:null as number|null,targetDistance:null as number|null,stopLevel:null,targetLevel:null,sizing:null,costs:null,notes:structuredClone(metadata.notes)};
 if(input.timeframe!==d.timeframe||!legacyScope(input))return {...base,status:'not_applicable',reason:'Strategins tidsram eller verifierade IG Forex/Kryptoscope matchar inte.'};
 const bars=input.candles,ms=duration[input.timeframe];
 if(!ms||!Number.isFinite(input.now)||bars.some((b,i)=>![b.open,b.high,b.low,b.close,b.openTime,b.closeTime].every(Number.isFinite)||b.open<=0||b.close<=0||b.low<=0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.closeTime-b.openTime!==ms||b.closeTime>input.now||i>0&&b.openTime-bars[i-1]!.openTime!==ms))return {...base,status:'invalid_data',reason:'Ogiltiga, ofullständiga eller ej stängda OHLC-ljus.'};
 if(bars.length<d.warmupBars)return {...base,status:'insufficient_data',reason:`Kräver minst ${d.warmupBars} verifierade stängda ljus.`};
 if(input.now-bars.at(-1)!.closeTime>ms)return {...base,status:'invalid_data',reason:'Senaste stängda ljuset är inaktuellt.'};
 // IG:s OTC-volym är inte global marknadsvolym; ingen volymproxy godtas här.
 if(d.requiresVolume)return {...base,status:'blocked_missing_verified_volume',reason:'Originalregeln kräver jämförbar verklig volym; ingen verifierad IG-volymkälla har kopplats.'};
 const series=computeSeries(bars.map(b=>({...b,volume:Number.NaN}))),i=bars.length-1;
 const keys=[...new Set<IndicatorKey>(['atr14','close',...d.entry.flatMap(r=>[r.left,...typeof r.right==='string'?[r.right]:[]]),...d.exit.flatMap(r=>[r.left,...typeof r.right==='string'?[r.right]:[]])])];
 if(keys.some(k=>series[k][i]===null||!Number.isFinite(series[k][i]))||series.atr14[i]!<=0)return {...base,status:'insufficient_data',reason:'Alla nödvändiga indikatorer eller positiv ATR kunde inte verifieras.'};
 const entry=evalAll(series,d.entry,i),exit=evalAll(series,d.exit,i);
 return {...base,status:'evaluated',reason:'Deterministisk jämförelse av källregler på IG-ljus; ingen order eller resultatprognos.',entrySignal:entry.pass,exitCondition:exit.pass,entryConditions:entry.results,exitConditions:exit.results,indicators:Object.fromEntries(keys.map(k=>[k,series[k][i]??null])),stopDistance:series.atr14[i]!*d.stopAtr,targetDistance:series.atr14[i]!*d.targetAtr,signalCloseTime:bars[i]!.closeTime};
}
export function evaluateIgStrategies(input:IgStrategyInput){return [evaluateIgStrategy(input),...legacyDefinitions.map(d=>evaluateLegacy(input,d))];}
