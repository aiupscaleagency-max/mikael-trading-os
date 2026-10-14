// Everything you save (layouts, watchlists, drawings, alerts, paper account) lives in ./data as
// plain JSON files you own. Writes go to a temp file first so a crash can't corrupt them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.QT_DATA_DIR || path.join(root, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export function read(name, fallback) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, `${name}.json`), "utf8"),
    );
  } catch {
    return fallback;
  }
}

export function write(name, value) {
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify(value, null, 2);
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows refuses to rename over a file that antivirus or the indexer has open.
    // Fall back to writing in place rather than losing the save.
    if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
  }
}
