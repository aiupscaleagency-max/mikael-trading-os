// Läs endast slutligt, lokalt kursresultat från den betrodda kopians katalog.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function loadCourse(directory, allowedRoot) {
  if (!directory) throw new Error("Kursvisningen är inte aktiverad i denna terminal.");
  const root = fs.realpathSync(allowedRoot);
  const dir = fs.realpathSync(directory);
  if (!dir.startsWith(root + path.sep)) throw new Error("Kurskatalogen måste ligga i kopians private-course.");
  const read = (name) => {
    const file = path.join(dir, name);
    if (fs.lstatSync(file).isSymbolicLink() || path.dirname(fs.realpathSync(file)) !== dir)
      throw new Error("Kursfilens sökväg är ogiltig.");
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error("Kursfilen är för stor.");
    return fs.readFileSync(file, "utf8");
  };
  if (fs.existsSync(path.join(dir, ".day4-incomplete"))) throw new Error("Senaste kursbacktestet är ofullständigt.");
  const resultText = read("backtest-result.json");
  const specText = read("strategy.json");
  const result = JSON.parse(resultText);
  const spec = JSON.parse(specText);
  const provenance = JSON.parse(read("data-provenance.json"));
  if (crypto.createHash("sha256").update(resultText).digest("hex") !== provenance.result_file_sha256
    || crypto.createHash("sha256").update(specText).digest("hex") !== provenance.spec_file_sha256)
    throw new Error("Kursens resultat eller strategi har ändrats efter verifiering.");
  if (result.result_version !== 1 || spec.unresolved?.length || result.data?.symbol !== "btcusd" || result.data?.bar !== "1d")
    throw new Error("Kursresultatet måste vara ett verifierat BTCUSD-dagstest.");
  const csvName = "tiingo-btcusd-1d-closed-20261013.csv";
  if (fs.realpathSync(spec.instrument.csv_path || "") !== path.join(dir, csvName)) throw new Error("Kursens CSV-referens stämmer inte.");
  const csv = read(csvName);
  if (crypto.createHash("sha256").update(csv).digest("hex") !== provenance.closed_csv_sha256)
    throw new Error("Kursens datakontrollsumma stämmer inte.");
  const lines = csv.trim().split(/\r?\n/);
  if (lines.shift() !== "date,open,high,low,close,volume") throw new Error("Ogiltigt CSV-format.");
  const cutoff = Date.parse(provenance.cutoff_utc) / 1000;
  const bars = lines.map((line) => {
    const [date, ...values] = line.split(",");
    const [open, high, low, close, volume] = values.map(Number);
    return { time: Date.parse(date) / 1000, open, high, low, close, volume };
  });
  if (!Number.isFinite(cutoff) || bars.length !== result.data.bars || bars.some((bar, i) =>
    !Object.values(bar).every(Number.isFinite) || bar.time + 86400 > cutoff || (i && bar.time <= bars[i - 1].time)))
    throw new Error("Kursens stängda candles stämmer inte med resultatet.");
  const trades = result.trades.map((trade) => {
    if (!bars[trade.entryIndex] || (trade.exitIndex !== null && !bars[trade.exitIndex])) throw new Error("Ogiltigt tradeindex.");
    return { entryTime: bars[trade.entryIndex].time, entryPrice: trade.entryPrice, exitTime: trade.exitIndex === null ? null : bars[trade.exitIndex].time, exitPrice: trade.exitPrice, exitReason: trade.exitReason, qty: trade.qty, pnl: trade.pnl };
  });
  return {
    name: result.specName, bars, trades, metrics: result.metrics, context: { buyAndHoldPct: result.context.buyAndHoldPct },
    period: { start: result.data.startISO, end: result.data.endISO },
    costs: result.data.costBps, identity: result.inputIdentity, warnings: result.warnings,
    source: "Tiingo BTCUSD · verifierad lokal CSV · stängda UTC-dagsbars",
    strategy: { entry: result.strategy.entryPlain, exit: result.strategy.exitPlain, stop: result.strategy.stopHuman, sizing: result.strategy.sizingHuman },
  };
}
