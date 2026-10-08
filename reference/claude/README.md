# Claude Trading OS med IG

`dashboard.html` i denna katalog är orörd referens från commit b32f604b239c418c9baf7d96bdcdfc6ce91a65b3: återställd Claude-version före senare Codex-ändringar. Referensfilen körs inte av tjänsten.

Rotens `dashboard.html` bevarar den ursprungliga handelsytans HTML/CSS och sidomeny. Den gamla JavaScript-handelsmotorn är ersatt av `src/server/ui/claude/app.mjs`, som anropar befintlig IG-backend genom en separat gateway. Det är en port av handelsytan och IG-stödda funktioner, inte en kopia som kör den tidigare Bybit-motorn.

Separat start: `node scripts/serve-claude-ig.mjs` (localhost:3938). Gatewayn använder samma IG-backend på dator1:9443 som nuvarande handelsyta, och inga lokala credentials. Båda vyerna delar därför konton, positioner, agenter, bibliotek och sessionsstatus.

Nuvarande handelsyta kan fortfarande öppnas genom `/workspace` på befintlig IG-tjänst. Agentic OS har separata kategorier `/trading` och `/trading-claude`.

Verifiera gatewayn med `node scripts/test-claude-ig-gateway.mjs`. Browserfixturen ligger i `src/server/ui/claude/browser-test.mjs`. Ingen verklig order behövs för dessa tester.

Begränsningar ska visas i Claude-ytans inställningar: gamla mäklarspecifika spot-/optionsfunktioner stöds inte direkt av IG, extra diagram visar historiksnapshots, katalogens fullständighet är beroende av gemensam IG-backend, och fil-/länkbaserad research är inte automatisk modellträning. Originalets knappar innebär inte att IG erbjuder samma ordertyp.
