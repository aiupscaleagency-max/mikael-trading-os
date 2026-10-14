// Cross-check every built-in indicator against a second, deliberately naive implementation
// written straight from TradingView's published Pine formulas. Nothing here imports the
// app's helpers: every window is recomputed from scratch, bar by bar, so a shared bug can't
// hide. Checked on the last 400 bars of real BTC daily data.
//
// The headline indicators were also checked against the open-source `technicalindicators`
// library (v3.1.0) on the same data: SMA, EMA, WMA, ATR, MACD, Bollinger, Stochastic,
// Williams %R, CCI, ROC, AO, ADX/DMI, PSAR, OBV, A/D, Ichimoku and Keltner matched to 1e-6;
// RSI, MFI and Stoch RSI matched to that library's 2-decimal rounding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compute, INDICATORS } from "../public/lib/indicators.js";

const bars = JSON.parse(
  readFileSync(new URL("./fixtures/btc-1d.json", import.meta.url), "utf8"),
);
const N = bars.length;
const O = bars.map((b) => b.open),
  H = bars.map((b) => b.high),
  L = bars.map((b) => b.low);
const C = bars.map((b) => b.close),
  V = bars.map((b) => b.volume);
const HL2 = bars.map((b) => (b.high + b.low) / 2),
  HLC3 = bars.map((b) => (b.high + b.low + b.close) / 3);
const ok = Number.isFinite;

// ---- naive building blocks: each one recomputes its window from scratch ----
const win = (s, i, n) => (i - n + 1 < 0 ? null : s.slice(i - n + 1, i + 1));
const allOk = (w) => w && w.every(ok);
const SMA = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    return allOk(w) ? w.reduce((a, b) => a + b, 0) / n : NaN;
  });
const SUM = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    return allOk(w) ? w.reduce((a, b) => a + b, 0) : NaN;
  });
const WMA = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    if (!allOk(w)) return NaN;
    let a = 0,
      d = 0;
    w.forEach((v, k) => {
      a += v * (k + 1);
      d += k + 1;
    });
    return a / d;
  });
const STDEV = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    if (!allOk(w)) return NaN;
    const m = w.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  });
const DEV = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    if (!allOk(w)) return NaN;
    const m = w.reduce((a, b) => a + b, 0) / n;
    return w.reduce((a, b) => a + Math.abs(b - m), 0) / n;
  });
const HIGHEST = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    return allOk(w) ? Math.max(...w) : NaN;
  });
const LOWEST = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    return allOk(w) ? Math.min(...w) : NaN;
  });
