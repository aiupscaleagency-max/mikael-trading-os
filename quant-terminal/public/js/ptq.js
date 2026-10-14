// PTQ connector UI: "Check with PTQ" under the strategy tester, and the PTQ tab.
// The terminal only reads from PTQ and can only make it do less (stop, disarm).
// Arming a strategy to trade happens in PTQ itself, on the command line.
import { api, esc, fmtPrice, fmtNum, ticker } from "./api.js";

const $ = (s, el = document) => el.querySelector(s);
let cached = null,
  cachedAt = 0;

export async function ptqStatus(force = false) {
  if (!force && cached && Date.now() - cachedAt < 15000) return cached;
  try {
    cached = await api.get("/api/ptq/status");
  } catch (e) {
    cached = { connected: false, reason: e.message };
  }
  cachedAt = Date.now();
  return cached;
}

const VERDICT = {
  approve: ["up", "Passed PTQ's checks"],
  reduce: ["warn", "Passed with warnings"],
  block: ["down", "Didn't pass PTQ's checks"],
};

const MARK = `<span class="ptq-logo"><span class="ptq-logo-mark"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 12 L7 6 L10 9 L13 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>PTQ</span>`;

function ptqHead(status = "") {
  return `<div class="ptq-top">${MARK}<span class="ptq-eyebrow">Part-Time Quant</span>${status ? `<span class="ptq-status">${status}</span>` : ""}</div>`;
}

function notConnected(st, tried = false) {
  return `<div class="ptq-box ptq-brand ptq-split">
    <div class="ptq-col">
      ${ptqHead()}
      <h3 class="ptq-title">Trade it <em>for real.</em></h3>
      <p class="ptq-lead">The quant checks run on your computer. PTQ takes the same rules further and trades the ones that pass through your own exchange or broker account.</p>
      <div class="ptq-actions">
        <div class="ptq-action"><a class="btn ptq" href="${esc(st.site)}" target="_blank" rel="noopener">Trade on PTQ &#8599;</a><span>New to PTQ? Start here.</span></div>
        <div class="ptq-action"><button class="btn ptq-outline" data-ptq-retry>I already have PTQ</button><span>${tried ? "Not found. Open PTQ on this computer, then try again." : "Connect your PTQ account to this tool."}</span></div>
      </div>
    </div>
    <ol class="ptq-steps">
      <li><span>01</span><div><b>Test it here</b><p>Backtest and quant checks in this app.</p></div></li>
      <li><span>02</span><div><b>PTQ re-tests it</b><p>On its own engine and price data, to see if the result was luck.</p></div></li>
      <li><span>03</span><div><b>You arm it</b><p>A strategy that passes trades through your own account, with limits you set.</p></div></li>
    </ol>
  </div>`;
}

// Mounts the "Check with PTQ" box. ctx = { strategy, symbol, tf, name }
export async function mountPtqCheck(el, ctx, tried = false) {
  const st = await ptqStatus();
  if (!st.connected) {
    el.innerHTML = notConnected(st, tried);
    el.querySelector("[data-ptq-retry]").onclick = async () => {
      await ptqStatus(true);
      mountPtqCheck(el, ctx, true);
    };
    return;
  }
  el.innerHTML = `<div class="ptq-box ptq-brand">
    ${ptqHead(`<i></i>PTQ ${esc(st.version || "")} connected${st.licensed ? "" : " · no licence found on this computer"}`)}
    <h3 class="ptq-title">Trade it <em>for real.</em></h3>
    <p class="ptq-lead">Send these rules to your PTQ: it re-tests them on ${esc(ticker(ctx.symbol))} ${esc(ctx.tf)} with its own engine, and a strategy that passes can trade through your own account once you arm it.</p>
    <div class="ptq-actions"><button class="btn ptq" data-ptq-check>Check with PTQ</button></div>
    <div data-ptq-out></div>
  </div>`;
  el.querySelector("[data-ptq-check]").onclick = async (e) => {
    const btn = e.currentTarget,
      out = el.querySelector("[data-ptq-out]");
    btn.disabled = true;
    btn.textContent = "PTQ is testing…";
    out.innerHTML =
      '<p class="hint-text">This can take up to a minute the first time PTQ loads the price history.</p>';
    try {
      const r = await api.post("/api/ptq/check", ctx);
      out.innerHTML = resultHtml(r);
      out.querySelector("[data-copy]")?.addEventListener("click", (ev) => {
        navigator.clipboard
          ?.writeText(ev.currentTarget.dataset.copy)
          .then(() => {
            ev.currentTarget.textContent = "Copied";
          });
      });
    } catch (err) {
      out.innerHTML = `<p class="down">${esc(err.message)}</p>`;
    }
    btn.disabled = false;
    btn.textContent = "Check again";
  };
}

