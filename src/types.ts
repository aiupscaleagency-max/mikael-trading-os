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
  /** IG: kontovaluta (t.ex. SEK). Saknas = USD/USDT som tidigare. */
  currency?: string;
  balance?: number | null;
  available?: number | null;
  profitLoss?: number | null;
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
  /** IG: positionens id (används för stängning), riktning och visningsnamn */
  dealId?: string;
  direction?: "BUY" | "SELL";
  name?: string;
  /** Valuta för unrealizedPnlUsdt (IG: kontovalutan). null P/L = kunde inte verifieras. */
  pnlCurrency?: string | null;
  pnlVerified?: boolean;
  stopLevel?: number | null;
  limitLevel?: number | null;
  /** Demo-simulering: Live-instrument som saknas på IG Demo, fyllt med låtsaspengar mot Live-pris (aldrig hos IG) */
  sim?: boolean;
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
  // Valfritt: sälj automatiskt vid vinst (takeProfit) eller förlust (stopLoss), som pris i quote-valutan.
  takeProfit?: number;
  stopLoss?: number;
  /** IG: stäng denna position (DELETE /positions/otc) i stället för att öppna en ny */
  closeDealId?: string;
  /** IG: insats (marginal) i kontovalutan; storleken räknas fram från IG:s regler */
  stakeAmount?: number;
  /** IG: systemets tidsstängning (sekunder). Sparas på orderutkastet så att en order som först blir
   *  "okänd" och senare stäms av som accepterad ändå får sin tidsstängning (granskning 2, B1). */
  timedExitSec?: number;
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
  /** IG */
  dealId?: string;
  dealReference?: string;
  /** IG: verklig öppningskurs ur IG:s bekräftelse (confirms.level), när den finns */
  fillLevel?: number;
  error?: string;
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