// Pine's ta.ema / ta.rma: seeded with an SMA of the first full window, then recursive.
function smooth(s, n, alpha) {
  const out = new Array(s.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < s.length; i++) {
    if (!ok(s[i])) {
      prev = NaN;
      continue;
    }
    if (!ok(prev)) {
      const w = win(s, i, n);
      if (allOk(w)) prev = w.reduce((a, b) => a + b, 0) / n;
      else continue;
    } else prev = alpha * s[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}
const EMA = (s, n) => smooth(s, n, 2 / (n + 1));
const RMA = (s, n) => smooth(s, n, 1 / n);
const CHANGE = (s, n = 1) => s.map((v, i) => (i >= n ? v - s[i - n] : NaN));
const TR = bars.map((b, i) =>
  i
    ? Math.max(
        b.high - b.low,
        Math.abs(b.high - C[i - 1]),
        Math.abs(b.low - C[i - 1]),
      )
    : b.high - b.low,
);
const ATR = (n) => RMA(TR, n);
const RSI = (s, n) => {
  const ch = CHANGE(s);
  const u = RMA(
      ch.map((d) => (ok(d) ? Math.max(d, 0) : NaN)),
      n,
    ),
    d = RMA(
      ch.map((x) => (ok(x) ? Math.max(-x, 0) : NaN)),
      n,
    );
  return u.map((x, i) =>
    d[i] === 0 ? 100 : x === 0 ? 0 : 100 - 100 / (1 + x / d[i]),
  );
};
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, k) => a.map((v) => v * k);

// Chop Zone's angle in whole degrees: the EMA slope as an angle, negative when the 34 EMA is falling.
// acos(1 / sqrt(1 + y^2)) is atan(|y|), so this uses the arctangent form.
const chopAngle = () => {
  const e = EMA(C, 34),
    hh = HIGHEST(H, 30),
    ll = LOWEST(L, 30);
  return C.map((_, i) => {
    if (!i) return NaN;
    const y = ((e[i - 1] - e[i]) / HLC3[i]) * ((25 / (hh[i] - ll[i])) * ll[i]);
    const deg = Math.round((180 * Math.atan(Math.abs(y))) / Math.PI);
    return y > 0 ? -deg : deg;
  });
};

// ---- TradingView's formulas, one per indicator ----
const REF = {
  sma: () => ({ value: SMA(C, 20) }),
  ema: () => ({ value: EMA(C, 9) }),
  wma: () => ({ value: WMA(C, 20) }),
  vwma: () => {
    const pv = C.map((c, i) => c * V[i]);
    return { value: SMA(pv, 20).map((x, i) => x / SMA(V, 20)[i]) };
  },
  hma: () => ({
    value: WMA(sub(mul(WMA(C, 10), 2), WMA(C, 20)), Math.floor(Math.sqrt(20))),
  }),
  dema: () => {
    const e = EMA(C, 20);
    return { value: sub(mul(e, 2), EMA(e, 20)) };
  },
  tema: () => {
    const e1 = EMA(C, 20),
      e2 = EMA(e1, 20),
      e3 = EMA(e2, 20);
    return { value: add(mul(sub(e1, e2), 3), e3) };
  },
  smma: () => ({ value: RMA(C, 20) }),
  alma: () => {
    const n = 20,
      m = 0.85 * (n - 1),
      s = n / 6;
    return {
      value: C.map((_, i) => {
        if (i < n - 1) return NaN;
        let norm = 0,
          sum = 0;
        for (let k = 0; k < n; k++) {
          const w = Math.exp(-((k - m) ** 2) / (2 * s * s));
          norm += w;
          sum += C[i - (n - 1 - k)] * w;
        }
        return sum / norm;
      }),
    };
  },
  lsma: () => ({
    value: C.map((_, i) => {
      const w = win(C, i, 20);
      if (!w) return NaN;
      const xs = w.map((__, k) => k),
        mx = 9.5,
        my = w.reduce((a, b) => a + b) / 20;
      let num = 0,
        den = 0;
      xs.forEach((x, k) => {
        num += (x - mx) * (w[k] - my);
        den += (x - mx) ** 2;
      });
      const slope = num / den;
      return my + slope * (19 - mx);
    }),
  }),
  macross: () => ({ fast: EMA(C, 9), slow: EMA(C, 21) }),
  ribbon: () => ({
    m20: EMA(C, 20),
    m50: EMA(C, 50),
    m100: EMA(C, 100),
    m200: EMA(C, 200),
  }),
  vwap: () => ({ value: HLC3 }), // daily bars: every bar is its own session
  bb: () => {
    const b = SMA(C, 20),
      sd = STDEV(C, 20);
    return { upper: add(b, mul(sd, 2)), basis: b, lower: sub(b, mul(sd, 2)) };
  },
  bbpb: () => {
    const b = SMA(C, 20),
      sd = STDEV(C, 20);
    return { value: C.map((c, i) => (c - (b[i] - 2 * sd[i])) / (4 * sd[i])) };
  },
  bbw: () => {
    const b = SMA(C, 20),
      sd = STDEV(C, 20);
    return { value: b.map((x, i) => ((4 * sd[i]) / x) * 100) };
  },
  kc: () => {
    const b = EMA(C, 20),
      a = ATR(10);
    return { upper: add(b, mul(a, 2)), basis: b, lower: sub(b, mul(a, 2)) };
  },
  donchian: () => {
    const u = HIGHEST(H, 20),
      l = LOWEST(L, 20);
    return { upper: u, lower: l, basis: u.map((x, i) => (x + l[i]) / 2) };
  },
  envelope: () => {
    const b = SMA(C, 20);
    return { upper: mul(b, 1.1), basis: b, lower: mul(b, 0.9) };
  },
  atr: () => ({ value: ATR(14) }),
  stdev: () => ({ value: STDEV(C, 20) }),
  hv: () => ({
    value: STDEV(
      C.map((c, i) => (i ? Math.log(c / C[i - 1]) : NaN)),
      10,
    ).map((x) => 100 * x * Math.sqrt(365)),
  }),
  rsi: () => {
    const r = RSI(C, 14);
    return { value: r, ma: SMA(r, 14) };
  },
  stoch: () => {
    const hh = HIGHEST(H, 14),
      ll = LOWEST(L, 14);
    const k = C.map((c, i) => (100 * (c - ll[i])) / (hh[i] - ll[i]));
    return { k, d: SMA(k, 3) };
  },
  stochrsi: () => {
    const r = RSI(C, 14),
      hh = HIGHEST(r, 14),
      ll = LOWEST(r, 14);
    const raw = r.map((x, i) => (100 * (x - ll[i])) / (hh[i] - ll[i]));
    const k = SMA(raw, 3);
    return { k, d: SMA(k, 3) };
  },
  macd: () => {
    const m = sub(EMA(C, 12), EMA(C, 26)),
      s = EMA(m, 9);
    return { macd: m, signal: s, hist: sub(m, s) };
  },
  cci: () => {
    const s = SMA(HLC3, 20),
      d = DEV(HLC3, 20);
    return { value: HLC3.map((x, i) => (x - s[i]) / (0.015 * d[i])) };
  },
  willr: () => {
    const hh = HIGHEST(H, 14),
      ll = LOWEST(L, 14);
    return { value: C.map((c, i) => (100 * (c - hh[i])) / (hh[i] - ll[i])) };
  },
  roc: () => ({
    value: C.map((c, i) => (i >= 9 ? (100 * (c - C[i - 9])) / C[i - 9] : NaN)),
  }),
  mom: () => ({ value: CHANGE(C, 10) }),
  mfi: () => {
    const ch = CHANGE(HLC3);
    const up = SUM(
        HLC3.map((x, i) => (ch[i] > 0 ? x * V[i] : ok(ch[i]) ? 0 : NaN)),
        14,
      ),
      dn = SUM(
        HLC3.map((x, i) => (ch[i] < 0 ? x * V[i] : ok(ch[i]) ? 0 : NaN)),
        14,
      );
    return { value: up.map((u, i) => 100 - 100 / (1 + u / dn[i])) };
  },
  cmo: () => {
    const m = CHANGE(C);
    const s1 = SUM(
        m.map((x) => (ok(x) ? Math.max(x, 0) : NaN)),
        9,
      ),
      s2 = SUM(
        m.map((x) => (ok(x) ? Math.max(-x, 0) : NaN)),
        9,
      );
    return { value: s1.map((a, i) => (100 * (a - s2[i])) / (a + s2[i])) };
  },
  trix: () => {
    const lc = C.map(Math.log);
    return { value: mul(CHANGE(EMA(EMA(EMA(lc, 18), 18), 18)), 10000) };
  },
  ao: () => ({ value: sub(SMA(HL2, 5), SMA(HL2, 34)) }),
  uo: () => {
    const pc = C.map((_, i) => (i ? C[i - 1] : NaN));
    const lo = L.map((l, i) => Math.min(l, pc[i])),
      hi = H.map((h, i) => Math.max(h, pc[i]));
    const bp = C.map((c, i) => c - lo[i]),
      tr = hi.map((h, i) => h - lo[i]);
    const avg = (n) => SUM(bp, n).map((x, i) => x / SUM(tr, n)[i]);
    const a7 = avg(7),
      a14 = avg(14),
      a28 = avg(28);
    return {
      value: a7.map((x, i) => (100 * (4 * x + 2 * a14[i] + a28[i])) / 7),
    };
  },
  tsi: () => {
    const pc = CHANGE(C);
    const ds = (s) => EMA(EMA(s, 25), 13);
    const t = ds(pc).map((x, i) => (100 * x) / ds(pc.map(Math.abs))[i]);
    return { value: t, signal: EMA(t, 13) };
  },
  ppo: () => {
    const f = EMA(C, 12),
      s = EMA(C, 26);
    const v = f.map((x, i) => (100 * (x - s[i])) / s[i]);
    return { value: v, signal: EMA(v, 9) };
  },
  coppock: () => {
    const roc = (n) =>
      C.map((c, i) => (i >= n ? (100 * (c - C[i - n])) / C[i - n] : NaN));
    return { value: WMA(add(roc(14), roc(11)), 10) };
  },
  elder: () => {
    const e = EMA(C, 13);
    return { bull: sub(H, e), bear: sub(L, e) };
  },
  bop: () => ({ value: C.map((c, i) => (c - O[i]) / (H[i] - L[i])) }),
  dmi: () => {
    const up = CHANGE(H),
      dn = CHANGE(L).map((x) => -x);
    const pdm = up.map((u, i) => (ok(u) ? (u > dn[i] && u > 0 ? u : 0) : NaN)),
      mdm = dn.map((d, i) => (ok(d) ? (d > up[i] && d > 0 ? d : 0) : NaN));
    const tr = RMA(
      TR.map((t, i) => (i ? t : NaN)),
      14,
    );
    const plus = RMA(pdm, 14).map((x, i) => (100 * x) / tr[i]),
      minus = RMA(mdm, 14).map((x, i) => (100 * x) / tr[i]);
    const dx = plus.map(
      (p, i) =>
        (100 * Math.abs(p - minus[i])) /
        (p + minus[i] === 0 ? 1 : p + minus[i]),
    );
    return { adx: RMA(dx, 14), plus, minus };
  },
  adx: () => ({ adx: REF.dmi().adx }),
  aroon: () => ({
    up: H.map((_, i) => {
      const w = win(H, i, 15);
      if (!w) return NaN;
      let k = 0;
      w.forEach((v, j) => {
        if (v >= w[k]) k = j;
      });
      return (100 * k) / 14;
    }),
    down: L.map((_, i) => {
      const w = win(L, i, 15);
      if (!w) return NaN;
      let k = 0;
      w.forEach((v, j) => {
        if (v <= w[k]) k = j;
      });
      return (100 * k) / 14;
    }),
  }),
  vortex: () => {
    const vmp = SUM(
        H.map((h, i) => (i ? Math.abs(h - L[i - 1]) : NaN)),
        14,
      ),
      vmm = SUM(
        L.map((l, i) => (i ? Math.abs(l - H[i - 1]) : NaN)),
        14,
      ),
      str = SUM(TR, 14);
    return {
      plus: vmp.map((x, i) => x / str[i]),
      minus: vmm.map((x, i) => x / str[i]),
    };
  },
  chop: () => {
    const s = SUM(TR, 14),
      hh = HIGHEST(H, 14),
      ll = LOWEST(L, 14);
    return {
      value: s.map(
        (x, i) => (100 * Math.log10(x / (hh[i] - ll[i]))) / Math.log10(14),
      ),
    };
  },
  mass: () => {
    const span = sub(H, L),
      e1 = EMA(span, 9),
      e2 = EMA(e1, 9);
    return {
      value: SUM(
        e1.map((x, i) => x / e2[i]),
        10,
      ),
    };
  },
  psar: null, // matched to technicalindicators above, and a step-by-step test lives in indicators.test.js
  supertrend: () => {
    const a = ATR(10),
      up = [],
      down = [];
    let pu = NaN,
      pl = NaN,
      pst = NaN;
    for (let i = 0; i < N; i++) {
      if (!ok(a[i])) {
        up.push(NaN);
        down.push(NaN);
        continue;
      }
      let u = HL2[i] + 3 * a[i],
        l = HL2[i] - 3 * a[i];
      if (ok(pl)) l = l > pl || C[i - 1] < pl ? l : pl;
      if (ok(pu)) u = u < pu || C[i - 1] > pu ? u : pu;
      const dir = !ok(pst)
        ? 1
        : pst === pu
          ? C[i] > u
            ? -1
            : 1
          : C[i] < l
            ? 1
            : -1;
      const st = dir === -1 ? l : u;
      up.push(dir === -1 ? st : NaN);
      down.push(dir === 1 ? st : NaN);
      pu = u;
      pl = l;
      pst = st;
    }
    return { up, down };
  },
  ichimoku: () => {
    const mid = (n) => HIGHEST(H, n).map((x, i) => (x + LOWEST(L, n)[i]) / 2);
    const conv = mid(9),
      base = mid(26);
    return { conversion: conv, base };
  },
  pivots: () => {
    // Daily bars, auto period = month: levels for a month come from the previous calendar month.
    const mk = (t) => {
      const d = new Date(t * 1000);
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    };
    const out = { p: [], r1: [], s1: [], r2: [], s2: [], r3: [], s3: [] };
    bars.forEach((b) => {
      const prev = bars.filter((x) => mk(x.time) === mk(b.time) - 1);
      if (!prev.length || mk(bars[0].time) === mk(b.time) - 1) {
        for (const k in out) out[k].push(NaN);
        return;
      }
      const h = Math.max(...prev.map((x) => x.high)),
        l = Math.min(...prev.map((x) => x.low)),
        c = prev[prev.length - 1].close,
        P = (h + l + c) / 3;
      out.p.push(P);
      out.r1.push(2 * P - l);
      out.s1.push(2 * P - h);
      out.r2.push(P + h - l);
      out.s2.push(P - (h - l));
      out.r3.push(h + 2 * (P - l));
      out.s3.push(l - 2 * (h - P));
    });
    return out;
  },
  volume: () => ({ value: V, ma: SMA(V, 20) }),
  obv: () => {
    let s = 0;
    return {
      value: C.map(
        (c, i) =>
          (s += i === 0 ? 0 : c > C[i - 1] ? V[i] : c < C[i - 1] ? -V[i] : 0),
      ),
    };
  },
  cmf: () => {
    const ad = bars.map((b) =>
      b.high === b.low
        ? 0
        : ((2 * b.close - b.low - b.high) / (b.high - b.low)) * b.volume,
    );
    return { value: SUM(ad, 20).map((x, i) => x / SUM(V, 20)[i]) };
  },
  ad: () => {
    let s = 0;
    return {
      value: bars.map(
        (b) =>
          (s +=
            b.high === b.low
              ? 0
              : ((2 * b.close - b.low - b.high) / (b.high - b.low)) * b.volume),
      ),
    };
  },
  pvt: () => {
    let s = 0;
    return {
      value: C.map((c, i) =>
        i ? (s += ((c - C[i - 1]) / C[i - 1]) * V[i]) : NaN,
      ),
    };
  },
  eom: () => {
    const ch = CHANGE(HL2);
    return {
      value: SMA(
        ch.map((x, i) => (10000 * x * (H[i] - L[i])) / V[i]),
        14,
      ),
    };
  },
  patterns: null, // markers, not a series
  vpvr: null, // drawn by the chart, checked in the volume profile test below
  markov: null, // checked in the Markov regime test below
  avwap: null, // checked in the anchored VWAP test below
  svp: null, // drawn by the chart, checked in the session volume profile test below
  pdhl: () => ({
    // Daily bars, period = day: each bar shows the bar before it.
    high: bars.map((b, i) => (i ? bars[i - 1].high : NaN)),
    low: bars.map((b, i) => (i ? bars[i - 1].low : NaN)),
  }),
  chaikinosc: () => {
    let s = 0;
    const adl = bars.map(
      (b) =>
        (s +=
          b.high === b.low
            ? 0
            : ((2 * b.close - b.low - b.high) / (b.high - b.low)) * b.volume),
    );
    return { value: sub(EMA(adl, 3), EMA(adl, 10)) };
  },
  cks: () => {
    const a = ATR(10);
    const fh = HIGHEST(H, 10).map((x, i) => x - a[i]),
      fl = LOWEST(L, 10).map((x, i) => x + a[i]);
    return { stopShort: HIGHEST(fh, 9), stopLong: LOWEST(fl, 9) };
  },
  chopzone: () => ({ value: chopAngle().map((a) => (ok(a) ? 1 : NaN)) }), // the colours are checked below
  crsi: () => {
    // Streak by looking back for the run of same-direction closes, rather than carrying a counter.
    const streak = C.map((c, i) => {
      const d = i ? Math.sign(c - C[i - 1]) : 0;
      let k = 0;
      while (d && i - k >= 1 && Math.sign(C[i - k] - C[i - k - 1]) === d) k++;
      return d * k;
    });
    const roc1 = C.map((c, i) => (i ? (100 * (c - C[i - 1])) / C[i - 1] : NaN));
    const rank = roc1.map((x, i) => {
      const w = i < 100 ? null : roc1.slice(i - 100, i);
      return allOk(w) ? w.filter((y) => y <= x).length : NaN;
    });
    const a = RSI(C, 3),
      b = RSI(streak, 2);
    return { value: C.map((_, i) => (a[i] + b[i] + rank[i]) / 3) };
  },
  dpo: () => {
    const ma = SMA(C, 21); // close - the average from floor(21 / 2) + 1 = 11 bars back
    return { value: C.map((c, i) => c - ma[i - 11]) };
  },
  efi: () => ({
    value: EMA(
      CHANGE(C).map((d, i) => d * V[i]),
      13,
    ),
  }),
  fisher: () => {
    const hi = HIGHEST(HL2, 9),
      lo = LOWEST(HL2, 9);
    const fisher = new Array(N).fill(NaN);
    let v = 0,
      f = 0;
    for (let i = 0; i < N; i++) {
      if (!ok(hi[i])) continue;
      const r = hi[i] === lo[i] ? 0 : (HL2[i] - lo[i]) / (hi[i] - lo[i]);
      v = 0.66 * (r - 0.5) + 0.67 * v;
      v = v > 0.99 ? 0.999 : v < -0.99 ? -0.999 : v;
      f = Math.atanh(v) + 0.5 * f; // 0.5 * ln((1 + v) / (1 - v)) is atanh(v)
      fisher[i] = f;
    }
    return {
      fisher,
      trigger: fisher.map((_, i) => (i ? fisher[i - 1] : NaN)),
    };
  },
  kvo: () => {
    const sv = CHANGE(HLC3).map((d, i) => (d >= 0 ? V[i] : -V[i]));
    const k = sub(EMA(sv, 34), EMA(sv, 55));
    return { kvo: k, signal: EMA(k, 13) };
  },
  kst: () => {
    const sr = (r, s) =>
      SMA(
        C.map((c, i) => (i >= r ? (100 * (c - C[i - r])) / C[i - r] : NaN)),
        s,
      );
    const k = add(
      add(sr(10, 10), mul(sr(15, 10), 2)),
      add(mul(sr(20, 10), 3), mul(sr(30, 15), 4)),
    );
    return { kst: k, signal: SMA(k, 9) };
  },
  mcginley: () => {
    const e = EMA(C, 14);
    let mg = NaN;
    return {
      value: C.map((c, i) => {
        mg = ok(mg) ? mg + (c - mg) / (14 * Math.pow(c / mg, 4)) : e[i];
        return mg;
      }),
    };
  },
  netvol: () => ({
    value: C.map((c, i) =>
      i && c > C[i - 1] ? V[i] : i && c < C[i - 1] ? -V[i] : 0,
    ),
  }),
  pivotshl: null, // markers, checked in the pivot high/low test below
  rvgi: () => {
    const sw = (s) =>
      s.map((_, i) =>
        i >= 3 ? (s[i - 3] + 2 * s[i - 2] + 2 * s[i - 1] + s[i]) / 6 : NaN,
      );
    const num = SUM(sw(sub(C, O)), 10),
      den = SUM(sw(sub(H, L)), 10);
    const v = num.map((x, i) => x / den[i]);
    return { value: v, signal: sw(v) };
  },
  rvi: () => {
    const sd = STDEV(C, 10),
      ch = CHANGE(C);
    const up = EMA(
        ch.map((d, i) => (d <= 0 ? 0 : sd[i])),
        14,
      ),
      dn = EMA(
        ch.map((d, i) => (d > 0 ? 0 : sd[i])),
        14,
      );
    return { value: up.map((u, i) => (100 * u) / (u + dn[i])) };
  },
  rci: () => ({
    // These closes never tie inside a 9-bar window, so Spearman's 6 * sum(d^2) form is exact here.
    value: C.map((_, i) => {
      const w = win(C, i, 9);
      if (!w) return NaN;
      let d2 = 0;
      w.forEach((x, k) => {
        const rank = 1 + w.filter((y) => y < x).length;
        d2 += (rank - (k + 1)) ** 2;
      });
      return 100 * (1 - (6 * d2) / (9 * (81 - 1)));
    }),
  }),
  smiergodic: () => {
    const pc = CHANGE(C);
    const num = EMA(EMA(pc, 5), 20),
      den = EMA(EMA(pc.map(Math.abs), 5), 20);
    const smi = num.map((x, i) => x / den[i]),
      signal = EMA(smi, 5);
    return { smi, signal, osc: sub(smi, signal) };
  },
  vstop: () => {
    const a = ATR(20);
    const up = new Array(N).fill(NaN),
      down = new Array(N).fill(NaN);
    let hiC = C[0],
      loC = C[0],
      trendUp = true,
      stop = NaN;
    for (let i = 0; i < N; i++) {
      const m = ok(a[i]) ? 2 * a[i] : TR[i];
      hiC = Math.max(hiC, C[i]);
      loC = Math.min(loC, C[i]);
      if (!ok(stop)) stop = C[i];
      else stop = trendUp ? Math.max(stop, hiC - m) : Math.min(stop, loC + m);
      const nowUp = C[i] - stop >= 0;
      if (nowUp !== trendUp) {
        hiC = loC = C[i];
        stop = nowUp ? hiC - m : loC + m;
      }
      trendUp = nowUp;
      (trendUp ? up : down)[i] = stop;
    }
    return { up, down };
  },
  volosc: () => {
    const f = EMA(V, 5),
      s = EMA(V, 10);
    return { value: f.map((x, i) => (100 * (x - s[i])) / s[i]) };
  },
  alligator: () => {
    // Each line is drawn that many bars ahead of the bar it was computed on.
    const ahead = (s, k) => s.map((_, i) => (i >= k ? s[i - k] : NaN));
    return {
      jaw: ahead(RMA(HL2, 13), 8),
      teeth: ahead(RMA(HL2, 8), 5),
      lips: ahead(RMA(HL2, 5), 3),
    };
  },
  fractals: null, // markers, checked in the Williams fractals test below
  zigzag: null, // checked in the Zig Zag tests below
  twap: () => ({
    value: bars.map((b) => (b.open + b.high + b.low + b.close) / 4),
  }), // daily bars: every bar is its own day
  bbtrend: () => {
    const band = (n) => {
      const m = SMA(C, n),
        sd = STDEV(C, n);
      return { m, u: add(m, mul(sd, 2)), l: sub(m, mul(sd, 2)) };
    };
    const s = band(20),
      l = band(50);
    return {
      value: s.m.map(
        (m, i) =>
          ((Math.abs(s.l[i] - l.l[i]) - Math.abs(s.u[i] - l.u[i])) / m) * 100,
      ),
    };
  },
  trendstrength: () => ({
    // r = (n*sum(xy) - sum(x)*sum(y)) / sqrt((n*sum(x^2) - sum(x)^2) * (n*sum(y^2) - sum(y)^2)), x = 0..13
    value: C.map((_, i) => {
      const w = win(C, i, 14);
      if (!w) return NaN;
      let sx = 0,
        sy = 0,
        sxy = 0,
        sxx = 0,
        syy = 0;
      w.forEach((y, x) => {
        sx += x;
        sy += y;
        sxy += x * y;
        sxx += x * x;
        syy += y * y;
      });
      return (
        (14 * sxy - sx * sy) /
        Math.sqrt((14 * sxx - sx * sx) * (14 * syy - sy * sy))
      );
    }),
  }),
  guppy: () =>
    Object.fromEntries(
      [3, 5, 8, 10, 12, 15, 30, 35, 40, 45, 50, 60].map((n) => [
        `ema${n}`,
        EMA(C, n),
      ]),
    ),
};

test("the reference covers every built-in indicator", () => {
  const missing = INDICATORS.filter(
    (d) => !d.id.startsWith("custom:") && !(d.id in REF),
  ).map((d) => d.id);
  assert.deepEqual(missing, []);
});

for (const [id, ref] of Object.entries(REF)) {
  if (!ref) continue;
  test(`${id} matches TradingView's formula on the last 400 bars`, () => {
    const ours = compute(id, bars),
      theirs = ref();
    for (const [key, want] of Object.entries(theirs)) {
      const got = ours[key];
      assert.ok(Array.isArray(got), `${id}.${key} missing`);
      let compared = 0;
      for (let i = N - 400; i < N; i++) {
        if (!ok(want[i])) continue;
        assert.ok(
          ok(got[i]),
          `${id}.${key}[${i}] is ${got[i]}, expected ${want[i]}`,
        );
        const tol = 1e-7 * Math.max(1, Math.abs(want[i]));
        assert.ok(
          Math.abs(got[i] - want[i]) <= tol,
          `${id}.${key}[${i}] = ${got[i]}, expected ${want[i]}`,
        );
        compared++;
      }
      assert.ok(
        compared > 100,
        `${id}.${key} only had ${compared} comparable bars`,
      );
    }
  });
}

// Volume profile: every bar's volume lands in the rows its range covers, and the value area holds
// at least the asked-for share of the total.
test("volume profile conserves volume and its value area holds 70%", async () => {
  const { VolumeProfile } = await import("../public/js/volume-profile.js");
  const sample = bars.slice(-200);
  const prof = VolumeProfile.profile(sample, 24, 70);
  const total = prof.total.reduce((a, b) => a + b, 0);
  const want = sample.reduce((a, b) => a + (b.volume || 0), 0);
  assert.ok(Math.abs(total - want) / want < 1e-9, "no volume lost or invented");
  const va = prof.total
    .slice(prof.vaLow, prof.vaHigh + 1)
    .reduce((a, b) => a + b, 0);
  assert.ok(va / total >= 0.7);
  assert.ok(prof.vaLow <= prof.poc && prof.poc <= prof.vaHigh);
  assert.equal(prof.total[prof.poc], Math.max(...prof.total));
});

// Markov regime: states follow the trailing-return rule, odds are probabilities, and no bar uses
// a transition that hadn't happened yet.
test("Markov regime labels states by trailing return and its odds never look ahead", () => {
  const r = compute("markov", bars, {
    lookback: 20,
    threshold: 5,
    minHistory: 50,
  });
  for (let i = 20; i < bars.length; i++) {
    const ret = bars[i].close / bars[i - 20].close - 1;
    assert.equal(r.state[i], ret >= 0.05 ? 1 : ret <= -0.05 ? -1 : 0);
    if (Number.isFinite(r.signal[i])) {
      assert.ok(
        r.pbull[i] >= 0 &&
          r.pbull[i] <= 1 &&
          r.pbear[i] >= 0 &&
          r.pbear[i] <= 1,
      );
      assert.ok(Math.abs(r.signal[i] - (r.pbull[i] - r.pbear[i])) < 1e-12);
    }
  }
  const cut = compute("markov", bars.slice(0, 600), {
    lookback: 20,
    threshold: 5,
    minHistory: 50,
  });
  for (let i = 0; i < 600; i++)
    if (Number.isFinite(cut.signal[i]))
      assert.ok(
        Math.abs(cut.signal[i] - r.signal[i]) < 1e-12,
        `bar ${i} changed when later bars were added`,
      );
});

test("anchored VWAP: starts at the anchor bar and is the volume-weighted mean of hlc3 from there", () => {
  const a = 200,
    anchor = bars[a].time;
  const r = compute("avwap", bars, {
    anchor,
    source: "hlc3",
    band1: 1,
    band2: 2,
  });
  for (let i = 0; i < a; i++)
    assert.ok(Number.isNaN(r.value[i]), `nothing before the anchor (bar ${i})`);
  const h = (b) => (b.high + b.low + b.close) / 3;
  assert.ok(
    Math.abs(r.value[a] - h(bars[a])) < 1e-9,
    "the anchor bar is its own price",
  );
  let pv = 0,
    pv2 = 0,
    v = 0;
  for (let i = a; i < a + 60; i++) {
    pv += h(bars[i]) * bars[i].volume;
    pv2 += h(bars[i]) ** 2 * bars[i].volume;
    v += bars[i].volume;
    const vw = pv / v,
      sd = Math.sqrt(Math.max(0, pv2 / v - vw * vw));
    assert.ok(Math.abs(r.value[i] - vw) < 1e-6 * vw, `value at ${i}`);
    assert.ok(
      Math.abs(r.upper1[i] - (vw + sd)) < 1e-6 * vw &&
        Math.abs(r.lower2[i] - (vw - 2 * sd)) < 1e-6 * vw,
      `bands at ${i}`,
    );
  }
  const later = compute("avwap", bars, {
    anchor: bars.at(-1).time + 86400,
    source: "hlc3",
    band1: 1,
    band2: 0,
  });
  assert.ok(
    later.value.every(Number.isNaN),
    "an anchor after the last bar draws nothing",
  );
  const none = compute("avwap", bars, {
    anchor: 0,
    source: "hlc3",
    band1: 0,
    band2: 0,
  });
  assert.equal(
    none.value.findIndex((x) => !Number.isNaN(x)),
    bars.length - 150,
    "no anchor yet: starts 150 bars back",
  );
  assert.ok(none.upper1.every(Number.isNaN), "band 0 is off");
});

test("session volume profile: one profile per session, each from that session's bars only", async () => {
  const { VolumeProfile, SessionVolumeProfile } =
    await import("../public/js/volume-profile.js");
  const { periodKey } = await import("../public/lib/indicators.js");
  // Daily bars grouped by month: every session is one calendar month and they tile the bars with no gaps or overlaps.
  const sessions = SessionVolumeProfile.sessions(bars, "month", periodKey);
  assert.ok(sessions.length > 12, "many monthly sessions");
  sessions.forEach((s, i) => {
    assert.equal(
      periodKey(bars[s.from].time, "month"),
      periodKey(bars[s.to].time, "month"),
      `session ${i} stays in one month`,
    );
    if (i)
      assert.equal(
        s.from,
        sessions[i - 1].to + 1,
        `session ${i} starts right after the last`,
      );
  });
  assert.equal(sessions.at(-1).to, bars.length - 1);
  // A session's profile is the same as a plain profile of just its bars.
  const s = sessions[5];
  const prof = VolumeProfile.profile(bars.slice(s.from, s.to + 1), 24, 70);
  assert.ok(
    prof && prof.poc >= prof.vaLow && prof.poc <= prof.vaHigh,
    "POC sits inside the value area",
  );
  // Auto picks days for intraday charts, months on the daily chart, years on weekly and slower.
  assert.equal(SessionVolumeProfile.periodFor("Auto", 3600), "day");
  assert.equal(SessionVolumeProfile.periodFor("Auto", 86400), "month");
  assert.equal(SessionVolumeProfile.periodFor("Auto", 7 * 86400), "year");
  assert.equal(SessionVolumeProfile.periodFor("Week", 3600), "week");
});

test("previous day high/low on intraday bars uses the whole previous day", () => {
  const day = 86400,
    t0 = Date.UTC(2026, 0, 5) / 1000;
  const hl = [
    [10, 5],
    [12, 7],
    [11, 6],
    [9, 4],
    [20, 15],
    [18, 16],
    [17, 14],
    [19, 13],
    [30, 25],
  ];
  const six = hl.map(([h, l], i) => ({
    time: t0 + i * 6 * 3600,
    open: l,
    high: h,
    low: l,
    close: h,
    volume: 1,
  }));
  const r = compute("pdhl", six);
  assert.ok(
    r.high.slice(0, 4).every((x) => Number.isNaN(x)),
    "nothing before day two",
  );
  assert.deepEqual(r.high.slice(4, 8), [12, 12, 12, 12]);
  assert.deepEqual(r.low.slice(4, 8), [4, 4, 4, 4]);
  assert.equal(r.high[8], 20);
  assert.equal(r.low[8], 13);
  assert.deepEqual(
    r.breaks.map((b, i) => (b ? i : -1)).filter((i) => i >= 0),
    [0, 4, 8],
  );
  const w = compute("pdhl", six, { period: "week" });
  assert.ok(
    w.high.every((x) => Number.isNaN(x)),
    "one week of bars has no previous week",
  );
});

// Small hand-made bars: highs and lows only matter, the rest follows from them.
const hand = (highs, lows) =>
  highs.map((h, i) => ({
    time: 1700000000 + i * 86400,
    open: (h + lows[i]) / 2,
    high: h,
    low: lows[i],
    close: (h + lows[i]) / 2,
    volume: 1,
  }));
const pricesToBars = (p) => hand(p, p);
const near = (a, b) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(b));

