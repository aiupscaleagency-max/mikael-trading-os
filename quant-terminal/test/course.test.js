// Säkerställ att kursvisningen bara läser betrodda, stängda historiska data.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadCourse } from "../lib/course.js";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quant-course-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "closed"); fs.mkdirSync(dir);
  const name = "tiingo-btcusd-1d-closed-20261013.csv";
  const csv = "date,open,high,low,close,volume\n2026-10-13T00:00:00+00:00,10,12,9,11,100\n";
  fs.writeFileSync(path.join(dir, name), csv);
  const save = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  save("strategy.json", { unresolved: [], instrument: { csv_path: path.join(dir, name) } });
  save("data-provenance.json", { cutoff_utc: "2026-10-14T00:00:00Z", closed_csv_sha256: crypto.createHash("sha256").update(csv).digest("hex") });
  save("backtest-result.json", { result_version: 1, specName: "Kurstest", data: { symbol: "btcusd", bar: "1d", bars: 1 }, trades: [{ entryIndex: 0, exitIndex: null, entryPrice: 10 }], strategy: {}, metrics: {}, context: {}, inputIdentity: {}, warnings: [] });
  const provenanceFile = path.join(dir, "data-provenance.json");
  const provenance = JSON.parse(fs.readFileSync(provenanceFile));
  provenance.result_file_sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "backtest-result.json"))).digest("hex");
  provenance.spec_file_sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "strategy.json"))).digest("hex");
  save("data-provenance.json", provenance);
  return { root, dir, save, name };
}
test("kursfilen visar officiella bars och ger ingen exit för öppen position", t => {
  const f = fixture(t); const result = loadCourse(f.dir, f.root);
  assert.equal(result.bars.length, 1); assert.equal(result.trades[0].exitTime, null);
  assert.equal(JSON.stringify(result).includes(f.dir), false);
});
test("kursläget kräver explicit aktivering och betrodd katalog", t => {
  const f = fixture(t);
  assert.throws(() => loadCourse(undefined, f.root));
  assert.throws(() => loadCourse(f.root, f.dir));
});
test("ändrade candles och ofullständiga resultat avvisas", t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.dir, f.name), "2026-10-14T00:00:00Z,10,12,9,11,100\n");
  assert.throws(() => loadCourse(f.dir, f.root), /kontrollsumma/);
  fs.writeFileSync(path.join(f.dir, ".day4-incomplete"), "blocked");
  assert.throws(() => loadCourse(f.dir, f.root), /ofullständigt/);
});
test("candle vars UTC-dygn inte stängt avvisas", t => {
  const f = fixture(t);
  const csv = "date,open,high,low,close,volume\n2026-10-14T00:00:00Z,10,12,9,11,100\n";
  fs.writeFileSync(path.join(f.dir, f.name), csv);
  f.save("data-provenance.json", { ...JSON.parse(fs.readFileSync(path.join(f.dir, "data-provenance.json"))), cutoff_utc: "2026-10-14T00:00:00Z", closed_csv_sha256: crypto.createHash("sha256").update(csv).digest("hex") });
  assert.throws(() => loadCourse(f.dir, f.root), /stängda candles/);
});
test("symlink till kursfil tillåts inte", t => {
  const f = fixture(t);
  const target = path.join(f.root, "external.json"); fs.writeFileSync(target, "{}");
  fs.unlinkSync(path.join(f.dir, "strategy.json")); fs.symlinkSync(target, path.join(f.dir, "strategy.json"));
  assert.throws(() => loadCourse(f.dir, f.root), /sökväg/);
});

test("ändrat kursresultat avvisas före visning", t => {
  const f = fixture(t);
  const p = path.join(f.dir, "backtest-result.json");
  const result = JSON.parse(fs.readFileSync(p)); result.metrics.netReturnPct = 999;
  f.save("backtest-result.json", result);
  assert.throws(() => loadCourse(f.dir, f.root), /ändrats efter verifiering/);
});
