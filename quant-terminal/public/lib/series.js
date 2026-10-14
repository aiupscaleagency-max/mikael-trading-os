// Timeframes, resampling and chart-type transforms. Shared by the browser and the server.

const UNIT_SEC = { s: 1, m: 60, h: 3600, D: 86400, W: 604800, M: 2592000 };

// "15m" -> { n: 15, unit: 'm', seconds: 900 }. Accepts 1s..59s, minutes, hours, D, W, M.
export function parseTf(tf) {
  const m = /^(\d+)?([smhDWM])$/.exec(String(tf).trim());
  if (!m)
    throw new Error(
      `Bad timeframe "${tf}". Use forms like 1s, 5m, 4h, 1D, 1W, 1M.`,
    );
  const n = Number(m[1] || 1);
  if (n < 1) throw new Error(`Bad timeframe "${tf}"`);
  return { n, unit: m[2], seconds: n * UNIT_SEC[m[2]] };
}

export const isIntraday = (tf) => parseTf(tf).seconds < 86400;

// Start of the bucket a bar at time t (UTC seconds) belongs to.
export function bucketStart(t, tf) {
  const { n, unit } = parseTf(tf);
  if (unit === "M") {
    const d = new Date(t * 1000);
    const months = d.getUTCFullYear() * 12 + d.getUTCMonth();
    const start = months - (months % n);
    return Date.UTC(Math.floor(start / 12), start % 12, 1) / 1000;
  }
  if (unit === "W") {
    const day = Math.floor(t / 86400);
    const monday = day - ((day + 3) % 7); // 1970-01-01 was a Thursday
    const week = Math.floor(monday / 7);
    return (monday - (week % n) * 7) * 86400;
  }
  const size = n * UNIT_SEC[unit];
  return Math.floor(t / size) * size;
}

// Merge bars into a larger timeframe. Bars must be sorted ascending.
export function resample(bars, tf) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const start = bucketStart(b.time, tf);
    if (!cur || cur.time !== start) {
      cur = {
        time: start,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume || 0,
      };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  return out;
}

// Pick the largest native timeframe that divides the requested one.
export function nativeBase(tf, natives) {
  const want = parseTf(tf);
  if (natives.includes(tf)) return tf;
  const candidates = natives
    .map((n) => ({ tf: n, ...parseTf(n) }))
    .filter((c) => {
      if (want.unit === "M")
        return c.unit === "M" ? want.n % c.n === 0 : c.seconds <= 86400;
      if (want.unit === "W")
        return c.unit === "W"
          ? want.n % c.n === 0
          : c.seconds <= 86400 && 86400 % c.seconds === 0;
      return (
        c.unit !== "M" &&
        c.unit !== "W" &&
        c.seconds <= want.seconds &&
        want.seconds % c.seconds === 0
      );
    })
    .sort((a, b) => b.seconds - a.seconds);
  return candidates[0]?.tf || null;
}

export function heikinAshi(bars) {
  const out = [];
  bars.forEach((b, i) => {
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open =
      i === 0
        ? (b.open + b.close) / 2
        : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({
      time: b.time,
      open,
      close,
      high: Math.max(b.high, open, close),
      low: Math.min(b.low, open, close),
      volume: b.volume,
    });
  });
  return out;
}