test("histogram colours follow their rules", () => {
  const chop = compute("chopzone", bars),
    ang = chopAngle();
  const up = [[5, "#26C6DA"], [3.57, "#43A047"], [2.14, "#A5D6A7"], [0.71, "#009688"]];
  const down = [[-5, "#D50000"], [-3.57, "#E91E63"], [-2.14, "#FF6D00"], [-0.71, "#FFB74D"]];
  const want = (a) => (up.find(([t]) => a >= t) ?? down.find(([t]) => a <= t) ?? [0, "#FDD835"])[1];
  for (let i = 0; i < N; i++)
    if (ok(ang[i])) assert.equal(chop.colors[i], want(ang[i]), `chopzone colour at ${i}`);
  assert.ok(new Set(chop.colors.filter((_, i) => ok(ang[i]))).size >= 5, "the fixture should visit most of the palette");

  const nv = compute("netvol", bars);
  for (let i = 1; i < N; i++) {
    if (C[i] === C[i - 1]) continue;
    const rose = C[i] > C[i - 1];
    assert.equal(nv.value[i], rose ? V[i] : -V[i]);
    assert.equal(nv.colors[i], rose ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)");
  }

  const bt = compute("bbtrend", bars),
    ref = REF.bbtrend().value;
  for (let i = 0; i < N; i++)
    if (ok(ref[i])) assert.equal(bt.colors[i], ref[i] >= 0 ? "#26a69a" : "#ef5350", `bbtrend colour at ${i}`);
});

