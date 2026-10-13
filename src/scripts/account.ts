import { config } from "../config.js";
import { BinanceBroker } from "../brokers/binance.js";
import { AlpacaBroker } from "../brokers/alpaca.js";
import { BlofinBroker } from "../brokers/blofin.js";
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

  let totalValue = 0;

  if (config.alpaca.enabled) {
    try {
      const broker = new AlpacaBroker({
        keyId: config.alpaca.keyId,
        secretKey: config.alpaca.secretKey,
        baseUrl: config.alpaca.baseUrl,
        dataUrl: config.alpaca.dataUrl,
        mode: config.mode,
      });
      await showBroker("Alpaca", broker);
      const acc = await broker.getAccount();
      totalValue += acc.totalValueUsdt;
    } catch (err) {
      log.error(`Alpaca: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (config.blofin.enabled) {
    try {
      const broker = new BlofinBroker({
        apiKey: config.blofin.apiKey,
        apiSecret: config.blofin.apiSecret,
        passphrase: config.blofin.passphrase,
        baseUrl: config.blofin.baseUrl,
        mode: config.mode,
      });
      await showBroker("Blofin", broker);
      const acc = await broker.getAccount();
      totalValue += acc.totalValueUsdt;
    } catch (err) {
      log.error(`Blofin: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (config.binance.enabled) {
    try {
      const broker = new BinanceBroker({
        apiKey: config.binance.apiKey,
        apiSecret: config.binance.apiSecret,
        baseUrl: config.binance.baseUrl,
        mode: config.mode,
      });
      await showBroker("Binance", broker);
      const acc = await broker.getAccount();
      totalValue += acc.totalValueUsdt;
    } catch (err) {
      log.error(`Binance: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${"═".repeat(50)}`);
  log.ok(`TOTAL PORTFÖLJ: ${totalValue.toFixed(2)} USD`);
  console.log("═".repeat(50));
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
