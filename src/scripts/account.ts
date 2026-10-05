import { config } from "../config.js";
import { BybitBroker } from "../brokers/bybit.js";
import { BybitPaperBroker } from "../brokers/bybitPaper.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { log } from "../logger.js";

async function showBroker(name: string, broker: BrokerAdapter): Promise<void> {
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  ${name.toUpperCase()} (${broker.mode})`);
  console.log("═".repeat(50));

  const account = await broker.getAccount();
  log.ok(`Totalt värde: ${account.totalValueUsdt.toFixed(2)} USDT/USD`);
  console.log("\nSaldon:");
  for (const b of account.balances) {
    console.log(`  ${b.asset.padEnd(8)} free=${b.free}  locked=${b.locked}`);
  }

  const positions = await broker.getPositions();
  if (positions.length > 0) {
    console.log("\nÖppna positioner:");
    for (const p of positions) {
      const value = (p.quantity * p.currentPrice).toFixed(2);
      console.log(
        `  ${p.symbol.padEnd(12)} qty=${p.quantity}  @ ${p.currentPrice.toFixed(4)}  (≈${value} USD)  PnL=${p.unrealizedPnlUsdt.toFixed(2)}`,
      );
    }
  } else {
    console.log("\nInga öppna positioner.");
  }
}

async function main(): Promise<void> {
  log.info("╔══════════════════════════════════════════════════════════╗");
  log.info("║            MIKAEL TRADING OS — ACCOUNT STATUS           ║");
  log.info("╚══════════════════════════════════════════════════════════╝");

  if (config.bybit.enabled) {
    try { await showBroker("Bybit EU LIVE", new BybitBroker(config.bybit)); }
    catch (err) { log.error(`Bybit EU LIVE: ${err instanceof Error ? err.message : String(err)}`); }
  }
  await showBroker("Bybit EU TEST", new BybitPaperBroker(config.bybit));
  log.info("TEST och LIVE är separata konton; saldona summeras inte.");
  process.exit(0);
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
