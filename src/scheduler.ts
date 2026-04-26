import type { Config } from "./config.js";
import { log } from "./logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Scheduler — kör uppgifter vid rätt tid.
//
//  Tre typer av schemalagda händelser:
//  1. Agent-loop: var 5 min (analysera + ev. handla)
//  2. Position-scan: var 15 min (justera trailing stops)
//  3. Morning briefing: kl 09:00 CET (07:00 UTC default)
//  4. Daily P&L: vid marknadsstängning (22:00 UTC)
// ═══════════════════════════════════════════════════════════════════════════

export interface ScheduledTask {
  name: string;
  /** Intervall i sekunder. null = cron-baserad (kör vid specifik tid). */
  intervalSeconds: number | null;
  /** UTC-timme att köra (bara om intervalSeconds === null). */
  runAtHourUtc?: number;
  /** Senast kördes (epoch ms). */
  lastRun: number;
  /** Funktion att köra. */
  execute: () => Promise<void>;
}

export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private running = false;

  addTask(task: ScheduledTask): void {
    this.tasks.push(task);
    log.info(
      `Scheduled: ${task.name} — ` +
        (task.intervalSeconds
          ? `var ${task.intervalSeconds}s`
          : `kl ${task.runAtHourUtc}:00 UTC`),
    );
  }

  async start(): Promise<void> {
    this.running = true;
    log.info(`Scheduler startar med ${this.tasks.length} uppgifter.`);

    process.on("SIGINT", () => {
      log.warn("SIGINT → avslutar scheduler…");
      this.running = false;
    });

    while (this.running) {
      const now = Date.now();

      for (const task of this.tasks) {
        if (this.shouldRun(task, now)) {
          log.info(`▸ Kör: ${task.name}`);
          try {
            await task.execute();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`Fel i ${task.name}: ${msg}`);
          }
          task.lastRun = Date.now();
        }
      }

      // Sov 10s mellan tick. Kort nog att vi fångar minutbaserade triggers.
      if (this.running) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }

    log.ok("Scheduler stoppad.");
  }

  stop(): void {
    this.running = false;
  }

  private shouldRun(task: ScheduledTask, now: number): boolean {
    // Intervall-baserad
    if (task.intervalSeconds !== null) {
      const elapsed = (now - task.lastRun) / 1000;
      return elapsed >= task.intervalSeconds;
    }

    // Tid-baserad: kör en gång per dag vid task.runAtHourUtc
    if (task.runAtHourUtc !== undefined) {
      const currentHour = new Date(now).getUTCHours();
      const lastHour = new Date(task.lastRun).getUTCHours();
      const lastDay = new Date(task.lastRun).getUTCDate();
      const today = new Date(now).getUTCDate();

      // Kör om rätt timme OCH vi inte redan kört idag
      return currentHour === task.runAtHourUtc &&
        (lastDay !== today || lastHour !== task.runAtHourUtc);
    }

    return false;
  }
}

/**
 * Skapar standard-schemat baserat på config.
 * run.ts ansvarar för att fylla i execute-funktionerna.
 */
export function createDefaultSchedule(config: Config): {
  agentLoop: Omit<ScheduledTask, "execute">;
  positionScan: Omit<ScheduledTask, "execute">;
  morningBriefing: Omit<ScheduledTask, "execute">;
  dailyPnl: Omit<ScheduledTask, "execute">;
} {
  return {
    agentLoop: {
      name: "Agent analys-loop",
      intervalSeconds: config.loopIntervalSeconds,
      lastRun: 0,
    },
    positionScan: {
      name: "Position-scan (trailing stop)",
      intervalSeconds: config.scanIntervalSeconds,
      lastRun: 0,
    },
    morningBriefing: {
      name: "Morning Briefing (Rule of 3)",
      intervalSeconds: null,
      runAtHourUtc: config.briefingHourUtc,
      lastRun: 0,
    },
    dailyPnl: {
      name: "Daily P&L-rapport",
      intervalSeconds: null,
      runAtHourUtc: 21, // 21:00 UTC ≈ 23:00 CET, efter US-stängning
      lastRun: 0,
    },
  };
}
