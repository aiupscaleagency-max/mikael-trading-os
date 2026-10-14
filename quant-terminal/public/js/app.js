import { api, download, esc, ticker, exchange } from "./api.js";
import { ChartPane, CHART_TYPES, newUid } from "./chart.js";
import { TOOLS } from "./drawings.js";
import {
  INDICATORS,
  BY_ID,
  registerIndicator,
  compute,
} from "../lib/indicators.js";
import { parseTf, toCsv } from "../lib/series.js";
import { initPanels } from "./panels.js";

const $ = (s, el = document) => el.querySelector(s);
const TF_QUICK = ["1m", "5m", "15m", "1h", "4h", "1D", "1W"];
const LAYOUTS = { 1: 1, "2v": 2, "2h": 2, 3: 3, 4: 4, 6: 6, 8: 8, 16: 16 };
const DEFAULT_WATCHLISTS = {
  Main: [
    "BINANCE:BTCUSDT",
    "BINANCE:ETHUSDT",
    "BINANCE:SOLUSDT",
    "US:AAPL",
    "US:NVDA",
    "US:SPY",
    "US:QQQ",
    "FX:EURUSD",
  ],
};

class App {
  constructor() {
    this.panes = [];
    this.active = null;
    this.tool = "cursor";
    this.prices = {};
    this.priceListeners = new Set();
    this.saveTimer = null;
  }

  async init() {
    let state = {};
    try {
      state = await api.get("/api/state");
    } catch {
      /* first run */
    }
    this.state = {
      layout: "1",
      panes: [
        {
          symbol: "BINANCE:BTCUSDT",
          tf: "1D",
          type: "candles",
          indicators: [
            { uid: newUid(), id: "ema", params: { length: 21 } },
            { uid: newUid(), id: "rsi", params: {} },
          ],
        },
      ],
      watchlists: DEFAULT_WATCHLISTS,
      activeWatchlist: "Main",
      drawings: {},
      settings: {},
      paper: null,
      strategies: {},
      ...state,
    };
    this.settings = {
      theme: "dark",
      volume: true,
      bars: 3000,
      utc: false,
      stayInDrawMode: false,
      syncCrosshair: false,
      ...this.state.settings,
    };
    this.state.settings = this.settings;
    document.documentElement.dataset.theme = this.settings.theme;
    await this.loadCustomIndicators();
    this.buildToolbar();
    this.buildDrawbar();
    this.setLayout(this.state.layout, false);
    this.panels = initPanels(this);
    this.bindKeys();
    this.showRibbon();
    this.listenAlerts();
    this.checkHealth();
    setInterval(() => this.checkHealth(), 60000);
  }

  // ---------- persistence ----------
  persist() {
    this.state.panes = this.panes.map((p) => p.cfg);
    this.state.active = this.panes.indexOf(this.active);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(
      () =>
        api
          .put("/api/state", this.state)
          .catch((e) => this.toast(`Couldn't save: ${e.message}`, "err")),
      400,
    );
  }
  getDrawings(symbol) {
    return structuredClone(this.state.drawings[symbol] || []);
  }
  saveDrawings(symbol, items) {
    this.state.drawings[symbol] = items.map(
      ({ id, type, points, text, color, rr }) => ({
        id,
        type,
        points,
        text,
        color,
        rr,
      }),
    );
    for (const p of this.panes)
      if (p.cfg.symbol === symbol && p.drawings.items !== items)
        p.drawings.setItems(this.getDrawings(symbol));
    this.persist();
  }

  // ---------- custom indicators ----------
  async loadCustomIndicators() {
    try {
      const list = await api.get("/api/custom");
      for (const c of list) await this.importCustom(c.file, c.mtime);
    } catch {
      /* none */
    }
  }
  async importCustom(file, v = Date.now()) {
    try {
      const mod = await import(`/custom/${encodeURIComponent(file)}?v=${v}`);
      return registerIndicator({
        ...mod.default,
        id: `custom:${file.replace(/\.js$/, "")}`,
      });
    } catch (e) {
      this.toast(
        `Custom indicator ${file} failed to load: ${e.message}`,
        "err",
      );
      return null;
    }
  }

