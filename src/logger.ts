// Minimal färgad konsol-logger. Inga externa beroenden.
// Vi loggar till stdout; run.ts kan piping:a till fil om du vill.

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function fmt(level: string, color: string, msg: string, meta?: unknown): string {
  const base = `${colors.dim}${ts()}${colors.reset} ${color}${level.padEnd(5)}${colors.reset} ${msg}`;
  if (meta !== undefined) {
    return `${base} ${colors.dim}${JSON.stringify(meta)}${colors.reset}`;
  }
  return base;
}

export const log = {
  info: (msg: string, meta?: unknown) => console.log(fmt("INFO", colors.blue, msg, meta)),
  ok: (msg: string, meta?: unknown) => console.log(fmt("OK", colors.green, msg, meta)),
  warn: (msg: string, meta?: unknown) => console.warn(fmt("WARN", colors.yellow, msg, meta)),
  error: (msg: string, meta?: unknown) => console.error(fmt("ERROR", colors.red, msg, meta)),
  agent: (msg: string, meta?: unknown) =>
    console.log(fmt("AGENT", colors.magenta, msg, meta)),
  trade: (msg: string, meta?: unknown) =>
    console.log(fmt("TRADE", colors.cyan, msg, meta)),
};
