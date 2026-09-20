import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openLearningDb, migrate, addColumnIfMissing } from "./db.js";

// Alla tester körs mot :memory: — ingen disk, inget nätverk, inga nycklar.

test("migrering är idempotent och bevarar data", () => {
  const db = openLearningDb(":memory:");
  const v1 = migrate(db); // redan körd av openLearningDb

  db.prepare(
    `INSERT INTO signal_journal (id, ts, source, signal_version, asset_class, symbol,
      venue, timeframe, leverage, is_perp, direction, setup_type, horizon_bars,
      confidence, regime, ensemble_status)
     VALUES ('sig-1', 1000, 'head_trader_proposal', 'v1', 'crypto', 'BTCUSDT',
      'binance', '4h', 5, 0, 'long', 'ta_score', 18, 0.7, 'trend_up', 'voted')`,
  ).run();

  // Kör om migreringen — får varken kasta eller röra befintlig data.
  const v2 = migrate(db);
  assert.equal(v2, v1, "user_version ska vara oförändrad vid omkörning");

  const row = db.prepare("SELECT * FROM signal_journal WHERE id = 'sig-1'").get();
  assert.ok(row, "raden ska finnas kvar efter omkörd migrering");
  assert.equal(row!.symbol, "BTCUSDT");
  assert.equal(row!.resolution_status, "open", "default ska vara 'open'");
  assert.equal(row!.resolve_attempts, 0);
});

test("addColumnIfMissing är en no-op när kolumnen redan finns", () => {
  const db = openLearningDb(":memory:");
  // Befintlig kolumn → ingen ALTER, ingen throw.
  addColumnIfMissing(db, "signal_journal", "symbol", "TEXT");
  // Ny kolumn → läggs till.
  addColumnIfMissing(db, "signal_journal", "test_kolumn", "TEXT");
  const cols = db.prepare("PRAGMA table_info(signal_journal)").all();
  assert.ok(cols.some((c) => c.name === "test_kolumn"));
  // Andra anropet ska inte kasta trots att kolumnen nu finns.
  addColumnIfMissing(db, "signal_journal", "test_kolumn", "TEXT");
});

test("en 'gammal' databas överlever nya migreringar med NULL i nya kolumner", () => {
  // Simulera en db som bara har grundtabellen utan de sena kolumnerna.
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE signal_journal (id TEXT PRIMARY KEY, ts INTEGER NOT NULL)`);
  db.prepare("INSERT INTO signal_journal (id, ts) VALUES ('gammal', 1)").run();

  addColumnIfMissing(db, "signal_journal", "regime", "TEXT");
  const row = db.prepare("SELECT * FROM signal_journal WHERE id = 'gammal'").get();
  assert.equal(row!.ts, 1, "gammal data ska vara kvar");
  assert.equal(row!.regime, null, "ny kolumn ska vara NULL för gamla rader");
});

test("CHECK-constraints avvisar skräpvärden", () => {
  const db = openLearningDb(":memory:");
  const insert = (assetClass: string, confidence: number) =>
    db.prepare(
      `INSERT INTO signal_journal (id, ts, source, signal_version, asset_class, symbol,
        venue, timeframe, leverage, is_perp, direction, setup_type, horizon_bars,
        confidence, regime, ensemble_status)
       VALUES (?, 1, 'head_trader_proposal', 'v1', ?, 'X', 'v', '4h', 1, 0,
        'long', 's', 10, ?, 'range', 'voted')`,
    ).run(`id-${assetClass}-${confidence}`, assetClass, confidence);

  assert.throws(() => insert("krypto", 0.5), /CHECK|constraint/i, "ogiltig asset_class");
  assert.throws(() => insert("crypto", 1.7), /CHECK|constraint/i, "confidence > 1");
  // Giltiga värden ska gå igenom.
  insert("crypto", 0.5);
});

test("lessons-tabellen finns och tar emot en lärdom", () => {
  const db = openLearningDb(":memory:");
  db.prepare(
    `INSERT INTO lessons (id, ts, scope, lesson_text, supporting_signal_ids, confidence, active)
     VALUES ('l1', 1, 'BTCUSDT', 'Undvik breakouts i high_vol', '["a","b","c","d","e"]', 0.6, 1)`,
  ).run();
  const row = db.prepare("SELECT * FROM lessons WHERE id='l1'").get();
  assert.equal(JSON.parse(String(row!.supporting_signal_ids)).length, 5);
  assert.equal(row!.active, 1);
});
