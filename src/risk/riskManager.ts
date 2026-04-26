import type { Config } from "../config.js";
import type { Account, OrderRequest, Position } from "../types.js";
import type { AgentState } from "../memory/store.js";

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
    },
  ): RiskCheckResult {
    const { state, account, positions, lastPrice } = ctx;
    const { risk } = this.config;

    // Samla alla tillåtna symboler från alla motorer
    const allowedSymbols = [
      ...this.config.crypto.symbols,
      ...this.config.stocks.symbols,
      ...this.config.wheel.underlyings,
    ];

    if (state.killSwitchActive) {
      return { allowed: false, reason: "Kill-switch är aktiv. Ingen handel tillåten." };
    }

    // Om symbolen finns i en av listorna ELLER är ett options-kontrakt (innehåller siffror), tillåt.
    const isOption = /\d/.test(order.symbol) && order.symbol.length > 6;
    if (!isOption && allowedSymbols.length > 0 && !allowedSymbols.includes(order.symbol)) {
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

      // Per-position-tak: skala ner om för stor
      let adjustedOrder: OrderRequest | undefined;
      if (orderUsd > risk.maxPositionUsd) {
        const scaled: OrderRequest = {
          ...order,
          quoteOrderQty: risk.maxPositionUsd,
          quantity: undefined,
        };
        adjustedOrder = scaled;
        orderUsd = risk.maxPositionUsd;
      }

      // Total exponering
      const currentExposure = positions.reduce(
        (sum, p) => sum + p.quantity * p.currentPrice,
        0,
      );
      if (currentExposure + orderUsd > risk.maxTotalExposureUsd) {
        const remaining = risk.maxTotalExposureUsd - currentExposure;
        if (remaining < 10) {
          return {
            allowed: false,
            reason: `Max total exponering (${risk.maxTotalExposureUsd} USDT) nådd. Nuvarande: ${currentExposure.toFixed(2)} USDT.`,
          };
        }
        // Skala ner till vad som får plats
        adjustedOrder = {
          ...(adjustedOrder ?? order),
          quoteOrderQty: remaining,
          quantity: undefined,
        };
      }

      // Finns tillräckligt med USDT i kontot?
      const usdtBal = account.balances.find((b) => b.asset === "USDT");
      const usdtFree = usdtBal ? usdtBal.free : 0;
      const finalUsd = adjustedOrder?.quoteOrderQty ?? orderUsd;
      if (usdtFree < finalUsd) {
        return {
          allowed: false,
          reason: `För lite USDT i kontot (${usdtFree.toFixed(2)} < ${finalUsd.toFixed(2)}).`,
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
