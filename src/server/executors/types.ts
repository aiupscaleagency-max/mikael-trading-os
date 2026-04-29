// ═══════════════════════════════════════════════════════════════════════════
// TradeExecutor Interface — gemensam yta för alla executors
//
// Mikes regel: TEST och LIVE måste köra EXAKT samma kod-väg.
// Skillnaden är BARA vilken executor som routar order + hämtar pris.
//
// PaperExecutor:    simulerar order, scalp resolveas mot Binance public-pris
// BinanceExecutor:  riktiga ordrar via Binance API + autentiserade prisdata
//
// Båda implementerar exakt samma API. Backend tradeState kallar bara
// executor.openOrder() / executor.resolveOrder() / executor.getPrice().
// ═══════════════════════════════════════════════════════════════════════════

export type ExecutorMode = "paper" | "binance-testnet" | "binance-live";

export interface OpenOrderParams {
  symbol: string;        // e.g. "BTCUSDT"
  side: "BUY" | "SELL";
  quoteAmount: number;   // stake i USD
  expiresAt?: number;    // unix ms (för scalp)
  clientOrderId?: string;
}

export interface OrderResult {
  orderId: string;       // executor-specifikt id (paper: trade-xxx, binance: orderId)
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  filledQuantity: number;
  filledQuoteAmount: number;
  fees: number;          // i quote-currency (USD)
  timestamp: number;
  status: "filled" | "partial" | "rejected" | "open";
  rawResponse?: unknown; // för debugging
}

export interface ResolveResult {
  orderId: string;
  exitPrice: number;
  pnl: number;           // realized PnL i quote-currency (USD)
  won: boolean;
  closedAt: number;
}

export interface AccountInfo {
  cashBalance: number;   // USD
  totalEquity: number;   // cash + open positions
  openPositions: number;
}

export interface TradeExecutor {
  readonly mode: ExecutorMode;
  readonly name: string;

  // Hämta nuvarande pris för en symbol
  getPrice(symbol: string): Promise<number>;

  // Öppna en order — returnerar orderId + entry-pris
  openOrder(params: OpenOrderParams): Promise<OrderResult>;

  // Resolveas en order (för scalp: vid expiresAt; för spot: explicit close)
  // Returns: exit-pris + faktisk pnl. Paper: simulerar binary outcome.
  // Live: stänger position via Binance och rapporterar fill.
  resolveOrder(orderId: string, openParams: { entryPrice: number; symbol: string; side: "BUY" | "SELL"; quoteAmount: number; payoutMultiplier: number }): Promise<ResolveResult>;

  // Hälsa-check — finns API-keys, är endpoints tillgängliga
  healthCheck(): Promise<{ ok: boolean; details: string }>;

  // Account-info (cash + equity) — paper: från in-memory state, live: från Binance API
  getAccount(): Promise<AccountInfo>;
}
