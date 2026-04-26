import type Anthropic from "@anthropic-ai/sdk";
import type { BrokerAdapter } from "../brokers/adapter.js";
import type { RiskManager } from "../risk/riskManager.js";
import type { AgentState } from "../memory/store.js";
import { computeIndicators } from "../indicators/ta.js";
import { getMacroSnapshot } from "../data/macro.js";
import { searchNews, getRedditTop } from "../data/news.js";
import type { OrderRequest, OrderResult, Position } from "../types.js";
import type { Config } from "../config.js";
import { log } from "../logger.js";

// Verktygen som Claude kan anropa. Varje verktyg har en JSON-schema-
// definition som skickas till API:et, plus en handler som faktiskt kör.

import type { StrategyEngine } from "../strategies/types.js";
import {
  getRecentPoliticianTrades,
  filterTopPerformers,
} from "../data/capitol.js";

export interface ToolContext {
  broker: BrokerAdapter;
  /** Alla tillgängliga brokers (för multi-broker operations) */
  brokers: Record<string, BrokerAdapter>;
  risk: RiskManager;
  config: Config;
  state: AgentState;
  /** Registrerade strategi-motorer */
  engines: StrategyEngine[];
  // Fylls i av handlers när order läggs — run.ts läser och persisterar.
  sideEffects: {
    placedOrders: Array<{ request: OrderRequest; result: OrderResult }>;
    killSwitchToggled: boolean;
  };
}

type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

interface ToolDef {
  definition: Anthropic.Tool;
  handler: ToolHandler;
}

// Hjälp-funktion: hämta fält med typ-check
function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new Error(`Tool input missing string field: ${key}`);
  return v;
}
function num(input: Record<string, unknown>, key: string): number {
  const v = input[key];
  if (typeof v !== "number") throw new Error(`Tool input missing number field: ${key}`);
  return v;
}
function optStr(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : undefined;
}
function optNum(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" ? v : undefined;
}

