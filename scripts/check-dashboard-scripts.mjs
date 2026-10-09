// Parsar varje inline <script> i dashboard.html med new Function (syntaxkontroll, kör inget).
import fs from "node:fs";
const file = process.argv[2] || new URL("../dashboard.html", import.meta.url);
const html = fs.readFileSync(file, "utf8");
const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
let m, n = 0, bad = 0;
while ((m = re.exec(html))) {
  const attrs = m[1] || "";
  if (/\bsrc=/.test(attrs) || /type=["'](?!text\/javascript|module)/.test(attrs)) continue;
  n++;
  try { new Function(m[2]); } catch (e) { bad++; const line = html.slice(0, m.index).split("\n").length; console.error(`Skript ${n} (rad ${line}): ${e.message}`); }
}
console.log(`${n} inline-skript, ${bad} fel`);
process.exit(bad ? 1 : 0);
