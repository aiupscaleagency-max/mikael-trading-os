// En ny körmapp per start hindrar kopierade scheman, AUTO och tidsstyrda exits från att återställas.
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
process.chdir(root);
const data = await fs.mkdtemp(path.join(root, ".ptqa-runs", "run-"));
process.env.TRADING_DATA_DIR = data;
process.env.DASHBOARD_PORT = "3941";
process.env.PTQA_COPY_LOCAL_ONLY = "1";
// Kopians lokala start får inte skriva över originalets Telegram-webhook.
process.env.PUBLIC_URL = "";
// Kursknapparna får aldrig använda originalets arbetsmapp eller Python-miljö.
process.env.PTQA_COURSE_WORKSPACE = path.join(root, "private-course/day4-closed-work");
process.env.PTQA_COURSE_HOME = path.join(root, "private-course/academy-home");
process.env.PTQ_ACADEMY_HOME = process.env.PTQA_COURSE_HOME;
process.env.PTQA_COURSE_PYTHON = path.join(root, "private-course/venv/bin/python");
process.env.MODE = "paper";
process.env.EXECUTION_MODE = "approve";
process.env.LIVE_TRADING_CONFIRMED = "false";
process.env.IG_ORDER_EXECUTION_ENABLED_LIVE = "false";
process.env.IG_ORDER_EXECUTION_ENABLED_DEMO = "false";
await fs.writeFile(path.join(data, "state.json"), JSON.stringify({ killSwitchActive: true, dailyRealizedPnlUsdt: 0, dailyPnlResetAt: Date.now(), openPositions: {} }));
await fs.writeFile(path.join(data, "execution-mode.json"), JSON.stringify({ executionMode: "approve" }));
// Endast bevakningslistor ärvs; inga kontosessioner, strategier eller väntande ordrar.
for (const env of ["demo", "live"]) {
  try { await fs.copyFile(path.join(root, "data", `ig-watchlist-${env}.json`), path.join(data, `ig-watchlist-${env}.json`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
process.argv = [process.argv[0]!, path.join(root, "src/run.ts"), "--serve"];
try { await import("../src/run.js"); }
catch { console.error("Kurskopian kunde inte starta. Kontrollera lokal konfiguration."); process.exitCode = 1; }