  // ---------- layout ----------
  setLayout(layout, save = true) {
    const count = LAYOUTS[layout] || 1;
    this.state.layout = String(layout);
    const grid = $("#grid");
    grid.dataset.count = count;
    const cols = {
      1: "1fr",
      2: layout === "2h" ? "1fr" : "1fr 1fr",
      3: "2fr 1fr",
      4: "1fr 1fr",
      6: "1fr 1fr 1fr",
      8: "1fr 1fr 1fr 1fr",
      16: "repeat(4, 1fr)",
    }[count];
    const rows = {
      1: "1fr",
      2: layout === "2h" ? "1fr 1fr" : "1fr",
      3: "1fr 1fr",
      4: "1fr 1fr",
      6: "1fr 1fr",
      8: "1fr 1fr",
      16: "repeat(4, 1fr)",
    }[count];
    grid.style.gridTemplateColumns = cols;
    grid.style.gridTemplateRows = rows;
    const cfgs = this.panes.length
      ? this.panes.map((p) => p.cfg)
      : this.state.panes;
    while (this.panes.length > count) this.panes.pop().destroy();
    const tfs = ["1D", "4h", "1h", "15m", "1W", "5m", "30m", "2h"];
    for (let i = 0; i < count; i++) {
      if (this.panes[i]) continue;
      const el = document.createElement("div");
      el.className = "pane";
      grid.appendChild(el);
      const base = cfgs[i] || {
        ...structuredClone(cfgs[0] || {}),
        tf: tfs[i % tfs.length],
        indicators: [],
      };
      const pane = new ChartPane(this, el, base);
      this.panes.push(pane);
      pane.load();
    }
    [...grid.children].forEach((el) => {
      if (!this.panes.some((p) => p.el === el)) el.remove();
    });
    if (count === 3) this.panes[0].el.style.gridRow = "span 2";
    else if (this.panes[0]) this.panes[0].el.style.gridRow = "";
    this.setActive(
      this.panes[Math.min(this.state.active ?? 0, count - 1)] || this.panes[0],
    );
    $("#layoutSel").value = this.state.layout;
    if (save) this.persist();
  }

  setActive(pane) {
    if (!pane || this.active === pane) return;
    this.active?.el.classList.remove("active");
    this.active = pane;
    pane.el.classList.add("active");
    this.syncToolbar();
    this.panels?.onActiveChange?.();
  }

  onPaneLoaded(pane) {
    if (pane === this.active) {
      this.syncToolbar();
      this.panels?.onActiveChange?.();
    }
  }

  // ---------- toolbar ----------
  buildToolbar() {
    const tfBox = $("#tfButtons");
    tfBox.innerHTML = TF_QUICK.map(
      (t) => `<button data-tf="${t}">${t}</button>`,
    ).join("");
    tfBox.onclick = (e) => {
      const tf = e.target.dataset.tf;
      if (tf) this.setTf(tf);
    };
    $("#tfCustom").onkeydown = (e) => {
      if (e.key !== "Enter") return;
      const v = e.target.value
        .trim()
        .replace(/^(\d+)d$/i, "$1D")
        .replace(/^(\d+)w$/i, "$1W");
      try {
        parseTf(v);
        this.setTf(v);
        e.target.value = "";
        e.target.blur();
      } catch (err) {
        this.toast(err.message, "err");
      }
    };
    $("#chartType").innerHTML = CHART_TYPES.map(
      ([v, l]) => `<option value="${v}">${l}</option>`,
    ).join("");
    $("#chartType").onchange = (e) => {
      this.active.cfg.type = e.target.value;
      this.active.render(true);
      this.persist();
    };
    $("#symbolBtn").onclick = () => this.openSymbolSearch();
    $("#indicatorsBtn").onclick = () => this.openIndicatorPicker();
    $("#compareBtn").onclick = () =>
      this.openSymbolSearch(
        "",
        (sym) => {
          this.active.cfg.compare.push(sym);
          this.persist();
          this.active.load({ keepView: true });
        },
        "Compare with…",
      );
    $("#layoutSel").onchange = (e) => this.setLayout(e.target.value);
    $("#syncSymbol").checked = !!this.settings.syncSymbol;
    $("#syncSymbol").onchange = (e) => {
      this.settings.syncSymbol = e.target.checked;
      this.persist();
    };
    $("#replayBtn").onclick = () => {
      if (this.active.replay) return this.active.stopReplay();
      this.setTool("replay-pick");
      this.toast("Click the bar you want replay to start from.");
    };
    $("#alertBtn").onclick = () => this.panels.openAlertDialog();
    $("#logBtn").onclick = () => {
      this.active.cfg.log = !this.active.cfg.log;
      this.active.render(false);
      this.syncToolbar();
      this.persist();
    };
    $("#snapBtn").onclick = () =>
      this.active
        .screenshot()
        .toBlob((b) =>
          download(
            `${ticker(this.active.cfg.symbol)}-${this.active.cfg.tf}.png`,
            b,
          ),
        );
    $("#csvBtn").onclick = () => this.exportCsv();
    $("#themeBtn").onclick = () => {
      this.settings.theme = this.settings.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = this.settings.theme;
      this.panes.forEach((p) => p.applyTheme());
      this.panels.onTheme?.();
      this.persist();
    };
    $("#settingsBtn").onclick = () => this.openSettings();
  }