function resultHtml(r) {
  const v = r.validation;
  const [cls, label] = VERDICT[v?.verdict] || ["", "No verdict"];
  const m = r.metrics || {};
  const metric = (k, val) =>
    `<div class="stat"><div class="k">${k}</div><div class="v">${val ?? "—"}</div></div>`;
  const pct = (x) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x}%`);
  let html = "";
  if (r.provenance !== "real-engine")
    html +=
      "<p class=\"down\">PTQ's engine wasn't running, so PTQ returned a simulated preview. This is not a real test: start the engine in PTQ and check again.</p>";
  html += `<div class="ptq-verdict ${cls}">${esc(label)}</div>`;
  if (v?.gates?.length) {
    html += `<table class="t"><tbody>${v.gates.map((g) => `<tr><td class="l">${esc(g.label)}</td><td class="l muted">${esc(g.value)}</td><td class="${g.pass ? "up" : "down"}">${g.pass ? "Pass" : "Fail"}</td></tr>`).join("")}</tbody></table>`;
  } else if (r.validationError) {
    html += `<p class="down">${esc(r.validationError)}</p>`;
  }
  html += `<div class="stats" style="margin-top:8px">${metric("PTQ net return", pct(m.netReturnPct))}${metric("PTQ Sharpe", m.sharpe)}${metric("PTQ max drawdown", m.maxDrawdownPct == null ? "—" : `-${m.maxDrawdownPct}%`)}${metric("PTQ trades", m.trades)}</div>`;
  html += `<p class="hint-text">PTQ tested ${esc(r.instrument)} on ${esc(r.timeframe)} with its own costs and fills, so its numbers won't match this tester's exactly.</p>`;
  for (const n of r.notes || []) html += `<p class="hint-text">${esc(n)}</p>`;
  html += `<p>Saved in your PTQ as <b>${esc(r.strategyName)}</b>. <a class="link" href="${esc(r.links.strategy)}" target="_blank" rel="noopener">Open it in PTQ</a></p>`;
  if (v?.verdict === "block") {
    html +=
      '<p class="hint-text">PTQ wouldn\'t trade this as it stands. Change the rules and check again.</p>';
  } else if (v) {
    const cmd = `ptq arm-strategy ${r.strategyId} --max-notional 100`;
    html += `<div class="ptq-arm"><b>Let PTQ trade it on your exchange</b>
      <ol>
        <li>Connect your exchange in PTQ: <a class="link" href="${esc(r.links.integrations)}" target="_blank" rel="noopener">Integrations</a>. Your keys stay in PTQ.</li>
        <li>In a terminal, run <code>${esc(cmd)}</code> <button class="btn small" data-copy="${esc(cmd)}">Copy</button><br><span class="hint-text">PTQ shows what you're agreeing to and asks you to add <code>--yes</code>. It asks you to confirm each trade unless you also add <code>--unattended</code>. <code>--max-notional</code> caps each order's size.</span></li>
        <li>Watch it in the PTQ tab below, or on PTQ's <a class="link" href="${esc(r.links.autopilot)}" target="_blank" rel="noopener">Autopilot</a> page.</li>
      </ol>
      <p class="hint-text">Live trading in PTQ is new: start small. Past results don't predict future ones.</p></div>`;
  }
  return html;
}

