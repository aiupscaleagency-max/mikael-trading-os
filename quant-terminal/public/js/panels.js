// Side panel (watchlist, alerts, calendar) and bottom panel (tester, screener, heatmap, paper, editor).
import {
  api,
  download,
  esc,
  fmtPrice,
  fmtPct,
  fmtNum,
  ticker,
  exchange,
} from "./api.js";
import { INDICATORS, BY_ID, registerIndicator } from "../lib/indicators.js";
import { mountPtqCheck, renderPtqTab } from "./ptq.js";
import { renderNews, renderSeasonals, renderFinancials } from "./research.js";
import { mountQuantChecks } from "./quantui.js";
import {
  backtest,
  tradesCsv,
  EXAMPLE_STRATEGIES,
  OPS,
  magnifierTf,
} from "../lib/backtest.js";
import { parseTf } from "../lib/series.js";
import { renderCourse } from "./course.js";

const $ = (s, el = document) => el.querySelector(s);
const LW = window.LightweightCharts;
const css = (n) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();


// ---------- operand picker (shared by tester, alerts, screener scans) ----------
const PRICE = [
  "close",
  "open",
  "high",
  "low",
  "volume",
  "hl2",
  "hlc3",
  "ohlc4",
];
const OP_LABEL = {
  ">": "is above",
  "<": "is below",
  ">=": "is at or above",
  "<=": "is at or below",
  crossesAbove: "crosses above",
  crossesBelow: "crosses below",
  crosses: "crosses",
};
const outputsOf = (def) => [
  ...def.outputs.map((o) => o.key),
  ...(def.id === "supertrend" ? ["direction"] : []),
];
const mainInput = (def) =>
  (def.inputs || []).find((i) => i.type === "int" || i.type === "float");

function operandHtml(o) {
  const val =
    o.kind === "line"
      ? "l"
      : o.kind === "value"
        ? "v"
        : o.kind === "price"
          ? `p:${o.field}`
          : `i:${o.id}`;
  const opts = [
    o.kind === "line" ? `<option value="l" selected>${esc(o.label || "Drawn line")}</option>` : "",
    `<optgroup label="Price">${PRICE.map((f) => `<option value="p:${f}" ${val === `p:${f}` ? "selected" : ""}>${f === "close" ? "Price (close)" : f}</option>`).join("")}</optgroup>`,
    `<option value="v" ${val === "v" ? "selected" : ""}>Value</option>`,
    `<optgroup label="Indicators">${INDICATORS.filter((d) => d.outputs.length)
      .map(
        (d) =>
          `<option value="i:${esc(d.id)}" ${val === `i:${d.id}` ? "selected" : ""}>${esc(d.name)}</option>`,
      )
      .join("")}</optgroup>`,
  ].join("");
  let extra = "";
  if (o.kind === "value")
    extra = `<input class="num" data-v type="number" step="any" value="${o.v ?? 0}">`;
  if (o.kind === "ind") {
    const def = BY_ID[o.id];
    const mi = def && mainInput(def);
    if (mi)
      extra += `<input class="num" data-p="${mi.key}" type="number" step="any" title="${esc(mi.label)}" value="${o.params?.[mi.key] ?? mi.default}">`;
    const outs = def ? outputsOf(def) : [];
    if (outs.length > 1)
      extra += `<select data-out>${outs.map((k) => `<option ${k === o.output ? "selected" : ""}>${k}</option>`).join("")}</select>`;
  }
  const lineData = o.kind === "line" ? ` data-line="${esc(JSON.stringify(o.line))}" data-label="${esc(o.label || "Drawn line")}"` : "";
  return `<span class="operand"${lineData}><select data-kind>${opts}</select>${extra}</span>`;
}

function readOperand(span) {
  const k = span.querySelector("[data-kind]").value;
  if (k === "l") return { kind: "line", line: JSON.parse(span.dataset.line), label: span.dataset.label };
  if (k === "v")
    return {
      kind: "value",
      v: Number(span.querySelector("[data-v]")?.value || 0),
    };
  if (k.startsWith("p:")) return { kind: "price", field: k.slice(2) };
  const id = k.slice(2),
    def = BY_ID[id];
  const params = {};
  const p = span.querySelector("[data-p]");
  if (p) params[p.dataset.p] = Number(p.value);
  return {
    kind: "ind",
    id,
    params,
    output: span.querySelector("[data-out]")?.value || outputsOf(def)[0],
  };
}

function ruleHtml(r) {
  return `<div class="rule">${operandHtml(r.left)}<select data-op>${OPS.map((o) => `<option value="${o}" ${o === r.op ? "selected" : ""}>${OP_LABEL[o]}</option>`).join("")}</select>${operandHtml(r.right)}<button class="x" title="Remove">&times;</button></div>`;
}

function bindRules(container, onChange = () => {}) {
  container.addEventListener("change", (e) => {
    const span = e.target.closest(".operand");
    if (span && e.target.matches("[data-kind]")) {
      const k = e.target.value;
      const o =
        k === "v"
          ? { kind: "value", v: 0 }
          : k.startsWith("p:")
            ? { kind: "price", field: k.slice(2) }
            : {
                kind: "ind",
                id: k.slice(2),
                params: {},
                output: outputsOf(BY_ID[k.slice(2)])[0],
              };
      span.outerHTML = operandHtml(o);
    }
    onChange();
  });
  container.addEventListener("click", (e) => {
    if (e.target.matches(".rule .x")) {
      e.target.closest(".rule").remove();
      onChange();
    }
  });
}

const readRules = (container) =>
  [...container.querySelectorAll(".rule")].map((r) => {
    const ops = r.querySelectorAll(".operand");
    return {
      left: readOperand(ops[0]),
      op: r.querySelector("[data-op]").value,
      right: readOperand(ops[1]),
    };
  });

function compileRules(groups) {
  const indicators = {};
  const ref = (o) => {
    if (o.kind === "line") return { line: o.line };
    if (o.kind === "value") return Number(o.v);
    if (o.kind === "price") return o.field;
    const key = `${o.id}_${Object.values(o.params || {}).join("_")}`.replace(
      /[^a-z0-9_]/gi,
      "_",
    );
    indicators[key] = { id: o.id, params: o.params || {} };
    return `${key}.${o.output}`;
  };
  const out = { indicators };
  for (const [name, rules] of Object.entries(groups))
    out[name] = rules.map((r) => ({
      left: ref(r.left),
      op: r.op,
      right: ref(r.right),
    }));
  return out;
}

function toOperand(x, indicators) {
  if (x && typeof x === "object" && x.line) return { kind: "line", line: x.line, label: "Drawn line" };
  if (typeof x === "number") return { kind: "value", v: x };
  if (PRICE.includes(x)) return { kind: "price", field: x };
  const [k, out] = String(x).split(".");
  const s = indicators[k];
  const def = BY_ID[s?.id];
  if (!def) return { kind: "value", v: 0 };
  return {
    kind: "ind",
    id: s.id,
    params: { ...(s.params || {}) },
    output: out || s.output || outputsOf(def)[0],
  };
}

const defaultRule = () => ({
  left: { kind: "price", field: "close" },
  op: "crossesAbove",
  right: { kind: "ind", id: "ema", params: { length: 50 }, output: "value" },
});

