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
const GLOBAL = "https://api.bybit.com";

export interface CustomSymbol {
  symbol: string;   // BASEUSDT (så som signalmotorn och strömmarna följer paren)
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
  fs.writeFileSync(FILE, JSON.stringify({ symbols: load() }, null, 2));
}

export function listCustomSymbols(): CustomSymbol[] {
  return [...load()];
}

/** False om myntet är tillagt utan USDC-par (då prenumereras bara USDT-paret). */
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
  const symbol = `${base}USDT`;
  if (config.crypto.symbols.includes(symbol) || adding.has(base)) throw new Error(`${base} följs redan`);
  adding.add(base);
  try { return await addChecked(base, symbol, note); } finally { adding.delete(base); }
}

const adding = new Set<string>();

async function addChecked(base: string, symbol: string, note?: string): Promise<CustomSymbol> {
  const [euUsdc, euUsdt, globalUsdt] = await Promise.all([
    spotExists(EU, `${base}USDC`), spotExists(EU, `${base}USDT`), spotExists(GLOBAL, symbol),
  ]);
  if (euUsdc === null || euUsdt === null || globalUsdt === null) throw new Error("Kunde inte nå Bybit just nu. Försök igen om en stund.");
  if (!euUsdc && !euUsdt) throw new Error(`${base} finns inte på Bybit EU, så det går inte att handla från ditt konto`);
  if (!globalUsdt) throw new Error(`${base} saknar live-data (${symbol}) på Bybit, så agenterna kan inte analysera det`);
  const c: CustomSymbol = { symbol, base, usdc: euUsdc, addedAt: new Date().toISOString(), note: note?.slice(0, 100) };
  load().push(c);
  save();
  config.crypto.symbols.push(symbol);
  log.ok(`[egna mynt] ${base} tillagt${euUsdc ? "" : " (bara USDT-par på Bybit EU)"}`);
  return c;
}

export function removeCustomSymbol(input: string): CustomSymbol {
  const base = toBase(input);
  const l = load();
  const i = l.findIndex((x) => x.base === base);
  if (i < 0) throw new Error(`${base} är inte ett eget mynt (de 15 vanliga tas bort i .env)`);
  const [c] = l.splice(i, 1);
  save();
  const j = config.crypto.symbols.indexOf(c!.symbol);
  if (j >= 0) config.crypto.symbols.splice(j, 1);
  log.info(`[egna mynt] ${base} borttaget`);
  return c!;
}
