import { loadState, saveState } from "../memory/store.js";
import { log } from "../logger.js";

// Manuell kill-switch. `npm run kill on` → stoppar all handel.
// `npm run kill off` → återställer.

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg !== "on" && arg !== "off") {
    console.log("Användning: npm run kill -- on|off");
    process.exit(1);
  }
  const state = await loadState();
  state.killSwitchActive = arg === "on";
  await saveState(state);
  if (arg === "on") {
    log.error("🛑 Kill-switch AKTIVERAD. All framtida handel kommer att blockeras.");
  } else {
    log.ok("Kill-switch avstängd. Agenten får handla igen (inom risk-ramar).");
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