// Renko from closes. boxSize 0 = ATR(14) of the last bar. Bricks get unique, increasing times.
export function renko(bars, boxSize = 0) {
  if (bars.length < 2) return [];
  let box = boxSize;
  if (!box) {
    let s = 0;
    const n = Math.min(14, bars.length - 1);
    for (let i = bars.length - n; i < bars.length; i++) {
      const p = bars[i - 1],
        b = bars[i];
      s += Math.max(
        b.high - b.low,
        Math.abs(b.high - p.close),
        Math.abs(b.low - p.close),
      );
    }
    box = s / n || bars.at(-1).close * 0.01;
  }
  const out = [];
  let base = bars[0].close,
    lastTime = -Infinity;
  const push = (t, open, close) => {
    const time = Math.max(t, lastTime + 1);
    lastTime = time;
    out.push({
      time,
      open,
      close,
      high: Math.max(open, close),
      low: Math.min(open, close),
    });
  };
  let dir = 0;
  for (const b of bars) {
    while (true) {
      if (b.close >= base + box * (dir === -1 ? 2 : 1)) {
        const open = dir === -1 ? base + box : base;
        push(b.time, open, open + box);
        base = open + box;
        dir = 1;
      } else if (b.close <= base - box * (dir === 1 ? 2 : 1)) {
        const open = dir === 1 ? base - box : base;
        push(b.time, open, open - box);
        base = open - box;
        dir = -1;
      } else break;
    }
  }
  return out.map((b) => ({ ...b, box }));
}

// Three-line break.
export function lineBreak(bars, lines = 3) {
  const out = [];
  let lastTime = -Infinity;
  for (const b of bars) {
    if (!out.length) {
      out.push({
        time: b.time,
        open: b.open,
        close: b.close,
        high: Math.max(b.open, b.close),
        low: Math.min(b.open, b.close),
      });
      lastTime = b.time;
      continue;
    }
    const recent = out.slice(-lines);
    const hi = Math.max(...recent.map((x) => x.high)),
      lo = Math.min(...recent.map((x) => x.low));
    const last = out.at(-1),
      up = last.close > last.open;
    let brick = null;
    if (b.close > (up ? last.close : hi))
      brick = { open: up ? last.close : last.open, close: b.close };
    else if (b.close < (up ? lo : last.close))
      brick = { open: up ? last.open : last.close, close: b.close };
    if (brick) {
      const time = Math.max(b.time, lastTime + 1);
      lastTime = time;
      out.push({
        time,
        ...brick,
        high: Math.max(brick.open, brick.close),
        low: Math.min(brick.open, brick.close),
      });
    }
  }
  return out;
}

export function toCsv(bars, extraCols = {}) {
  const keys = Object.keys(extraCols);
  const head = [
    "time",
    "iso",
    "open",
    "high",
    "low",
    "close",
    "volume",
    ...keys,
  ].join(",");
  const rows = bars.map((b, i) =>
    [
      b.time,
      new Date(b.time * 1000).toISOString(),
      b.open,
      b.high,
      b.low,
      b.close,
      b.volume ?? "",
      ...keys.map((k) => {
        const v = extraCols[k][i];
        return typeof v === "number" && !Number.isNaN(v) ? v : "";
      }),
    ].join(","),
  );
  return [head, ...rows].join("\n");
}

