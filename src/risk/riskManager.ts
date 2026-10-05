import type { Config } from "../config.js";
import type { Account, OrderRequest, Position } from "../types.js";
import type { AgentState } from "../memory/store.js";
import { getTradePercent, percentageAmount } from "./tradeSizing.js";
import { MAX_LIVE_STAKE_USD, testStakeCapUsd } from "../server/orderGate.js";

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  // Justerad order (t.ex. nedskalad storlek). Om null används originalet.
  adjustedOrder?: OrderRequest;
}

/**
 * Risk manager är det sista filtret innan en order går till broker. Agenten
 * kan vilja vad den vill — den här klassen har vetorätt. Reglerna:
 *
 *   1. Kill-switch: om aktiverad, ingen handel alls.
 *   2. Symbol-whitelist: bara symboler i ALLOWED_SYMBOLS får handlas.
 *   3. Daglig förlust-gräns: om dagens realiserade PnL <= -MAX_DAILY_LOSS_USD
 *      stängs all ny handel för dagen.
 *   4. Max öppna positioner.
 *   5. Max USD per position. Om agenten ber om mer, skala ner.
 *   6. Max total exponering (summa av alla öppna positioners värde).
 */
export class RiskManager {
  constructor(private readonly config: Config) {}

  checkOrder(
    order: OrderRequest,
    ctx: {
      state: AgentState;
      account: Account;
      positions: Position[];
      lastPrice: number;
      /** true = TEST/låtsaskonto. Bara då gäller insats-trappan. */
      paper?: boolean;
    },
  ): RiskCheckResult {
    const { state, account, positions, lastPrice } = ctx;
    const { risk } = this.config;

    // Samla alla tillåtna symboler från alla motorer
    const allowedSymbols = [
      ...this.config.crypto.symbols,
    ];

    if (state.killSwitchActive) {
      return { allowed: false, reason: "Kill-switch är aktiv. Ingen handel tillåten." };
    }

    // Om symbolen finns i en av listorna ELLER är ett options-kontrakt (innehåller siffror), tillåt.
    const isOption = false;
    if (!isOption && allowedSymbols.length > 0 && !allowedSymbols.some((s) => s.replace(/USDT$/, "USDC") === order.symbol.replace(/USDT$/, "USDC"))) {
      return {
        allowed: false,
        reason: `Symbol ${order.symbol} finns inte i tillåtna listor (${allowedSymbols.join(", ")}).`,
      };
    }

    if (state.dailyRealizedPnlUsdt <= -risk.maxDailyLossUsd) {
      return {
        allowed: false,
        reason: `Daglig förlust-gräns nådd (${state.dailyRealizedPnlUsdt.toFixed(2)} USDT). Handel pausad till UTC-midnatt.`,
      };
    }

    // BUY-specifika kontroller
    if (order.side === "BUY") {
      if (positions.length >= risk.maxOpenPositions) {
        return {
          allowed: false,
          reason: `Max ${risk.maxOpenPositions} öppna positioner redan. Stäng något innan du öppnar nytt.`,
        };
      }

      // Beräkna hur mycket USD ordern motsvarar
      let orderUsd = 0;
      if (order.quoteOrderQty !== undefined) {
        orderUsd = order.quoteOrderQty;
      } else if (order.quantity !== undefined) {
        orderUsd = order.quantity * lastPrice;
      }

      if (orderUsd <= 0) {
        return { allowed: false, reason: "Kan inte beräkna order-storlek i USD." };
      }

      // Samma procent av det färska kontovärdet i TEST och LIVE.
      const stakeUsd = percentageAmount(account.totalValueUsdt, account.totalValueUsdt, getTradePercent());
      const maxPos = stakeUsd;
      const minPos = Math.min(risk.minPositionUsd, maxPos);
      let adjustedOrder: OrderRequest | undefined;
      if (maxPos <= 0) return { allowed: false, reason: "Kontovärdet är tomt eller ogiltigt" };
      if (Math.abs(orderUsd - maxPos) > 0.005) {
        const scaled: OrderRequest = {
          ...order,
          quoteOrderQty: maxPos,
          quantity: undefined,
        };
        adjustedOrder = scaled;
        orderUsd = maxPos;
      } else if (minPos && orderUsd < minPos) {
        return {
          allowed: false,
          reason: `Order $${orderUsd.toFixed(2)} under MIN_POSITION_USD ($${minPos}). Höj eller skip.`,
        };
      }

      // Total exponering
      const currentExposure = positions.reduce(
        (sum, p) => sum + p.quantity * p.currentPrice,
        0,
      );
      // Insats-trappan: tillåt maxOpenPositions × insatsen, men aldrig under .env-värdet
      const maxExposure = Math.max(risk.maxTotalExposureUsd, (risk.maxOpenPositions ?? 0) * stakeUsd);
      if (currentExposure + orderUsd > maxExposure) {
        const remaining = maxExposure - currentExposure;
        if (remaining < 10) {
          return {
            allowed: false,
            reason: `Max total exponering (${maxExposure} USDT) nådd. Nuvarande: ${currentExposure.toFixed(2)} USDT.`,
          };
        }
        // Skala ner till vad som får plats
        adjustedOrder = {
          ...(adjustedOrder ?? order),
          quoteOrderQty: remaining,
          quantity: undefined,
        };
      }

      // Finns tillräckligt med kassa i kontot? Räknar dollar-valutorna som kassa:
      // USDT (Binance), USDC (Bybit EU) och USD (Alpaca paper).
      const usdtFree = account.balances
        .filter((b) => b.asset === "USDT" || b.asset === "USDC" || b.asset === "USD")
        .reduce((sum, b) => sum + (Number.isFinite(b.free) ? b.free : 0), 0);
      const finalUsd = adjustedOrder?.quoteOrderQty ?? orderUsd;
      if (usdtFree < finalUsd) {
        return {
          allowed: false,
          reason: `För lite kassa i kontot (USDT/USDC/USD ${usdtFree.toFixed(2)} < ${finalUsd.toFixed(2)}).`,
        };
      }

      return { allowed: true, adjustedOrder };
    }

    // SELL: vi behöver äga tillräckligt av basvalutan
    if (order.side === "SELL") {
      const position = positions.find((p) => p.symbol === order.symbol);
      if (!position) {
        return {
          allowed: false,
          reason: `Ingen öppen position i ${order.symbol} att sälja.`,
        };
      }
      if (order.quantity !== undefined && order.quantity > position.quantity) {
        return {
          allowed: false,
          reason: `Försöker sälja ${order.quantity} men äger bara ${position.quantity} ${position.baseAsset}.`,
        };
      }
      return { allowed: true };
    }

    return { allowed: false, reason: "Okänd order-sida." };
  }
}
