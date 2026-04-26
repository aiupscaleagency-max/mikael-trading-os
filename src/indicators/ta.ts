// Klassiska tekniska indikatorer. Håll dem rena funktioner utan beroenden —
// gör dem testbara och enkla att återanvända.

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // Starta EMA på SMA över första period-värdena — standardkonvention.
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaVal = values[i]! * k + emaVal * (1 - k);
  }
  return emaVal;
}

/** Wilder RSI. Returnerar null om för få datapunkter. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average True Range — mått på volatilitet. Används för stop-loss-storlek. */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number | null {
  if (highs.length <= period) return null;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const high = highs[i]!;
    const low = lows[i]!;
    const prevClose = closes[i - 1]!;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  // Wilder smoothing
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]!) / period;
  }
  return atrVal;
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult | null {
  if (values.length < slow + signalPeriod) return null;
  // Beräkna rullande EMA-serier för att få signal-linjen.
  const emaSeries = (vals: number[], period: number): number[] => {
    const k = 2 / (period + 1);
    const out: number[] = [];
    let prev = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out.push(prev);
    for (let i = period; i < vals.length; i++) {
      prev = vals[i]! * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  };

  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  // Justera för att index-linjera — fast-serien börjar tidigare.
  const offset = slow - fast;
  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[i + offset]! - emaSlow[i]!);
  }
  const signalLine = emaSeries(macdLine, signalPeriod);
  const macdVal = macdLine[macdLine.length - 1]!;
  const signalVal = signalLine[signalLine.length - 1]!;
  return {
    macd: macdVal,
    signal: signalVal,
    histogram: macdVal - signalVal,
  };
}

/** Kompakt indikator-sammanfattning som agenten får som tool-output. */
export interface IndicatorSummary {
  lastClose: number;
  sma20: number | null;
  sma50: number | null;
  ema20: number | null;
  rsi14: number | null;
  atr14: number | null;
  macd: MacdResult | null;
  changePct24: number | null;
}

export function computeIndicators(klines: {
  high: number;
  low: number;
  close: number;
}[]): IndicatorSummary {
  const closes = klines.map((k) => k.close);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const lastClose = closes[closes.length - 1] ?? 0;
  const first24h = closes.length >= 24 ? closes[closes.length - 24]! : closes[0]!;
  const changePct24 = first24h > 0 ? ((lastClose - first24h) / first24h) * 100 : null;
  return {
    lastClose,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    ema20: ema(closes, 20),
    rsi14: rsi(closes, 14),
    atr14: atr(highs, lows, closes, 14),
    macd: macd(closes),
    changePct24,
  };
}