export const TOOLS: Record<string, ToolDef> = {
  get_account: {
    definition: {
      name: "get_account",
      description:
        "Hämtar aktuella saldon och totalvärdet på kontot i USDT. Använd detta för att veta hur mycket kapital som finns att arbeta med.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (_input, ctx) => {
      const account = await ctx.broker.getAccount();
      return {
        totalValueUsdt: Number(account.totalValueUsdt.toFixed(2)),
        balances: account.balances.map((b) => ({
          asset: b.asset,
          free: b.free,
          locked: b.locked,
        })),
      };
    },
  },

  get_positions: {
    definition: {
      name: "get_positions",
      description:
        "Listar alla öppna spot-positioner (innehav som inte är quote-valuta). Returnerar symbol, kvantitet, genomsnittligt entry-pris, aktuellt pris och orealiserat PnL.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (_input, ctx) => {
      const positions = await ctx.broker.getPositions();
      // Berika med entry-pris från memory state
      const enriched = positions.map((p) => {
        const tracked = ctx.state.openPositions[p.symbol];
        if (tracked) {
          const pnl = (p.currentPrice - tracked.avgEntryPrice) * tracked.quantity;
          return {
            ...p,
            avgEntryPrice: tracked.avgEntryPrice,
            openedAt: tracked.openedAt,
            unrealizedPnlUsdt: Number(pnl.toFixed(2)),
          };
        }
        return p;
      });
      return enriched;
    },
  },

  get_ticker: {
    definition: {
      name: "get_ticker",
      description:
        "Hämtar aktuellt pris och 24-timmars-statistik för en symbol. Använd för att snabbt se var priset står nu.",
      input_schema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Binance spot-symbol, t.ex. BTCUSDT" },
        },
        required: ["symbol"],
      },
    },
    handler: async (input, ctx) => {
      return await ctx.broker.getTicker(str(input, "symbol"));
    },
  },

  get_indicators: {
    definition: {
      name: "get_indicators",
      description:
        "Hämtar historiska candles för en symbol och räknar ut tekniska indikatorer (SMA20, SMA50, EMA20, RSI14, ATR14, MACD, 24h-förändring). Detta är ditt primära analysverktyg. Välj interval utifrån din tidshorisont.",
      input_schema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Binance spot-symbol, t.ex. BTCUSDT" },
          interval: {
            type: "string",
            enum: ["1m", "5m", "15m", "1h", "4h", "1d"],
            description: "Tidsupplösning för candles",
          },
          limit: {
            type: "number",
            description: "Antal candles (rekommenderat: 100-200 för meningsfulla indikatorer)",
          },
        },
        required: ["symbol", "interval"],
      },
    },
    handler: async (input, ctx) => {
      const symbol = str(input, "symbol");
      const interval = str(input, "interval");
      const limit = optNum(input, "limit") ?? 100;
      const klines = await ctx.broker.getKlines(symbol, interval, limit);
      const indicators = computeIndicators(klines);
      return {
        symbol,
        interval,
        candlesAnalyzed: klines.length,
        indicators,
        // Skicka även de senaste 5 candlesarna så Claude ser formen
        recentCandles: klines.slice(-5).map((k) => ({
          time: new Date(k.closeTime).toISOString(),
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
        })),
      };
    },
  },

  place_order: {
    definition: {
      name: "place_order",
      description:
        "Lägger en riktig order mot brokern. Detta verktyg går genom risk managern som kan blockera eller skala ner ordern. För BUY: specificera `quote_qty` (hur många USDT du vill spendera). För SELL: specificera `base_qty` (hur mycket av tokenen du vill sälja). Ange alltid en kort `reasoning` som förklarar varför.",
      input_schema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Binance spot-symbol, t.ex. BTCUSDT" },
          side: { type: "string", enum: ["BUY", "SELL"] },
          type: { type: "string", enum: ["MARKET", "LIMIT"], description: "Orderstyp. MARKET för omedelbart." },
          quote_qty: {
            type: "number",
            description: "För BUY MARKET: hur många USDT du vill spendera",
          },
          base_qty: {
            type: "number",
            description: "För SELL eller LIMIT: hur många av basvalutan",
          },
          limit_price: {
            type: "number",
            description: "Endast för LIMIT: priset per enhet",
          },
          reasoning: {
            type: "string",
            description: "Din motivering för varför denna trade ska tas",
          },
        },
        required: ["symbol", "side", "type", "reasoning"],
      },
    },
    handler: async (input, ctx) => {
      const symbol = str(input, "symbol");
      const side = str(input, "side") as "BUY" | "SELL";
      const type = str(input, "type") as "MARKET" | "LIMIT";
      const reasoning = str(input, "reasoning");
      const quoteQty = optNum(input, "quote_qty");
      const baseQty = optNum(input, "base_qty");
      const limitPrice = optNum(input, "limit_price");

      const orderReq: OrderRequest = {
        symbol,
        side,
        type,
        quoteOrderQty: quoteQty,
        quantity: baseQty,
        price: limitPrice,
      };

      // Risk-koll. Vi behöver färsk data för detta.
      const [account, positions, ticker] = await Promise.all([
        ctx.broker.getAccount(),
        ctx.broker.getPositions(),
        ctx.broker.getTicker(symbol),
      ]);
      const check = ctx.risk.checkOrder(orderReq, {
        state: ctx.state,
        account,
        positions: positions as Position[],
        lastPrice: ticker.price,
      });

      if (!check.allowed) {
        log.warn(`Risk manager blockerade order: ${check.reason}`);
        return {
          accepted: false,
          reason: check.reason,
          hint: "Du kan inte lägga denna order. Justera storlek/symbol eller gör något annat.",
        };
      }

      const finalOrder = check.adjustedOrder ?? orderReq;

      // I approve-läge lägger vi INTE ordern nu — vi bara förbereder den för
      // mänsklig bekräftelse. I auto-läge skickar vi direkt.
      if (ctx.config.executionMode === "approve") {
        log.agent(
          `[APPROVE-LÄGE] Claude vill lägga order: ${finalOrder.side} ${finalOrder.symbol} — ${reasoning}`,
        );
        return {
          accepted: true,
          executed: false,
          reason: "Order godkänd av risk manager men väntar på mänsklig bekräftelse (EXECUTION_MODE=approve).",
          proposedOrder: finalOrder,
          instructions:
            "Användaren kommer att se detta förslag och antingen bekräfta eller avvisa. Fortsätt inte anta att den faktiskt har exekverats.",
        };
      }

      // AUTO-läge: skicka ordern på riktigt
      try {
        const result = await ctx.broker.placeOrder(finalOrder);
        ctx.sideEffects.placedOrders.push({ request: finalOrder, result });
        log.trade(
          `${result.side} ${result.executedQty} ${result.symbol} @ ${result.avgFillPrice.toFixed(4)} (${result.cummulativeQuoteQty.toFixed(2)} USDT)`,
          { orderId: result.orderId, reasoning },
        );
        return {
          accepted: true,
          executed: true,
          result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Order misslyckades: ${msg}`);
        return { accepted: true, executed: false, error: msg };
      }
    },
  },

  get_macro_snapshot: {
    definition: {
      name: "get_macro_snapshot",
      description:
        "Hämtar det globala makroläget just nu: WTI- och Brent-olja, naturgas, guld, silver, VIX (volatilitetsindex för USA:s börs), DXY (dollarindex), 10-årig US-statsränta, S&P 500, och Crypto Fear & Greed Index. Använd detta för att förstå vilken 'regim' vi är i — risk-on eller risk-off — innan du fattar beslut. När olja rusar, VIX exploderar, eller dollarn stärks kraftigt brukar krypto reagera.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async () => {
      const snap = await getMacroSnapshot();
      // Lägg på lite mänsklig tolkningshjälp utan att dra slutsatser åt Claude.
      const hints: string[] = [];
      if (snap.vix && snap.vix.price > 25) hints.push("VIX >25: förhöjd stress på aktiemarknaden");
      if (snap.vix && snap.vix.price > 35) hints.push("VIX >35: panik-läge");
      if (snap.crudeWti && Math.abs(snap.crudeWti.changePct24h) > 3)
        hints.push(`Olja rör sig kraftigt idag (${snap.crudeWti.changePct24h}%)`);
      if (snap.dxy && Math.abs(snap.dxy.changePct24h) > 0.5)
        hints.push(`Dollarn rör sig ovanligt (${snap.dxy.changePct24h}%)`);
      if (snap.cryptoFearGreed && snap.cryptoFearGreed.value <= 25)
        hints.push("Crypto Fear & Greed: extreme fear (kontraritiska köp-zoner historiskt)");
      if (snap.cryptoFearGreed && snap.cryptoFearGreed.value >= 75)
        hints.push("Crypto Fear & Greed: extreme greed (kontraritiska sälj-zoner historiskt)");
      return { snapshot: snap, hints };
    },
  },

  search_news: {
    definition: {
      name: "search_news",
      description:
        "Söker globala nyheter via Google News RSS. Returnerar rubriker med källa, datum och länk. Använd för att undersöka pågående händelser innan du handlar — t.ex. 'oil OPEC cut', 'Middle East escalation', 'Trump tariffs', 'Fed rate decision', 'Bitcoin ETF'. Limit 10 rubriker per sökning.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Sökfras på engelska (eller valfritt språk). Var specifik.",
          },
          limit: { type: "number", description: "Antal rubriker, default 10, max 20" },
        },
        required: ["query"],
      },
    },
    handler: async (input) => {
      const query = str(input, "query");
      const limit = Math.min(optNum(input, "limit") ?? 10, 20);
      const items = await searchNews(query, limit);
      return {
        query,
        count: items.length,
        items,
      };
    },
  },

  get_reddit_top: {
    definition: {
      name: "get_reddit_top",
      description:
        "Hämtar dagens topp-postningar från ett subreddit. Användbara subreddits: worldnews, geopolitics, economics, energy, cryptocurrency, bitcoin, stockmarket. Inte lika curaterat som nyhetsmedier men fångar ofta sentiment och vad som diskuteras nu.",
      input_schema: {
        type: "object",
        properties: {
          subreddit: { type: "string", description: "Subreddit-namn utan r/-prefix" },
          limit: { type: "number", description: "Antal posts, default 15, max 25" },
        },
        required: ["subreddit"],
      },
    },
    handler: async (input) => {
      const subreddit = str(input, "subreddit");
      const limit = Math.min(optNum(input, "limit") ?? 15, 25);
      const items = await getRedditTop(subreddit, limit);
      return {
        subreddit,
        count: items.length,
        items,
      };
    },
  },

  run_strategy_scan: {
    definition: {
      name: "run_strategy_scan",
      description:
        "Kör en eller alla aktiva strategi-motorer och returnerar deras signaler. " +
        "Motor A (politician_copy): spårar Congress-trades. Motor B (wheel_strategy): " +
        "Wheel-signaler (puts/calls). Motor C (crypto_momentum): krypto momentum-setup. " +
        "Returnerar en lista signaler med action, symbol, reasoning och confidence.",
      input_schema: {
        type: "object",
        properties: {
          engine: {
            type: "string",
            enum: ["politician_copy", "wheel_strategy", "crypto_momentum", "all"],
            description: "Vilken motor att köra, eller 'all' för alla aktiva",
          },
        },
        required: ["engine"],
      },
    },
    handler: async (input, ctx) => {
      const engineName = str(input, "engine");
      const toRun =
        engineName === "all"
          ? ctx.engines
          : ctx.engines.filter((e) => e.name === engineName);

      if (toRun.length === 0) {
        return { error: `Ingen motor '${engineName}' aktiv. Aktiva: ${ctx.engines.map((e) => e.name).join(", ")}` };
      }

      const allSignals = [];
      for (const engine of toRun) {
        const signals = await engine.scan();
        allSignals.push(...signals);
      }

      return {
        enginesRun: toRun.map((e) => e.name),
        totalSignals: allSignals.length,
        signals: allSignals,
      };
    },
  },

  get_politician_trades: {
    definition: {
      name: "get_politician_trades",
      description:
        "Hämtar senaste aktietransaktioner från US Congress-medlemmar (STOCK Act disclosures). " +
        "OBS: Data har 1-45 dagars fördröjning. Visar politiker, parti, ticker, belopp och datum. " +
        "Kan filtreras till bara top performers.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Antal trades, default 20" },
          topOnly: {
            type: "boolean",
            description: "true = bara top-performande politiker (Pelosi, McCaul, etc.)",
          },
        },
      },
    },
    handler: async (input) => {
      const limit = optNum(input, "limit") ?? 20;
      const topOnly = input.topOnly === true;
      let trades = await getRecentPoliticianTrades(limit);
      if (topOnly) trades = filterTopPerformers(trades);
      return { count: trades.length, trades };
    },
  },

  get_all_positions: {
    definition: {
      name: "get_all_positions",
      description:
        "Hämtar positioner från ALLA anslutna brokers (Alpaca, Blofin, Binance). " +
        "Returnerar en sammanfattning per broker med totalt värde och individuella positioner. " +
        "Använd för att se hela portföljen innan du fattar beslut.",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (_input, ctx) => {
      const summary: Array<{
        broker: string;
        mode: string;
        account: { totalValueUsdt: number };
        positions: unknown[];
      }> = [];

      for (const [name, broker] of Object.entries(ctx.brokers)) {
        try {
          const account = await broker.getAccount();
          const positions = await broker.getPositions();
          summary.push({
            broker: name,
            mode: broker.mode,
            account: { totalValueUsdt: Number(account.totalValueUsdt.toFixed(2)) },
            positions: positions.map((p) => ({
              symbol: p.symbol,
              qty: p.quantity,
              entry: p.avgEntryPrice,
              current: p.currentPrice,
              pnl: Number(p.unrealizedPnlUsdt.toFixed(2)),
            })),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          summary.push({
            broker: name,
            mode: "error",
            account: { totalValueUsdt: 0 },
            positions: [{ error: msg }],
          });
        }
      }

      const totalValue = summary.reduce(
        (sum, s) => sum + s.account.totalValueUsdt,
        0,
      );
      return { totalPortfolioValue: Number(totalValue.toFixed(2)), brokers: summary };
    },
  },

  activate_kill_switch: {
    definition: {
      name: "activate_kill_switch",
      description:
        "Aktiverar kill-switchen som omedelbart stoppar all framtida handel. Använd detta om du ser något katastrofalt (flash crash, börs hacked, etc.). Kräver manuell återställning.",
      input_schema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Varför du aktiverar kill-switchen" },
        },
        required: ["reason"],
      },
    },
    handler: async (input, ctx) => {
      const reason = str(input, "reason");
      ctx.state.killSwitchActive = true;
      ctx.sideEffects.killSwitchToggled = true;
      log.error(`🛑 KILL-SWITCH AKTIVERAD av agenten: ${reason}`);
      return { activated: true };
    },
  },
};

export function toolDefinitions(): Anthropic.Tool[] {
  return Object.values(TOOLS).map((t) => t.definition);
}

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = TOOLS[name];
  if (!tool) {
    return { error: `Okänt verktyg: ${name}` };
  }
  try {
    return await tool.handler(input, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}
