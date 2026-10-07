# Realtid mellan datorerna

Trading OS använder en gemensam backend på dator1. Dator2:s lokala vidarekoppling måste stödja både HTTP och WebSocket Upgrade för att realtidsvyn ska fungera.

## Inför driftsättning

1. Installera och verifiera den nya backendversionen på dator1, inklusive IG:s Lightstreamer-klient och `/api/ig/realtime`.
2. Ersätt dator2:s gamla `~/.local/share/trading-os-access/forward-dashboard.mjs` med repo-filen `scripts/forward-dashboard.mjs` och starta om den befintliga vidarekopplingstjänsten.
3. Behåll upstream `https://aiupscale-dator1.tail64d627.ts.net:9443` och localhost-port 3939 om driftskonfigurationen inte uttryckligen ändras.
4. Kontrollera HTTP 101 för realtidsanslutningen, gemensamt konto/miljö och att ändringar syns i båda vyerna.

Den installerade vidarekopplingen ändras inte automatiskt av en uppdatering av denna repo. Både backend och vidarekoppling måste uppdateras. Den gamla vidarekopplingen fungerar för HTTP men saknar WebSocket Upgrade.

Vidarekopplingen binder endast 127.0.0.1 och tillåter lokala Host/Origin. WebSocket kräver Origin och tillåts endast på `/api/ig/realtime`. Förmedlade identitetshuvuden tas bort innan uppströmsanropet; backendens egna behörighetskontroller gäller fortfarande. TLS-certifikatvalidering är aktiv för produktionsupstream.

Verifiering: `npm run test:forwarder` startar två tillfälliga localhost-servrar och testar HTTP, WebSocket-echo, nekad extern/missing Origin, nekad Host och borttagning av identitetshuvuden. Testet kontaktar inte IG och skickar inga order.

## Scheman och sommartid

Scheman använder Europe/Stockholm. Under höstens dubbla klocktimme körs varje schema högst en gång per lokalt datum och tid. En tid som inte finns vid vårens tidsomställning hoppas över. Missade tider återspelas inte; engångsscheman markeras pausade när tiden har passerat. Serveromstart eller ändrad IG-kontoanslutning kräver uttrycklig återaktivering. Paus/radering före själva sessionsskapandet avbryter även en väntande schemastart.

### Saknad DELAY i PRICE-strömmen

När IG levererar PRICE med saknad DELAY får öppna diagram en separat, läsande REST-kontroll via den gemensamma IG-budgeten och metadatacachen. Kontrollen kräver exakt instrument, `streamingPricesAvailable === true`, TRADEABLE, `delayTime === 0` och färska UTC-/mottagningstider. Den gäller högst 60 sekunder från underlagets klockor; förnyelse försöks tidigast efter 30 sekunder. Endast högst fyra öppna diagram omfattas, inte hela katalogen.

Beviset binds till kontoanslutning och aktuell upstreamanslutning. Avbrott, kontobyte, utgången giltighet eller misslyckad kontroll spärrar kompletteringen. Explicit DELAY från strömmen vinner alltid. Bid/ask och diagramljus fortsätter komma från WebSocket; REST-priser kopieras aldrig in i streamkvoten. UI visar separat REST-verifierad fördröjning och kontrollerar giltighet även mellan tickar. Detta är ingen latensgaranti eller orderaktivering.
