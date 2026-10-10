// ═══════════════════════════════════════════════════════════════════════════
// Koppling av Demo-simuleringen (src/integrations/igDemoSim.ts) till serverns riktiga datakällor.
//   Live-pris och IG:s regler: getIgMarket("live") — LÄSNING, och alltid UTANFÖR orderns läsförtur
//   (withIgPriority), så att övning i Demo aldrig äter Live-orderns reserverade läsbudget.
//   Strömkvoter: igMarketData (Live-strömmen) först; REST bara som reserv.
//   Katalogbelägg: peekIgMarketDirectory (ingen IG-läsning) + en Demo-läsning av EPIC:en vid behov.
// Inget här skriver till IG.
// ═══════════════════════════════════════════════════════════════════════════
import { createIgDemoSim, createDemoSimRouter, type SimMarket, type SimQuote } from "../integrations/igDemoSim.js";
import { getIgMarket } from "../integrations/igMarkets.js";
import { peekIgMarketDirectory } from "../integrations/igMarketDirectory.js";
import { withoutIgPriority } from "../integrations/igConnection.js";
import { igMarketData } from "./igMarketData.js";
import { loadState } from "../memory/store.js";
import { dataPath } from "../dataDir.js";
import { config } from "../config.js";
import { log } from "../logger.js";

const startSek = Number(process.env.IG_DEMO_SIM_START_SEK);

export const igDemoSimRouter = createDemoSimRouter({
  live: (c) => peekIgMarketDirectory("live", c),
  demo: (c) => peekIgMarketDirectory("demo", c),
  probeDemo: (epic) => withoutIgPriority(async () => {
    try { const m = await getIgMarket("demo", epic); return m.epic === epic ? "exists" : "unknown"; }
    catch (e) { return e instanceof Error && e.message === "IG svarade HTTP 404" ? "missing" : "unknown"; }
  }),
});

// Bevakade simulerade instrument i Demo läses från Live (pris, ljus, ström), aldrig från IG Demo.
igMarketData.setLiveSourced((env, epic) => env === "demo" && igDemoSimRouter.liveOnly(epic));

export const igDemoSim = createIgDemoSim({
  market: (epic) => withoutIgPriority(() => getIgMarket("live", epic)) as Promise<SimMarket>,
  streamQuote: (epic) => {
    const q = igMarketData.quote(epic, "live");
    return q ? ({ bid: q.bid, offer: q.offer, receivedAt: q.receivedAt, observedAt: q.observedAt, delayTime: q.delayTime, marketStatus: q.marketStatus } as SimQuote) : null;
  },
  guard: () => loadState(),
  file: dataPath("ig-demo-sim.json"),
  startBalance: Number.isFinite(startSek) && startSek > 0 ? startSek : 100_000,
  maxOpenPositions: config.risk.maxOpenPositions,
});

let timer: NodeJS.Timeout | null = null;
/** TP/SL för simulerade positioner (var 5:e s). Håller Live-strömmen vid liv för deras EPICs. */
export function startIgDemoSim(onClosed?: (t: { dealId: string; epic: string; name: string; reason: string; pnl: number }) => void): void {
  if (timer) return;
  let running = false;
  timer = setInterval(() => {
    if (running) return;
    const epics = igDemoSim.openEpics();
    if (!epics.length) return;
    running = true;
    igMarketData.requestStream(epics, "live");
    void igDemoSim.tick()
      .then((done) => { for (const t of done) { log.trade(`[demo-sim] ${t.reason}: stängde ${t.name} (${t.dealId}) · P/L ${t.pnl.toFixed(2)} ${t.currency}`); onClosed?.(t); } })
      .catch((e) => log.warn(`[demo-sim] TP/SL-varvet misslyckades: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { running = false; });
  }, 5_000);
  timer.unref?.();
}
