import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// EGNA MYNT (Mike 2026-10-04): lägg till mynt du får tips om i grupper, så
// analyserar agenterna dem också. Ett mynt godkänns bara om det går att handla
// på Bybit EU (spot) och har live-data på Bybit. Sparas i data/custom-symbols.json
// och laddas in i config.crypto.symbols vid start (se config.ts).
// ═══════════════════════════════════════════════════════════════════════════

const FILE = path.resolve("data/custom-symbols.json");
const EU = "https://api.bybit.eu";


export interface CustomSymbol {
  symbol: string;   // BASEUSDC på Bybit EU
  base: string;
  usdc: boolean;    // finns BASE/USDC på Bybit EU (dit ordrarna går)
  addedAt: string;
  note?: string;    // t.ex. vilken grupp tipset kom från
}

let list: CustomSymbol[] | null = null;

function load(): CustomSymbol[] {
  if (list) return list;
  try { list = (JSON.parse(fs.readFileSync(FILE, "utf8")) as { symbols?: CustomSymbol[] }).symbols ?? []; }
  catch { list = []; }
  return list;
}

function save(): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = `${FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ symbols: load() }, null, 2));
  fs.renameSync(temp, FILE);
}

export function listCustomSymbols(): CustomSymbol[] {
  // Äldre sparade signalpar kan heta USDT trots verifierat USDC-handelspar.
  return load().map((c) => ({ ...c, symbol: c.usdc ? `${c.base.toUpperCase()}USDC` : c.symbol }));
}

/** Bara verifierade USDC-par ingår i marknadskatalogen. */
export function hasUsdcPair(base: string): boolean {
  const c = load().find((x) => x.base === base);
  return c ? c.usdc : true;
}

/** true/false = Bybit svarade; null = Bybit gick inte att nå (då gissar vi inte). */
async function spotExists(host: string, pair: string): Promise<boolean | null> {
  try {
    const r = await fetch(`${host}/v5/market/instruments-info?category=spot&symbol=${pair}`, { signal: AbortSignal.timeout(10_000) });
    const d = (await r.json()) as { retCode?: number; result?: { list?: Array<{ status?: string }> } };
    if (d.retCode !== 0) return null;
    return (d.result?.list ?? []).some((x) => x.status === "Trading");
  } catch {
    return null;
  }
}

/** "pepe", "PEPE/USDT", "pepeusdc" → "PEPE" */
export function toBase(input: string): string {
  const s = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length > 4 ? s.replace(/(USDT|USDC)$/, "") : s;
}

export async function addCustomSymbol(input: string, note?: string): Promise<CustomSymbol> {
  const base = toBase(input);
  if (!/^[A-Z0-9]{2,15}$/.test(base)) throw new Error("Skriv myntets kortnamn, t.ex. PEPE eller WIF");
  if (["USDC", "USDT", "USD", "DAI", "FDUSD", "BUSD", "TUSD", "PYUSD", "EUR", "USDE"].includes(base)) throw new Error(`${base} är en stablecoin, inget att handla`);
  const symbol = `${base}USDC`;
  if (config.crypto.symbols.includes(symbol) || load().some((s) => s.base.toUpperCase() === base) || adding.has(base)) throw new Error(`${base} följs redan`);
  adding.add(base);
  try { return await addChecked(base, symbol, note); } finally { adding.delete(base); }
}

const adding = new Set<string>();

async function addChecked(base: string, symbol: string, note?: string): Promise<CustomSymbol> {
  const euUsdc = await spotExists(EU, symbol);
  if (euUsdc === null) throw new Error("Kunde inte nå Bybit EU. Försök igen om en stund.");
  if (!euUsdc) throw new Error(`${base} saknar USDC-par på Bybit EU`);
  const c: CustomSymbol = { symbol, base, usdc: euUsdc, addedAt: new Date().toISOString(), note: note?.slice(0, 100) };
  const before = load().slice();
  load().push(c);
  try { save(); } catch (err) { list = before; throw err; }
  config.crypto.symbols.push(symbol);
  log.ok(`[egna mynt] ${base} tillagt${euUsdc ? "" : " (bara USDT-par på Bybit EU)"}`);
  return c;
}

export function removeCustomSymbol(input: string): CustomSymbol {
  const base = toBase(input);
  const l = load();
  const i = l.findIndex((x) => x.base === base);
  if (i < 0) throw new Error(`${base} är inte ett eget mynt (de 15 vanliga tas bort i .env)`);
  const before = l.slice();
  const [c] = l.splice(i, 1);
  try { save(); } catch (err) { list = before; throw err; }
  for (const symbol of [c!.symbol, `${c!.base.toUpperCase()}USDC`]) {
    const j = config.crypto.symbols.indexOf(symbol);
    if (j >= 0) config.crypto.symbols.splice(j, 1);
  }
  log.info(`[egna mynt] ${base} borttaget`);
  return { ...c!, symbol: c!.usdc ? `${c!.base.toUpperCase()}USDC` : c!.symbol };
}