  syncToolbar() {
    const p = this.active;
    if (!p) return;
    $("#symbolLabel").textContent = ticker(p.cfg.symbol);
    $("#symbolBtn").title =
      `${p.cfg.symbol} — change symbol (or just start typing)`;
    document
      .querySelectorAll("#tfButtons button")
      .forEach((b) => b.classList.toggle("active", b.dataset.tf === p.cfg.tf));
    $("#tfCustom").placeholder = TF_QUICK.includes(p.cfg.tf) ? "7m" : p.cfg.tf;
    $("#tfCustom").classList.toggle("on", !TF_QUICK.includes(p.cfg.tf));
    $("#chartType").value = p.cfg.type;
    $("#logBtn").classList.toggle("on", !!p.cfg.log);
    $("#replayBtn").classList.toggle("on", !!p.replay);
  }

  setTf(tf) {
    this.active.cfg.tf = tf;
    this.active.load();
    this.syncToolbar();
    this.persist();
  }

  setSymbol(sym, pane = this.active) {
    const targets = this.settings.syncSymbol ? this.panes : [pane];
    for (const p of targets) {
      p.cfg.symbol = sym;
      p.cfg.compare = p.cfg.compare.filter((s) => s !== sym);
      p.load();
    }
    this.syncToolbar();
    this.persist();
  }

