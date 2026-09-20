import type {
  Account,
  Kline,
  OrderRequest,
  OrderResult,
  Position,
  Ticker,
} from "../types.js";

// Generiskt broker-interface. Binance är förstå implementationen men poängen
// är att vi senare kan lägga till Alpaca, OANDA, eller vad som helst utan att
// röra agenten.
export interface BrokerAdapter {
  readonly name: string;
  readonly mode: "paper" | "live";

  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>;

  /**
   * Candles inom ett tidsintervall. VALFRI — lärloopens avgörningsjobb
   * behöver den, men brokers som inte stödjer det (Alpaca/OANDA/Blofin ännu)
   * ska inte behöva ändras. Saknas den lämnas signalen öppen istället för att
   * felaktigt markeras som ej avgörbar.
   */
  getKlinesRange?(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
  ): Promise<Kline[]>;

  placeOrder(order: OrderRequest): Promise<OrderResult>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
}