// Average true range of the last 14 bars, the default box/range size for the price-only charts.
function recentAtr(bars, n = 14) {
  const k = Math.min(n, bars.length - 1);
  if (k < 1) return bars[0] ? bars[0].close * 0.01 : 1;
  let s = 0;
  for (let i = bars.length - k; i < bars.length; i++) {
    const p = bars[i - 1], b = bars[i];
    s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  return s / k || bars.at(-1).close * 0.01;
}

const uniqueTimes = () => {
  let last = -Infinity;
  return (t) => (last = Math.max(t, last + 1));
};

// Range bars: a new bar starts each time price has covered `range` (default: ATR 14). Each source
// bar is walked open -> low -> high -> close (or open -> high -> low -> close on down bars).
export function rangeBars(bars, range = 0) {
  if (!bars.length) return [];
  const R = range || recentAtr(bars);
  const out = [], stamp = uniqueTimes();
  let cur = null;
  const emit = () => out.push({ ...cur, time: stamp(cur.time) });
  const feed = (price, time) => {
    if (!cur) { cur = { time, open: price, high: price, low: price, close: price, volume: 0 }; return; }
    for (;;) {
      if (price > cur.high && price - cur.low >= R) {
        const top = cur.low + R;
        Object.assign(cur, { high: top, close: top }); emit();
        cur = { time, open: top, high: top, low: top, close: top, volume: 0 };
      } else if (price < cur.low && cur.high - price >= R) {
        const bot = cur.high - R;
        Object.assign(cur, { low: bot, close: bot }); emit();
        cur = { time, open: bot, high: bot, low: bot, close: bot, volume: 0 };
      } else {
        cur.high = Math.max(cur.high, price); cur.low = Math.min(cur.low, price); cur.close = price;
        return;
      }
    }
  };
  for (const b of bars) {
    const path = b.close >= b.open ? [b.open, b.low, b.high, b.close] : [b.open, b.high, b.low, b.close];
    for (const p of path) feed(p, b.time);
    cur.volume += b.volume || 0;
  }
  emit();
  return out.map((b) => ({ ...b, range: R }));
}

// Kagi: turning points of the close, reversing after `reversal` (default ATR 14). Yang (green)
// once the line breaks the previous high, yin (red) once it breaks the previous low.
export function kagi(bars, reversal = 0) {
  if (bars.length < 2) return [];
  const R = reversal || recentAtr(bars);
  const stamp = uniqueTimes();
  const pts = [];
  let dir = 0, extreme = bars[0].close, extremeTime = bars[0].time, yang = true;
  let lastHigh = Infinity, lastLow = -Infinity;
  const push = (time, v) => pts.push({ time: stamp(time), value: v, yang });
  push(bars[0].time, bars[0].close);
  for (const b of bars.slice(1)) {
    const c = b.close;
    if (dir >= 0 && c > extreme) { extreme = c; extremeTime = b.time; if (dir === 0) dir = 1; if (c > lastHigh) yang = true; continue; }
    if (dir <= 0 && c < extreme) { extreme = c; extremeTime = b.time; if (dir === 0) dir = -1; if (c < lastLow) yang = false; continue; }
    if (dir === 1 && extreme - c >= R) { push(extremeTime, extreme); lastHigh = extreme; dir = -1; extreme = c; extremeTime = b.time; if (c < lastLow) yang = false; }
    else if (dir === -1 && c - extreme >= R) { push(extremeTime, extreme); lastLow = extreme; dir = 1; extreme = c; extremeTime = b.time; if (c > lastHigh) yang = true; }
  }
  push(extremeTime, extreme);
  return pts.map((p) => ({ time: p.time, open: p.value, high: p.value, low: p.value, close: p.value, color: p.yang ? '#089981' : '#f23645', reversal: R }));
}

// Point & figure from closes: X columns up, O columns down, a box of `box` (default ATR 14) and a
// `reversal`-box turn. Each column comes back as one candle spanning the column.
export function pointFigure(bars, box = 0, reversal = 3) {
  if (bars.length < 2) return [];
  const B = box || recentAtr(bars);
  const stamp = uniqueTimes();
  const fl = (v) => Math.floor(v / B + 1e-9) * B, ce = (v) => Math.ceil(v / B - 1e-9) * B;
  const cols = [];
  const base = fl(bars[0].close);
  let col = null;
  for (const b of bars) {
    const c = b.close;
    if (!col) {
      if (c >= base + B) col = { dir: 1, lo: base, hi: fl(c), time: b.time };
      else if (c <= base - B) col = { dir: -1, hi: base, lo: ce(c), time: b.time };
      continue;
    }
    if (col.dir === 1) {
      if (c >= col.hi + B) col.hi = fl(c);
      else if (c <= col.hi - reversal * B) { cols.push(col); col = { dir: -1, hi: col.hi - B, lo: ce(c), time: b.time }; }
    } else if (c <= col.lo - B) col.lo = ce(c);
    else if (c >= col.lo + reversal * B) { cols.push(col); col = { dir: 1, lo: col.lo + B, hi: fl(c), time: b.time }; }
  }
  if (col) cols.push(col);
  return cols.map((k) => ({
    time: stamp(k.time), open: k.dir === 1 ? k.lo : k.hi, close: k.dir === 1 ? k.hi : k.lo, high: k.hi, low: k.lo,
    boxes: Math.round((k.hi - k.lo) / B) + 1, box: B, dir: k.dir,
  }));
}
