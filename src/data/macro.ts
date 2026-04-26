// Gratis makro-data utan API-nycklar.
//   - Yahoo Finance (query1.finance.yahoo.com) för råvaror, index, räntor
//   - Alternative.me för Crypto Fear & Greed Index
//
// Båda tjänsterna är offentliga och kräver ingen auth, men de är också
// inofficiella — de kan ändra format eller gå ner. Vi tolererar fel per-fält
// istället för att krascha hela snapshot:en.

export interface MacroQuote {
  price: number;
  changePct24h: number;
}

export interface MacroSnapshot {
  // Energi
  crudeWti: MacroQuote | null; // CL=F — USA:s referensolja
  crudeBrent: MacroQuote | null; // BZ=F — Europas referens
  naturalGas: MacroQuote | null; // NG=F
  // Safe haven / monetär
  gold: MacroQuote | null; // GC=F
  silver: MacroQuote | null; // SI=F
  // Risk/volatilitet
  vix: MacroQuote | null; // ^VIX — SPX-volatilitet, "skräck-index"
  // Valuta/ränta
  dxy: MacroQuote | null; // DX-Y.NYB — dollarindex
  us10y: MacroQuote | null; // ^TNX — 10-årig US-statsränta
  // Aktier som regim-proxy
  sp500: MacroQuote | null; // ^GSPC
  // Krypto-sentiment
  cryptoFearGreed: { value: number; label: string } | null;
  // När snapshotet togs
  takenAt: number;
}

interface YahooChartResp {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
    }>;
  };
}

async function yahooQuote(symbol: string): Promise<MacroQuote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol,
    )}?interval=1d&range=5d`;
    const res = await fetch(url, {
      // Yahoo blockerar tomma user agents
      headers: { "User-Agent": "Mozilla/5.0 (compatible; trading-agent/0.1)" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as YahooChartResp;
    const result = data.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const changePct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
    return {
      price: Number(price.toFixed(4)),
      changePct24h: Number(changePct.toFixed(2)),
    };
  } catch {
    return null;
  }
}

interface FearGreedResp {
  data?: Array<{ value?: string; value_classification?: string }>;
}

async function fearGreed(): Promise<MacroSnapshot["cryptoFearGreed"]> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    if (!res.ok) return null;
    const data = (await res.json()) as FearGreedResp;
    const item = data.data?.[0];
    if (!item?.value) return null;
    return {
      value: Number(item.value),
      label: item.value_classification ?? "unknown",
    };
  } catch {
    return null;
  }
}

export async function getMacroSnapshot(): Promise<MacroSnapshot> {
  // Parallellt — Yahoo gör per-symbol-requests, så vi vill inte seriekoppla dem.
  const [
    crudeWti,
    crudeBrent,
    naturalGas,
    gold,
    silver,
    vix,
    dxy,
    us10y,
    sp500,
    cryptoFearGreed,
  ] = await Promise.all([
    yahooQuote("CL=F"),
    yahooQuote("BZ=F"),
    yahooQuote("NG=F"),
    yahooQuote("GC=F"),
    yahooQuote("SI=F"),
    yahooQuote("^VIX"),
    yahooQuote("DX-Y.NYB"),
    yahooQuote("^TNX"),
    yahooQuote("^GSPC"),
    fearGreed(),
  ]);

  return {
    crudeWti,
    crudeBrent,
    naturalGas,
    gold,
    silver,
    vix,
    dxy,
    us10y,
    sp500,
    cryptoFearGreed,
    takenAt: Date.now(),
  };
}