test("detrended price oscillator, centered: each close against the average centred on it", () => {
  const ma = SMA(C, 21),
    r = compute("dpo", bars, { centered: "On" });
  assert.equal(r.value.length, N);
  for (let i = N - 400; i < N - 11; i++)
    assert.ok(near(r.value[i], C[i] - ma[i + 11]), `dpo[${i}] = ${r.value[i]}`);
  assert.ok(r.value.slice(N - 11).every(Number.isNaN), "the newest 11 bars have no average ahead of them yet");
});

test("alligator lines run past the last bar by their offsets", () => {
  const r = compute("alligator", bars);
  assert.equal(r.extendBars, 8);
  assert.deepEqual([r.jaw.length, r.teeth.length, r.lips.length], [N + 8, N + 5, N + 3]);
  for (const [key, len, k] of [["jaw", 13, 8], ["teeth", 8, 5], ["lips", 5, 3]]) {
    const line = RMA(HL2, len);
    for (let j = 0; j < k; j++) assert.ok(near(r[key][N + j], line[N - k + j]), `${key} tail ${j}`);
  }
});

test("TWAP averages ohlc4 since the period began and starts over each period", () => {
  const t0 = Date.UTC(2026, 0, 5) / 1000; // a Monday
  const px = [10, 20, 30, 40, 100, 200, 300, 400, 1000];
  const at = [0, 6, 12, 18, 24, 30, 36, 42, 7 * 24].map((h) => t0 + h * 3600);
  const six = px.map((p, i) => ({ time: at[i], open: p, high: p, low: p, close: p, volume: 1 }));
  const idx = (r) => r.breaks.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
  const day = compute("twap", six);
  assert.deepEqual(day.value, [10, 15, 20, 25, 100, 150, 200, 250, 1000]);
  assert.deepEqual(idx(day), [4, 8]);
  const week = compute("twap", six, { anchor: "week" });
  assert.deepEqual(week.value.slice(0, 8).map((x) => Math.round(x * 1e6) / 1e6), [10, 15, 20, 25, 40, 66.666667, 100, 137.5]);
  assert.equal(week.value[8], 1000);
  assert.deepEqual(idx(week), [8]);
  const month = compute("twap", six, { anchor: "month" });
  assert.ok(near(month.value[8], 2100 / 9));
  assert.deepEqual(idx(month), []);
});

