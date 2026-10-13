import { dataDir, dataPath } from "../dataDir.js";
import type http from "node:http";
import { analysisModeInfo } from "./analysisMode.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { IgBroker } from "../brokers/ig.js";
import { igMarketData } from "./igMarketData.js";
import { getIgStatus } from "../integrations/igConnection.js";
import { log } from "../logger.js";
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
//  Live-lagret: IG-saldo, live-lampor och strategibiblioteket
//
//  Egen fil så att api.ts bara behöver två rader: initLiveLayer() vid start
//  och handleLiveRoutes() i routningen.
//
//    GET  /api/live/status                     → lampor (IG Demo/Live, IG-ström, JEV, AI, strategier)
//    GET  /api/bybit/*                         → 410: plattformen är IG (se /api/ig/* och /api/market/*)
//    GET  /api/strategies                      → biblioteket + vad som går att välja
//    POST /api/strategies                      → ny strategi
//    POST /api/strategies/parse                → "beskriv med egna ord" → regler (AI)
//    POST /api/strategies/backtest             → backtest på IG-historik (högst 500 stängda ljus)
//    POST /api/strategies/:id                  → uppdatera
//    POST /api/strategies/:id/delete           → ta bort
//    POST /api/strategies/:id/test             → vilka regler stämmer just nu
//    POST /api/strategies/:id/reset            → nollställ strategins läge (inne/ute)
//    GET  /api/strategies/signals              → senaste signaler med JEV/AI-bedömning
//    GET  /api/strategies/scoreboard           → poängtavla från TEST-körningen + senaste träning
//    POST /api/strategies/:id/train            → avstängt med IG (för lite historik), ärligt besked
//    POST /api/strategies/:id/apply-training   → använd träningens förslag (det gamla sparas)
//    POST /api/strategies/signals/:id/queue    → lägg som väntande order
//    GET  /api/live/agent-tree                 → arbetsträdet: vem jobbar, var i processen
// ═══════════════════════════════════════════════════════════════════════════

let brokersRef: Record<string, BrokerAdapter> = {};
let parseClient: Anthropic | null = null;

export function initLiveLayer(
  brokers: Record<string, BrokerAdapter>,
  broadcast: (event: string, data: unknown) => void,
): void {
  brokersRef = brokers;
  // IG-kontohändelser (Lightstreamer ACCOUNT/TRADE) vidare till sidan.
  igMarketData.events.on("account", (env: string, a: unknown) => broadcast("ig-account", { env, account: a }));
  igMarketData.events.on("trade", (env: string, t: unknown) => broadcast("ig-trade", { env, trade: t }));
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
  const ig = getIgStatus();
  const env = igMarketData.getActiveEnv();
  const st = igMarketData.streamStatus(env);
  const jev = getJevStatus();
  const runner = getRunnerStatus();
  const envLamp = (e: "demo" | "live") => {
    const x = ig.environments[e];
    return lamp(x.status === "connected", null, `${e === "live" ? "IG Live" : "IG Demo"} · ${x.status === "connected" ? `${x.account?.currency ?? ""} ansluten` : x.credentialsComplete ? (x.error ?? x.status) : "inloggningsuppgifter saknas"}`);
  };
  return {
    time: Date.now(),
    platform: "IG",
    env,
    lamps: {
      igDemo: envLamp("demo"),
      igLive: envLamp("live"),
      igStream: lamp(st.status === "CONNECTED:WS-STREAMING", m.lastFrameMs, `IG Lightstreamer (${env === "live" ? "Live" : "Demo"}) · ${st.status} · ${m.cachedSymbols} kvoter`),
      igCandles: lamp(k.connected, k.lastFrameMs, `IG ljus · ${k.symbols.length} instrument @ ${k.interval} · bara stängda ljus till signaler`),
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
        detail: `${runner.streams.length} instrument/intervall · ${runner.evaluations} körningar`,
      },
    },
    wallet: null,
  };
}

