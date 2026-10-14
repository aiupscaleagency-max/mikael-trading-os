// Visa kursmotorns resultat utan att köra terminalens andra testmotor.
import { api, esc } from "./api.js";
export async function renderCourse(container, app) {
  container.innerHTML = '<p class="hint-text">Läser verifierat Day 4-resultat…</p>';
  try {
    const course = await api.get("/api/ptqa/course");
    if (!container.isConnected || !document.querySelector('[data-tab="course"].active')) return;
    const m = course.metrics;
    container.innerHTML = `<div style="padding:16px"><h3>${esc(course.name)} · officiellt Day 4</h3>
      <p>${esc(course.source)} · ${esc(course.period.start)}–${esc(course.period.end)} · ${course.bars.length} candles</p>
      <button class="btn primary" id="loadCourseChart">Visa kursstrategin på diagrammet</button>
      <p><b>Kursmotorns resultat gäller.</b> Vanliga ”Run on chart” använder en annan motor och återskapar inte detta ATR-stopp och riskbaserade storlek.</p>
      <table><tbody>${[["Netto efter kostnader", `${m.netReturnPct}%`], ["Stängda trades",m.trades], ["Största drawdown",`${m.maxDrawdownPct}%`], ["Köp och behåll",`${course.context.buyAndHoldPct}%`], ["Kostnad per sida",`${course.costs} bps`]].map(([label,value]) => `<tr><th>${esc(label)}</th><td>${esc(String(value))}</td></tr>`).join("")}</tbody></table>
      <p>${esc(course.strategy.entry)}<br>${esc(course.strategy.exit)}<br>Stopp: ${esc(course.strategy.stop)}. Storlek: ${esc(course.strategy.sizing)}.</p>
      <p class="hint-text">Pilarna visar kursmotorns faktiska historiska köp/sälj. EMA12, EMA21 och SMA50 visas med kursens beräkning. Öppen slutposition får ingen säljsignal. Historik bevisar inte framtida vinst.</p>
      <details><summary>Resultatets identitet och varningar</summary><p>Spec: ${esc(course.identity.specSha256)}<br>Bars: ${esc(course.identity.barsSha256)}</p>${course.warnings.map(w=>`<p>${esc(w)}</p>`).join("")}</details>
      <p id="courseChartStatus" role="status"></p></div>`;
    container.querySelector("#loadCourseChart").onclick = () => {
      try {
        app.active.loadCourse(course);
        container.querySelector("#courseChartStatus").textContent = "Kursdiagrammet visar exakt Tiingo-underlag och officiella trades. Liveuppdatering är avstängd för denna vy.";
      } catch { container.querySelector("#courseChartStatus").textContent = "Kursdiagrammet kunde inte öppnas."; }
    };
  } catch { container.innerHTML = '<p class="hint-text">Kursresultatet är inte tillgängligt eller kunde inte verifieras.</p>'; }
}
