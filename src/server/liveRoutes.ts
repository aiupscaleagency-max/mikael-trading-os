import type http from "node:http";
import { analysisModeInfo } from "./analysisMode.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { BybitBroker } from "../brokers/bybit.js";
import { log } from "../logger.js";
import {
  startBybitPublicStream, startBybitPrivateStream, setBybitWalletFromRest, getBybitWallet,
  subscribeBybitWallet, subscribeBybitOrders, getBybitStreamStatus, fetchBybitCandles,
  getBybitTickers, watchBybitTicker, fetchBybitHistory, getBybitTicker, BYBIT_INTERVAL,
} from "./bybitStream.js";
import { scoreboard, READY_RULES } from "./paperLedger.js";
import { trainStrategy, type TrainResult, type HistBar } from "../strategies/trainer.js";
import fs from "node:fs/promises";
import path from "node:path";
import { getMarketStreamStatus, getCachedPrice } from "./marketStream.js";
import { getKlineStreamStatus } from "./klineStream.js";
import { getLastPrescreen, prescreenEnabled, flaggedPairs } from "../orchestrator/prescreen.js";
import { getTeamLast } from "./teamLast.js";
import { config } from "../config.js";
import { getJevStatus } from "./jevClient.js";
import { snapshot as agentTreeSnapshot, registerStrategies, userAction, agentStart, agentDone, agentFail, getAnalysis } from "./agentActivity.js";
import {
  startStrategyRunner, syncStrategies, getStrategySignals, getStrategyPositions, queueSignal,
  resetStrategyPosition, getRunnerStatus, getRunnerCandles, pairOf,
} from "./strategyRunner.js";
import {
  loadLibrary, upsertStrategy, deleteStrategy, sanitizeStrategy, backtest, evaluateNow,
  INTERVALS, REVIEW_MODELS, type Strategy,
} from "../strategies/library.js";
import { INDICATORS, OPERATORS } from "../strategies/ruleEngine.js";
import { createLlmClient, extractJson, hasLlmCredentials, modelFor, toDirectModel, usingGateway } from "../llm/gateway.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Live-lagret: Bybit-saldo, live-lampor och strategibiblioteket
//
//  Egen fil så att api.ts bara behöver två rader: initLiveLayer() vid start
//  och handleLiveRoutes() i routningen.
//
//    GET  /api/live/status                     → lampor för alla strömmar
//    GET  /api/bybit/balance                   → Unified + Funding (riktiga pengar)
//    GET  /api/bybit/pairs                     → alla spot-par i USDC på Bybit EU
//    GET  /api/strategies                      → biblioteket + vad som går att välja
//    POST /api/strategies                      → ny strategi
//    POST /api/strategies/parse                → "beskriv med egna ord" → regler (AI)
//    POST /api/strategies/backtest             → backtest av en strategi (sparad eller utkast)
//    POST /api/strategies/:id                  → uppdatera
//    POST /api/strategies/:id/delete           → ta bort
//    POST /api/strategies/:id/test             → vilka regler stämmer just nu
//    POST /api/strategies/:id/reset            → nollställ strategins läge (inne/ute)
//    GET  /api/strategies/signals              → senaste signaler med JEV/AI-bedömning
//    GET  /api/strategies/scoreboard           → poängtavla från TEST-körningen + senaste träning
//    POST /api/strategies/:id/train            → träna (prova varianter, kontroll på osedd data)
//    POST /api/strategies/:id/apply-training   → använd träningens förslag (det gamla sparas)
//    POST /api/strategies/signals/:id/queue    → lägg som väntande order
//    GET  /api/live/agent-tree                 → arbetsträdet: vem jobbar, var i processen
// ═══════════════════════════════════════════════════════════════════════════

let brokersRef: Record<string, BrokerAdapter> = {};
let walletRefreshedAt = 0;
let pairsCache: { at: number; pairs: string[] } | null = null;
let parseClient: Anthropic | null = null;