/** Stängda IG-ljus för en strategis "coin" (EPIC). Högst 500 (bufferten); inga påhittade ljus. */
async function igBars(coin: string, interval: string) {
  const epic = pairOf(coin);
  if (!epic) throw new Error(`${coin} finns inte som IG-EPIC i bevakningslistan`);
  // Demo-simulering: Live-instrument som saknas på IG Demo läses från Live
  const env = igMarketData.dataEnv(igMarketData.getActiveEnv(), epic);
  await igMarketData.ensureSeries(env, epic, interval);
  const bars = igMarketData.closed(epic, interval, env);
  if (!bars.length) throw new Error(igMarketData.historyError(epic, interval, env) ?? "historik saknas");
  return bars;
}

// ─── AI: "beskriv med egna ord" → regler ──────────────────────────────────

async function parseStrategyText(text: string): Promise<Record<string, unknown>> {
  if (!hasLlmCredentials()) throw new Error("Ingen AI-nyckel finns (AI_GATEWAY_API_KEY eller ANTHROPIC_API_KEY). Fyll i reglerna själv nedanför.");
  parseClient ??= createLlmClient();
  const model = modelFor("specialist", "claude-haiku-4-5-20251001");
  const system = [
    "Du översätter en trading-strategi som Mike beskriver på svenska till JSON-regler för en regelmotor.",
    "IG CFD: strategin köper (entry) och säljer/stänger (exit).",
    `Tillåtna indikatorer (nycklar): ${Object.entries(INDICATORS).map(([k, v]) => `${k} = ${v}`).join("; ")}.`,
    `Tillåtna operatorer: ${Object.keys(OPERATORS).join(", ")}.`,
    "En regel: {\"left\": indikator, \"op\": operator, \"right\": tal eller indikator, \"factor\": valfri multiplikator när right är en indikator}.",
    "Alla regler i entry måste stämma samtidigt för köp; samma för exit.",
    `interval är ett av: ${INTERVALS.join(", ")}. coins är IG-EPICs från bevakningslistan: ${igMarketData.watchlistDetailed().map((w) => `${w.epic} (${w.name ?? "?"})`).join(", ") || "tom"}.`,
    "stopAtr och targetAtr är avstånd i ATR (standard 1.5 och 3). stakeUsd standard 5.",
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
const TRAIN_FILE = dataPath("strategy-training.json");
const HISTORY_UNUSED: { t?: TrainResult; b?: HistBar; f?: typeof trainStrategy; a?: typeof agentStart; d?: typeof agentDone; e?: typeof agentFail } = {};

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

    // Plattformen är IG: Bybit-adresserna finns kvar men svarar 410 så att inget tyst läser Bybit.
    if (p.startsWith("/api/bybit/")) {
      send(res, 410, { error: "Plattformen är IG. Använd /api/ig/balance, /api/market/watchlist, /api/market/klines och /api/market/stream." });
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
        quote: null,
        platform: "IG",
        watchlist: igMarketData.watchlistDetailed(),
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
      const results = await Promise.all(s.coins.map(async (coin) => {
        try {
          const bars = await igBars(coin, s!.interval);
          return { coin, epic: pairOf(coin), bars: bars.length, source: "IG-historik (högst 500 stängda ljus)", ...backtest(s!, bars) };
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
        const epic = pairOf(coin);
        const q = epic ? igMarketData.quote(epic) : null;
        if (q?.mid) return q.mid;
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
          // IG: träningen behöver tusentals ljus; IG:s historikkvot (REST prices) räcker inte till det
          // utan att äta upp kvoten för diagram och signaler. Därför avstängd, med ärligt besked.
          void HISTORY_UNUSED;
          send(res, 409, { ok: false, error: "Träning är inte tillgänglig med IG: den kräver 500–5000 historiska ljus per instrument och IG:s historikkvot räcker inte. Använd backtest (högst 500 stängda IG-ljus)." });
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
              try { bars = await igBars(coin, s.interval); } catch (err) {
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
