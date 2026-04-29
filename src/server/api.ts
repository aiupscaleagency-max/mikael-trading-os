import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadState, saveState, loadRecentDecisions } from "../memory/store.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import { computeIndicators } from "../indicators/ta.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getCostSummary } from "../cost/tracker.js";
import { handleUpdate as handleTelegramUpdate, sendMessage as sendTelegramMessage, setupWebhook as setupTelegramWebhook } from "./telegram.js";
import { getMarketSnapshot, formatSnapshotForPrompt } from "./marketContext.js";
import { BinanceClient, type BinanceCredentials } from "./integrations/binance.js";
import { OandaClient, type OandaCredentials } from "./integrations/oanda.js";

// In-memory keys (per server-instans). I produktion: kryptera + Supabase.
let binanceCreds: BinanceCredentials | null = null;
let oandaCreds: OandaCredentials | null = null;

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP API + Dashboard server
//
//  Endpoints:
//    GET  /                         → Dashboard HTML
//    GET  /api/status               → Portföljstatus (alla brokers)
//    GET  /api/decisions?limit=20   → Senaste beslut
//    GET  /api/state                → Agent state (kill-switch, PnL, positioner)
//    POST /api/kill-switch          → Toggle kill-switch { active: true/false }
//    GET  /api/brokers              → Lista anslutna brokers + vilken som är aktiv
//    POST /api/active-broker        → Byt aktiv broker { broker: "alpaca"|"binance"|... }
//    GET  /api/events               → SSE-stream (live-uppdateringar)
//    POST /api/ask-agent            → Ställ manuell fråga till valfri agent
//    POST /api/run-agent            → Trigga ny analys-turn
//
//  Inga externa beroenden förutom @anthropic-ai/sdk.
// ═══════════════════════════════════════════════════════════════════════════

// SSE-klienter (Server-Sent Events)
const sseClients: Set<http.ServerResponse> = new Set();

// Runtime broker selection — vilken broker agenten använder som "primär"
let activeBrokerName: string | null = null;

export function getActiveBrokerName(): string | null {
  return activeBrokerName;
}

export function setActiveBrokerName(name: string | null): void {
  activeBrokerName = name;
}

export function broadcastEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Agent system prompts för manuella frågor
const AGENT_PROMPTS: Record<string, { model: string; system: string }> = {
  macro: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Makro-Analytikern i Mikaels trading-team. Du analyserar makroekonomi: VIX, olja, dollar, crypto fear/greed, centralbanker, geopolitik. Svara koncist på svenska.",
  },
  technical: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Teknisk Analytikern i Mikaels trading-team. Du analyserar indikatorer: SMA, RSI, MACD, volym, entry/exit-zoner, bias per symbol. Svara koncist på svenska.",
  },
  sentiment: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Sentiment-Analytikern i Mikaels trading-team. Du analyserar marknadssentiment via Reddit, nyheter, politiker-trades, contrary signals. Svara koncist på svenska.",
  },
  risk: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Risk-Analytikern i Mikaels trading-team. Du bedömer portföljrisk: heat, korrelation, drawdown-scenarier, position sizing. Svara koncist på svenska.",
  },
  quant: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Kvant-Analytikern i Mikaels trading-team. Du analyserar volatilitet, Sharpe, win-rate, trend vs mean-reversion. Svara koncist på svenska.",
  },
  options: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Options-Strategen i Mikaels trading-team. Du analyserar IV-rank, premium selling, roll opportunities, optimal optionsstrategi. Svara koncist på svenska.",
  },
  portfolio: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Portfölj-Strategen i Mikaels trading-team. Du analyserar diversifiering, sektorkoncentration, rebalansering, asset allocation. Svara koncist på svenska.",
  },
  execution: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Exekverings-Optimeraren i Mikaels trading-team. Du optimerar ordertyp (market/limit), timing, DCA vs lump sum, slippage. Svara koncist på svenska.",
  },
  advisor: {
    model: "claude-opus-4-7",
    system: "Du är Claude Advisor i Mikaels trading-team. Du är en strategisk rådgivare som ser helheten: marknadscykler, beteendefinans-fällor, contrarian-perspektiv, blinda fläckar, svansrisker. Du ifrågasätter alltid teamets konsensus. Svara på svenska.",
  },
  forex: {
    model: "claude-haiku-4-5-20251001",
    system: "Du är Viktor — Forex-Specialisten i Mikaels trading-team. Du analyserar valuta-mot-valuta-trades (EUR/USD, GBP/USD, USD/JPY, AUD/USD, NZD/USD, USD/CHF, USD/CAD, EUR/GBP, EUR/JPY, GBP/JPY). Du fokuserar på: centralbanksbeslut (Fed, ECB, BoE, BoJ, RBA, RBNZ, SNB, BoC), räntedifferentialer, DXY (dollar-index), risk-on/risk-off-flöden, carry trades, och geopolitik. Du ger entry/SL/TP per pair, R:R-ratio, och flaggar viktiga events (CPI, NFP, FOMC, ECB, BoJ-intervention). Svara koncist på svenska.",
  },
  head_trader: {
    model: "claude-sonnet-4-6",
    system: "Du är Head Trader i Mikaels trading-team. Du syntetiserar alla specialisters analyser och fattar slutgiltiga handelsbeslut. Du har veto från Risk-analytikern och Advisor. Avsluta alltid med Rule of 3: [1] Regim [2] Action [3] Bevaka. Svara på svenska.",
  },
};