  buildDrawbar() {
    const bar = $("#drawbar");
    bar.innerHTML =
      TOOLS.map(
        (t, i) =>
          `${i === 1 ? "<hr>" : ""}<button data-tool="${t.id}" title="${t.label}"><svg viewBox="0 0 24 24">${t.icon}</svg></button>`,
      ).join("") +
      '<hr><button data-act="alert" title="Alert when price crosses the selected line"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20h4"/></svg></button>' +
      '<button data-act="delete" title="Delete selected drawing (Delete key)"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' +
      '<button data-act="clear" title="Remove all drawings on this symbol"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19"/></svg></button>';
    bar.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.tool)
        this.setTool(this.tool === b.dataset.tool ? "cursor" : b.dataset.tool);
      if (b.dataset.act === "alert") this.alertOnSelectedDrawing();
      if (b.dataset.act === "delete" && !this.active.deleteSelectedDrawing())
        this.toast("Click a drawing first to select it.");
      if (
        b.dataset.act === "clear" &&
        confirm(`Remove every drawing on ${ticker(this.active.cfg.symbol)}?`)
      )
        this.active.clearDrawings();
    };
    this.setTool("cursor");
  }

  setTool(tool) {
    this.tool = tool;
    document
      .querySelectorAll("#drawbar [data-tool]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    for (const p of this.panes) p.setInteractive(tool === "cursor");
    document.body.style.cursor = tool === "cursor" ? "" : "crosshair";
  }

  // ---------- modals ----------
  modal(title, bodyHtml, { foot = "", wide = false } = {}) {
    const card = $("#modalCard");
    card.style.width = wide ? "min(780px, 96vw)" : "";
    card.innerHTML = `<div class="modal-head"><span>${esc(title)}</span><button data-close title="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div class="modal-body">${bodyHtml}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}`;
    $("#modal").classList.remove("hidden");
    card.querySelector("[data-close]").onclick = () => this.closeModal();
    $("#modal").onmousedown = (e) => {
      if (e.target.id === "modal") this.closeModal();
    };
    return card;
  }
  closeModal() {
    $("#modal").classList.add("hidden");
    $("#modalCard").innerHTML = "";
  }

  openSymbolSearch(initial = "", onPick = null, title = "Symbol search") {
    const card = this.modal(
      title,
      `<input class="search-in" id="symQ" placeholder="BTC, AAPL, EURUSD, ^FTSE, VOD.L…" autocomplete="off" value="${esc(initial)}"><div class="list" id="symList"></div><div class="hint-text" style="margin-top:8px">Crypto: Binance (falls back to Coinbase and Kraken). US stocks and ETFs: Nasdaq. Forex: Kraken. Global indices, futures and non-US stocks use Yahoo symbols (YAHOO:^FTSE, YAHOO:GC=F) when Yahoo is reachable.</div>`,
    );
    const q = card.querySelector("#symQ"),
      list = card.querySelector("#symList");
    let sel = 0,
      results = [],
      timer;
    const pick = (sym) => {
      this.closeModal();
      if (onPick) onPick(sym);
      else this.setSymbol(sym);
    };
    const draw = () => {
      list.innerHTML =
        results
          .map(
            (r, i) =>
              `<div class="item ${i === sel ? "sel" : ""}" data-i="${i}"><span><b>${esc(ticker(r.symbol))}</b> <span class="muted">${esc(r.name || "")}</span></span><span class="meta">${esc(r.type || "")} · ${esc(r.exchange || "")}</span></div>`,
          )
          .join("") ||
        (q.value.trim()
          ? `<div class="item" data-raw="1"><span>Open <b>${esc(q.value.trim().toUpperCase())}</b></span><span class="meta">press Enter</span></div>`
          : "");
    };
    const run = async () => {
      const v = q.value.trim();
      if (!v) {
        results = [];
        draw();
        return;
      }
      try {
        results = await api.search(v);
      } catch {
        results = [];
      }
      if (q.value.trim() === v) {
        sel = 0;
        draw();
      }
    };
    q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(run, 180);
    };
    q.onkeydown = (e) => {
      if (e.key === "ArrowDown") {
        sel = Math.min(sel + 1, results.length - 1);
        draw();
        e.preventDefault();
      }
      if (e.key === "ArrowUp") {
        sel = Math.max(sel - 1, 0);
        draw();
        e.preventDefault();
      }
      if (e.key === "Enter") pick(results[sel]?.symbol || q.value.trim());
    };
    list.onclick = (e) => {
      const it = e.target.closest(".item");
      if (!it) return;
      pick(
        it.dataset.raw ? q.value.trim() : results[Number(it.dataset.i)].symbol,
      );
    };
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
    if (initial) run();
  }

  openIndicatorPicker() {
    const card = this.modal(
      "Indicators",
      `<input class="search-in" id="indQ" placeholder="Search ${INDICATORS.length} indicators…" autocomplete="off"><div class="list" id="indList"></div>`,
      {
        foot: '<span class="hint-text" style="margin-right:auto">No limit per chart. Write your own in the Indicator editor tab.</span><button class="btn" data-new>New custom indicator</button>',
      },
    );
    const q = card.querySelector("#indQ"),
      list = card.querySelector("#indList");
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const groups = {};
      for (const d of INDICATORS) {
        if (
          term &&
          !`${d.name} ${d.id} ${d.group}`.toLowerCase().includes(term)
        )
          continue;
        (groups[d.group || "Other"] ||= []).push(d);
      }
      list.innerHTML = Object.entries(groups)
        .sort(([g1], [g2]) => (g2 === "Quant (bonus)") - (g1 === "Quant (bonus)"))
        .map(
          ([g, ds]) =>
            `<div class="group ${g === "Quant (bonus)" ? "gold-text" : ""}">${esc(g)}</div>${ds.map((d) => `<div class="item" data-id="${esc(d.id)}"><span>${esc(d.name)}</span><span class="meta">${d.overlay ? "on price" : "own pane"}</span></div>`).join("")}`,
        )
        .join("");
    };
    q.oninput = draw;
    list.onclick = (e) => {
      const it = e.target.closest("[data-id]");
      if (!it) return;
      const uid = this.active.addIndicator(it.dataset.id);
      const anchor = (BY_ID[it.dataset.id].inputs || []).find((i) => i.type === "time");
      if (anchor) {
        this.closeModal();
        this.pickAnchor(this.active, uid, anchor.key);
      } else this.toast(`Added ${BY_ID[it.dataset.id].name}`);
    };
    card.querySelector("[data-new]").onclick = () => {
      this.closeModal();
      this.panels.showBottom("editor");
    };
    draw();
    q.focus();
  }

  /** Wait for a click on the chart and anchor indicator `uid` there (Anchored VWAP). Escape keeps the current anchor. */
  pickAnchor(pane, uid, key) {
    this.pendingAnchor = { pane, uid, key };
    this.setTool("anchor-pick");
    this.toast("Click the bar to anchor it to.");
  }

  openIndicatorSettings(pane, ind) {
    const def = BY_ID[ind.id];
    const fields = (def.inputs || [])
      .map((i) => {
        const v = ind.params?.[i.key] ?? i.default;
        if (i.type === "source") {
          // Indicators on indicators: any output of another indicator on this chart can be the source.
          const others = pane.cfg.indicators
            .filter((x) => x.uid !== ind.uid && !String(x.params?.source || "").includes(ind.uid) && BY_ID[x.id]?.outputs.length)
            .flatMap((x) => BY_ID[x.id].outputs.map((o) => [`ind:${x.uid}:${o.key}`, `${(/\(([^)]+)\)$/.exec(BY_ID[x.id].name)?.[1].split(" / ")[0] || BY_ID[x.id].name)} ${pane.indicatorParamsLabel(x)}: ${o.label}`]));
          const price = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"].map((s) => `<option ${s === v ? "selected" : ""}>${s}</option>`).join("");
          const inds = others.map(([val, label]) => `<option value="${esc(val)}" ${val === v ? "selected" : ""}>${esc(label)}</option>`).join("");
          return `<label class="field">${esc(i.label)}<select data-k="${i.key}"><optgroup label="Price">${price}</optgroup>${inds ? `<optgroup label="Another indicator">${inds}</optgroup>` : ""}</select></label>`;
        }
        if (i.type === "select")
          return `<label class="field">${esc(i.label)}<select data-k="${i.key}">${i.options.map((s) => `<option ${s === v ? "selected" : ""}>${s}</option>`).join("")}</select></label>`;
        if (i.type === "time") {
          const local = v ? new Date((v - new Date(v * 1000).getTimezoneOffset() * 60) * 1000).toISOString().slice(0, 16) : "";
          return `<label class="field">${esc(i.label)}<input data-k="${i.key}" data-type="time" type="datetime-local" value="${local}"><button class="btn small" type="button" data-pick="${i.key}">Pick on chart</button></label>`;
        }
        return `<label class="field">${esc(i.label)}<input data-k="${i.key}" data-type="${i.type}" type="number" step="${i.type === "int" ? 1 : "any"}" value="${v}"></label>`;
      })
      .join("");
    const colors = def.outputs
      .map(
        (o) =>
          `<label class="field">${esc(o.label)}<input data-c="${o.key}" type="color" value="${(ind.colors?.[o.key] || o.color).slice(0, 7)}"></label>`,
      )
      .join("");
    const card = this.modal(
      def.name,
      `<div class="form-grid">${fields || '<span class="hint-text">No inputs.</span>'}<label class="field">Timeframe<select data-tf>${["", "5m", "15m", "1h", "4h", "1D", "1W", "1M"].map((t) => `<option value="${t}" ${(ind.tf || "") === t ? "selected" : ""}>${t || `Same as chart (${pane.cfg.tf})`}</option>`).join("")}</select></label></div><p class="hint-text">A higher timeframe shows its value once each of its bars has closed, so history never peeks ahead.</p>${colors ? `<h4>Colours</h4><div class="form-grid">${colors}</div>` : ""}`,
      {
        foot: '<button class="btn" data-reset>Defaults</button><button class="btn primary" data-ok>Apply</button>',
      },
    );
    card.querySelector("[data-ok]").onclick = () => {
      ind.params = {};
      card.querySelectorAll("[data-k]").forEach((el) => {
        ind.params[el.dataset.k] =
          el.dataset.type === "time"
            ? el.value
              ? Math.floor(new Date(el.value).getTime() / 1000)
              : 0
            : el.dataset.type
              ? Number(el.value)
              : el.value;
      });
      ind.colors = {};
      card.querySelectorAll("[data-c]").forEach((el) => {
        ind.colors[el.dataset.c] = el.value;
      });
      ind.tf = card.querySelector("[data-tf]").value || undefined;
      this.closeModal();
      pane.render(false);
      this.persist();
    };
    card.querySelectorAll("[data-pick]").forEach((b) => {
      b.onclick = () => {
        this.closeModal();
        this.pickAnchor(pane, ind.uid, b.dataset.pick);
      };
    });
    card.querySelector("[data-reset]").onclick = () => {
      ind.params = {};
      ind.colors = {};
      this.closeModal();
      pane.render(false);
      this.persist();
    };
  }

  openSettings() {
    const s = this.settings;
    const card = this.modal(
      "Settings",
      `<div class="form-grid">
      <label class="field">Bars to load per chart<input id="sBars" type="number" min="200" max="20000" step="100" value="${s.bars}"></label>
      <label class="field">Time axis<select id="sUtc"><option value="0" ${!s.utc ? "selected" : ""}>My local time</option><option value="1" ${s.utc ? "selected" : ""}>UTC</option></select></label>
      <label class="field">Volume on the price chart<select id="sVol"><option value="1" ${s.volume ? "selected" : ""}>Show</option><option value="0" ${!s.volume ? "selected" : ""}>Hide</option></select></label>
      <label class="field">After placing a drawing<select id="sStay"><option value="0" ${!s.stayInDrawMode ? "selected" : ""}>Back to cursor</option><option value="1" ${s.stayInDrawMode ? "selected" : ""}>Keep the tool</option></select></label>
      <label class="field">Crosshair across charts<select id="sSync"><option value="0" ${!s.syncCrosshair ? "selected" : ""}>Independent</option><option value="1" ${s.syncCrosshair ? "selected" : ""}>Synced</option></select></label>
    </div><p class="hint-text">Everything you save lives in the <code>data</code> folder next to the app, on your machine.</p>`,
      { foot: '<button class="btn primary" data-ok>Save</button>' },
    );
    card.querySelector("[data-ok]").onclick = () => {
      Object.assign(s, {
        bars: Math.max(200, Math.min(20000, Number($("#sBars").value) || 3000)),
        utc: $("#sUtc").value === "1",
        volume: $("#sVol").value === "1",
        stayInDrawMode: $("#sStay").value === "1",
        syncCrosshair: $("#sSync").value === "1",
      });
      this.closeModal();
      this.persist();
      this.panes.forEach((p) => p.load({ keepView: true }));
    };
  }

  syncCrosshair(src, p) {
    const utc = src.timeOfLogical(p.logical);
    for (const pane of this.panes) {
      if (pane === src || !pane.shown.length) continue;
      const l = pane.logicalOf(utc);
      const i = Math.max(0, Math.min(pane.shown.length - 1, Math.round(l)));
      const b = pane.shown[i];
      if (b) pane.chart.setCrosshairPosition(b.close, pane.times[i], pane.main);
    }
  }

  exportCsv() {
    const p = this.active;
    const extra = {};
    for (const ind of p.cfg.indicators) {
      const def = BY_ID[ind.id];
      const res = p.indResults[ind.uid] || {};
      for (const o of def?.outputs || [])
        if (Array.isArray(res[o.key])) extra[`${ind.id}_${o.key}`] = res[o.key];
    }
    download(`${ticker(p.cfg.symbol)}-${p.cfg.tf}.csv`, toCsv(p.shown, extra));
  }

  // ---------- keys ----------
  bindKeys() {
    document.addEventListener("keydown", (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(
        document.activeElement?.tagName,
      );
      if (e.key === "Escape") {
        if (!$("#modal").classList.contains("hidden")) return this.closeModal();
        if (this.tool !== "cursor") return this.setTool("cursor");
        if (this.active?.drawings.selected) {
          this.active.drawings.selected = null;
          this.active.drawings.update();
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        this.active?.deleteSelectedDrawing()
      ) {
        e.preventDefault();
        return;
      }
      if (!$("#modal").classList.contains("hidden")) return;
      if (/^[a-z0-9^]$/i.test(e.key)) {
        e.preventDefault();
        this.openSymbolSearch(e.key.toUpperCase());
      }
    });
  }

  // A drawn line as an alert condition: trend lines and rays are checked at the line's price on
  // each bar, on the server, so they fire with this tab closed.
  lineOperandFor(d) {
    const [a, b] = d.points;
    const line = (extend, label) => ({ kind: "line", label, line: { t1: a.time, p1: a.price, t2: b.time, p2: b.price, extend } });
    switch (d.type) {
      case "hline": return { kind: "value", v: Number(a.price.toPrecision(8)) };
      case "hray": return { kind: "line", label: "Horizontal ray", line: { t1: a.time, p1: a.price, t2: a.time + 1, p2: a.price, extend: "right" } };
      case "trend": return line("none", "Trend line (between its two points)");
      case "ray": return line("right", "Ray");
      case "extended": return line("both", "Extended line");
      case "channel": return line("none", "Channel's first line");
      default: return null;
    }
  }

  alertOnSelectedDrawing() {
    const d = this.active?.drawings.selected;
    if (!d) return this.toast("Click a line on the chart first to select it.");
    const right = this.lineOperandFor(d);
    if (!right) return this.toast("Alerts work on trend lines, rays, extended and horizontal lines.");
    this.panels.openAlertDialog({ rules: [{ left: { kind: "price", field: "close" }, op: "crosses", right }] });
  }

  // ---------- replay across charts ----------
  syncReplayFrom(pane, bar) {
    if (!bar) return;
    const end = bar.time + parseTf(pane.cfg.tf).seconds;
    for (const p of this.panes) if (p !== pane && p.bars.length && !(p.replay && !p.replay.follower)) p.replayTo(end);
  }
  onReplayStart(pane) {
    if (this.settings.syncReplay && !pane.replay?.follower) this.syncReplayFrom(pane, pane.bars[pane.replay.index]);
    this.syncToolbar();
    this.panels?.onReplayChange?.();
  }
  onReplayBar(pane, bar) {
    if (this.settings.syncReplay && !pane.replay?.follower) this.syncReplayFrom(pane, bar);
    this.panels?.onReplayBar?.(pane, bar);
  }
  onReplayStop(pane) {
    for (const p of this.panes) if (p !== pane && p.replay?.follower) p.stopReplay();
    this.syncToolbar();
    this.panels?.onReplayChange?.();
  }

  // The Academy ribbon: hidden for a week after it's closed.
  showRibbon() {
    const el = $("#ribbon");
    let hiddenUntil = 0;
    try { hiddenUntil = Number(localStorage.getItem("qt-ribbon-hidden-until")) || 0; } catch { /* storage off */ }
    if (Date.now() < hiddenUntil) return;
    el.classList.remove("hidden");
    document.body.classList.add("has-ribbon");
    el.querySelector(".ribbon-x").onclick = () => {
      el.classList.add("hidden");
      document.body.classList.remove("has-ribbon");
      try { localStorage.setItem("qt-ribbon-hidden-until", String(Date.now() + 7 * 86400e3)); } catch { /* storage off */ }
    };
  }

  // ---------- prices, alerts, status ----------
  onPrice(symbol, price) {
    this.prices[symbol] = price;
    for (const fn of this.priceListeners) fn(symbol, price);
  }

  listenAlerts() {
    const es = new EventSource("/api/events");
    es.addEventListener("alert", (m) => {
      const e = JSON.parse(m.data);
      this.toast(`<b>Alert</b><br>${esc(e.text)}`, "alert", 12000);
      this.beep();
      if ("Notification" in window && Notification.permission === "granted")
        new Notification("Quant Terminal alert", { body: e.text });
      this.panels?.onAlertFired?.(e);
    });
  }

  beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.08;
      o.start();
      o.stop(ctx.currentTime + 0.25);
    } catch {
      /* no audio */
    }
  }

  async checkHealth() {
    try {
      const h = await api.get("/api/health");
      const failing = Object.entries(h.providers || {})
        .filter(([, v]) => !v.ok)
        .map(([k]) => k);
      this.setStatus(
        failing.length ? "warn" : "ok",
        failing.length
          ? `Some sources are failing (${failing.join(", ")}); fallbacks are in use.`
          : "All data sources responding",
      );
    } catch {
      this.setStatus(
        "bad",
        "The local server is not responding. Is it still running?",
      );
    }
  }
  setStatus(level, title) {
    const el = $("#status");
    el.className = `status ${level}`;
    if (title) el.title = title;
  }

  toast(html, kind = "", ms = 3500) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = html;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
}

const app = new App();
window.app = app;
app.init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="toast err" style="position:fixed;left:20px;bottom:20px">Startup failed: ${esc(e.message)}</div>`,
  );
});
