// Gemensamma typer för hela trading-agenten.

export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";
export type Mode = "paper" | "live";
export type ExecutionMode = "auto" | "approve";

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface Ticker {
  symbol: string;
  price: number;
  // 24h-förändring i procent
  changePct24h: number;
  volume24h: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export interface Account {
  balances: Balance[];
  // Totalt estimerat värde i USDT (quote-valuta)
  totalValueUsdt: number;
  updatedAt: number;
}

export interface Position {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  quantity: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnlUsdt: number;
  openedAt: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  // Kvantitet uttryckt i BAS-valuta (t.ex. BTC i BTCUSDT)
  quantity?: number;
  // Alternativt: spendera X av quote-valuta (t.ex. X USDT). Binance MARKET stöder quoteOrderQty.
  quoteOrderQty?: number;
  // Endast för LIMIT
  price?: number;
}

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  status: string;
  executedQty: number;
  cummulativeQuoteQty: number;
  avgFillPrice: number;
  timestamp: number;
}

export interface DecisionRecord {
  id: string;
  timestamp: number;
  mode: Mode;
  // "hold" betyder agenten tittade men bestämde sig för att inte göra något
  action: "buy" | "sell" | "hold" | "cancel";
  symbol?: string;
  reasoning: string;
  // De tool-calls agenten gjorde under analysen (för review)
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  orderResult?: OrderResult;
  // Fylls i efteråt när positionen stängs
  outcome?: {
    closedAt: number;
    realizedPnlUsdt: number;
    exitPrice: number;
    notes?: string;
  };
}