// ==========================================================================================
export function initPanels(app) {
  const side = $("#sideBody"),
    bottom = $("#bottomBody"),
    bottomEl = $("#bottom");
  let sideTab = "watchlist",
    bottomTab = "tester";
  const P = {};
  api.get("/api/ptqa/course").then(() => { $("#courseTab").hidden = false; }).catch(() => {});

  // ---------- tabs ----------
  $("#sideTabs").onclick = (e) => {
    const t = e.target.dataset.tab;
    if (t) showSide(t);
  };
  $("#bottomTabs").onclick = (e) => {
    const t = e.target.closest("[data-tab]")?.dataset.tab;
    if (t) showBottom(t, true);
  };
  $("#bottomToggle").onclick = () => {
    bottomEl.classList.toggle("collapsed");
    if (!bottomEl.classList.contains("collapsed")) renderBottom();
  };

  function showSide(t) {
    sideTab = t;
    document
      .querySelectorAll("#sideTabs button")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    renderSide();
  }
  function showBottom(t, toggle = false) {
    if (
      toggle &&
      t === bottomTab &&
      !bottomEl.classList.contains("collapsed")
    ) {
      bottomEl.classList.add("collapsed");
      return;
    }
    bottomTab = t;
    bottomEl.classList.remove("collapsed");
    document
      .querySelectorAll("#bottomTabs [data-tab]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    renderBottom();
  }
  const renderSide = () =>
    ({
      watchlist: renderWatchlist,
      alerts: renderAlerts,
      calendar: renderCalendar,
      news: () => renderNews(side, app),
    })[sideTab]();
  const renderBottom = () => {
    if (!bottomEl.classList.contains("collapsed"))
      ({
        tester: renderTester,
        course: () => renderCourse(bottom, app),
        screener: renderScreener,
        heatmap: renderHeatmap,
        seasonals: () => renderSeasonals(bottom, app),
        financials: () => renderFinancials(bottom, app),
        paper: renderPaper,
        editor: renderEditor,
        ptq: () => renderPtqTab(bottom, app),
      })[bottomTab]();
  };

  // ======================= WATCHLIST =======================
  let quotes = {};
  function wlSymbols() {
    return app.state.watchlists[app.state.activeWatchlist] || [];
  }
  function renderWatchlist() {
    const names = Object.keys(app.state.watchlists);
    side.innerHTML = `<div class="wl-head"><select class="in" id="wlSel">${names.map((n) => `<option ${n === app.state.activeWatchlist ? "selected" : ""}>${esc(n)}</option>`).join("")}</select><button class="btn small" id="wlNew" title="New list">+ List</button><button class="btn small" id="wlDel" title="Delete this list">Delete</button></div>
      <div style="padding:8px"><input class="in" id="wlAdd" placeholder="Add symbol (Enter)" style="width:100%"></div><div id="wlRows"></div>`;
    $("#wlSel").onchange = (e) => {
      app.state.activeWatchlist = e.target.value;
      app.persist();
      renderWatchlist();
      refreshQuotes();
    };
    $("#wlNew").onclick = () => {
      const n = prompt("Name for the new list:");
      if (!n || app.state.watchlists[n]) return;
      app.state.watchlists[n] = [];
      app.state.activeWatchlist = n;
      app.persist();
      renderWatchlist();
    };
    $("#wlDel").onclick = () => {
      if (names.length < 2) return app.toast("Keep at least one list.");
      if (!confirm(`Delete the list "${app.state.activeWatchlist}"?`)) return;
      delete app.state.watchlists[app.state.activeWatchlist];
      app.state.activeWatchlist = Object.keys(app.state.watchlists)[0];
      app.persist();
      renderWatchlist();
    };
    $("#wlAdd").onkeydown = async (e) => {
      if (e.key !== "Enter" || !e.target.value.trim()) return;
      try {
        const r = await api.get(
          `/api/resolve?symbol=${encodeURIComponent(e.target.value.trim())}`,
        );
        const list = wlSymbols();
        if (!list.includes(r.id)) list.push(r.id);
        e.target.value = "";
        app.persist();
        drawRows();
        refreshQuotes();
      } catch (err) {
        app.toast(err.message, "err");
      }
    };
    $("#wlRows").onclick = (e) => {
      const row = e.target.closest(".wl-row");
      if (!row) return;
      if (e.target.closest(".x")) {
        app.state.watchlists[app.state.activeWatchlist] = wlSymbols().filter(
          (s) => s !== row.dataset.sym,
        );
        app.persist();
        return drawRows();
      }
      app.setSymbol(row.dataset.sym);
    };
    drawRows();
  }
  function drawRows() {
    const box = $("#wlRows");
    if (!box) return;
    const cur = app.active?.cfg.symbol;
    box.innerHTML =
      wlSymbols()
        .map((s) => {
          const q = quotes[s] || {};
          const live = app.prices[s] ?? q.price;
          return `<div class="wl-row ${s === cur ? "current" : ""}" data-sym="${esc(s)}"><span class="sym">${esc(ticker(s))} <span class="ex">${esc(exchange(s))}</span></span><span class="px">${fmtPrice(live)}</span><span class="chg ${q.changePct >= 0 ? "up" : "down"}">${fmtPct(q.changePct)}</span><button class="x" title="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
        })
        .join("") ||
      '<div class="pad hint-text">Empty list. Add a symbol above.</div>';
  }
  async function refreshQuotes() {
    const syms = [...new Set([...wlSymbols(), ...paperSymbols()])];
    if (!syms.length) return;
    try {
      const q = await api.quotes(syms);
      Object.assign(quotes, q);
      for (const [s, v] of Object.entries(q))
        if (v.price) app.onPrice(s, v.price);
      if (sideTab === "watchlist") drawRows();
    } catch {
      /* offline */
    }
  }
  setInterval(refreshQuotes, 5000);
  refreshQuotes();

  // ======================= ALERTS =======================
  async function renderAlerts() {
    side.innerHTML =
      '<div class="pad row-flex"><button class="btn primary" id="alNew">New alert</button><button class="btn" id="alPerm">Desktop notifications</button></div><div id="alList"></div><h4 class="pad" style="margin:0;padding-bottom:0">Recent</h4><div id="alLog"></div>';
    $("#alNew").onclick = () => openAlertDialog();
    const perm = $("#alPerm");
    if (!("Notification" in window) || Notification.permission === "granted")
      perm.remove();
    else
      perm.onclick = () =>
        Notification.requestPermission().then(() => renderAlerts());
    let list = [],
      log = [];
    try {
      [list, log] = await Promise.all([
        api.get("/api/alerts"),
        api.get("/api/alerts/log"),
      ]);
    } catch {
      /* server down */
    }
    $("#alList").innerHTML =
      list
        .map(
          (a) =>
            `<div class="card" data-id="${a.id}"><div class="top"><div><b>${esc(ticker(a.symbol))}</b> <span class="muted">${esc(a.tf)}</span><div>${esc(describeAlert(a))}</div><div class="sub">${a.active ? "Active" : "Stopped"} · ${{ once: "only once", oncePerBar: "once per bar", oncePerBarClose: "once per bar close" }[a.trigger] || a.trigger}${a.webhook ? " · webhook" : ""}${a.fired ? ` · fired ${a.fired}x` : ""}</div></div><div class="row-flex" style="flex-wrap:nowrap"><button class="btn small" data-act="toggle">${a.active ? "Stop" : "Restart"}</button><button class="btn small danger" data-act="del">Delete</button></div></div></div>`,
        )
        .join("") ||
      '<div class="pad hint-text">No alerts yet. They run inside the app, so they keep firing with this tab closed as long as the app is running.</div>';
    $("#alLog").innerHTML =
      log
        .slice(0, 30)
        .map(
          (e) =>
            `<div class="card"><div>${esc(e.text)}</div><div class="sub">${new Date(e.at).toLocaleString()}${e.webhook ? ` · webhook ${esc(e.webhook)}` : ""}</div></div>`,
        )
        .join("") || '<div class="pad hint-text">Nothing has fired yet.</div>';
    $("#alList").onclick = async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const id = btn.closest("[data-id]").dataset.id;
      const a = list.find((x) => x.id === id);
      if (btn.dataset.act === "del") await api.del(`/api/alerts/${id}`);
      if (btn.dataset.act === "toggle")
        await api.patch(`/api/alerts/${id}`, {
          active: !a.active,
          lastBar: null,
        });
      renderAlerts();
    };
  }
  function describeAlert(a) {
    if (a.message) return a.message;
    const name = (x) => {
      if (typeof x === "number") return fmtPrice(x);
      if (PRICE.includes(x)) return x === "close" ? "Price" : x;
      const [k, out] = String(x).split(".");
      const s = a.indicators?.[k];
      const def = BY_ID[s?.id];
      return def
        ? `${def.name.replace(/ \(.*\)$/, "")} ${Object.values(s.params || {}).join(" ")}${out && outputsOf(def).length > 1 ? ` ${out}` : ""}`
        : x;
    };
    const conds = a.conditions?.length ? a.conditions : [{ left: a.left, op: a.op, right: a.right }];
    const nm = (x) => (x && typeof x === "object" && x.line ? "your drawn line" : name(x));
    return conds.map((c) => `${nm(c.left)} ${OP_LABEL[c.op] || c.op} ${nm(c.right)}`).join(a.match === "any" ? " or " : " and ");
  }
  function openAlertDialog(preset = {}) {
    const p = app.active;
    const price = p?.shown.at(-1)?.close ?? 0;
    const rules = preset.rules || [preset.rule || {
      left: { kind: "price", field: "close" },
      op: "crossesAbove",
      right: { kind: "value", v: Number(price.toPrecision(6)) },
    }];
    const card = app.modal(
      "Create alert",
      `<div class="form-grid"><label class="field">Symbol<input id="aSym" value="${esc(preset.symbol || p?.cfg.symbol || "")}"></label><label class="field">Timeframe<input id="aTf" value="${esc(p?.cfg.tf || "1h")}"></label></div>
      <h4>Conditions</h4><div class="rules" id="aRule">${rules.map(ruleHtml).join("")}</div>
      <div class="row-flex"><button class="btn small" id="aAdd">+ Condition</button><label class="field" style="flex-direction:row;align-items:center;gap:6px">Fire when<select id="aMatch"><option value="all">all are true</option><option value="any">any is true</option></select></label><span class="hint-text">Up to 5.</span></div>
      <div class="form-grid"><label class="field">Trigger<select id="aTrig"><option value="once">Only once</option><option value="oncePerBar">Once per bar</option><option value="oncePerBarClose">Once per bar close</option></select></label><label class="field">Message (optional)<input id="aMsg" placeholder="BTC broke out"></label></div>
      <h4>Also send to (optional)</h4><div class="row-flex"><input class="in" id="aHook" placeholder="Discord, Slack or Telegram webhook URL" style="flex:1"><button class="btn" id="aTest">Test</button></div>
      <p class="hint-text">Telegram: https://api.telegram.org/bot&lt;token&gt;/sendMessage?chat_id=&lt;your id&gt;. Alerts are checked every 15 seconds while the app runs.</p>`,
      {
        foot: '<button class="btn primary" id="aOk">Create alert</button>',
        wide: true,
      },
    );
    bindRules(card.querySelector("#aRule"));
    card.querySelector("#aAdd").onclick = () => {
      const box = card.querySelector("#aRule");
      if (box.querySelectorAll(".rule").length >= 5) return app.toast("An alert can have up to 5 conditions.");
      box.insertAdjacentHTML("beforeend", ruleHtml({ left: { kind: "price", field: "close" }, op: ">", right: { kind: "value", v: Number(price.toPrecision(6)) } }));
    };
    card.querySelector("#aTest").onclick = async () => {
      try {
        const r = await api.post("/api/webhook-test", {
          url: card.querySelector("#aHook").value.trim(),
        });
        app.toast(
          r.ok ? "Test message sent." : `Webhook replied HTTP ${r.status}`,
          r.ok ? "" : "err",
        );
      } catch (e) {
        app.toast(e.message, "err");
      }
    };
    card.querySelector("#aOk").onclick = async () => {
      const rs = readRules(card.querySelector("#aRule"));
      if (!rs.length) return app.toast("Add a condition.", "err");
      const c = compileRules({ rules: rs });
      try {
        await api.post("/api/alerts", {
          symbol: card.querySelector("#aSym").value.trim(),
          tf: card.querySelector("#aTf").value.trim(),
          left: c.rules[0].left,
          op: c.rules[0].op,
          right: c.rules[0].right,
          conditions: c.rules,
          match: card.querySelector("#aMatch").value,
          indicators: c.indicators,
          trigger: card.querySelector("#aTrig").value,
          message: card.querySelector("#aMsg").value.trim(),
          webhook: card.querySelector("#aHook").value.trim(),
        });
        app.closeModal();
        app.toast("Alert created.");
        if ("Notification" in window && Notification.permission === "default")
          Notification.requestPermission();
        showSide("alerts");
      } catch (e) {
        app.toast(e.message, "err");
      }
    };
  }

  // ======================= CALENDAR =======================
  let calFilter = "High", calView = "economic", calMine = false;
  async function renderCalendar() {
    side.innerHTML = `<div class="pad row-flex"><select class="in" id="calV"><option value="economic">Economic</option><option value="earnings">Earnings</option><option value="dividends">Dividends</option></select><span class="spacer"></span>${
      calView === "economic"
        ? '<select class="in" id="calF"><option value="all">All</option><option value="Medium">Medium + high</option><option value="High">High impact</option></select>'
        : `<label class="hint-text"><input type="checkbox" id="calMine" ${calMine ? "checked" : ""}> My watchlists</label>`
    }</div><div id="calList" class="pad hint-text">Loading…</div>`;
    $("#calV").value = calView;
    $("#calV").onchange = (e) => { calView = e.target.value; renderCalendar(); };
    if ($("#calF")) { $("#calF").value = calFilter; $("#calF").onchange = (e) => { calFilter = e.target.value; renderCalendar(); }; }
    if ($("#calMine")) $("#calMine").onchange = (e) => { calMine = e.target.checked; renderCalendar(); };
    const list = $("#calList");
    const dayHead = (label) => `<h4 class="pad" style="margin:0;padding-bottom:0">${esc(label)}</h4>`;
    const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
    const mine = new Set(Object.values(app.state.watchlists || {}).flat());
    try {
      if (calView === "economic") {
        const rows = await api.get("/api/calendar");
        const keep = (r) => calFilter === "all" || r.impact === "High" || (calFilter === "Medium" && r.impact === "Medium");
        let day = "";
        list.className = "";
        list.innerHTML = rows.filter(keep).map((r) => {
          const d = new Date(r.date);
          const label = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
          const head = label !== day ? dayHead((day = label)) : "";
          return `${head}<div class="card"><div class="top"><span><b>${esc(r.country)}</b> ${esc(r.title)}</span><span class="impact-${esc(r.impact)}">${esc(r.impact)}</span></div><div class="sub">${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}${r.forecast ? ` · forecast ${esc(r.forecast)}` : ""}${r.previous ? ` · previous ${esc(r.previous)}` : ""}</div></div>`;
        }).join("") || '<div class="pad hint-text">Nothing at this impact level this week.</div>';
        return;
      }
      const rows = (await api.get(`/api/${calView}?days=5`)).filter((r) => !calMine || mine.has(r.symbol));
      rows.sort((x, y) => x.date.localeCompare(y.date) || (mine.has(y.symbol) - mine.has(x.symbol)) || (y.marketCap || 0) - (x.marketCap || 0));
      let day = "";
      list.className = "";
      list.innerHTML = rows.slice(0, 250).map((r) => {
        const head = r.date !== day ? dayHead(fmtDay((day = r.date))) : "";
        const star = mine.has(r.symbol) ? ' <span class="up" title="On your watchlist">●</span>' : "";
        const sub = calView === "earnings"
          ? `${esc(r.when)}${r.epsForecast ? ` · EPS forecast ${esc(r.epsForecast)}` : ""}${r.lastYearEps ? ` · last year ${esc(r.lastYearEps)}` : ""}${r.marketCap ? ` · cap ${fmtNum(r.marketCap)}` : ""}`
          : `${r.amount != null ? `${fmtPrice(r.amount)} a share` : ""}${r.payDate ? ` · paid ${esc(r.payDate)}` : ""}${r.annual ? ` · ${fmtPrice(r.annual)} a year` : ""}`;
        return `${head}<div class="card cal-row" data-sym="${esc(r.symbol)}" style="cursor:pointer"><div class="top"><span><b>${esc(r.ticker)}</b>${star} <span class="muted">${esc((r.name || "").slice(0, 34))}</span></span></div><div class="sub">${sub}</div></div>`;
      }).join("") || `<div class="pad hint-text">${calMine ? "None of your watchlist symbols in the next five trading days." : "Nothing listed for the next five trading days."}</div>`;
      list.onclick = (e) => { const row = e.target.closest(".cal-row"); if (row) app.setSymbol(row.dataset.sym); };
    } catch (e) {
      list.textContent = `Calendar unavailable: ${e.message}`;
    }
  }

  // ======================= STRATEGY TESTER =======================
  let lastResult = null,
    equityChart = null;
  const tState = {
    groups: null,
    settings: {
      direction: "long",
      stopLossPct: 0,
      takeProfitPct: 0,
      trailingStopPct: 0,
      exitMatch: "all",
      maxBarsInTrade: 0,
      initialCapital: 10000,
      positionPct: 100,
      feePct: 0.1,
      slippagePct: 0.05,
      spreadPct: 0,
      intrabar: "worst",
    },
  };
  function strategyToUi(s) {
    const ind = s.indicators || {};
    const g = (k) =>
      (s[k] || []).map((r) => ({
        left: toOperand(r.left, ind),
        op: r.op,
        right: toOperand(r.right, ind),
      }));
    tState.groups = {
      entryLong: g("entryLong"),
      exitLong: g("exitLong"),
      entryShort: g("entryShort"),
      exitShort: g("exitShort"),
    };
    for (const k of ["stopLossPct", "takeProfitPct", "trailingStopPct", "maxBarsInTrade"])
      tState.settings[k] = s[k] || 0;
    tState.settings.exitMatch = s.exitMatch === "any" ? "any" : "all";
  }
  if (!tState.groups) strategyToUi(EXAMPLE_STRATEGIES["EMA cross (9/21)"]);

  function readTester() {
    const groups = {};
    for (const k of ["entryLong", "exitLong", "entryShort", "exitShort"])
      groups[k] = readRules(bottom.querySelector(`[data-g="${k}"]`));
    tState.groups = groups;
    bottom.querySelectorAll("[data-s]").forEach((el) => {
      tState.settings[el.dataset.s] =
        el.type === "number" ? Number(el.value) : el.value;
    });
    return { ...compileRules(groups), ...tState.settings };
  }

  function renderTester() {
    const group = (k, title) =>
      `<h4>${title}</h4><div class="rules" data-g="${k}">${(tState.groups[k] || []).map(ruleHtml).join("")}</div><button class="btn small" data-add="${k}">+ Condition</button>`;
    const num = (k, label, step = "any") =>
      `<label class="field">${label}<input data-s="${k}" type="number" step="${step}" value="${tState.settings[k]}"></label>`;
    const saved = Object.keys(app.state.strategies || {});
    bottom.innerHTML = `<div class="tester"><div class="left">
      <div class="row-flex"><select class="in" id="tPreset"><option value="">Load a strategy…</option><optgroup label="Examples">${Object.keys(
        EXAMPLE_STRATEGIES,
      )
        .map((n) => `<option value="ex:${esc(n)}">${esc(n)}</option>`)
        .join(
          "",
        )}</optgroup>${saved.length ? `<optgroup label="Saved">${saved.map((n) => `<option value="sv:${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` : ""}</select><button class="btn primary" id="tRun">Run on chart</button></div>
      <p class="hint-text">Entry conditions must all be true. Exits can need all of theirs or just one. Leave a section empty to skip it. Signals use the bar's close and fill at the next bar's open.</p>
      ${group("entryLong", "Buy (enter long) when")}${group("exitLong", "Sell (exit long) when")}${group("entryShort", "Enter short when")}${group("exitShort", "Exit short when")}
      <h4>Exits</h4><div class="row-flex"><label class="field">Exit when<select class="in" data-s="exitMatch"><option value="all"${tState.settings.exitMatch === "any" ? "" : " selected"}>all exit conditions are true</option><option value="any"${tState.settings.exitMatch === "any" ? " selected" : ""}>any one exit condition is true</option></select></label>${num("maxBarsInTrade", "Exit after this many bars (0 = off)", 1)}</div>
      <h4>Risk</h4><div class="row-flex">${num("stopLossPct", "Stop loss %")}${num("takeProfitPct", "Take profit %")}${num("trailingStopPct", "Trailing stop %")}</div>
      <h4>Money</h4><div class="row-flex">${num("initialCapital", "Starting capital")}${num("positionPct", "Position size %")}${num("feePct", "Fee % per side")}${num("slippagePct", "Slippage % per side")}${num("spreadPct", "Spread % (bid to ask)")}<button class="btn small" id="tSpread" title="Read the live bid and ask (crypto)">Live spread</button></div>
      <h4>Fills inside a bar</h4><div class="row-flex"><label class="field">Stops and targets<select class="in" data-s="intrabar">${[
        ["worst", "Stop first when a bar touches both (cautious)"],
        ["ohlc", "TradingView's path: open, nearer extreme, far extreme, close"],
        ["magnifier", "Bar magnifier: real lower-timeframe bars inside each bar"],
      ]
        .map(([v, t]) => `<option value="${v}"${tState.settings.intrabar === v ? " selected" : ""}>${t}</option>`)
        .join("")}</select></label></div>
      <div class="row-flex" style="margin-top:12px"><button class="btn" id="tSave">Save strategy</button><button class="btn" id="tJson">Edit as JSON</button></div>
    </div><div class="right" id="tOut"><div class="hint-text">Pick or build a strategy, then press <b>Run on chart</b>. It runs on the active chart's symbol and timeframe.</div></div></div>`;
    for (const k of ["entryLong", "exitLong", "entryShort", "exitShort"])
      bindRules(bottom.querySelector(`[data-g="${k}"]`));
    bottom.querySelectorAll("[data-add]").forEach((b) => {
      b.onclick = () => {
        bottom
          .querySelector(`[data-g="${b.dataset.add}"]`)
          .insertAdjacentHTML("beforeend", ruleHtml(defaultRule()));
      };
    });
    $("#tPreset").onchange = (e) => {
      const v = e.target.value;
      if (!v) return;
      const s = v.startsWith("ex:")
        ? EXAMPLE_STRATEGIES[v.slice(3)]
        : app.state.strategies[v.slice(3)];
      strategyToUi(s);
      tState.name = v.slice(3);
      for (const k of [
        "initialCapital",
        "positionPct",
        "feePct",
        "slippagePct",
        "spreadPct",
        "intrabar",
      ])
        if (s[k] != null) tState.settings[k] = s[k];
      renderTester();
    };
    $("#tRun").onclick = runTester;
    $("#tSpread").onclick = async () => {
      const sym = app.active?.cfg.symbol;
      try {
        const r = await api.get(`/api/spread?symbol=${encodeURIComponent(sym)}`);
        bottom.querySelector('[data-s="spreadPct"]').value = Number(r.spreadPct.toPrecision(2));
        app.toast(`${ticker(r.symbol)} on ${r.source}: bid ${fmtPrice(r.bid)}, ask ${fmtPrice(r.ask)}. Spread set to ${Number(r.spreadPct.toPrecision(2))}%.`);
      } catch (e) {
        app.toast(e.message, "err");
      }
    };
    $("#tSave").onclick = () => {
      const name = prompt("Name this strategy:");
      if (!name) return;
      app.state.strategies = {
        ...(app.state.strategies || {}),
        [name]: readTester(),
      };
      app.persist();
      app.toast(`Saved "${name}".`);
    };
    $("#tJson").onclick = () => {
      const card = app.modal(
        "Strategy JSON",
        `<p class="hint-text">The same format your AI agent can write. Operands: numbers, price fields, indicator keys, or key.output.</p><textarea class="in" id="tJ" rows="22">${esc(JSON.stringify(readTester(), null, 2))}</textarea>`,
        {
          foot: '<button class="btn primary" id="tJOk">Apply</button>',
          wide: true,
        },
      );
      card.querySelector("#tJOk").onclick = () => {
        try {
          const s = JSON.parse(card.querySelector("#tJ").value);
          strategyToUi(s);
          for (const k of [
            "initialCapital",
            "positionPct",
            "feePct",
            "slippagePct",
            "spreadPct",
            "intrabar",
          ])
            if (s[k] != null) tState.settings[k] = s[k];
          app.closeModal();
          renderTester();
        } catch (e) {
          app.toast(`Invalid JSON: ${e.message}`, "err");
        }
      };
    };
    if (lastResult) showResult(lastResult);
  }

  async function runTester() {
    const p = app.active;
    if (p?.course) return app.toast("Kursläget visar officiella resultat. Öppna fliken Day 4 · Kursresultat; Run on chart återskapar inte ATR-stopp och riskstorlek.", "err");
    if (!p?.bars.length)
      return app.toast("The active chart has no data yet.", "err");
    let strat;
    try {
      strat = readTester();
    } catch (e) {
      return app.toast(e.message, "err");
    }
    if (!strat.entryLong.length && !strat.entryShort.length)
      return app.toast("Add at least one entry condition.", "err");
    try {
      const bars = p.replay ? p.bars.slice(0, p.replay.index + 1) : p.bars;
      let subBars = null;
      if (strat.intrabar === "magnifier") {
        const sec = parseTf(p.cfg.tf).seconds;
        const m = magnifierTf(sec, bars.at(-1).time - bars[0].time + sec);
        if (!m) app.toast("This chart is already as fine as the bar magnifier goes, so it uses the OHLC path.");
        else {
          app.toast(`Loading ${m.tf} bars for the bar magnifier…`);
          const span = bars.at(-1).time - bars[0].time + sec;
          const r = await api.candles(p.cfg.symbol, m.tf, Math.ceil(span / m.seconds) + 10);
          subBars = r.candles.filter((c) => c.time >= bars[0].time && c.time < bars.at(-1).time + sec);
        }
      }
      const r = backtest(bars, strat, { subBars });
      lastResult = { ...r, symbol: p.cfg.symbol, tf: p.cfg.tf, bars, strat, subBars };
      p.extraMarkers = r.trades.flatMap((t) => [
        {
          time: t.entryTime,
          position: t.side === "long" ? "belowBar" : "aboveBar",
          shape: t.side === "long" ? "arrowUp" : "arrowDown",
          color: t.side === "long" ? "#2962ff" : "#ff6d00",
          text: t.side === "long" ? "Buy" : "Short",
        },
        {
          time: t.exitTime,
          position: t.side === "long" ? "aboveBar" : "belowBar",
          shape: "circle",
          color: t.pnl >= 0 ? "#089981" : "#f23645",
          text: `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%`,
        },
      ]);
      p.render(false);
      showResult(lastResult);
    } catch (e) {
      app.toast(e.message, "err");
    }
  }

  function showResult(r) {
    const out = $("#tOut");
    if (!out) return;
    const s = r.stats;
    const stat = (k, v, cls = "") =>
      `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v ?? "—"}</div></div>`;
    const pc = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v}%`);
    out.innerHTML = `<div class="row-flex"><b>${esc(ticker(r.symbol))} ${esc(r.tf)}</b><span class="hint-text">${r.bars.length} bars · ${new Date(r.bars[0].time * 1000).toLocaleDateString()} to ${new Date(r.bars.at(-1).time * 1000).toLocaleDateString()} · ${esc(s.feesAndSlippage)} · ${esc(s.fills)}</span><span class="spacer"></span><button class="btn small" id="tCsv">Export trades (CSV)</button><button class="btn small" id="tClear">Clear chart marks</button></div>
      <div class="stats">${stat("Net profit", pc(s.netProfitPct), s.netProfitPct >= 0 ? "up" : "down")}${stat("Buy and hold", pc(s.buyHoldPct), s.buyHoldPct >= 0 ? "up" : "down")}${stat("Max drawdown", s.maxDrawdownPct == null ? "—" : `-${s.maxDrawdownPct}%`, "down")}${stat("Trades", s.totalTrades)}${stat("Win rate", s.winRatePct == null ? "—" : `${s.winRatePct}%`)}${stat("Profit factor", s.profitFactor)}${stat("Sharpe", s.sharpe)}${stat("Sortino", s.sortino)}${stat("Avg trade", pc(s.avgTradePct))}${stat("Time in market", s.exposurePct == null ? "—" : `${s.exposurePct}%`)}</div>
      <div class="equity" id="tEq"></div>
      <div id="tQuant"></div>
      <div id="tPtq"></div>
      <table class="t"><thead><tr><th>Side</th><th>Entry</th><th>Exit</th><th>Entry price</th><th>Exit price</th><th>P&amp;L %</th><th>Bars</th><th class="l">Exit reason</th></tr></thead><tbody>${r.trades
        .slice()
        .reverse()
        .slice(0, 300)
        .map(
          (t) =>
            `<tr data-t="${t.entryTime}"><td>${t.side}</td><td>${new Date(t.entryTime * 1000).toLocaleString()}</td><td>${new Date(t.exitTime * 1000).toLocaleString()}</td><td>${fmtPrice(t.entryPrice)}</td><td>${fmtPrice(t.exitPrice)}</td><td class="${t.pnl >= 0 ? "up" : "down"}">${t.pnlPct.toFixed(2)}%</td><td>${t.bars}</td><td class="l">${esc(t.exitReason)}</td></tr>`,
        )
        .join("")}</tbody></table>`;
    $("#tCsv").onclick = () =>
      download(`${ticker(r.symbol)}-${r.tf}-trades.csv`, tradesCsv(r.trades));
    $("#tClear").onclick = () => {
      app.active.extraMarkers = [];
      app.active.render(false);
    };
    equityChart?.remove();
    const el = $("#tEq");
    equityChart = LW.createChart(el, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: css("--bg") },
        textColor: css("--text"),
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: css("--grid") },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    const eq = equityChart.addSeries(LW.AreaSeries, {
      lineColor: "#2962ff",
      topColor: "rgba(41,98,255,.3)",
      bottomColor: "rgba(41,98,255,0)",
      lineWidth: 2,
      title: "Strategy",
    });
    eq.setData(r.equity.map((e) => ({ time: e.time, value: e.value })));
    const bh = equityChart.addSeries(LW.LineSeries, {
      color: "#787b86",
      lineWidth: 1,
      title: "Buy & hold",
      priceLineVisible: false,
    });
    const c0 = r.bars[0].close;
    bh.setData(
      r.bars.map((b) => ({
        time: b.time,
        value: (r.strat.initialCapital * b.close) / c0,
      })),
    );
    equityChart.timeScale().fitContent();
    mountQuantChecks($("#tQuant"), r);
    mountPtqCheck($("#tPtq"), { strategy: r.strat, symbol: r.symbol, tf: r.tf, name: tState.name || `${ticker(r.symbol)} ${r.tf}` });
  }

  // ======================= SCREENER =======================
  const sc = {
    universe: "crypto",
    rows: [],
    sort: "volume",
    dir: -1,
    filters: {},
    scan: null,
    rule: {
      left: { kind: "ind", id: "rsi", params: { length: 14 }, output: "value" },
      op: "<",
      right: { kind: "value", v: 30 },
    },
    tf: "1D",
  };
  async function loadScreener() {
    $("#scTable").innerHTML = '<div class="pad hint-text">Loading…</div>';
    try {
      sc.rows = await api.get(`/api/screener?universe=${sc.universe}`);
      sc.scan = null;
    } catch (e) {
      sc.rows = [];
      app.toast(e.message, "err");
    }
    drawScreener();
  }
  function filtered() {
    const f = sc.filters;
    const term = (f.q || "").toLowerCase();
    return sc.rows
      .filter(
        (r) =>
          (!term || `${r.ticker} ${r.name}`.toLowerCase().includes(term)) &&
          (f.minPrice == null || r.price >= f.minPrice) &&
          (f.maxPrice == null || r.price <= f.maxPrice) &&
          (f.minChg == null || r.changePct >= f.minChg) &&
          (f.maxChg == null || r.changePct <= f.maxChg) &&
          (f.minVol == null || r.volume >= f.minVol) &&
          (f.minCap == null || (r.marketCap || 0) >= f.minCap) &&
          (!f.sector || r.sector === f.sector) &&
          (!sc.scan || sc.scan[r.symbol]?.pass),
      )
      .sort(
        (a, b) =>
          sc.dir *
          (typeof a[sc.sort] === "string"
            ? a[sc.sort].localeCompare(b[sc.sort])
            : (a[sc.sort] || 0) - (b[sc.sort] || 0)),
      );
  }
  function renderScreener() {
    const sectors = [
      ...new Set(sc.rows.map((r) => r.sector).filter(Boolean)),
    ].sort();
    const n = (k, label, w = 80) =>
      `<label class="field">${label}<input data-f="${k}" type="number" step="any" style="width:${w}px" value="${sc.filters[k] ?? ""}"></label>`;
    bottom.innerHTML = `<div class="pad"><div class="row-flex">
      <label class="field">Market<select id="scU"><option value="crypto">Crypto (USDT pairs)</option><option value="us">US stocks</option><option value="etf">US ETFs</option></select></label>
      <label class="field">Search<input data-f="q" value="${esc(sc.filters.q || "")}" style="width:120px"></label>
      ${n("minPrice", "Price from")}${n("maxPrice", "Price to")}${n("minChg", "Change % from", 70)}${n("maxChg", "Change % to", 70)}${n("minVol", "Min volume", 100)}${sc.universe !== "crypto" ? n("minCap", "Min market cap", 110) : ""}
      ${sectors.length > 1 ? `<label class="field">Sector<select data-f="sector"><option value="">All</option>${sectors.map((s) => `<option ${s === sc.filters.sector ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>` : ""}
      <button class="btn" id="scRefresh" style="align-self:end">Refresh</button></div>
      <div class="row-flex" style="margin-top:8px"><span class="hint-text">Technical filter:</span><div class="rules" id="scRule" style="margin:0">${ruleHtml(sc.rule)}</div><label class="field">On<select id="scTf">${["1h", "4h", "1D", "1W"].map((t) => `<option ${t === sc.tf ? "selected" : ""}>${t}</option>`).join("")}</select></label><button class="btn primary" id="scScan" style="align-self:end">Scan top 100</button>${sc.scan ? '<button class="btn" id="scClear" style="align-self:end">Clear scan</button>' : ""}</div></div>
      <div id="scTable"></div>`;
    $("#scU").value = sc.universe;
    $("#scU").onchange = (e) => {
      sc.universe = e.target.value;
      sc.filters = {};
      renderScreener();
      loadScreener();
    };
    bottom.querySelectorAll("[data-f]").forEach((el) => {
      el.oninput = () => {
        const v = el.value.trim();
        sc.filters[el.dataset.f] =
          v === "" ? null : el.type === "number" ? Number(v) : v;
        drawScreener();
      };
    });
    bindRules($("#scRule"));
    $("#scRule .x")?.remove();
    $("#scRefresh").onclick = loadScreener;
    $("#scClear") &&
      ($("#scClear").onclick = () => {
        sc.scan = null;
        renderScreener();
      });
    $("#scScan").onclick = async () => {
      const [rule] = readRules($("#scRule"));
      sc.rule = rule;
      sc.tf = $("#scTf").value;
      const c = compileRules({ rules: [rule] });
      const prev = sc.scan;
      sc.scan = null;
      const targets = filtered()
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 100)
        .map((r) => r.symbol);
      sc.scan = prev;
      $("#scScan").textContent = `Scanning ${targets.length}…`;
      try {
        const res = await api.post("/api/scan", {
          symbols: targets,
          tf: sc.tf,
          indicators: c.indicators,
          rules: c.rules,
        });
        sc.scan = Object.fromEntries(res.map((x) => [x.symbol, x]));
        const hits = res.filter((x) => x.pass).length;
        app.toast(`${hits} of ${targets.length} match.`);
      } catch (e) {
        app.toast(e.message, "err");
      }
      renderScreener();
    };
    if (!sc.rows.length) loadScreener();
    else drawScreener();
  }
  function drawScreener() {
    const box = $("#scTable");
    if (!box) return;
    const rows = filtered();
    const cols = [
      ["ticker", "Symbol"],
      ["name", "Name"],
      ["price", "Price"],
      ["changePct", "Change %"],
      ["volume", sc.universe === "crypto" ? "Volume (USDT)" : "Volume"],
      ...(sc.universe !== "crypto"
        ? [
            ["marketCap", "Market cap"],
            ["sector", "Sector"],
          ]
        : []),
    ];
    box.innerHTML = `<table class="t"><thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" class="${k === "name" || k === "sector" ? "l" : ""}">${l}${sc.sort === k ? (sc.dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead><tbody>${rows
      .slice(0, 500)
      .map(
        (r) =>
          `<tr data-s="${esc(r.symbol)}"><td><b>${esc(r.ticker)}</b></td><td class="l muted">${esc((r.name || "").slice(0, 40))}</td><td>${fmtPrice(r.price)}</td><td class="${r.changePct >= 0 ? "up" : "down"}">${fmtPct(r.changePct)}</td><td>${fmtNum(r.volume, 0)}</td>${sc.universe !== "crypto" ? `<td>${fmtNum(r.marketCap, 0)}</td><td class="l muted">${esc(r.sector)}</td>` : ""}</tr>`,
      )
      .join(
        "",
      )}</tbody></table><div class="pad hint-text">${rows.length} match${rows.length === 1 ? "" : "es"}${rows.length > 500 ? " (showing 500)" : ""}. Click a row to open its chart.${sc.universe !== "crypto" ? " Live prices for the 200 largest companies; the rest show the last close." : ""}</div>`;
    box.querySelector("thead").onclick = (e) => {
      const k = e.target.closest("th")?.dataset.k;
      if (!k) return;
      sc.dir = sc.sort === k ? -sc.dir : -1;
      sc.sort = k;
      drawScreener();
    };
    box.querySelector("tbody").onclick = (e) => {
      const s = e.target.closest("tr")?.dataset.s;
      if (s) app.setSymbol(s);
    };
  }

  // ======================= HEATMAP =======================
  const hm = { universe: "us", size: "marketCap" };
  async function renderHeatmap() {
    bottom.innerHTML = `<div class="pad row-flex"><label class="field">Market<select id="hmU"><option value="us">US stocks (200 largest)</option><option value="crypto">Crypto (100 most traded)</option></select></label><label class="field">Size by<select id="hmS"><option value="marketCap">Market cap</option><option value="volume">Volume</option></select></label><span class="hint-text" style="align-self:end">Colour = today's change. Click a tile to open its chart.</span></div><div class="heatmap-wrap" style="height:calc(100% - 64px)"><canvas id="hmC"></canvas></div>`;
    $("#hmU").value = hm.universe;
    $("#hmS").value = hm.size;
    $("#hmU").onchange = (e) => {
      hm.universe = e.target.value;
      renderHeatmap();
    };
    $("#hmS").onchange = (e) => {
      hm.size = e.target.value;
      drawHeatmap();
    };
    try {
      const rows = await api.get(`/api/screener?universe=${hm.universe}`);
      hm.rows =
        hm.universe === "us"
          ? rows
              .filter((r) => r.marketCap > 0)
              .sort((a, b) => b.marketCap - a.marketCap)
              .slice(0, 200)
          : rows.sort((a, b) => b.volume - a.volume).slice(0, 100);
      drawHeatmap();
    } catch (e) {
      app.toast(e.message, "err");
    }
  }
  function squarify(items, x, y, w, h) {
    const out = [];
    let rest = items.filter((i) => i.value > 0);
    const total = rest.reduce((a, i) => a + i.value, 0);
    if (!total) return out;
    const scale = (w * h) / total;
    let rx = x,
      ry = y,
      rw = w,
      rh = h;
    while (rest.length) {
      const short = Math.min(rw, rh);
      const row = [];
      let best = Infinity;
      for (const it of rest) {
        const test = [...row, it];
        const s = test.reduce((a, i) => a + i.value * scale, 0);
        const max = Math.max(...test.map((i) => i.value * scale)),
          min = Math.min(...test.map((i) => i.value * scale));
        const worst = Math.max(
          (short * short * max) / (s * s),
          (s * s) / (short * short * min),
        );
        if (worst > best) break;
        best = worst;
        row.push(it);
      }
      const area = row.reduce((a, i) => a + i.value * scale, 0);
      const thick = area / short;
      let off = 0;
      for (const it of row) {
        const len = (it.value * scale) / thick;
        if (rw >= rh) out.push({ ...it, x: rx, y: ry + off, w: thick, h: len });
        else out.push({ ...it, x: rx + off, y: ry, w: len, h: thick });
        off += len;
      }
      if (rw >= rh) {
        rx += thick;
        rw -= thick;
      } else {
        ry += thick;
        rh -= thick;
      }
      rest = rest.slice(row.length);
    }
    return out;
  }
  function drawHeatmap() {
    const c = $("#hmC");
    if (!c || !hm.rows) return;
    const dpr = window.devicePixelRatio || 1,
      W = c.clientWidth,
      H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const cap = hm.universe === "us" ? 3 : 8;
    const color = (ch) => {
      const t = Math.max(-1, Math.min(1, ch / cap));
      const base = [66, 69, 80],
        up = [8, 153, 129],
        dn = [242, 54, 69];
      const tgt = t >= 0 ? up : dn,
        k = Math.abs(t);
      return `rgb(${base.map((b, i) => Math.round(b + (tgt[i] - b) * k)).join(",")})`;
    };
    const val = (r) =>
      Math.max(
        1,
        hm.size === "volume"
          ? r.volume * (hm.universe === "us" ? r.price : 1)
          : r.marketCap || r.volume,
      );
    let tiles = [];
    if (hm.universe === "us") {
      const bySector = {};
      for (const r of hm.rows) (bySector[r.sector || "Other"] ||= []).push(r);
      const groups = Object.entries(bySector)
        .map(([name, rs]) => ({
          name,
          value: rs.reduce((a, r) => a + val(r), 0),
          rs,
        }))
        .sort((a, b) => b.value - a.value);
      for (const g of squarify(groups, 0, 0, W, H)) {
        const inner = squarify(
          g.rs
            .map((r) => ({ ...r, value: val(r) }))
            .sort((a, b) => b.value - a.value),
          g.x + 1,
          g.y + 14,
          g.w - 2,
          g.h - 15,
        );
        tiles.push(...inner);
        ctx.fillStyle = css("--panel");
        ctx.fillRect(g.x, g.y, g.w, g.h);
        ctx.fillStyle = css("--muted");
        ctx.font = "600 10px -apple-system, Segoe UI, sans-serif";
        ctx.textBaseline = "top";
        if (g.w > 50)
          ctx.fillText(
            g.name.toUpperCase().slice(0, Math.floor(g.w / 7)),
            g.x + 4,
            g.y + 2,
          );
      }
    } else
      tiles = squarify(
        hm.rows
          .map((r) => ({ ...r, value: val(r) }))
          .sort((a, b) => b.value - a.value),
        0,
        0,
        W,
        H,
      );
    for (const t of tiles) {
      ctx.fillStyle = color(t.changePct);
      ctx.fillRect(t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1);
      if (t.w > 34 && t.h > 22) {
        const fs = Math.max(10, Math.min(22, Math.sqrt(t.w * t.h) / 5));
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `600 ${fs}px -apple-system, Segoe UI, sans-serif`;
        ctx.fillText(
          t.ticker.replace(/USDT$/, ""),
          t.x + t.w / 2,
          t.y + t.h / 2 - (t.h > 40 ? fs * 0.45 : 0),
        );
        if (t.h > 40) {
          ctx.font = `${fs * 0.75}px -apple-system, Segoe UI, sans-serif`;
          ctx.fillText(
            fmtPct(t.changePct),
            t.x + t.w / 2,
            t.y + t.h / 2 + fs * 0.6,
          );
        }
        ctx.textAlign = "left";
      }
    }
    hm.tiles = tiles;
    let tip = document.querySelector(".tip");
    c.onmousemove = (e) => {
      const r = c.getBoundingClientRect(),
        x = e.clientX - r.left,
        y = e.clientY - r.top;
      const t = tiles.find(
        (q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h,
      );
      if (!t) {
        tip?.remove();
        tip = null;
        return;
      }
      if (!tip) {
        tip = document.createElement("div");
        tip.className = "tip";
        document.body.appendChild(tip);
      }
      tip.innerHTML = `<b>${esc(t.ticker)}</b> ${esc(t.name || "")}<br>${fmtPrice(t.price)} <span class="${t.changePct >= 0 ? "up" : "down"}">${fmtPct(t.changePct)}</span>${t.marketCap ? `<br>Market cap ${fmtNum(t.marketCap)}` : ""}`;
      tip.style.left = `${e.clientX + 14}px`;
      tip.style.top = `${e.clientY + 14}px`;
    };
    c.onmouseleave = () => {
      tip?.remove();
      tip = null;
    };
    c.onclick = (e) => {
      const r = c.getBoundingClientRect(),
        x = e.clientX - r.left,
        y = e.clientY - r.top;
      const t = tiles.find(
        (q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h,
      );
      if (t) app.setSymbol(t.symbol);
    };
  }
  window.addEventListener("resize", () => {
    if (bottomTab === "heatmap") drawHeatmap();
  });

  // ======================= PAPER TRADING =======================
  // While the active chart is in bar replay, paper trading uses a separate practice account that
  // fills at the replayed bar's prices, so replay trades never mix with the live paper account.
  const replayPane = () => (app.active?.replay ? app.active : null);
  const freshAccount = () => ({ initial: 100000, cash: 100000, feePct: 0.05, positions: {}, orders: [], history: [] });
  const paper = () => (replayPane() ? (app.state.replayPaper ||= freshAccount()) : livePaper());
  const livePaper = () =>
    (app.state.paper ||= {
      initial: 100000,
      cash: 100000,
      feePct: 0.05,
      positions: {},
      orders: [],
      history: [],
    });
  const price = (s) => {
    const rp = replayPane();
    if (rp && s === rp.cfg.symbol) return rp.bars[rp.replay.index]?.close;
    return rp ? null : app.prices[s];
  };
  function paperSymbols() {
    const p = app.state.paper;
    return p
      ? [...Object.keys(p.positions), ...p.orders.map((o) => o.symbol)]
      : [];
  }
  function fill(sym, side, qty, px, note = "", acct = null) {
    const p = acct || paper();
    const rp = acct ? null : replayPane();
    const signed = side === "buy" ? qty : -qty;
    const pos = p.positions[sym] || { qty: 0, avg: 0 };
    const fee = Math.abs(qty * px) * (p.feePct / 100);
    let realized = 0;
    if (pos.qty !== 0 && Math.sign(pos.qty) !== Math.sign(signed)) {
      const closing =
        Math.sign(signed) * Math.min(Math.abs(signed), Math.abs(pos.qty));
      realized = -closing * (px - pos.avg);
    }
    const nq = pos.qty + signed;
    if (nq === 0) delete p.positions[sym];
    else if (pos.qty === 0 || Math.sign(nq) !== Math.sign(pos.qty))
      p.positions[sym] = { qty: nq, avg: px };
    else if (Math.sign(signed) === Math.sign(pos.qty))
      p.positions[sym] = {
        qty: nq,
        avg: (pos.qty * pos.avg + signed * px) / nq,
      };
    else p.positions[sym] = { qty: nq, avg: pos.avg };
    p.cash -= signed * px + fee;
    p.history.unshift({
      time: rp ? rp.bars[rp.replay.index].time * 1000 : Date.now(),
      symbol: sym,
      side,
      qty,
      price: px,
      fee,
      realized: realized - fee,
      note,
    });
    p.history = p.history.slice(0, 500);
    app.persist();
    app.toast(
      `Paper ${side} ${fmtNum(qty, 4)} ${ticker(sym)} at ${fmtPrice(px)}`,
    );
  }
  function checkOrders(sym, px) {
    const p = app.state.paper;
    if (!p?.orders.length) return;
    let changed = false;
    for (const o of [...p.orders]) {
      if (o.symbol !== sym) continue;
      const hit =
        o.type === "limit"
          ? o.side === "buy"
            ? px <= o.price
            : px >= o.price
          : o.side === "buy"
            ? px >= o.price
            : px <= o.price;
      if (!hit) continue;
      p.orders = p.orders.filter((x) => x !== o && (!o.oco || x.oco !== o.oco));
      fill(
        sym,
        o.side,
        o.qty,
        o.type === "limit" ? o.price : px,
        o.note || `${o.type} order`,
        p,
      );
      changed = true;
    }
    if (changed && bottomTab === "paper") renderPaper();
  }
  app.priceListeners.add((sym, px) => {
    checkOrders(sym, px);
    if (
      bottomTab === "paper" &&
      !bottomEl.classList.contains("collapsed") &&
      app.state.paper?.positions[sym]
    )
      drawPaperNumbers();
  });
  function equity() {
    const p = paper();
    return (
      p.cash +
      Object.entries(p.positions).reduce(
        (a, [s, pos]) => a + pos.qty * (price(s) ?? pos.avg),
        0,
      )
    );
  }
  function drawPaperNumbers() {
    const p = paper();
    const eq = equity();
    const el = $("#ppEq");
    if (el) {
      el.innerHTML = `<div class="stat"><div class="k">Equity</div><div class="v">${fmtPrice(eq)}</div></div><div class="stat"><div class="k">Cash</div><div class="v">${fmtPrice(p.cash)}</div></div><div class="stat"><div class="k">Total P&amp;L</div><div class="v ${eq >= p.initial ? "up" : "down"}">${fmtPrice(eq - p.initial)} (${fmtPct(((eq - p.initial) / p.initial) * 100)})</div></div>`;
    }
    const pos = $("#ppPos");
    if (pos) {
      pos.innerHTML =
        Object.entries(p.positions)
          .map(([s, x]) => {
            const px = price(s) ?? x.avg,
              pnl = x.qty * (px - x.avg);
            return `<tr data-s="${esc(s)}"><td><b>${esc(ticker(s))}</b></td><td>${x.qty > 0 ? "Long" : "Short"}</td><td>${fmtNum(Math.abs(x.qty), 4)}</td><td>${fmtPrice(x.avg)}</td><td>${fmtPrice(px)}</td><td class="${pnl >= 0 ? "up" : "down"}">${fmtPrice(pnl)} (${fmtPct(((px - x.avg) / x.avg) * 100 * Math.sign(x.qty))})</td><td><button class="btn small" data-close="${esc(s)}">Close</button></td></tr>`;
          })
          .join("") ||
        '<tr><td colspan="7" class="l muted">No open positions.</td></tr>';
    }
  }
  function renderPaper() {
    const p = paper();
    const sym = app.active?.cfg.symbol || "";
    const px = price(sym) ?? app.active?.bars.at(-1)?.close;
    bottom.innerHTML = `<div class="tester"><div class="left">
      <h4 style="margin-top:0">Order ticket · ${esc(ticker(sym))} ${px ? `<span class="muted">${fmtPrice(px)}</span>` : ""}</h4>
      <div class="row-flex"><label class="field">Type<select id="ppType"><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option></select></label><label class="field">Price<input id="ppPrice" type="number" step="any" value="${px ? Number(px.toPrecision(6)) : ""}" style="width:110px"></label><label class="field">Amount ($)<input id="ppAmt" type="number" step="any" value="1000" style="width:100px"></label></div>
      <div class="row-flex" style="margin-top:6px"><label class="field">Stop loss % (optional)<input id="ppSl" type="number" step="any" style="width:90px"></label><label class="field">Take profit % (optional)<input id="ppTp" type="number" step="any" style="width:90px"></label></div>
      <div class="row-flex" style="margin-top:10px"><button class="btn primary" id="ppBuy" style="background:var(--up);border-color:var(--up)">Buy</button><button class="btn primary" id="ppSell" style="background:var(--down);border-color:var(--down)">Sell / short</button></div>
      <h4>Account</h4><div class="row-flex"><label class="field">Starting balance<input id="ppInit" type="number" value="${p.initial}" style="width:110px"></label><label class="field">Fee % per trade<input id="ppFee" type="number" step="any" value="${p.feePct}" style="width:80px"></label><button class="btn danger" id="ppReset" style="align-self:end">Reset account</button></div>
      <p class="hint-text">${replayPane() ? `<b>Replay trading.</b> Orders fill at the replayed bars' prices in a separate practice account. Step or play the replay to fill limit and stop orders. Exit replay to go back to your live paper account.` : "Simulated fills at the live price. No real money, no exchange connection."}</p>
    </div><div class="right"><div class="stats" id="ppEq"></div>
      <h4>Positions</h4><table class="t"><thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg price</th><th>Last</th><th>P&amp;L</th><th></th></tr></thead><tbody id="ppPos"></tbody></table>
      <h4>Working orders</h4><table class="t"><thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Price</th><th>Qty</th><th></th></tr></thead><tbody>${p.orders.map((o) => `<tr><td><b>${esc(ticker(o.symbol))}</b></td><td>${o.side}</td><td>${o.type}${o.oco ? " (bracket)" : ""}</td><td>${fmtPrice(o.price)}</td><td>${fmtNum(o.qty, 4)}</td><td><button class="btn small" data-cancel="${o.id}">Cancel</button></td></tr>`).join("") || '<tr><td colspan="6" class="l muted">None.</td></tr>'}</tbody></table>
      <h4>History</h4><table class="t"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Realised</th></tr></thead><tbody>${p.history
        .slice(0, 100)
        .map(
          (h) =>
            `<tr><td>${new Date(h.time).toLocaleString()}</td><td>${esc(ticker(h.symbol))}</td><td>${h.side}</td><td>${fmtNum(h.qty, 4)}</td><td>${fmtPrice(h.price)}</td><td class="${h.realized >= 0 ? "up" : "down"}">${h.realized ? fmtPrice(h.realized) : ""}</td></tr>`,
        )
        .join("")}</tbody></table>
    </div></div>`;
    drawPaperNumbers();
    const place = async (side) => {
      const type = $("#ppType").value,
        amt = Number($("#ppAmt").value);
      let cur = price(sym) ?? app.active?.bars.at(-1)?.close;
      if (!cur) {
        try {
          cur = (await api.quotes([sym]))[sym]?.price;
        } catch {
          /* none */
        }
      }
      if (!cur || !(amt > 0))
        return app.toast("Need a live price and an amount.", "err");
      const qty = amt / cur;
      const sl = Number($("#ppSl").value),
        tp = Number($("#ppTp").value);
      const entry = type === "market" ? cur : Number($("#ppPrice").value);
      const exitSide = side === "buy" ? "sell" : "buy",
        dir = side === "buy" ? 1 : -1;
      const addBracket = () => {
        const oco = sl > 0 && tp > 0 ? `oco${Date.now()}` : null;
        if (sl > 0)
          paper().orders.push({
            id: `o${Date.now()}s`,
            symbol: sym,
            side: exitSide,
            type: "stop",
            price: entry * (1 - (dir * sl) / 100),
            qty,
            oco,
            note: "stop loss",
          });
        if (tp > 0)
          paper().orders.push({
            id: `o${Date.now()}t`,
            symbol: sym,
            side: exitSide,
            type: "limit",
            price: entry * (1 + (dir * tp) / 100),
            qty,
            oco,
            note: "take profit",
          });
      };
      if (type === "market") {
        fill(sym, side, qty, cur);
        addBracket();
      } else {
        if (!(entry > 0)) return app.toast("Set a price for the order.", "err");
        paper().orders.push({
          id: `o${Date.now()}`,
          symbol: sym,
          side,
          type,
          price: entry,
          qty: amt / entry,
        });
        addBracket();
        app.toast(`${type} ${side} order placed.`);
      }
      app.persist();
      renderPaper();
      refreshQuotes();
    };
    $("#ppBuy").onclick = () => place("buy");
    $("#ppSell").onclick = () => place("sell");
    $("#ppReset").onclick = () => {
      if (
        !confirm(
          "Reset the paper account? Positions, orders and history are cleared.",
        )
      )
        return;
      app.state[replayPane() ? "replayPaper" : "paper"] = {
        initial: Number($("#ppInit").value) || 100000,
        cash: Number($("#ppInit").value) || 100000,
        feePct: Number($("#ppFee").value) || 0,
        positions: {},
        orders: [],
        history: [],
      };
      app.persist();
      renderPaper();
    };
    $("#ppFee").onchange = (e) => {
      paper().feePct = Number(e.target.value) || 0;
      app.persist();
    };
    bottom.onclick = (e) => {
      const close = e.target.closest("[data-close]")?.dataset.close;
      if (close) {
        const pos = paper().positions[close];
        const px2 = price(close) ?? pos.avg;
        fill(
          close,
          pos.qty > 0 ? "sell" : "buy",
          Math.abs(pos.qty),
          px2,
          "closed",
        );
        paper().orders = paper().orders.filter((o) => o.symbol !== close);
        app.persist();
        renderPaper();
      }
      const cancel = e.target.closest("[data-cancel]")?.dataset.cancel;
      if (cancel) {
        paper().orders = paper().orders.filter((o) => o.id !== cancel);
        app.persist();
        renderPaper();
      }
    };
  }

  // ======================= INDICATOR EDITOR =======================
  const TEMPLATE = `export default {
  name: 'EMA ribbon squeeze',
  overlay: true, // true = drawn on the price chart, false = its own pane
  inputs: [
    { key: 'fast', label: 'Fast EMA', type: 'int', default: 8 },
    { key: 'slow', label: 'Slow EMA', type: 'int', default: 34 },
  ],
  outputs: [
    { key: 'fast', label: 'Fast', kind: 'line', color: '#26a69a' },
    { key: 'slow', label: 'Slow', kind: 'line', color: '#ef5350' },
  ],
  // bars: [{ time, open, high, low, close, volume }], p: your inputs,
  // ta: sma, ema, rma, wma, hma, rsi, atr, stdev, highest, lowest, crossover, crossunder, source, compute(...)
  calc(bars, p, ta) {
    const close = ta.source(bars, 'close');
    const fast = ta.ema(close, p.fast), slow = ta.ema(close, p.slow);
    const up = ta.crossover(fast, slow);
    return {
      fast,
      slow,
      markers: bars.filter((b, i) => up[i]).map((b) => ({ time: b.time, position: 'belowBar', shape: 'arrowUp', color: '#26a69a', text: 'Cross' })),
    };
  },
};
`;
  let edFile = null;
  const edListHtml = (list) =>
    list.map((c) => `<div class="card" data-file="${esc(c.file)}"><div class="top"><span>${esc(c.file)}</span><span class="row-flex"><button class="btn small" data-act="open">Edit</button><button class="btn small" data-act="add">Add to chart</button><button class="btn small danger" data-act="del">Delete</button></span></div>${c.error ? `<div class="sub down">${esc(c.error)}</div>` : ""}</div>`).join("") || '<p class="hint-text">None yet.</p>';
  async function renderEditor() {
    let list = [];
    try {
      list = await api.get("/api/custom");
    } catch {
      /* none */
    }
    bottom.innerHTML = `<div class="tester"><div class="left"><div class="row-flex"><button class="btn primary" id="edNew">New indicator</button></div>
      <h4>Your indicators</h4><div id="edList">${edListHtml(list)}</div>
      <p class="hint-text">Each indicator is a small JavaScript file in the app's <code>custom</code> folder. You can also ask your AI agent: "add an indicator to Quant Terminal that…" and it will write the file for you.</p></div>
      <div class="right"><div class="row-flex"><input class="in" id="edName" placeholder="Indicator name" style="flex:1"><button class="btn" id="edSave">Save</button><button class="btn primary" id="edSaveAdd">Save and add to chart</button></div><textarea class="in" id="edCode" spellcheck="false" style="flex:1;min-height:220px"></textarea><div id="edErr" class="down"></div></div></div>`;
    const code = $("#edCode");
    code.value = TEMPLATE;
    $("#edName").value = "EMA ribbon squeeze";
    code.onkeydown = (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      const s = code.selectionStart;
      code.setRangeText("  ", s, code.selectionEnd, "end");
    };
    $("#edNew").onclick = () => {
      edFile = null;
      code.value = TEMPLATE.replace("'EMA ribbon squeeze'", "'My indicator'");
      $("#edName").value = "My indicator";
    };
    const save = async (add) => {
      $("#edErr").textContent = "";
      const name = $("#edName").value.trim() || "indicator";
      let src = code.value;
      try {
        const r = await api.post("/api/custom", { name, code: src });
        const def = await app.importCustom(r.file);
        if (!def)
          throw new Error(
            "Saved, but the browser could not load it. Check the code.",
          );
        app.toast(`Saved ${r.file}`);
        if (add) app.active.addIndicator(def.id);
        else app.panes.forEach((p) => p.render(false));
        edFile = r.file;
        renderEditorList();
      } catch (e) {
        $("#edErr").textContent = e.message;
      }
    };
    $("#edSave").onclick = () => save(false);
    $("#edSaveAdd").onclick = () => save(true);
    $("#edList").onclick = async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const file = btn.closest("[data-file]").dataset.file;
      if (btn.dataset.act === "open") {
        code.value = await (
          await fetch(`/custom/${encodeURIComponent(file)}?v=${Date.now()}`)
        ).text();
        $("#edName").value = file.replace(/\.js$/, "").replace(/-/g, " ");
        edFile = file;
      }
      if (btn.dataset.act === "add") {
        const def = await app.importCustom(file);
        if (def) app.active.addIndicator(def.id);
      }
      if (btn.dataset.act === "del" && confirm(`Delete ${file}?`)) {
        await api.del(`/api/custom/${encodeURIComponent(file)}`);
        renderEditor();
      }
    };
  }
  const renderEditorList = async () => {
    const box = $("#edList");
    if (box) box.innerHTML = edListHtml(await api.get("/api/custom").catch(() => []));
  };

  // Limit and stop orders in the replay account fill when a replayed bar's range reaches them.
  function checkReplayOrders(pane, bar) {
    const p = app.state.replayPaper;
    if (!p?.orders.length) return;
    for (const o of [...p.orders]) {
      if (o.symbol !== pane.cfg.symbol) continue;
      let px = null;
      if (o.type === "limit" && o.side === "buy" && bar.low <= o.price) px = Math.min(o.price, bar.open);
      if (o.type === "limit" && o.side === "sell" && bar.high >= o.price) px = Math.max(o.price, bar.open);
      if (o.type === "stop" && o.side === "buy" && bar.high >= o.price) px = Math.max(o.price, bar.open);
      if (o.type === "stop" && o.side === "sell" && bar.low <= o.price) px = Math.min(o.price, bar.open);
      if (px == null) continue;
      p.orders = p.orders.filter((x) => x !== o && (!o.oco || x.oco !== o.oco));
      fill(o.symbol, o.side, o.qty, px, o.note || `${o.type} order`);
    }
  }
  let paperRenderAt = 0;
  P.onReplayBar = (pane, bar) => {
    if (pane !== app.active || !bar) return;
    checkReplayOrders(pane, bar);
    if (bottomTab === "paper" && !bottomEl.classList.contains("collapsed") && Date.now() - paperRenderAt > 250) { paperRenderAt = Date.now(); renderPaper(); }
  };
  P.onReplayChange = () => {
    if (bottomTab === "paper" && !bottomEl.classList.contains("collapsed")) renderPaper();
  };

  // ---------- hooks for the app ----------
  P.showBottom = showBottom;
  P.openAlertDialog = openAlertDialog;
  let lastSymbol = null;
  P.onActiveChange = () => {
    if (sideTab === "watchlist") drawRows();
    const sym = app.active?.cfg.symbol;
    if (sym !== lastSymbol) {
      lastSymbol = sym;
      if (sideTab === "news") renderNews(side, app);
      if (!bottomEl.classList.contains("collapsed") && bottomTab === "seasonals") renderSeasonals(bottom, app);
      if (!bottomEl.classList.contains("collapsed") && bottomTab === "financials") renderFinancials(bottom, app);
    }
    if (bottomTab === "paper" && !bottomEl.classList.contains("collapsed"))
      renderPaper();
  };
  P.onAlertFired = () => {
    if (sideTab === "alerts") renderAlerts();
  };
  P.onTheme = () => {
    renderBottom();
  };
  showSide("watchlist");
  return P;
}