function bybit(): BybitBroker | null {
  const b = brokersRef.bybit;
  return b instanceof BybitBroker ? b : null;
}

async function refreshWalletRest(): Promise<void> {
  const b = bybit();
  if (!b) return;
  try {
    const raw = await b.getWalletRaw();
    if (raw) setBybitWalletFromRest(raw);
    walletRefreshedAt = Date.now();
  } catch (err) {
    log.warn(`[bybit] saldo via REST misslyckades: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function initLiveLayer(
  brokers: Record<string, BrokerAdapter>,
  broadcast: (event: string, data: unknown) => void,
): void {
  brokersRef = brokers;
  startBybitPublicStream();
  // Priser för de vanligaste paren, så att live-lampan och tickern visar
  // något även innan en strategi slagits på.
  for (const c of ["BTC", "ETH", "SOL"]) watchBybitTicker(pairOf(c));

  if (bybit()) {
    startBybitPrivateStream();
    void refreshWalletRest();
  }
  subscribeBybitWallet((w) => broadcast("bybit-wallet", w));
  subscribeBybitOrders((o) => broadcast("bybit-order", o));
  void startStrategyRunner(brokers, broadcast).catch((err) =>
    log.warn(`[strategi] start misslyckades: ${err instanceof Error ? err.message : String(err)}`));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); if (body.length > 200_000) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function bodyJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

// ─── Status ───────────────────────────────────────────────────────────────

function lamp(connected: boolean, agoMs: number | null, detail: string) {
  const ago = agoMs != null && agoMs >= 0 ? agoMs : null;
  return { connected: connected && (ago == null || ago < 90_000), lastMessageAgoMs: ago, detail };
}

function liveStatus() {
  const m = getMarketStreamStatus();
  const k = getKlineStreamStatus();
  const by = getBybitStreamStatus();
  const jev = getJevStatus();
  const runner = getRunnerStatus();
  const w = getBybitWallet();
  return {
    time: Date.now(),
    lamps: {
      bybitPrices: lamp(m.connected, m.lastFrameMs, `Bybit EU priser · ${m.cachedSymbols} par`),
      bybitCandles: lamp(k.connected, k.lastFrameMs, `Bybit EU ljus · ${k.symbols.length} par @ ${k.interval}`),
      bybitMarket: lamp(by.public.connected, by.public.lastMessageAgoMs, `Bybit priser + ljus · ${by.public.detail}`),
      bybitAccount: lamp(by.private.connected, by.private.lastMessageAgoMs, `Bybit konto · ${by.private.detail}`),
      jev: {
        connected: jev.route !== "rules_only" && !jev.circuitOpen,
        lastMessageAgoMs: null,
        detail: jev.route === "rules_only" ? "ingen JEV-nyckel — bara regler" : `JEV via ${jev.route}${jev.circuitOpen ? " · pausad efter fel" : ""}`,
      },
      ai: {
        connected: hasLlmCredentials(),
        lastMessageAgoMs: null,
        detail: !hasLlmCredentials() ? "ingen AI-nyckel" : usingGateway() ? "AI-modeller via gateway (Claude, GPT m.fl.)" : "Claude direkt (bara Claude-modeller)",
      },
      strategies: {
        connected: runner.started,
        lastMessageAgoMs: runner.lastEvalAt ? Date.now() - runner.lastEvalAt : null,
        detail: `${runner.streams.length} par/intervall · ${runner.evaluations} körningar`,
      },
    },
    wallet: w,
  };
}

// ─── Saldo ────────────────────────────────────────────────────────────────

async function balance(refresh: boolean) {
  const b = bybit();
  if (!b) return { connected: false, error: "Bybit är inte kopplat (BYBIT_API_KEY saknas i .env)" };
  const w0 = getBybitWallet();
  if (refresh || !w0 || (w0.source === "rest" && Date.now() - walletRefreshedAt > 60_000)) await refreshWalletRest();
  const unified = getBybitWallet();
  let funding: { coins: Array<{ coin: string; balance: number; usdValue: number }>; totalUsd: number } | null = null;
  let fundingError: string | null = null;
  try {
    const coins = await b.getFundingBalances();
    funding = { coins, totalUsd: coins.reduce((a, c) => a + c.usdValue, 0) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fundingError = /permission|10005|denied|not.*auth/i.test(msg)
      ? "Nyckeln saknar läsrätt för Funding. Bocka i Assets → Wallet (Read) på nyckeln hos Bybit."
      : msg.slice(0, 200);
  }
  return {
    connected: true,
    quote: "USDC",
    unified,
    funding,
    fundingError,
    totalUsd: (unified?.totalEquityUsd ?? 0) + (funding?.totalUsd ?? 0),
    tradableUsd: unified?.totalEquityUsd ?? 0,
  };
}

async function bybitPairs(): Promise<string[]> {
  if (pairsCache && Date.now() - pairsCache.at < 3_600_000) return pairsCache.pairs;
  const quote = "USDC";
  const base = "https://api.bybit.eu";
  const res = await fetch(`${base}/v5/market/instruments-info?category=spot&limit=1000`);
  const body = (await res.json()) as { result?: { list?: Array<{ baseCoin: string; quoteCoin: string; status: string }> } };
  const pairs = (body.result?.list ?? [])
    .filter((x) => x.quoteCoin === quote && x.status === "Trading")
    .map((x) => x.baseCoin)
    .sort();
  pairsCache = { at: Date.now(), pairs };
  return pairs;
}

// ─── AI: "beskriv med egna ord" → regler ──────────────────────────────────

async function parseStrategyText(text: string): Promise<Record<string, unknown>> {
  if (!hasLlmCredentials()) throw new Error("Ingen AI-nyckel finns (AI_GATEWAY_API_KEY eller ANTHROPIC_API_KEY). Fyll i reglerna själv nedanför.");
  parseClient ??= createLlmClient();
  const model = modelFor("specialist", "claude-haiku-4-5-20251001");
  const system = [
    "Du översätter en trading-strategi som Mike beskriver på svenska till JSON-regler för en regelmotor.",
    "Spot-handel: bara köp (entry) och sälj (exit). Ingen blankning.",
    `Tillåtna indikatorer (nycklar): ${Object.entries(INDICATORS).map(([k, v]) => `${k} = ${v}`).join("; ")}.`,
    `Tillåtna operatorer: ${Object.keys(OPERATORS).join(", ")}.`,
    "En regel: {\"left\": indikator, \"op\": operator, \"right\": tal eller indikator, \"factor\": valfri multiplikator när right är en indikator}.",
    "Alla regler i entry måste stämma samtidigt för köp; samma för exit.",
    `interval är ett av: ${INTERVALS.join(", ")}. coins är bas-coins som BTC, ETH, SOL.`,
    "stopAtr och targetAtr är avstånd i ATR (standard 1.5 och 3). Insatsen väljs som procent av kontovärdet, standard 1 %.",
    "Hittar du inte på en regel som passar, välj den närmaste och förklara i description.",
    "Svara ENDAST med JSON: {\"name\",\"description\",\"coins\",\"interval\",\"entry\",\"exit\",\"stopAtr\",\"targetAtr\",\"stakeUsd\"}",
  ].join("\n");
  const res = (await parseClient.messages.create({
    model: usingGateway() ? model : toDirectModel(model),
    max_tokens: 1200,
    system,
    messages: [{ role: "user", content: text.slice(0, 2000) }],
  })) as Anthropic.Message;
  const out = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  return JSON.parse(extractJson(out)) as Record<string, unknown>;
}

// ─── Routning ─────────────────────────────────────────────────────────────

/** Returnerar true om requesten hanterades. */
// ─── Träningsresultat (senaste per strategi) ─────────────────────────────

type StoredTraining = TrainResult & { errors?: Record<string, string>; appliedAt?: string; previous?: unknown };
const TRAIN_FILE = path.resolve(process.cwd(), "data", "strategy-training.json");
const training = new Set<string>();

async function readTrainings(): Promise<Record<string, StoredTraining>> {
  try { return JSON.parse(await fs.readFile(TRAIN_FILE, "utf8")) as Record<string, StoredTraining>; } catch { return {}; }
}

async function writeTrainings(all: Record<string, StoredTraining>): Promise<void> {
  await fs.mkdir(path.dirname(TRAIN_FILE), { recursive: true });
  await fs.writeFile(`${TRAIN_FILE}.tmp`, JSON.stringify(all, null, 1), "utf8");
  await fs.rename(`${TRAIN_FILE}.tmp`, TRAIN_FILE);
}

export async function handleLiveRoutes(
  url: URL,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/live/") && !p.startsWith("/api/bybit/") && !p.startsWith("/api/strategies") && !p.startsWith("/api/team/")) return false;

  try {
    if (p === "/api/live/status" && method === "GET") { send(res, 200, liveStatus()); return true; }

    // Senaste analysen ("Kör analys" eller schemat): vad agenterna kom fram till.
    if (p === "/api/team/last" && method === "GET") { send(res, 200, { team: getTeamLast() }); return true; }
    if (p === "/api/live/analysis" && method === "GET") { send(res, 200, { analysis: getAnalysis() }); return true; }

    // Vad som analyseras: agenternas mynt, hur ofta, och vilka par signaltabellen följer.
    if (p === "/api/live/watchlist" && method === "GET") {
      const k = getKlineStreamStatus();
      send(res, 200, {
        agentSymbols: config.crypto.symbols,
        loopMinutes: Math.round(config.loopIntervalSeconds / 60),
        analysis: analysisModeInfo(),
        signalSymbols: k.symbols,
        signalInterval: k.interval,
        // Försållning: vilka par AI-teamet skulle titta på just nu, och senaste turen
        prescreen: {
          enabled: prescreenEnabled(),
          flaggedNow: flaggedPairs(config.crypto.symbols).flagged,
          lastTurn: getLastPrescreen(),
        },
      });
      return true;
    }

    if (p === "/api/live/agent-tree" && method === "GET") {
      registerStrategies(await loadLibrary());
      send(res, 200, agentTreeSnapshot(Number(url.searchParams.get("limit")) || 120));
      return true;
    }

    if (p === "/api/bybit/balance" && method === "GET") {
      send(res, 200, await balance(url.searchParams.get("refresh") === "1"));
      return true;
    }

    if (p === "/api/bybit/pairs" && method === "GET") {
      try { send(res, 200, { pairs: await bybitPairs() }); }
      catch (err) { send(res, 200, { pairs: [], error: err instanceof Error ? err.message : String(err) }); }
      return true;
    }

    // Senaste pris per par från Bybit (serverns WebSocket-cache, REST som reserv).
    // Enbart Bybit EU-priser för dashboarden.
    if (p === "/api/bybit/prices" && method === "GET") {
      const symbols = (url.searchParams.get("symbols") || config.crypto.symbols.join(","))
        .split(",").map((x) => x.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean).slice(0, 50);
      const prices: Record<string, number> = {};
      const missing: string[] = [];
      for (const s of symbols) { const px = getCachedPrice(s); if (px) prices[s] = px; else missing.push(s); }
      if (missing.length) {
        for (const base of ["https://api.bybit.eu"]) {
          try {
            const r = await fetch(`${base}/v5/market/tickers?category=spot`);
            const body = (await r.json()) as { retCode: number; result?: { list?: Array<{ symbol: string; lastPrice: string }> } };
            if (!r.ok || body.retCode !== 0 || !body.result?.list) continue;
            const bySym = new Map(body.result.list.map((t) => [t.symbol, Number(t.lastPrice)]));
            for (const s of missing) { const px = bySym.get(s); if (px && px > 0) prices[s] = px; }
            break;
          } catch { /* prova nästa adress */ }
        }
      }
      send(res, 200, { prices, source: "bybit", at: Date.now() });
      return true;
    }

    if (p === "/api/bybit/tickers" && method === "GET") { send(res, 200, { tickers: getBybitTickers() }); return true; }

    // Diagrammets ljus från Bybit (samma som TradingView med Bybit valt). Bara publik
    // marknadsdata, ingen nyckel. Det pågående ljuset är med; sidan håller det
    // levande via Bybits WebSocket.
    if (p === "/api/bybit/klines" && method === "GET") {
      const symbol = (url.searchParams.get("symbol") || "BTCUSDC").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const iv = BYBIT_INTERVAL[url.searchParams.get("interval") || "1m"];
      const limit = Math.min(1000, Math.max(10, Number(url.searchParams.get("limit")) || 300));
      if (!iv || !/^[A-Z0-9]{2,16}USDC$/.test(symbol)) { send(res, 400, { error: "okänt intervall", klines: [] }); return true; }
      let lastErr = "";
      // USDC-par = samma marknad som på bybit.eu: fråga Bybit EU först

      const bases = ["https://api.bybit.eu"];
      for (const base of bases) {
        try {
          const r = await fetch(`${base}/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&limit=${limit}`);
          const body = (await r.json()) as { retCode: number; retMsg: string; result?: { list?: string[][] } };
          if (!r.ok || body.retCode !== 0 || !body.result?.list?.length) { lastErr = `${base}: ${body.retMsg || r.status}`; continue; }
          const klines = body.result.list.slice().reverse().map((k) => ({
            time: Math.floor(Number(k[0]) / 1000),
            open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]),
          }));
          send(res, 200, { symbol, klines, source: base.includes(".eu") ? "bybit-eu" : "bybit", at: Date.now() });
          return true;
        } catch (err) { lastErr = `${base}: ${err instanceof Error ? err.message : String(err)}`; }
      }
      send(res, 502, { symbol, klines: [], source: "bybit-eu", error: lastErr });
      return true;
    }

    if (p === "/api/strategies" && method === "GET") {
      send(res, 200, {
        strategies: await loadLibrary(),
        positions: getStrategyPositions(),
        indicators: INDICATORS,
        operators: OPERATORS,
        intervals: INTERVALS,
        models: REVIEW_MODELS,
        quote: "USDC",
        runner: getRunnerStatus(),
      });
      return true;
    }

    if (p === "/api/strategies" && method === "POST") {
      const r = await upsertStrategy(await bodyJson(req));
      if (r.ok) { await syncStrategies(); userAction(`skapade strategin ${r.strategy.name}`, { to: `strategy:${r.strategy.id}` }); }
      send(res, r.ok ? 200 : 400, r);
      return true;
    }

    if (p === "/api/strategies/parse" && method === "POST") {
      const b = await bodyJson(req);
      const text = String(b.text ?? "").trim();
      if (text.length < 5) { send(res, 400, { ok: false, error: "Beskriv strategin med några ord." }); return true; }
      try {
        const draft = await parseStrategyText(text);
        const checked = sanitizeStrategy({ ...draft, sourceText: text, enabled: false });
        send(res, 200, checked.ok
          ? { ok: true, draft: checked.strategy }
          : { ok: false, error: `AI:n gav ofullständiga regler: ${checked.error}`, raw: draft });
      } catch (err) {
        send(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (p === "/api/strategies/backtest" && method === "POST") {
      const b = await bodyJson(req);
      let s: Strategy | undefined;
      if (typeof b.id === "string") s = (await loadLibrary()).find((x) => x.id === b.id);
      else {
        const r = sanitizeStrategy((b.strategy as Record<string, unknown>) ?? {});
        if (!r.ok) { send(res, 400, r); return true; }
        s = r.strategy;
      }
      if (!s) { send(res, 404, { ok: false, error: "Strategin finns inte" }); return true; }
      const limit = Math.min(1000, Math.max(100, Number(b.limit) || 1000));
      const results = await Promise.all(s.coins.map(async (coin) => {
        try {
          const bars = await fetchBybitCandles(pairOf(coin), s!.interval, limit);
          return { coin, ...backtest(s!, bars) };
        } catch (err) {
          return { coin, error: err instanceof Error ? err.message : String(err) };
        }
      }));
      send(res, 200, { ok: true, interval: s.interval, results });
      return true;
    }

    if (p === "/api/strategies/scoreboard" && method === "GET") {
      const lib = await loadLibrary();
      const trained = await readTrainings();
      const priceOf = (coin: string) => {
        const t = getBybitTicker(pairOf(coin));
        if (t?.price) return t.price;
        const c = lib.map((s) => getRunnerCandles(coin, s.interval)).find((x) => x.length);
        return c?.[c.length - 1]?.close ?? null;
      };
      send(res, 200, {
        rules: READY_RULES,
        rows: lib.map((s) => {
          const t = trained[s.id];
          return {
            name: s.name, enabled: s.enabled, venue: s.venue, coins: s.coins, interval: s.interval,
            ...scoreboard(s.id, priceOf),
            training: t ? {
              trainedAt: t.trainedAt, verdict: t.verdict, verdictText: t.verdictText, variantsTested: t.variantsTested,
              current: t.current, best: t.best, applied: Boolean(t.appliedAt),
            } : null,
          };
        }),
      });
      return true;
    }

    {
      const m = p.match(/^\/api\/strategies\/([0-9a-f-]{36})\/(train|apply-training|training)$/);
      if (m) {
        const id = m[1]!;
        const action = m[2];
        const s = (await loadLibrary()).find((x) => x.id === id);
        if (!s) { send(res, 404, { ok: false, error: "Strategin finns inte" }); return true; }
        if (action === "training" && method === "GET") {
          send(res, 200, { ok: true, training: (await readTrainings())[id] ?? null });
          return true;
        }
        if (action === "train" && method === "POST") {
          if (training.has(id)) { send(res, 409, { ok: false, error: "Strategin tränas redan, vänta en stund." }); return true; }
          training.add(id);
          userAction(`tränar strategin ${s.name}`, { to: `strategy:${id}` });
          try {
            const b = await bodyJson(req);
            const candles = Math.min(5000, Math.max(500, Number(b.candles) || 3000));
            const history: Record<string, HistBar[]> = {};
            const errors: Record<string, string> = {};
            await Promise.all(s.coins.map(async (coin) => {
              try { history[coin] = await fetchBybitHistory(pairOf(coin), s.interval, candles); }
              catch (err) { errors[coin] = err instanceof Error ? err.message : String(err); }
            }));
            // Mikes krav 2026-10-01: minst 10 affärer per dag. Kan ändras i dashboarden eller med TRAIN_MIN_TRADES_PER_DAY.
            const perDayRaw = b.minTradesPerDay ?? process.env.TRAIN_MIN_TRADES_PER_DAY ?? 10;
            const minTradesPerDay = Math.min(500, Math.max(0, Number(perDayRaw) || 0));
            // Träningen syns i arbetsträdet: strategins ruta (och dess agent) jobbar tills den är klar.
            const variants = Math.min(600, Math.max(20, Number(b.variants) || 300));
            agentStart(`strategy:${id}`, `tränar ${variants} varianter på ${Object.keys(history).length} coins`, { from: s.agent ?? undefined });
            let result: TrainResult;
            try { result = trainStrategy(s, history, { maxVariants: variants, minTradesPerDay }); }
            catch (err) { agentFail(`strategy:${id}`, `träningen misslyckades: ${err instanceof Error ? err.message : String(err)}`); throw err; }
            agentDone(`strategy:${id}`, `träning klar: ${result.verdict} (${result.variantsTested} varianter)`);
            const all = await readTrainings();
            all[id] = { ...result, errors };
            await writeTrainings(all);
            log.info(`[träning] ${s.name}: ${result.variantsTested} varianter på ${result.ms} ms — ${result.verdict}`);
            send(res, 200, { ...result, errors });
          } finally {
            training.delete(id);
          }
          return true;
        }
        if (action === "apply-training" && method === "POST") {
          const all = await readTrainings();
          const t = all[id];
          if (!t || t.verdict !== "bättre") { send(res, 400, { ok: false, error: "Det finns inget godkänt förslag att använda." }); return true; }
          // Det gamla sparas i träningsfilen så att det går att gå tillbaka.
          const previous = { entry: s.entry, exit: s.exit, stopAtr: s.stopAtr, targetAtr: s.targetAtr };
          const r = await upsertStrategy({ ...t.best.params }, id);
          if (r.ok) userAction(`använde träningsförslaget för ${s.name}`, { to: `strategy:${id}` });
          if (!r.ok) { send(res, 400, r); return true; }
          all[id] = { ...t, appliedAt: new Date().toISOString(), previous };
          await writeTrainings(all);
          await syncStrategies();
          send(res, 200, { ok: true, strategy: r.strategy, previous });
          return true;
        }
      }
    }

    if (p === "/api/strategies/signals" && method === "GET") {
      const limit = Math.min(300, Number(url.searchParams.get("limit")) || 50);
      send(res, 200, { signals: getStrategySignals(limit, url.searchParams.get("strategyId") ?? undefined) });
      return true;
    }

    {
      const m = p.match(/^\/api\/strategies\/signals\/([0-9a-f-]{36})\/queue$/);
      if (m && method === "POST") {
        const b = await bodyJson(req);
        const venue = b.venue === "live" ? "live" : b.venue === "test" ? "test" : undefined;
        send(res, 200, await queueSignal(m[1]!, venue));
        return true;
      }
    }

    {
      const m = p.match(/^\/api\/strategies\/([0-9a-f-]{36})(?:\/(delete|test|reset))?$/);
      if (m && method === "POST") {
        const id = m[1]!;
        const action = m[2];
        if (action === "delete") {
          const ok = await deleteStrategy(id);
          if (ok) userAction("tog bort en strategi", { to: `strategy:${id}` });
          resetStrategyPosition(id);
          send(res, ok ? 200 : 404, { ok });
          return true;
        }
        if (action === "reset") {
          const b = await bodyJson(req);
          resetStrategyPosition(id, typeof b.coin === "string" ? b.coin : undefined);
          send(res, 200, { ok: true });
          return true;
        }
        if (action === "test") {
          const s = (await loadLibrary()).find((x) => x.id === id);
          if (!s) { send(res, 404, { ok: false, error: "Strategin finns inte" }); return true; }
          const positions = getStrategyPositions();
          const results = await Promise.all(s.coins.map(async (coin) => {
            let bars = getRunnerCandles(coin, s.interval);
            if (bars.length < 50) {
              try { bars = await fetchBybitCandles(pairOf(coin), s.interval, 500); } catch (err) {
                return { coin, error: err instanceof Error ? err.message : String(err) };
              }
            }
            const last = bars[bars.length - 1];
            return { coin, inPosition: Boolean(positions[`${s.id}:${coin}`]), candleCloseTime: last?.closeTime ?? null, ...evaluateNow(s, bars) };
          }));
          send(res, 200, { ok: true, results });
          return true;
        }
        const r = await upsertStrategy(await bodyJson(req), id);
        if (r.ok) { await syncStrategies(); userAction(`ändrade strategin ${r.strategy.name} (${r.strategy.enabled ? "på" : "av"})`, { to: `strategy:${id}` }); }
        send(res, r.ok ? 200 : 400, r);
        return true;
      }
    }

    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[live-api] ${method} ${p}: ${msg}`);
    send(res, 500, { ok: false, error: msg.slice(0, 300) });
    return true;
  }
}