test("VWAP on daily bars draws a joined line, and an anchor makes it run over the week", () => {
  const t0 = Date.UTC(2026, 0, 5) / 1000; // a Monday
  const daily = [10, 20, 30, 40, 50, 60].map((p, i) => ({ time: t0 + i * 86400, open: p, high: p, low: p, close: p, volume: 1 }));
  const day = compute("vwap", daily);
  assert.deepEqual(day.value, [10, 20, 30, 40, 50, 60]);
  assert.ok(day.breaks.every((b) => !b), "no breaks when each session is one bar");
  const week = compute("vwap", daily, { anchor: "week" });
  assert.deepEqual(week.value, [10, 15, 20, 25, 30, 35]);
  const hourly = [1, 2, 3, 4].map((p, i) => ({ time: t0 + [0, 6, 24, 30][i] * 3600, open: p, high: p, low: p, close: p, volume: 1 }));
  assert.deepEqual(compute("vwap", hourly).breaks, [false, false, true, false]);
});

test("pivot points high low: a bar is a pivot once the bars either side are lower, ties go to the earlier bar", () => {
  const b = hand([5, 6, 9, 7, 6, 6, 8, 10, 10, 7, 7], [4, 5, 8, 6, 5, 5, 7, 9, 3, 6, 6]);
  const got = compute("pivotshl", b, { left: 2, right: 2 }).markers.map((m) => [b.findIndex((x) => x.time === m.time), m.position, m.text]);
  assert.deepEqual(got, [
    [2, "aboveBar", "9"],
    [4, "belowBar", "5"], // bar 5 has the same low, but the earlier bar wins
    [7, "aboveBar", "10"], // so does bar 8 with the same high
    [8, "belowBar", "3"],
  ]);
  // On real data every marker is the extreme of its own window of left + right + 1 bars.
  const m = compute("pivotshl", bars).markers;
  assert.ok(m.length > 10, `only ${m.length} pivots`);
  for (const k of m) {
    const c = bars.findIndex((x) => x.time === k.time),
      w = bars.slice(c - 10, c + 11);
    assert.ok(c >= 10 && c + 10 < N, "pivots need ten bars on each side");
    if (k.position === "aboveBar") assert.equal(Math.max(...w.map((x) => x.high)), Number(k.text));
    else assert.equal(Math.min(...w.map((x) => x.low)), Number(k.text));
  }
});

