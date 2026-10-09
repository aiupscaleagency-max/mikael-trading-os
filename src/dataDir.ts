import path from "node:path";

/**
 * Alla datafiler (ordrar, minne, kostnad, IG-tillstånd) ligger här.
 * TRADING_DATA_DIR gör att en andra instans på samma dator kan köra med egna
 * filer utan att krocka med den första. Standard: ./data (som tidigare).
 */
export function dataDir(): string {
  return path.resolve(process.env.TRADING_DATA_DIR || path.join(process.cwd(), "data"));
}
export function dataPath(...parts: string[]): string {
  return path.join(dataDir(), ...parts);
}
