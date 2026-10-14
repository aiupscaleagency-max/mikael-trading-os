// Thin wrapper over the local server. Writes carry the x-qt header the server requires.
async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers:
      body !== undefined
        ? { "Content-Type": "application/json", "x-qt": "1" }
        : { "x-qt": "1" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(data?.error || data || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (u) => req("GET", u),
  post: (u, b) => req("POST", u, b ?? {}),
  put: (u, b) => req("PUT", u, b ?? {}),
  patch: (u, b) => req("PATCH", u, b ?? {}),
  del: (u) => req("DELETE", u),
  candles: (symbol, tf, limit = 3000) =>
    req(
      "GET",
      `/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}&limit=${limit}`,
    ),
  quotes: (symbols) =>
    req("GET", `/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`),
  search: (q) => req("GET", `/api/search?q=${encodeURIComponent(q)}`),
};

export function download(name, content, type = "text/csv") {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e6) return fmtNum(v);
  const d = a >= 1000 ? 2 : a >= 1 ? (a >= 100 ? 2 : 4) : a >= 0.01 ? 6 : 8;
  return v.toLocaleString(undefined, {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
}

export function fmtNum(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(d);
}

export const fmtPct = (v) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
// "BINANCE:BTCUSDT" -> "BTCUSDT"; a spread "SPREAD:BINANCE:BTCUSDT / BINANCE:ETHUSDT" -> "BTCUSDT/ETHUSDT".
export const ticker = (id) => {
  const s = String(id || "");
  if (s.startsWith("SPREAD:")) return s.slice(7).split(" ").map((x) => (x.includes(":") ? x.split(":").pop() : x)).join("");
  return s.split(":").pop();
};
export const exchange = (id) => String(id || "").split(":")[0];