let anthropicApiKey: string | null = null;
let runAgentCallback: ((instruction?: string) => Promise<void>) | null = null;

export function setApiKey(key: string): void {
  anthropicApiKey = key;
}

export function setRunAgentCallback(cb: (instruction?: string) => Promise<void>): void {
  runAgentCallback = cb;
}

export function startServer(
  port: number,
  brokers: Record<string, BrokerAdapter>,
): http.Server {
  const uiDir = path.resolve(import.meta.dirname, "ui");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const method = req.method ?? "GET";

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      // ── SSE stream ──
      if (url.pathname === "/api/events" && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      // ── Status (alla brokers) ──
      if (url.pathname === "/api/status" && method === "GET") {
        const result: Record<string, unknown> = {};
        for (const [name, broker] of Object.entries(brokers)) {
          try {
            const account = await broker.getAccount();
            const positions = await broker.getPositions();
            result[name] = { account, positions, error: null };
          } catch (err) {
            result[name] = { account: null, positions: [], error: String(err) };
          }
        }
        json(res, result);
        return;
      }

      // ── Decisions ──
      if (url.pathname === "/api/decisions" && method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const decisions = await loadRecentDecisions(limit);
        json(res, decisions);
        return;
      }

      // ── State ──
      if (url.pathname === "/api/state" && method === "GET") {
        const state = await loadState();
        json(res, state);
        return;
      }

      // ── Lista brokers ──
      if (url.pathname === "/api/brokers" && method === "GET") {
        const list = Object.entries(brokers).map(([name, broker]) => ({
          name,
          mode: broker.mode,
          active: (activeBrokerName ?? Object.keys(brokers)[0]) === name,
        }));
        json(res, { brokers: list, activeBroker: activeBrokerName ?? Object.keys(brokers)[0] ?? null });
        return;
      }

      // ── Byt aktiv broker ──
      if (url.pathname === "/api/active-broker" && method === "POST") {
        const body = await readBody(req);
        const { broker: name } = JSON.parse(body) as { broker: string };
        if (!brokers[name]) {
          res.writeHead(400);
          json(res, { error: `Broker '${name}' finns inte. Tillgängliga: ${Object.keys(brokers).join(", ")}` });
          return;
        }
        activeBrokerName = name;
        broadcastEvent("broker-changed", { activeBroker: name });
        log.info(`Aktiv broker bytt till: ${name}`);
        json(res, { ok: true, activeBroker: name });
        return;
      }

      // ── Klines (candlestick data) ──
      if (url.pathname === "/api/klines" && method === "GET") {
        const symbol = url.searchParams.get("symbol") ?? "BTCUSDT";
        const interval = url.searchParams.get("interval") ?? "1h";
        const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
        const brokerName = url.searchParams.get("broker") ?? activeBrokerName ?? Object.keys(brokers)[0];
        const broker = brokerName ? brokers[brokerName] : undefined;
        if (!broker) {
          json(res, { error: "Ingen broker tillgänglig" });
          return;
        }
        try {
          const klines = await broker.getKlines(symbol, interval, Math.min(limit, 500));
          const indicators = computeIndicators(klines);
          json(res, { symbol, interval, klines, indicators });
        } catch (err) {
          json(res, { error: String(err), symbol, interval, klines: [] });
        }
        return;
      }

      // ── Ticker ──
      if (url.pathname === "/api/ticker" && method === "GET") {
        const symbol = url.searchParams.get("symbol") ?? "BTCUSDT";
        const brokerName = url.searchParams.get("broker") ?? activeBrokerName ?? Object.keys(brokers)[0];
        const broker = brokerName ? brokers[brokerName] : undefined;
        if (!broker) {
          json(res, { error: "Ingen broker tillgänglig" });
          return;
        }
        try {
          const ticker = await broker.getTicker(symbol);
          json(res, ticker);
        } catch (err) {
          json(res, { error: String(err) });
        }
        return;
      }

      // ── Cost summary (today/week/month + per-agent breakdown) ──
      // ENDAST för admin/owner. När multi-tenant byggs: scope:a per user_id.
      if (url.pathname === "/api/cost" && method === "GET") {
        const summary = await getCostSummary({
          dailyCapUsd: config.costCap.dailyUsd,
          weeklyCapUsd: config.costCap.weeklyUsd,
        });
        json(res, summary);
        return;
      }

      // ── Mode (Paper/Propose/Live) ──
      // GET → returnerar nuvarande mode + executionMode
      // POST → uppdaterar in-memory + persisterar till .env
      // För Live krävs explicit confirmation-array (6-punkts-checklista)
      if (url.pathname === "/api/mode" && method === "GET") {
        json(res, {
          mode: config.mode,
          executionMode: config.executionMode,
          // Härled UI-läge från kombination
          uiMode: config.mode === "paper" ? "paper" :
                  config.executionMode === "approve" ? "propose" : "live",
        });
        return;
      }

      if (url.pathname === "/api/mode" && method === "POST") {
        const body = await readBody(req);
        const { uiMode, confirmation } = JSON.parse(body) as {
          uiMode: "paper" | "propose" | "live";
          confirmation?: { confirmed: boolean[] };
        };

        // Live-läge kräver att alla 6 checklistor är confirmed
        if (uiMode === "live") {
          const allChecked = confirmation?.confirmed?.length === 6 &&
                             confirmation.confirmed.every((c) => c === true);
          if (!allChecked) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Live-läge kräver 6 bekräftelser." }));
            return;
          }
        }

        // Mappa UI-läge → config
        const newMode = uiMode === "paper" ? "paper" : "live";
        const newExecMode = uiMode === "propose" ? "approve" : "auto";

        // Mutera in-memory config — alla framtida agent-anrop använder nya värden
        (config as { mode: string }).mode = newMode;
        (config as { executionMode: string }).executionMode = newExecMode;

        // Persistera till .env så det överlever restart
        try {
          const envPath = "/root/mikael-trading-os/.env";
          const envContent = await fs.readFile(envPath, "utf8").catch(() => "");
          let updated = envContent;
          updated = updated.includes("\nMODE=")
            ? updated.replace(/\nMODE=[^\n]*/, `\nMODE=${newMode}`)
            : updated.replace(/^MODE=[^\n]*/, `MODE=${newMode}`);
          updated = updated.includes("\nEXECUTION_MODE=")
            ? updated.replace(/\nEXECUTION_MODE=[^\n]*/, `\nEXECUTION_MODE=${newExecMode}`)
            : updated + `\nEXECUTION_MODE=${newExecMode}`;
          updated = updated.includes("\nLIVE_TRADING_CONFIRMED=")
            ? updated.replace(/\nLIVE_TRADING_CONFIRMED=[^\n]*/, `\nLIVE_TRADING_CONFIRMED=${newMode === "live" ? "true" : "false"}`)
            : updated + `\nLIVE_TRADING_CONFIRMED=${newMode === "live" ? "true" : "false"}`;
          await fs.writeFile(envPath, updated, "utf8");
        } catch (err) {
          log.warn(`Kunde inte persistera mode till .env: ${err instanceof Error ? err.message : String(err)}`);
        }

        log.warn(`Mode bytt: ${uiMode.toUpperCase()} (mode=${newMode}, exec=${newExecMode}) via dashboard`);
        broadcastEvent("mode-changed", { uiMode, mode: newMode, executionMode: newExecMode });
        json(res, { ok: true, uiMode, mode: newMode, executionMode: newExecMode });
        return;
      }

      // ── Kill-switch ──
      if (url.pathname === "/api/kill-switch" && method === "POST") {
        const body = await readBody(req);
        const { active } = JSON.parse(body) as { active: boolean };
        const state = await loadState();
        state.killSwitchActive = active;
        await saveState(state);
        broadcastEvent("kill-switch", { active });
        log.warn(`Kill-switch ${active ? "AKTIVERAD" : "avaktiverad"} via dashboard`);
        json(res, { ok: true, active });
        return;
      }

      // ── Ask Agent (manuell fråga till valfri agent) ──
      if (url.pathname === "/api/ask-agent" && method === "POST") {
        const body = await readBody(req);
        const { agent, question } = JSON.parse(body) as { agent: string; question: string };

        const agentConfig = AGENT_PROMPTS[agent];
        if (!agentConfig) {
          res.writeHead(400);
          json(res, { error: `Okänd agent: '${agent}'. Tillgängliga: ${Object.keys(AGENT_PROMPTS).join(", ")}` });
          return;
        }
        if (!anthropicApiKey) {
          res.writeHead(500);
          json(res, { error: "ANTHROPIC_API_KEY ej konfigurerad" });
          return;
        }

        log.agent(`[Manual] Fråga till ${agent}: ${question.slice(0, 80)}...`);

        try {
          const client = new Anthropic({ apiKey: anthropicApiKey });

          // Samla kontext för agenten
          const state = await loadState();
          const recentDecisions = await loadRecentDecisions(10);
          const contextData: Record<string, unknown> = {
            killSwitch: state.killSwitchActive,
            dailyPnl: state.dailyRealizedPnlUsdt,
            openPositions: state.openPositions,
            recentDecisions: recentDecisions.map((d) => ({
              action: d.action, symbol: d.symbol, reasoning: d.reasoning.slice(0, 150),
            })),
          };

          // Hämta portföljdata om broker finns
          const activeName = activeBrokerName ?? Object.keys(brokers)[0];
          const broker = activeName ? brokers[activeName] : undefined;
          if (broker) {
            try {
              const [account, positions] = await Promise.all([
                broker.getAccount(), broker.getPositions(),
              ]);
              contextData.account = { totalValueUsdt: account.totalValueUsdt };
              contextData.positions = positions.map((p) => ({
                symbol: p.symbol, qty: p.quantity,
                entry: p.avgEntryPrice, current: p.currentPrice,
                pnl: p.unrealizedPnlUsdt,
              }));
            } catch { /* broker data optional */ }
          }

          const response = await client.messages.create({
            model: agentConfig.model,
            max_tokens: 2000,
            system: `${agentConfig.system}\n\nHär är aktuell kontext:\n${JSON.stringify(contextData)}`,
            messages: [{ role: "user", content: question }],
          });

          const responseText = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");

          log.agent(`[Manual] ${agent} svarade (${responseText.length} tecken)`);
          json(res, { agent, question, response: responseText, model: agentConfig.model });
        } catch (err) {
          log.error(`[Manual] Fel från ${agent}: ${err instanceof Error ? err.message : String(err)}`);
          res.writeHead(500);
          json(res, { error: `Agent-fel: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }

      // ── Run Agent (trigga ny analys-turn, valfritt med Mikes instruktion) ──
      if (url.pathname === "/api/run-agent" && method === "POST") {
        if (!runAgentCallback) {
          res.writeHead(500);
          json(res, { error: "Agent-callback ej konfigurerad" });
          return;
        }

        // Body kan vara tom eller ha {instruction: "Köp BTC för $50"}
        let instruction: string | undefined;
        try {
          const body = await readBody(req);
          if (body) {
            const parsed = JSON.parse(body) as { instruction?: string };
            instruction = parsed.instruction?.trim() || undefined;
          }
        } catch { /* ignore parse fel — kör utan instruktion */ }

        log.info(`[API] Manuell agent-turn triggad${instruction ? ` med instruktion: "${instruction}"` : ""}`);
        json(res, { ok: true, message: "Agent-turn startar...", instruction });

        // Kör async utan att blocka response
        runAgentCallback(instruction).catch((err) => {
          log.error(`Manuell turn misslyckades: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }

      // ── Dashboard HTML ──
      // Servera root-dashboard.html (single source of truth) framför gamla ui/index.html
      if ((url.pathname === "/" || url.pathname === "/dashboard.html") && method === "GET") {
        try {
          const rootDashboard = path.resolve(import.meta.dirname, "../../dashboard.html");
          const html = await fs.readFile(rootDashboard, "utf8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch {
          // Fallback: gamla ui/index.html
          try {
            const html = await fs.readFile(path.join(uiDir, "index.html"), "utf8");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
          } catch {
            res.writeHead(500);
            res.end("Dashboard HTML not found");
          }
        }
        return;
      }

      // ── Cross-device sync (frontend STATE delas mellan dator + mobil) ──
      // Lagrar JSON per clientId i /app/data/sync/{clientId}.json
      if (url.pathname === "/api/sync/save" && method === "POST") {
        const body = await readBody(req);
        try {
          const parsed = JSON.parse(body) as { clientId?: string; state?: unknown };
          if (!parsed.clientId || !parsed.state) {
            res.writeHead(400);
            json(res, { error: "clientId + state krävs" });
            return;
          }
          const clientId = String(parsed.clientId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
          const dir = path.resolve(process.cwd(), "data", "sync");
          await fs.mkdir(dir, { recursive: true });
          const file = path.join(dir, `${clientId}.json`);
          await fs.writeFile(file, JSON.stringify({ updatedAt: Date.now(), state: parsed.state }), "utf8");
          // Broadcast till andra devices via SSE
          broadcastEvent("sync-updated", { clientId, updatedAt: Date.now() });
          json(res, { ok: true, updatedAt: Date.now() });
        } catch (err) {
          res.writeHead(500);
          json(res, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (url.pathname === "/api/sync/load" && method === "GET") {
        const clientId = (url.searchParams.get("clientId") || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
        if (!clientId) {
          res.writeHead(400);
          json(res, { error: "clientId krävs" });
          return;
        }
        try {
          const file = path.resolve(process.cwd(), "data", "sync", `${clientId}.json`);
          const data = await fs.readFile(file, "utf8");
          json(res, JSON.parse(data));
        } catch (err) {
          // Filen finns ej än — returnera tomt
          json(res, { updatedAt: 0, state: null });
        }
        return;
      }

      // ── Telegram webhook ──
      if (url.pathname === "/api/telegram/webhook" && method === "POST") {
        const body = await readBody(req);
        try {
          const update = JSON.parse(body);
          // Helper för att fråga agent (Hanna m.fl.) — INKL live-marknadsdata
          const askAgent = async (agentKey: string, question: string): Promise<string> => {
            if (!anthropicApiKey) return "❌ Anthropic API-nyckel ej konfigurerad i backend.";
            const agentMap: Record<string, string> = {
              hanna: "head_trader",
              tomas: "technical",
              karin: "quant",
              rasmus: "risk",
              markus: "macro",
              petra: "portfolio",
              sara: "sentiment",
              lars: "macro",
              emma: "execution",
              albert: "advisor",
              viktor: "forex",
            };
            const profileKey = agentMap[agentKey] || agentKey;
            const profile = AGENT_PROMPTS[profileKey];
            if (!profile) return `❌ Okänd agent: ${agentKey}`;

            // Hämta live marknadsdata för agenter som behöver det
            // (Hanna/head_trader, technical, quant, forex, advisor, portfolio)
            const wantsMarketData = ["head_trader", "technical", "quant", "forex", "advisor", "portfolio", "risk"].includes(profileKey);
            let systemPrompt = profile.system;
            if (wantsMarketData) {
              try {
                const snap = await getMarketSnapshot();
                if (snap) {
                  const marketBlock = formatSnapshotForPrompt(snap);
                  systemPrompt = `${profile.system}\n\n---\n\n${marketBlock}\n\n**VIKTIGT:** Använd alltid datan ovan när du svarar — det är riktiga live-priser från Binance just nu. Hänvisa till specifika nivåer, RSI-värden, trender. Du HAR realtidsdata. Vägra inte ge konkreta rekommendationer.`;
                }
              } catch (err) {
                log.warn(`Market snapshot misslyckades: ${err instanceof Error ? err.message : String(err)}`);
              }
            }

            // Prompt-caching på system-promten — sparar tokens när Mike frågar flera gånger
            const client = new Anthropic({ apiKey: anthropicApiKey });
            const resp = await client.messages.create({
              model: profile.model,
              max_tokens: 800,
              system: [
                { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
              ],
              messages: [{ role: "user", content: question }],
            });
            const txt = resp.content.find((b) => b.type === "text");
            return txt && "text" in txt ? txt.text : "(inget svar)";
          };
          const getStatus = async (): Promise<string> => {
            const state = await loadState();
            const decisions = await loadRecentDecisions(3);
            const lines = [
              "<b>📊 Status — Mikael Trading OS</b>",
              `Kill-switch: ${state.killSwitchActive ? "🔴 AKTIV" : "🟢 inaktiv"}`,
              `Aktiv broker: ${activeBrokerName ?? "(default)"}`,
              `Senaste beslut:`,
              ...decisions.slice(0, 3).map((d: { symbol?: string; action?: string; amount?: number }) => `• ${d.symbol || "?"} ${d.action || ""} ${d.amount ? `$${d.amount}` : ""}`),
            ];
            return lines.join("\n");
          };
          // Asynkront — svara 200 direkt så Telegram inte retry:ar
          handleTelegramUpdate(update, { askAgent, getStatus }).catch((err) => {
            log.error(`Telegram-handler-fel: ${err instanceof Error ? err.message : String(err)}`);
          });
          json(res, { ok: true });
        } catch (err) {
          log.error(`Telegram webhook parse-fel: ${err instanceof Error ? err.message : String(err)}`);
          json(res, { ok: false });
        }
        return;
      }

      // ── Binance public prices (för PROPOSE-mode — riktiga marknadspriser, ingen auth) ──
      if (url.pathname === "/api/binance/prices" && method === "GET") {
        const symbolsParam = url.searchParams.get("symbols") || "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,DOTUSDT,MATICUSDT";
        const symbols = symbolsParam.split(",").map((s) => s.trim());
        try {
          const url2 = "https://api.binance.com/api/v3/ticker/price";
          const r = await fetch(url2);
          if (!r.ok) {
            json(res, { error: `Binance svarade ${r.status}`, prices: {} });
            return;
          }
          const all = (await r.json()) as Array<{ symbol: string; price: string }>;
          const result: Record<string, number> = {};
          for (const s of symbols) {
            const found = all.find((x) => x.symbol === s);
            if (found) result[s] = parseFloat(found.price);
          }
          json(res, { prices: result, source: "binance-public", at: Date.now() });
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err), prices: {} });
        }
        return;
      }

      // ── Binance public klines (riktiga candlesticks) ──
      if (url.pathname === "/api/binance/klines" && method === "GET") {
        const symbol = url.searchParams.get("symbol") || "BTCUSDT";
        const interval = url.searchParams.get("interval") || "1h";
        const limit = url.searchParams.get("limit") || "100";
        try {
          const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
          if (!r.ok) {
            json(res, { error: `Binance svarade ${r.status}`, candles: [] });
            return;
          }
          const raw = (await r.json()) as Array<Array<string | number>>;
          const candles = raw.map((k) => ({
            time: Math.floor((k[0] as number) / 1000),
            open: parseFloat(k[1] as string),
            high: parseFloat(k[2] as string),
            low: parseFloat(k[3] as string),
            close: parseFloat(k[4] as string),
            volume: parseFloat(k[5] as string),
          }));
          json(res, { symbol, interval, candles, source: "binance-public", at: Date.now() });
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err), candles: [] });
        }
        return;
      }

      // ═══════ BINANCE INTEGRATION (Testnet + Live samma kod) ═══════
      // POST /api/binance/setup — konfigurera API keys (testnet eller mainnet)
      if (url.pathname === "/api/binance/setup" && method === "POST") {
        const body = await readBody(req);
        const { apiKey, apiSecret, testnet } = JSON.parse(body) as { apiKey: string; apiSecret: string; testnet: boolean };
        if (!apiKey || !apiSecret) { res.writeHead(400); json(res, { error: "apiKey + apiSecret krävs" }); return; }
        try {
          const client = new BinanceClient({ apiKey, apiSecret, testnet: !!testnet });
          const hc = await client.healthCheck();
          if (!hc.ok) { json(res, { ok: false, error: hc.details }); return; }
          binanceCreds = { apiKey, apiSecret, testnet: !!testnet };
          json(res, { ok: true, mode: hc.canTrade ? "trading" : "read-only", details: hc.details });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // GET /api/binance/account — riktig balans + positions från Binance API
      if (url.pathname === "/api/binance/account" && method === "GET") {
        if (!binanceCreds) { json(res, { error: "Binance ej konfigurerat — POSTa /api/binance/setup först" }); return; }
        try {
          const client = new BinanceClient(binanceCreds);
          const equity = await client.getTotalEquity();
          json(res, { ok: true, mode: binanceCreds.testnet ? "testnet" : "live", ...equity });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // POST /api/binance/order — lägg riktig MARKET-order
      if (url.pathname === "/api/binance/order" && method === "POST") {
        if (!binanceCreds) { res.writeHead(400); json(res, { error: "Binance ej konfigurerat" }); return; }
        const body = await readBody(req);
        const { symbol, side, quoteOrderQty, clientOrderId } = JSON.parse(body) as { symbol: string; side: "BUY" | "SELL"; quoteOrderQty: number; clientOrderId?: string };
        try {
          const client = new BinanceClient(binanceCreds);
          const order = await client.placeMarketOrder({ symbol, side, quoteOrderQty, clientOrderId });
          json(res, { ok: true, order });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // GET /api/binance/trades?symbol=BTCUSDT — riktig trade-historik
      if (url.pathname === "/api/binance/trades" && method === "GET") {
        if (!binanceCreds) { json(res, { error: "Binance ej konfigurerat" }); return; }
        const symbol = url.searchParams.get("symbol") || "BTCUSDT";
        try {
          const client = new BinanceClient(binanceCreds);
          const trades = await client.getMyTrades(symbol, 50);
          json(res, { ok: true, trades });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // ═══════ OANDA INTEGRATION (forex demo + live) ═══════
      if (url.pathname === "/api/oanda/setup" && method === "POST") {
        const body = await readBody(req);
        const { apiToken, accountId, practice } = JSON.parse(body) as { apiToken: string; accountId: string; practice: boolean };
        if (!apiToken || !accountId) { res.writeHead(400); json(res, { error: "apiToken + accountId krävs" }); return; }
        try {
          const client = new OandaClient({ apiToken, accountId, practice: practice !== false });
          const hc = await client.healthCheck();
          if (!hc.ok) { json(res, { ok: false, error: hc.details }); return; }
          oandaCreds = { apiToken, accountId, practice: practice !== false };
          json(res, { ok: true, details: hc.details });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (url.pathname === "/api/oanda/account" && method === "GET") {
        if (!oandaCreds) { json(res, { error: "Oanda ej konfigurerat" }); return; }
        try {
          const client = new OandaClient(oandaCreds);
          const summary = await client.getAccountSummary();
          const positions = await client.getOpenPositions();
          json(res, { ok: true, mode: oandaCreds.practice ? "practice" : "live", summary, positions });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (url.pathname === "/api/oanda/order" && method === "POST") {
        if (!oandaCreds) { res.writeHead(400); json(res, { error: "Oanda ej konfigurerat" }); return; }
        const body = await readBody(req);
        const { symbol, side, units, clientOrderId } = JSON.parse(body) as { symbol: string; side: "BUY" | "SELL"; units: number; clientOrderId?: string };
        try {
          const client = new OandaClient(oandaCreds);
          const order = await client.placeMarketOrder({ symbol, side, units, clientOrderId });
          json(res, { ok: true, order });
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      // Status båda integrationer (för UI)
      if (url.pathname === "/api/integrations/status" && method === "GET") {
        json(res, {
          binance: binanceCreds ? { configured: true, mode: binanceCreds.testnet ? "testnet" : "live" } : { configured: false },
          oanda: oandaCreds ? { configured: true, mode: oandaCreds.practice ? "practice" : "live" } : { configured: false },
        });
        return;
      }

      // ── 404 ──
      res.writeHead(404);
      res.end("Not found");
    } catch (err) {
      log.error(`Server error: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(500);
      res.end("Internal error");
    }
  });

  server.listen(port, () => {
    log.ok(`Dashboard: http://localhost:${port}`);
    // Sätt upp Telegram-webhook om token finns
    const publicUrl = process.env.PUBLIC_URL || "https://trading.aiupscale.agency";
    if (process.env.TELEGRAM_BOT_TOKEN && publicUrl.startsWith("https://")) {
      setupTelegramWebhook(publicUrl).catch((err) => {
        log.error(`Telegram-webhook setup-fel: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  });

  return server;
}

function json(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
