import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DDL_SIGNAL_JOURNAL, DDL_LESSONS, DDL_INDEXES } from "./schema.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  LÄRLOOPENS DATABAS — data/learning.db (node:sqlite, inbyggt i Node 22).
//
//  Separat butik från decisions.jsonl / lessons.json, som INTE rörs.
//
//  Migreringarna är idempotenta: samma process kan köras hur många gånger som
//  helst, på tom eller full databas, utan dataförlust. Bara additiva satser —
//  CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS och
//  addColumnIfMissing(). Aldrig DROP, aldrig table-rebuild.
//
//  All SQLite-användning hålls bakom denna modul + signalJournal.ts, så ett
//  eventuellt byte till better-sqlite3 blir en tvåfilsändring.
//
//  VIKTIGT för all statistik: krypto, forex och aktier blandas aldrig. Varje
//  aggregerande SELECT måste ha GROUP BY asset_class (eller filtrera på den).
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "learning.db");

interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

/**
 * Lägger till en kolumn bara om den saknas. Dubbel säkerhet vid sidan av
 * user_version: om någon kört en ALTER manuellt blir migreringen en no-op
 * istället för ett krasch.
 */
export function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

// Migreringar körs i ordning. Nya fält i senare faser läggs till som nya
// poster här — ändra ALDRIG en redan släppt migrering.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "signal_journal + lessons + index",
    up: (db) => {
      db.exec(DDL_SIGNAL_JOURNAL);
      db.exec(DDL_LESSONS);
      for (const idx of DDL_INDEXES) db.exec(idx);
    },
  },
];

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}

/** Kör alla migreringar som ligger efter databasens user_version. */
export function migrate(db: DatabaseSync): number {
  let version = currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.exec("BEGIN");
    try {
      m.up(db);
      // PRAGMA tar inte parametrar — versionen är en literal ur vår egen array.
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
      version = m.version;
      log.info(`[Lärloop] Migrering ${m.version} körd: ${m.description}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return version;
}

let cached: DatabaseSync | null = null;

/**
 * Öppnar (och migrerar) lärloopens databas.
 * Skicka ":memory:" för tester — då cachas inget.
 */
export function openLearningDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  if (dbPath === DEFAULT_DB_PATH && cached) return cached;

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  // WAL ger samtidiga läsare medan avgörningsjobbet skriver.
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  if (dbPath === DEFAULT_DB_PATH) cached = db;
  return db;
}

/** Stänger den cachade databasen. Används av tester och vid nedstängning. */
export function closeLearningDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}
