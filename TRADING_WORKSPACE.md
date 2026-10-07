# Trading OS – handelsyta

Standardstart (`npm run agent`, `npm run serve`, `npm run ui`) använder IG-handelsytan på port 3939. Gamla Bybit/Binance-flöden, TP/SL-bevakare och regelbots startar endast med explicit `--legacy`, `--once` eller `--propose`. Äldre API-rutter svarar 410 i standardläget. Agentic-OS, domäner, credentials och serverkonfiguration har inte ändrats.

## Arbetsflöde

- Anslut Demo eller Live separat. Instrument och kontraktsregler hämtas från IG; diagrammet visar IG REST-data och kvotens färskhet. Dokumenterad streaming är inte inkopplad i denna version.
- Starta en session med ett fast instrumenturval. JEV kör först, sedan exakt Teknisk analytiker → Hanna/Head Trader med befintlig modellrouting. Tiingo är historisk kryptoreferens, inte exekveringspris. Saknad forex-mappning visas som otillgängligt referensunderlag.
- En signal kopieras till ett utkast. Varje verklig order kräver manuell granskning, aktuell kontosession och serverberäknad risk. Ingen automatisk öppning från agentsessioner är aktiverad.
- Double up skapar ett nytt utkast med samma storlek/riktning. Roll over förlänger endast en aktiv planerad stängningsbegäran; CFD har ingen fast utbetalning eller utgångstid.
- Designläge aktiveras i Inställningar och använder tydligt märkta lokala exempel. Inga broker-/LLM-anrop görs i detta läge.

## Verifiering och begränsningar

Orderexekvering kräver den befintliga flaggan `IG_ORDER_EXECUTION_ENABLED=true`; flaggan ändras inte av denna leverans. Saknat kontraktsvärde, marginal, aktuellt pris, fullständig daglig P/L eller överskridna riskgränser blockerar order. Riskgränserna är USD och därför tillåter serverns ordermodul endast verifierade USD CFD-konton tills valutakonvertering har implementerats.

MARKET kan ha planerad tidsstängning. LIMIT kräver manuell stängning eftersom kopplingen mellan fyllnadsbekräftelse och ny positionsidentitet ännu inte är implementerad. Tidsplaner återupptas inte automatiskt vid processomstart och avbryts vid kontosessionsbyte eller kill switch. Okänt order-/stängningsutfall omsänds aldrig automatiskt.

IG:s öppna positioner och väntande working orders avstäms mot mäklaren. Transaktionshistoriken kan vara delvis tillgänglig och saknade priser, kostnader och tider visas som okända. P/L-scenarier är brutto när kostnader saknas.

Kör `npx tsc --noEmit` och `npm run test:workspace`. Fabrikstesterna mockar alla IG- och LLM-anrop; webbläsartesterna använder en isolerad HTTP-fixture och testar desktop, laptop och mobil. Verklig orderläggning och betald agentanalys har inte verifierats mot externa tjänster.

## Driftkontroll 2026-10-07

Den befintliga LaunchAgent-processen startades om på port 3939. HTML, JavaScript, CSS och API svarade 200. IG Live-inloggning, konto, positionslista och historik kunde verifieras genom läsanrop. Inga order skickades. Demo har API-nyckel men saknar kompletta inloggningsuppgifter i sin separata credentials-post; Live är komplett. Den befintliga orderflaggan är avstängd.

Agentic-OS:s iframe-kod lämnades orörd. Dess konfigurerade adress `https://aiupscale-dator1.tail64d627.ts.net:9443` kunde inte DNS-resolveras från denna maskin, så inbäddningen kunde inte verifieras här.
