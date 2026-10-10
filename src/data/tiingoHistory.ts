import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DAY = 86_400_000;
export interface DailyReferenceBar { date: string; open: number; high: number; low: number; close: number; volume: number | null }
export interface HistoricalContext {
  symbol: string; ticker: string | null; source: "Tiingo aggregated crypto USD reference";
  purpose: "historical_reference_only"; status: "ready" | "partial" | "unavailable";
  quote: "USD"; interval: "1day"; requestedFrom: string; requestedTo: string;
  from: string | null; to: string | null; count: number; missingDays: number; rejectedBars: number;
  returnPct: number | null; maxDrawdownPct: number | null; cached: boolean; fetchedAt: number | null; error: string | null;
}
const contexts = new Map<string, HistoricalContext>();
const pending = new Map<string, Promise<HistoricalContext>>();
let cooldownUntil = 0;

/** Endast uttryckligt angiven nyckel eller kursens befintliga lokala nyckelfil läses. */
/** Tiingo-nyckeln: .env först, annars kursens keys.json (samma källa för dagshistorik och minidiagram). */
export function tiingoKey(): string | null {
  const env = process.env.TIINGO_API_KEY?.trim();
  if (env) return env;
  if (process.env.TIINGO_NO_FILE_KEY === "1") return null; // testerna: aldrig en riktig nyckel
  const homes = [process.env.PTQ_ACADEMY_HOME, path.join(os.homedir(), ".ptq-academy"),
    process.env.PTQA_COURSE_HOME || path.join(os.homedir(), "ai_upscale_work/projects/ptqa-trading/ptqa-local-environment")].filter((p): p is string => !!p);
  for (const home of homes) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(home, "keys.json"), "utf8"));
      if (typeof data.tiingo === "string" && data.tiingo.trim()) return data.tiingo.trim();
    } catch { /* Endast dessa kända kursplatser provas; ingen global nyckelsökning. */ }
  }
  return null;
}
const key = tiingoKey;
export function getTiingoStatus() {
  const configured = !!key();
  return { provider: "Tiingo", configured, purpose: "historical_reference_only", quote: "USD", interval: "1day", years: 3,
    status: configured ? "configured" : "unavailable", error: configured ? null : "Tiingo-nyckel saknas; IG-analysen fortsätter utan historisk referens",
    symbols: [...contexts.values()].map((c) => ({ ...c })) };
}
function range(now: number) {
  const end = new Date(Math.floor(now / DAY) * DAY - DAY);
  const start = new Date(end); start.setUTCFullYear(start.getUTCFullYear() - 3);
  return {start: start.getTime(), end: end.getTime(), from: start.toISOString().slice(0,10), to: end.toISOString().slice(0,10)};
}
function empty(symbol: string, now: number): HistoricalContext {
  const r = range(now);
  return {symbol,ticker:/^[A-Z0-9]{2,20}USDC$/.test(symbol) ? `${symbol.slice(0,-4).toLowerCase()}usd` : null,
    source:"Tiingo aggregated crypto USD reference",purpose:"historical_reference_only",status:"unavailable",quote:"USD",interval:"1day",
    requestedFrom:r.from,requestedTo:r.to,from:null,to:null,count:0,missingDays:Math.round((r.end-r.start)/DAY)+1,rejectedBars:0,
    returnPct:null,maxDrawdownPct:null,cached:false,fetchedAt:null,error:null};
}
/** Stängda UTC-dagsljus krävs; saknade eller felaktiga dagar fylls aldrig ut. */
export function summarizeHistory(symbol: string, raw: unknown, now: number, fetchedAt: number, cached = false): HistoricalContext {
  const result=empty(symbol,now), r=range(now);
  if(!Array.isArray(raw)) throw new Error("Tiingo returnerade ett ogiltigt historikformat");
  const bars = new Map<number,DailyReferenceBar>();
  for(const item of raw) {
    if(!item || typeof item !== "object") {result.rejectedBars++;continue;}
    const b=item as Record<string,unknown>, timestamp=typeof b.date === "string" ? Date.parse(b.date) : NaN;
    const values=[b.open,b.high,b.low,b.close];
    if(!Number.isFinite(timestamp) || timestamp % DAY !== 0 || values.some(v=>typeof v!=="number" || !Number.isFinite(v) || v<=0)
      || Number(b.high)<Math.max(Number(b.open),Number(b.close)) || Number(b.low)>Math.min(Number(b.open),Number(b.close))) {result.rejectedBars++;continue;}
    if(timestamp<r.start || timestamp>r.end) continue;
    if(bars.has(timestamp)) {result.rejectedBars++;continue;}
    bars.set(timestamp,{date:new Date(timestamp).toISOString(),open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close),volume:typeof b.volume==="number" && Number.isFinite(b.volume) && b.volume>=0?b.volume:null});
  }
  const ordered=[...bars.entries()].sort((a,b)=>a[0]-b[0]).map(([,b])=>b);
  result.count=ordered.length;result.missingDays-=ordered.length;result.fetchedAt=fetchedAt;result.cached=cached;
  if(!ordered.length) {result.error="Tiingo saknar verifierade stängda dagsljus för referensparet";return result;}
  result.from=ordered[0]!.date.slice(0,10);result.to=ordered.at(-1)!.date.slice(0,10);
  result.status=result.missingDays===0 && result.rejectedBars===0 ? "ready":"partial";
  result.returnPct=(ordered.at(-1)!.close/ordered[0]!.close-1)*100;
  let peak=ordered[0]!.close, drawdown=0;
  for(const b of ordered) {peak=Math.max(peak,b.close);drawdown=Math.min(drawdown,(b.close/peak-1)*100);}
  result.maxDrawdownPct=drawdown;
  result.error=result.status==="partial"?"Ofullständig dagsserie; avkastning och drawdown beskriver enbart observerade stängningar":null;
  return result;
}
async function collect(symbol: string, now: number, allowFetch: boolean): Promise<HistoricalContext> {
  const result=empty(symbol,now), token=key();
  if(!result.ticker) {result.error="Historisk referens stöder enbart valda kryptopar med USDC";return result;}
  if(!token) {result.error="Tiingo-nyckel saknas; IG-data används fortsatt";return result;}
  const file=path.resolve("data/tiingo-history",`${result.ticker}.json`);
  try {
    const saved=JSON.parse(fs.readFileSync(file,"utf8"));
    if(saved.ticker===result.ticker && saved.requestedTo===result.requestedTo && saved.requestedFrom===result.requestedFrom && typeof saved.fetchedAt==="number" && now-saved.fetchedAt>=0 && now-saved.fetchedAt<DAY) return summarizeHistory(symbol,saved.bars,now,saved.fetchedAt,true);
  } catch { /* En ogiltig cache ersätts bara av verifierad leverantörsdata. */ }
  if(!allowFetch) {result.error="Historisk referens saknas i cache; turens hämtbudget är slut och IG-data används fortsatt";return result;}
  if(now<cooldownUntil) {result.error="Tiingo pausas efter anropsbegränsning; IG-data används fortsatt";return result;}
  try {
    const url=new URL("https://api.tiingo.com/tiingo/crypto/prices");
    url.search=new URLSearchParams({tickers:result.ticker,startDate:result.requestedFrom,endDate:result.requestedTo,resampleFreq:"1day"}).toString();
    const response=await fetch(url,{headers:{Authorization:`Token ${token}`,Accept:"application/json"},signal:AbortSignal.timeout(6000)});
    if(!response.ok) {
      if(response.status===429) cooldownUntil=now+60_000;
      result.error=response.status===401||response.status===403?"Tiingo nekade behörighet":response.status===429?"Tiingo begränsade antal anrop":`Tiingo svarade HTTP ${response.status}`;
      return result;
    }
    const data:unknown=await response.json();
    if(!Array.isArray(data)) throw Error("format");
    const entry=data.find((d)=>d?.ticker===result.ticker && d?.baseCurrency===symbol.slice(0,-4).toLowerCase() && d?.quoteCurrency==="usd");
    if(!entry || !Array.isArray(entry.priceData)) {result.error="Tiingo saknar det begärda USD-referensparet";return result;}
    const summary=summarizeHistory(symbol,entry.priceData,now,now);
    if(summary.count) {
      try {
        fs.mkdirSync(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp,JSON.stringify({ticker:result.ticker,requestedFrom:result.requestedFrom,requestedTo:result.requestedTo,fetchedAt:now,bars:entry.priceData}));fs.renameSync(temp,file);
      } catch { summary.error = `${summary.error ? summary.error+"; " : ""}Historikcache kunde inte sparas`; }
    }
    return summary;
  } catch {result.error="Tiingo-historik kunde inte hämtas eller verifieras inom tidsgränsen";return result;}
}
export async function getHistoricalContext(symbol: string, options: { allowFetch?: boolean } = {}): Promise<HistoricalContext> {
  symbol=symbol.trim().toUpperCase();
  const previous=pending.get(symbol);if(previous) return previous;
  const job=collect(symbol,Date.now(),options.allowFetch !== false);pending.set(symbol,job);
  try {const context=await job;contexts.set(symbol,context);return {...context};}
  finally {pending.delete(symbol);}
}
