// The gold "Bonus: quant checks" box under a strategy tester result.
import { esc, fmtPct } from "./api.js";
import { quantChecks } from "../lib/quant.js";

export function mountQuantChecks(el, result) {
  el.innerHTML = `<div class="gold-box">
    <div class="gold-head"><span class="gold-badge">Bonus</span><b>Quant checks</b></div>
    <p class="hint-text">The checks quant desks run before they trust a backtest: walk-forward, overfitting (PBO), deflated Sharpe, cost stress, nearby settings, and a Monte Carlo of these trades. It re-runs this strategy about 25 times with nearby settings, here on your computer.</p>
    <div class="row-flex"><button class="btn gold" data-run>Run quant checks</button></div>
    <div data-out></div>
  </div>`;
  el.querySelector("[data-run]").onclick = (e) => {
    const btn = e.currentTarget,
      out = el.querySelector("[data-out]");
    btn.disabled = true;
    btn.textContent = "Checking…";
    setTimeout(() => {
      try {
        out.innerHTML = render(quantChecks(result.bars, result.strat, { subBars: result.subBars }));
      } catch (err) {
        out.innerHTML = `<p class="down">${esc(err.message)}</p>`;
      }
      btn.disabled = false;
      btn.textContent = "Run again";
    }, 30);
  };
}

function render(q) {
  const total = q.gates.length;
  const cls =
    q.passed === total ? "up" : q.passed >= total / 2 ? "warn" : "down";
  const verdict =
    q.passed === total
      ? "It holds up on every check here. Paper trade it next before any real money."
      : q.passed === 0
        ? "It failed every check. The backtest result is most likely luck or tuned to the past."
        : "Some checks failed. Part of this result may be luck or tuned to the past.";
  let html = `<div class="ptq-verdict ${cls}">Passed ${q.passed} of ${total} checks</div><p>${verdict}</p>`;
  html += `<table class="t"><tbody>${q.gates.map((g) => `<tr><td class="l"><b>${esc(g.label)}</b></td><td class="l muted">${esc(g.value)}</td><td class="${g.pass ? "up" : "down"}">${g.pass ? "Pass" : "Fail"}</td></tr>`).join("")}</tbody></table>`;

  if (q.walkForward) {
    const wf = q.walkForward;
    const day = (t) =>
      t
        ? new Date(t * 1000).toLocaleDateString(undefined, {
            month: "short",
            year: "numeric",
          })
        : "";
    html += `<h4>Walk-forward</h4><p class="hint-text">For each stretch, the settings that had done best up to then, then how they did on the stretch itself. ${wf.positiveFolds} of ${wf.folds.length} stretches made money.</p>
      <table class="t"><thead><tr><th class="l">Stretch</th><th>Settings picked</th><th>Return</th><th>Sharpe</th></tr></thead><tbody>${wf.folds.map((f) => `<tr><td class="l">${day(f.from)} to ${day(f.to)}</td><td>${f.chosen.join(" / ") || "as set"}</td><td class="${f.testReturnPct >= 0 ? "up" : "down"}">${fmtPct(f.testReturnPct)}</td><td>${f.testSharpe.toFixed(2)}</td></tr>`).join("")}</tbody></table>`;
  }

  if (q.tunables.length === 2) {
    const [a, b] = q.tunables;
    const cell = (v) =>
      q.variants.find((x) => x.values[0] === v[0] && x.values[1] === v[1]);
    html += `<h4>Nearby settings</h4><p class="hint-text">Net return for each pair of settings. A real edge is a broad patch of green, not one lucky square. Outlined: yours.</p>
      <table class="t heat"><thead><tr><th class="l">${esc(a.label)} \\ ${esc(b.label)}</th>${b.values.map((v) => `<th>${v}</th>`).join("")}</tr></thead><tbody>${a.values
        .map(
          (va) =>
            `<tr><td class="l"><b>${va}</b></td>${b.values
              .map((vb) => {
                const v = cell([va, vb]);
                const n = v?.netPct ?? 0,
                  k = Math.min(1, Math.abs(n) / 100);
                const bg =
                  n >= 0
                    ? `rgba(8,153,129,${0.12 + 0.55 * k})`
                    : `rgba(242,54,69,${0.12 + 0.55 * k})`;
                return `<td style="background:${bg}" class="${v?.isBase ? "base" : ""}">${fmtPct(n)}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("")}</tbody></table>`;
  } else if (q.tunables.length === 1) {
    const [a] = q.tunables;
    html += `<h4>Nearby settings</h4><table class="t"><thead><tr><th class="l">${esc(a.label)}</th>${q.variants.map((v) => `<th>${v.values[0]}${v.isBase ? " (yours)" : ""}</th>`).join("")}</tr></thead><tbody><tr><td class="l">Net return</td>${q.variants.map((v) => `<td class="${v.netPct >= 0 ? "up" : "down"}">${fmtPct(v.netPct)}</td>`).join("")}</tr></tbody></table>`;
  }

  const mc = q.monteCarlo;
  if (mc) {
    html += `<h4>Monte Carlo</h4><p>Reshuffling these ${q.base.trades} trades ${mc.runs.toLocaleString()} times: the worst 5% of runs ended at ${fmtPct(mc.p5)}, the middle at ${fmtPct(mc.p50)}, the best 5% at ${fmtPct(mc.p95)}. The usual worst drop was ${mc.ddP50.toFixed(1)}%, and 1 run in 20 fell ${mc.ddP95.toFixed(1)}% or more. ${mc.lossProb.toFixed(0)}% of runs ended down.</p>`;
  }
  html += `<p class="hint-text">Probabilistic Sharpe ${q.psr == null ? "n/a" : q.psr.toFixed(3)}; the best Sharpe ${q.trials} random versions would be expected to show is ${q.sr0.toFixed(2)}. These checks use past prices only: passing them doesn't mean a strategy will make money.</p>`;
  return html;
}
