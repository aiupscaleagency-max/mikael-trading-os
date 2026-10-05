import type { BrokerAdapter } from "../brokers/adapter.js";

export const ANALYSIS_TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"] as const;
export type AnalysisTimeframe = typeof ANALYSIS_TIMEFRAMES[number];
export type AnalysisBroker = "bybit" | "bybit-paper";

/** Frys kontovalet före asynkrona kontroller; senare globala ändringar får inte byta konto. */
export function resolveAnalysisBroker(request: Pick<AnalysisRequest, "broker">, activeBroker: string | null): AnalysisBroker {
  const broker = request.broker ?? activeBroker ?? "bybit-paper";
  if (broker !== "bybit" && broker !== "bybit-paper") throw new Error("Ogiltigt analyskonto");
  return broker;
}

export interface AnalysisRequest {
  broker?: AnalysisBroker;
  selectedSymbols: string[];
  timeframe?: AnalysisTimeframe;
  instruction?: string;
  requestId?: string;
}
export function validateAnalysisRequest(value: unknown, allowedSymbols: readonly string[]): AnalysisRequest {
  if (!value || typeof value !== "object") throw new Error("Analysen kräver ett uttryckligt parurval");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.selectedSymbols) || !input.selectedSymbols.length || input.selectedSymbols.length > 100) throw new Error("Välj minst ett tillåtet par före analysen");
  const allowed = new Set(allowedSymbols);
  const selectedSymbols = [...new Set(input.selectedSymbols.map((s: unknown) => {
    if (typeof s !== "string") throw new Error("Parurvalet måste innehålla symbolnamn");
    const symbol = s.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,20}USDC$/.test(symbol) || !allowed.has(symbol)) throw new Error(`Otillåtet analyspar: ${symbol}`);
    return symbol;
  }))];
  if (input.broker !== undefined && input.broker !== "bybit" && input.broker !== "bybit-paper") throw new Error("Ogiltigt analyskonto");
  const timeframe = input.timeframe ?? "1m";
  if (!ANALYSIS_TIMEFRAMES.includes(timeframe as AnalysisTimeframe)) throw new Error("Ogiltigt analysintervall");
  if (input.instruction !== undefined && (typeof input.instruction !== "string" || input.instruction.length > 20_000)) throw new Error("Ogiltig analysinstruktion");
  if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId))) throw new Error("Ogiltigt analys-ID");
  return { broker: input.broker as AnalysisBroker | undefined, selectedSymbols, timeframe: timeframe as AnalysisTimeframe, instruction: input.instruction as string | undefined, requestId: input.requestId as string | undefined };
}

/** Symbolgrinden gäller även modellens verktygsanrop och reservvägar. Risk får läsa hela kontot. */
export function scopeBroker(broker: BrokerAdapter, symbols: readonly string[]): BrokerAdapter {
  const selected = new Set(symbols);
  const check = (symbol: string): void => { if (!selected.has(symbol.toUpperCase())) throw new Error(`Par ${symbol} ingår inte i analysens bindande urval`); };
  return {
    name: broker.name, mode: broker.mode,
    getAccount: () => broker.getAccount(), getPositions: () => broker.getPositions(),
    getTicker: (symbol) => { check(symbol); return broker.getTicker(symbol); },
    getKlines: (symbol, interval, limit) => { check(symbol); return broker.getKlines(symbol, interval, limit); },
    placeOrder: (order) => { check(order.symbol); return broker.placeOrder(order); },
    cancelOrder: (symbol, id) => { check(symbol); return broker.cancelOrder(symbol, id); },
  };
}

/** JEV får begränsa urvalet, aldrig utöka det genom en reservväg. */
export function intersectAnalysisSymbols(selected: readonly string[], candidates: readonly string[]): string[] {
  const allowed = new Set(selected);
  return [...new Set(candidates.filter((s) => allowed.has(s)))];
}