// ---------- PTQ tab ----------
let tabTimer = null;
export async function renderPtqTab(el, app, tried = false) {
  clearTimeout(tabTimer);
  const st = await ptqStatus(true);
  if (!st.connected) {
    el.innerHTML = `<div class="pad ptq-tab">${notConnected(st, tried)}</div>`;
    el.querySelector("[data-ptq-retry]").onclick = () => renderPtqTab(el, app, true);
    return;
  }
  let o;
  try {
    o = await api.get("/api/ptq/overview");
  } catch (e) {
    el.innerHTML = `<div class="pad down">${esc(e.message)}</div>`;
    return;
  }
  const ks = o.killSwitch || {},
    pf = o.portfolio || {},
    auto = o.autopilot || {};
  const arms = Array.isArray(o.arms) ? o.arms : [];
  const journal = Array.isArray(o.journal) ? o.journal : [];
  const errLine = (x) =>
    x?.error ? `<p class="down">${esc(x.error)}</p>` : "";
  const when = (t) => (t ? new Date(t).toLocaleString() : "—");
  el.innerHTML = `<div class="tester ptq-brand ptq-tab"><div class="left">
      <div class="row-flex">${MARK}<span class="ptq-status"><i></i>${esc(st.version || "")} connected · ${esc(st.url)}${st.licensed ? "" : " · no licence on this computer"}</span><span class="spacer"></span><button class="btn small ptq-ghost" data-refresh>Refresh</button><a class="btn small ptq" href="${esc(o.links.app)}" target="_blank" rel="noopener">Open PTQ</a></div>
      <h4>Trading</h4>
      ${
        ks.engaged
          ? "<p class=\"down\"><b>Stopped.</b> PTQ's stop is on, so it places no new orders. Release it in PTQ when you're ready.</p>"
          : `<p>${auto.running ? "PTQ's autopilot is running" : "PTQ's autopilot is paused"}${auto.unattendedLiveEnabled === false ? " (unattended live is switched off)" : ""}.</p><button class="btn danger" data-kill>Stop all PTQ trading</button><p class="hint-text">Stops new orders straight away. Open positions stay as they are; close them in PTQ or on your exchange.</p>`
      }
      ${errLine(ks)}
      <h4>Account</h4>
      ${
        pf.connected
          ? `<div class="stats">${[
              ["Equity", fmtPrice(pf.equity)],
              ["Cash", fmtPrice(pf.cash)],
              ["Today", pf.dayPnlUsd == null ? "—" : fmtPrice(pf.dayPnlUsd)],
              [
                "Exposure",
                pf.grossExposurePct == null ? "—" : `${pf.grossExposurePct}%`,
              ],
            ]
              .map(
                ([k, v]) =>
                  `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`,
              )
              .join(
                "",
              )}</div><p class="hint-text">From ${esc(pf.source || "your broker")}.</p>`
          : `<p class="hint-text">${esc(pf.message || "No exchange connected in PTQ yet.")} <a class="link" href="${esc(o.links.integrations)}" target="_blank" rel="noopener">Connect one in PTQ</a></p>`
      }
      ${errLine(pf)}
    </div><div class="right">
      <h4 style="margin-top:0">Positions</h4>
      <table class="t"><thead><tr><th>Market</th><th>Qty</th><th>Entry</th><th>Value</th><th>P&amp;L</th></tr></thead><tbody>${(pf.positions || []).map((p) => `<tr><td><b>${esc(p.instrument || p.symbol || "")}</b></td><td>${fmtNum(p.qty, 4)}</td><td>${fmtPrice(p.avgPrice ?? p.entry ?? p.avgEntryPrice)}</td><td>${fmtPrice(p.marketValue ?? p.value)}</td><td class="${(p.unrealizedPnl ?? p.pnl ?? 0) >= 0 ? "up" : "down"}">${fmtPrice(p.unrealizedPnl ?? p.pnl)}</td></tr>`).join("") || '<tr><td colspan="5" class="l muted">No open positions.</td></tr>'}</tbody></table>
      <h4>Armed strategies</h4>
      <table class="t"><thead><tr><th>Strategy</th><th>Markets</th><th>Max per order</th><th>Confirm trades</th><th>Expires</th><th></th></tr></thead><tbody>${arms.map((a) => `<tr><td><b>${esc(a.strategyName || a.strategyId)}</b>${a.halted ? ` <span class="down">halted${a.haltedReason ? `: ${esc(a.haltedReason)}` : ""}</span>` : ""}</td><td>${esc((a.scope?.symbols || []).join(", "))}</td><td>${fmtNum(a.scope?.maxNotional, 2)}</td><td>${a.requirePerTradeConfirm ? "Yes" : "No (unattended)"}</td><td>${when(a.scope?.expiresAt)}</td><td>${a.armed ? `<button class="btn small danger" data-disarm="${esc(a.strategyId)}">Disarm</button>` : '<span class="muted">disarmed</span>'}</td></tr>`).join("") || '<tr><td colspan="6" class="l muted">Nothing armed. Run "Check with PTQ" in the Strategy tester tab to send a strategy over.</td></tr>'}</tbody></table>
      ${errLine(o.arms)}
      <h4>Recent PTQ orders</h4>
      <table class="t"><thead><tr><th>Time</th><th>Market</th><th>Side</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead><tbody>${
        journal
          .slice(0, 25)
          .map(
            (j) =>
              `<tr><td>${when(j.ts)}</td><td>${esc(j.instrument || "")}</td><td>${esc(j.direction || "")}</td><td>${fmtNum(j.filledQty ?? j.qty, 4)}</td><td>${fmtPrice(j.fillPrice ?? j.limitPrice)}</td><td class="${j.status === "rejected" ? "down" : ""}">${esc(j.status || "")}${j.simulated ? " (simulated)" : j.live ? " (live)" : ""}</td></tr>`,
          )
          .join("") ||
        '<tr><td colspan="6" class="l muted">No orders yet.</td></tr>'
      }</tbody></table>
    </div></div>`;
  el.querySelector("[data-refresh]").onclick = () => renderPtqTab(el, app);
  el.querySelector("[data-kill]")?.addEventListener("click", async () => {
    if (
      !confirm(
        "Stop all PTQ trading now? PTQ places no new orders until you release the stop in PTQ.",
      )
    )
      return;
    try {
      await api.post("/api/ptq/kill-switch", {});
      app.toast("PTQ stopped. No new orders.");
    } catch (e) {
      app.toast(e.message, "err");
    }
    renderPtqTab(el, app);
  });
  el.querySelectorAll("[data-disarm]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Disarm this strategy? PTQ stops trading it.")) return;
      try {
        await api.post(
          `/api/ptq/arms/${encodeURIComponent(b.dataset.disarm)}/disarm`,
          {},
        );
        app.toast("Disarmed.");
      } catch (e) {
        app.toast(e.message, "err");
      }
      renderPtqTab(el, app);
    }),
  );
  tabTimer = setTimeout(() => {
    if (el.isConnected && el.querySelector("[data-refresh]"))
      renderPtqTab(el, app);
  }, 15000);
}
