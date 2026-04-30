import crypto from "node:crypto";
import { log } from "../../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Binance API-integration — Testnet OCH Mainnet (samma kod, olika base-URL)
//
// Mike vill: TEST = Binance Testnet (riktig API, demo-pengar)
//           LIVE = Binance Mainnet (riktiga pengar)
//
// Säkerhet:
// - HMAC-SHA256-signering på alla auth-endpoints
// - recvWindow 5000ms
// - Byggs som READ-ONLY först, write-permissions kräver explicit setup
// ═══════════════════════════════════════════════════════════════════════════

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

const TESTNET_BASE = "https://testnet.binance.vision";
const MAINNET_BASE = "https://api.binance.com";

export class BinanceClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  readonly mode: "testnet" | "live";

  constructor(creds: BinanceCredentials) {
    if (!creds.apiKey || !creds.apiSecret) {
      throw new Error("Binance kräver apiKey + apiSecret");
    }
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
    this.baseUrl = creds.testnet ? TESTNET_BASE : MAINNET_BASE;
    this.mode = creds.testnet ? "testnet" : "live";
  }

  private sign(queryString: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(queryString).digest("hex");
  }

  private async signedRequest<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const allParams = { ...params, timestamp, recvWindow };
    const queryString = Object.entries(allParams)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const signature = this.sign(queryString);
    const url = `${this.baseUrl}${path}?${queryString}&signature=${signature}`;
    const r = await fetch(url, {
      method,
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Binance ${method} ${path} → ${r.status}: ${errText.slice(0, 300)}`);
    }
    return r.json() as Promise<T>;
  }

  // ─── PUBLIC endpoints (ingen auth) ───

  async getPrice(symbol: string): Promise<number> {
    const r = await fetch(`${this.baseUrl}/api/v3/ticker/price?symbol=${symbol}`);
    if (!r.ok) throw new Error(`Binance ticker svar ${r.status}`);
    const data = (await r.json()) as { price: string };
    return parseFloat(data.price);
  }

  async getKlines(symbol: string, interval = "1m", limit = 100): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
    const r = await fetch(`${this.baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!r.ok) throw new Error(`Binance klines svar ${r.status}`);
    const raw = (await r.json()) as Array<Array<string | number>>;
    return raw.map((k) => ({
      time: Math.floor((k[0] as number) / 1000),
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
    }));
  }

  // ─── AUTHENTICATED endpoints ───

  async getAccount(): Promise<{
    canTrade: boolean;
    canDeposit: boolean;
    canWithdraw: boolean;
    balances: Array<{ asset: string; free: string; locked: string }>;
  }> {
    return this.signedRequest("GET", "/api/v3/account");
  }

  async getOpenOrders(symbol?: string): Promise<Array<{
    symbol: string;
    orderId: number;
    clientOrderId: string;
    price: string;
    origQty: string;
    executedQty: string;
    status: string;
    type: string;
    side: string;
    time: number;
  }>> {
    return this.signedRequest("GET", "/api/v3/openOrders", symbol ? { symbol } : {});
  }

  async getMyTrades(symbol: string, limit = 50): Promise<Array<{
    symbol: string;
    id: number;
    orderId: number;
    price: string;
    qty: string;
    quoteQty: string;
    commission: string;
    commissionAsset: string;
    time: number;
    isBuyer: boolean;
  }>> {
    return this.signedRequest("GET", "/api/v3/myTrades", { symbol, limit });
  }

  async placeMarketOrder(params: {
    symbol: string;
    side: "BUY" | "SELL";
    quoteOrderQty?: number; // USD-belopp (för BUY)
    quantity?: number;       // base-asset-qty (för SELL eller LIMIT)
    clientOrderId?: string;
  }): Promise<{
    orderId: number;
    clientOrderId: string;
    symbol: string;
    side: string;
    status: string;
    executedQty: string;
    cummulativeQuoteQty: string;
    fills?: Array<{ price: string; qty: string; commission: string; commissionAsset: string }>;
  }> {
    const orderParams: Record<string, string | number> = {
      symbol: params.symbol,
      side: params.side,
      type: "MARKET",
    };
    if (params.quoteOrderQty) orderParams.quoteOrderQty = params.quoteOrderQty.toFixed(2);
    if (params.quantity) orderParams.quantity = params.quantity.toFixed(6);
    if (params.clientOrderId) orderParams.newClientOrderId = params.clientOrderId;
    log.info(`[binance-${this.mode}] PLACE ORDER ${params.side} ${params.symbol} ${params.quoteOrderQty ? `$${params.quoteOrderQty}` : `${params.quantity}qty`}`);
    return this.signedRequest("POST", "/api/v3/order", orderParams);
  }

  async cancelOrder(symbol: string, orderId: number): Promise<unknown> {
    return this.signedRequest("DELETE", "/api/v3/order", { symbol, orderId });
  }

  // ─── ORDER- & TRANSFER-historik ───

  async getAllOrders(symbol: string, limit = 100): Promise<Array<{
    symbol: string; orderId: number; clientOrderId: string;
    price: string; origQty: string; executedQty: string; cummulativeQuoteQty: string;
    status: string; type: string; side: string; time: number; updateTime: number;
  }>> {
    return this.signedRequest("GET", "/api/v3/allOrders", { symbol, limit });
  }

  // Insättningshistorik (mainnet bara — testnet stödjer ej /sapi/)
  async getDepositHistory(): Promise<Array<{
    amount: string; coin: string; network: string; status: number;
    address: string; txId: string; insertTime: number; transferType: number;
  }>> {
    if (this.mode === "testnet") return [];
    return this.signedRequest("GET", "/sapi/v1/capital/deposit/hisrec", { limit: 100 });
  }

  // Uttagshistorik (mainnet bara)
  async getWithdrawHistory(): Promise<Array<{
    id: string; amount: string; coin: string; network: string; status: number;
    address: string; txId: string; applyTime: string; transactionFee: string;
  }>> {
    if (this.mode === "testnet") return [];
    return this.signedRequest("GET", "/sapi/v1/capital/withdraw/history", { limit: 100 });
  }

  // ─── WebSocket User Data Stream ───
  // Skapa listenKey (giltig 60 min, måste pingas var 30 min)
  async createListenKey(): Promise<string> {
    const r = await fetch(`${this.baseUrl}/api/v3/userDataStream`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
    if (!r.ok) throw new Error(`createListenKey ${r.status}: ${await r.text()}`);
    const data = (await r.json()) as { listenKey: string };
    return data.listenKey;
  }

  async keepAliveListenKey(listenKey: string): Promise<void> {
    const r = await fetch(`${this.baseUrl}/api/v3/userDataStream?listenKey=${listenKey}`, {
      method: "PUT",
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
    if (!r.ok) throw new Error(`keepAliveListenKey ${r.status}`);
  }

  getWsUrl(): string {
    return this.mode === "testnet" ? "wss://stream.testnet.binance.vision/ws" : "wss://stream.binance.com:9443/ws";
  }

  // ─── Härledda metoder ───

  // Total USDT-värde av kontot — använder BATCH-fetch (1 request för alla priser)
  async getTotalEquity(): Promise<{ cashUsdt: number; cashBreakdown: Array<{ asset: string; amount: number }>; positions: Array<{ asset: string; qty: number; valueUsdt: number }>; totalUsdt: number }> {
    const account = await this.getAccount();
    const nonZero = account.balances.filter((b) => parseFloat(b.free) + parseFloat(b.locked) > 0);
    // Räkna ALLA stablecoins som cash (1:1 USD): USDT, USDC, BUSD, FDUSD, TUSD, DAI, USDP
    const STABLES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDP"];
    let cashUsdt = 0;
    const cashBreakdown: Array<{ asset: string; amount: number }> = [];
    for (const stable of STABLES) {
      const b = nonZero.find((x) => x.asset === stable);
      if (b) {
        const amount = parseFloat(b.free) + parseFloat(b.locked);
        if (amount > 0.01) {
          cashUsdt += amount;
          cashBreakdown.push({ asset: stable, amount });
        }
      }
    }
    // Hämta ALLA priser i ETT anrop (snabbare än per-token)
    let allPrices: Map<string, number> = new Map();
    try {
      const r = await fetch(`${this.baseUrl}/api/v3/ticker/price`);
      if (r.ok) {
        const arr = (await r.json()) as Array<{ symbol: string; price: string }>;
        for (const p of arr) allPrices.set(p.symbol, parseFloat(p.price));
      }
    } catch {
      // fall through — utan priser blir totalUsdt = cashUsdt
    }
    const positions: Array<{ asset: string; qty: number; valueUsdt: number }> = [];
    let totalUsdt = cashUsdt;
    for (const b of nonZero) {
      if (STABLES.includes(b.asset)) continue;
      const qty = parseFloat(b.free) + parseFloat(b.locked);
      const price = allPrices.get(`${b.asset}USDT`);
      if (price && price > 0) {
        const valueUsdt = qty * price;
        positions.push({ asset: b.asset, qty, valueUsdt });
        totalUsdt += valueUsdt;
      }
    }
    // Sortera positioner efter värde (störst först)
    positions.sort((a, b) => b.valueUsdt - a.valueUsdt);
    return { cashUsdt, cashBreakdown, positions, totalUsdt };
  }

  // ─── PORTFOLIO TRADES + REALIZED PnL (FIFO) ───
  // Aggregerar trades för alla symbols där användaren haft volym, beräknar realized PnL via FIFO-matchning
  async getPortfolioTradeStats(): Promise<{
    totalTrades: number;
    closedTrades: number;
    wins: number;
    losses: number;
    realizedPnlUsdt: number;
    feesUsdt: number;
    perSymbol: Array<{ symbol: string; trades: number; realizedPnl: number; wins: number; losses: number }>;
    recentTrades: Array<{ symbol: string; side: string; price: number; qty: number; quoteQty: number; time: number; pnl: number | null }>;
  }> {
    const account = await this.getAccount();
    const STABLES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDP"];
    // Symboler att kolla = alla non-stablecoin assets med någonsin-balans + några bas-pairs
    const candidates = new Set<string>();
    for (const b of account.balances) {
      if (STABLES.includes(b.asset)) continue;
      const total = parseFloat(b.free) + parseFloat(b.locked);
      if (total > 0) candidates.add(`${b.asset}USDT`);
    }
    // Lägg till vanliga par så vi fångar stängda positioner (sålda till 0)
    ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"].forEach((s) => candidates.add(s));

    let allTrades: Array<{ symbol: string; side: "BUY" | "SELL"; price: number; qty: number; quoteQty: number; commission: number; commissionAsset: string; time: number }> = [];
    // Hämta trades parallellt (max 10 åt gången för att inte trigga rate-limit)
    const symbols = Array.from(candidates);
    const batchSize = 8;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map((s) => this.getMyTrades(s, 100)));
      for (let j = 0; j < batch.length; j++) {
        const symbol = batch[j];
        const r = results[j];
        if (r.status !== "fulfilled") continue;
        for (const t of r.value) {
          allTrades.push({
            symbol,
            side: t.isBuyer ? "BUY" : "SELL",
            price: parseFloat(t.price),
            qty: parseFloat(t.qty),
            quoteQty: parseFloat(t.quoteQty),
            commission: parseFloat(t.commission),
            commissionAsset: t.commissionAsset,
            time: t.time,
          });
        }
      }
    }
    allTrades.sort((a, b) => a.time - b.time);

    // FIFO realized PnL per symbol
    const perSymbol = new Map<string, { trades: number; realizedPnl: number; wins: number; losses: number; lots: Array<{ qty: number; price: number }> }>();
    let totalFees = 0;
    const tradedWithPnL: Array<{ symbol: string; side: string; price: number; qty: number; quoteQty: number; time: number; pnl: number | null }> = [];

    for (const t of allTrades) {
      let s = perSymbol.get(t.symbol);
      if (!s) { s = { trades: 0, realizedPnl: 0, wins: 0, losses: 0, lots: [] }; perSymbol.set(t.symbol, s); }
      s.trades++;
      // Approx fee i USDT (commissionAsset varierar — om USDT ta direkt, annars approx via price)
      const feeUsdt = t.commissionAsset === "USDT" ? t.commission : t.commission * t.price;
      totalFees += feeUsdt;

      let tradePnl: number | null = null;
      if (t.side === "BUY") {
        s.lots.push({ qty: t.qty, price: t.price });
      } else {
        // SELL → matcha mot oldest BUY-lots (FIFO)
        let qtyToSell = t.qty;
        let costBasis = 0;
        while (qtyToSell > 0 && s.lots.length > 0) {
          const lot = s.lots[0];
          const taken = Math.min(qtyToSell, lot.qty);
          costBasis += taken * lot.price;
          lot.qty -= taken;
          qtyToSell -= taken;
          if (lot.qty <= 1e-9) s.lots.shift();
        }
        const sellValue = (t.qty - qtyToSell) * t.price;
        tradePnl = sellValue - costBasis - feeUsdt;
        if (tradePnl !== 0) {
          s.realizedPnl += tradePnl;
          if (tradePnl > 0) s.wins++; else s.losses++;
        }
      }
      tradedWithPnL.push({ symbol: t.symbol, side: t.side, price: t.price, qty: t.qty, quoteQty: t.quoteQty, time: t.time, pnl: tradePnl });
    }

    let totalRealized = 0, wins = 0, losses = 0, closedTrades = 0;
    const perSymArr: Array<{ symbol: string; trades: number; realizedPnl: number; wins: number; losses: number }> = [];
    for (const [sym, s] of perSymbol) {
      totalRealized += s.realizedPnl;
      wins += s.wins;
      losses += s.losses;
      closedTrades += s.wins + s.losses;
      perSymArr.push({ symbol: sym, trades: s.trades, realizedPnl: s.realizedPnl, wins: s.wins, losses: s.losses });
    }
    perSymArr.sort((a, b) => Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl));
    // Senaste 20 trades (nyast först)
    const recentTrades = tradedWithPnL.slice(-20).reverse();

    return {
      totalTrades: allTrades.length,
      closedTrades,
      wins,
      losses,
      realizedPnlUsdt: totalRealized,
      feesUsdt: totalFees,
      perSymbol: perSymArr,
      recentTrades,
    };
  }

  // Healthcheck — verifierar API-keys + permissions
  async healthCheck(): Promise<{ ok: boolean; canTrade: boolean; usdtFree: number; details: string }> {
    try {
      const account = await this.getAccount();
      const usdt = account.balances.find((b) => b.asset === "USDT");
      const free = usdt ? parseFloat(usdt.free) : 0;
      return {
        ok: true,
        canTrade: account.canTrade,
        usdtFree: free,
        details: `Binance ${this.mode} OK · canTrade=${account.canTrade} · USDT free $${free.toFixed(2)}`,
      };
    } catch (err) {
      return {
        ok: false,
        canTrade: false,
        usdtFree: 0,
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// Cached client per credential-hash (förhindrar att skapa nya HTTP-clients varje request)
const clientCache = new Map<string, BinanceClient>();

export function getBinanceClient(creds: BinanceCredentials): BinanceClient {
  const key = `${creds.testnet ? "t" : "l"}-${creds.apiKey.slice(0, 8)}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, new BinanceClient(creds));
  }
  return clientCache.get(key)!;
}