test("Williams fractals: two lower bars each side, equal bars tolerated on the older side only", () => {
  const b = hand(
    [15, 16, 19, 17, 16, 16, 18, 18, 17, 16, 15, 14],
    [6, 5, 4, 5, 3, 4, 5, 5, 2, 2, 4, 5],
  );
  const got = compute("fractals", b).markers.map((m) => [b.findIndex((x) => x.time === m.time), m.position, m.shape]);
  assert.deepEqual(got, [
    [2, "aboveBar", "arrowDown"],
    [4, "belowBar", "arrowUp"],
    [7, "aboveBar", "arrowDown"], // bar 6 matches its high, bar 7 still counts
    [9, "belowBar", "arrowUp"], // bar 8 matches its low, bar 9 still counts
  ]);
  // Bar 6 (high 18) is not a fractal: bar 7 is no lower. Bar 8 (low 2) is not either: bar 9 is no higher.
  assert.ok(!got.some(([i]) => i === 6 || i === 8));
  const real = compute("fractals", bars).markers;
  assert.ok(real.length > 50);
  assert.ok(real.every((m) => bars.findIndex((x) => x.time === m.time) <= N - 3), "the newest two bars carry no fractal");
});

test("Zig Zag: straight legs between pivots, the last leg ends at the latest extreme", () => {
  const z = (p, deviation, depth) => compute("zigzag", pricesToBars(p), { deviation, depth }).value;
  const same = (got, want) => {
    assert.equal(got.length, want.length);
    want.forEach((w, i) => assert.ok(Number.isNaN(w) ? Number.isNaN(got[i]) : near(got[i], w), `bar ${i}: ${got[i]}, expected ${w}`));
  };
  const nan = NaN;
  // Pivots: high 109 (bar 3), low 94 (7), high 117 (11), then the open leg down to 99 (15).
  same(z([100, 102, 105, 109, 107, 103, 97, 94, 99, 105, 111, 117, 114, 108, 103, 99, 100, 101], 10, 3), [
    nan, nan, nan, 109, 105.25, 101.5, 97.75, 94, 99.75, 105.5, 111.25, 117, 112.5, 108, 103.5, 99, nan, nan,
  ]);
  // A 10% swing that is too close to the last pivot is ignored with depth 3 and kept with depth 1.
  same(z([100, 120, 105, 130, 100], 10, 3), [100, 110, 120, 130, 100]);
  same(z([100, 120, 105, 130, 100], 10, 1), [100, 120, 105, 130, 100]);
  // Falling through the last low before a pivot can be confirmed moves that low down.
  same(z([100, 120, 90, 95, 100, 105], 10, 3), [nan, nan, 90, 95, 100, 105]);
  same(z([100, 120, 90, 95, 100, 105], 10, 1), [100, 120, 90, 95, 100, 105]);
  same(z([100, 80, 110, 105, 100, 95], 10, 3), [nan, nan, 110, 105, 100, 95]);
  same(z([100, 80, 110, 105, 100, 95], 10, 1), [100, 80, 110, 105, 100, 95]);
  same(z([100, 101, 102, 101, 100], 10, 3), [nan, nan, nan, nan, nan]);

  // On real data the legs alternate, each is at least 5% of the pivot it leaves, and confirmed pivots sit 10+ bars apart.
  const v = compute("zigzag", bars).value;
  const first = v.findIndex(ok),
    last = N - 1 - [...v].reverse().findIndex(ok);
  const turns = [first];
  for (let i = first + 1; i < last; i++) if (Math.sign(v[i] - v[i - 1]) !== Math.sign(v[i + 1] - v[i])) turns.push(i);
  turns.push(last);
  assert.ok(turns.length > 10, `only ${turns.length} turning points`);
  for (let k = 0; k + 1 < turns.length; k++) {
    const a = v[turns[k]],
      b = v[turns[k + 1]];
    assert.ok(Math.abs(b - a) / a >= 0.05 - 1e-9, `leg ${k} moves ${(100 * (b - a)) / a}%`);
    if (k + 2 < turns.length) assert.ok(turns[k + 1] - turns[k] >= 10, `pivots ${k} and ${k + 1} are ${turns[k + 1] - turns[k]} bars apart`);
    if (k + 2 < turns.length) assert.ok(Math.sign(b - a) !== Math.sign(v[turns[k + 2]] - b), `legs ${k} and ${k + 1} go the same way`);
  }
});

test("Fisher Transform clamps its value, so a straight run settles instead of blowing up", () => {
  const up = pricesToBars(Array.from({ length: 80 }, (_, i) => 100 + i)),
    down = pricesToBars(Array.from({ length: 80 }, (_, i) => 200 - i));
  const limit = 2 * Math.atanh(0.999); // fish = atanh(0.999) + 0.5 * fish settles at twice that
  assert.ok(near(compute("fisher", up).fisher[79], limit));
  assert.ok(near(compute("fisher", down).fisher[79], -limit));
});

test("Connors RSI ranks today's move against the values at or below it, like ta.percentrank", () => {
  // Alternating closes repeat the same two rates of change exactly.
  const closes = [100, 110, 100, 110, 100, 110, 100, 110],
    streak = [0, 1, -1, 1, -1, 1, -1, 1];
  const mk = (cs) => cs.map((c, i) => ({ time: 1700000000 + i * 86400, open: c, high: c, low: c, close: c, volume: 1 }));
  const crsi = compute("crsi", mk(closes), { rankLength: 2 }).value;
  const price = compute("rsi", mk(closes), { length: 3, maLength: 0 }).value;
  const run = compute("rsi", mk(streak.map((s) => 100 + s)), { length: 2, maLength: 0 }).value;
  // At bar 5 the move is +10%; the two before it are -9.09% and +10%, both at or below it: 100.
  assert.ok(near(3 * crsi[5] - price[5] - run[5], 100));
  assert.ok(near(3 * crsi[6] - price[6] - run[6], 50)); // -9.09% against +10% and -9.09%: one at or below
});

test("Rank Correlation Index gives tied closes the average of their ranks", () => {
  const mk = (cs) => cs.map((c, i) => ({ time: 1700000000 + i * 86400, open: c, high: c, low: c, close: c, volume: 1 }));
  // Price ranks 1, 2.5, 2.5, 4 against time ranks 1..4: r = 4.5 / sqrt(5 * 4.5) = sqrt(0.9).
  assert.ok(near(compute("rci", mk([1, 2, 2, 3]), { length: 4 }).value[3], 100 * Math.sqrt(0.9)));
  assert.ok(near(compute("rci", mk([1, 2, 3, 4]), { length: 4 }).value[3], 100));
  assert.ok(near(compute("rci", mk([4, 3, 2, 1]), { length: 4 }).value[3], -100));
});

test("Chande Kroll Stop starts once both of its windows are full", () => {
  const r = compute("cks", bars); // ATR and the 10-bar extreme need 10 bars, the stop needs 9 of those
  assert.equal(r.stopShort.findIndex(ok), 17);
  assert.equal(r.stopLong.findIndex(ok), 17);
});
