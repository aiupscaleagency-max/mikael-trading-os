# Trading OS – handelsyta

Standardstart (`npm run agent`, `npm run serve`, `npm run ui`) använder IG-handelsytan på port 3939. Gamla Bybit/Binance-flöden, TP/SL-bevakare och regelbots startar endast med explicit `--legacy`, `--once` eller `--propose`. Äldre API-rutter svarar 410 i standardläget. Agentic-OS, domäner, credentials och serverkonfiguration har inte ändrats.

## Arbetsflöde

- Anslut Demo eller Live separat. Instrument och kontraktsregler hämtas från IG; diagrammet visar IG REST-data och kvotens färskhet. Dokumenterad streaming är inte inkopplad i denna version.
- Starta en session med ett fast instrumenturval. JEV kör först, sedan exakt Teknisk analytiker → Hanna/Head Trader med befintlig modellrouting. Tiingo är historisk kryptoreferens, inte exekveringspris. Saknad forex-mappning visas som otillgängligt referensunderlag.
- En signal kopieras till ett utkast. Varje verklig order kräver manuell granskning, aktuell kontosession och serverberäknad risk. Ingen automatisk öppning från agentsessioner är aktiverad.
- Double up skapar ett nytt utkast med samma storlek/riktning. Roll over förlänger endast en aktiv planerad stängningsbegäran; CFD har ingen fast utbetalning eller utgångstid.
- Designläge aktiveras i Inställningar och använder tydligt märkta lokala exempel. Inga broker-/LLM-anrop görs i detta läge.

## Verifiering och begränsningar

Orderexekvering kräver den befintliga flaggan `IG_ORDER_EXECUTION_ENABLED=true`; flaggan ändras inte av denna leverans. Saknat kontraktsvärde, marginal, aktuellt pris, fullständig daglig P/L eller överskridna riskgränser blockerar order. Riskgränserna är USD och räknas konservativt till SEK med verifierad USD/SEK bid. Kontraktsrisk, marginal och förlust räknas med ask; positiva P/L-scenarier med bid. Endast verifierade USD/SEK-konton och exekveringsvalutor stöds. Saknad eller äldre än 60 sekunder valutakurs blockerar nya order. Marginalen använder högsta verifierade IG-marginalband och märks som konservativ övre gräns när banden skiljer sig.

MARKET kan ha planerad tidsstängning. LIMIT kräver manuell stängning eftersom kopplingen mellan fyllnadsbekräftelse och ny positionsidentitet ännu inte är implementerad. Tidsplaner återupptas inte automatiskt vid processomstart och avbryts vid kontosessionsbyte eller kill switch. Okänt order-/stängningsutfall omsänds aldrig automatiskt.

IG:s öppna positioner och väntande working orders avstäms mot mäklaren. Transaktionshistoriken kan vara delvis tillgänglig och saknade priser, kostnader och tider visas som okända. P/L-scenarier är brutto när kostnader saknas.

Kör `npx tsc --noEmit` och `npm run test:workspace`. Fabrikstesterna mockar alla IG- och LLM-anrop; webbläsartesterna använder en isolerad HTTP-fixture och testar desktop, laptop och mobil. Verklig orderläggning har inte verifierats. Avgränsad agentanalys har verifierats med befintliga modeller och budget mot externa tjänster; se driftkontrollen nedan.

## Driftkontroll 2026-10-07

Den befintliga LaunchAgent-processen startades om på port 3939. HTML, JavaScript, CSS och API svarade 200. IG Live-inloggning, konto, positionslista och historik kunde verifieras genom läsanrop. Inga order skickades. Demo-nyckeln är aktiv men IG kräver separat Demo-API-användarnamn och lösenord; vanliga webbinloggningen räcker inte. Live-inloggningen är verifierad. Den befintliga orderflaggan är avstängd.

Agentic-OS:s iframe-kod lämnades orörd. Dess konfigurerade adress `https://aiupscale-dator1.tail64d627.ts.net:9443` svarar inte när Tailscale är avstängt, så inbäddningen kunde inte verifieras här.

## Fortsatt verifiering 2026-10-07

En verklig avgränsad analys kördes med befintliga modellval och budget: JEV → Teknisk analytiker → Hanna, med Tiingo-referens status ready. Inga broker-order skickades. V3:s marknadssnapshot har en tidszonlös updateTime, så prisadaptern hämtar nu V4:s uttryckliga UTC-epoch och prisstege när V3 saknar updateTimeUTC. Epoch i sekunder och millisekunder normaliseras; saknad verifierbar tid blockerar fortfarande order och riktade signaler. Extra REST-anrop räknas i läsbudgeten.

Anslutningsknappen visar pågående arbete och bestående fel. Efter lyckad anslutning öppnas första tillgängliga instrument om användaren inte redan gjort ett eget val. Krypto/Forex kräver instrumenttypen CURRENCIES så Bitcoin-aktier och ETF:er inte hamnar i kryptolistan.

IG:s inloggade inställningssida bekräftar att Demo-API kräver separat användarnamn och lösenord. Demo-nyckeln är aktiv, men dessa uppgifter måste skapas av användaren hos IG innan API-demo kan verifieras. Tailscale BackendState är Stopped på datorn och port 9443 svarar inte, vilket hindrar den befintliga Agentic-inbäddningen. Nätverkskonfigurationen har inte ändrats.

Live-kontot är SEK. Forex-kontrakten använder native prisnivåer och punktvärdet valueOfOnePip / onePipMeans, verifierat mot contractSize. scalingFactor omvandlar POINTS-stopavstånd och används inte för att skala kursen på nytt. Instrumentmetadata cachas 300 sekunder, UTC-priskvoter 15 sekunder och faktiska GET-anrop räknas i läsbudgeten. Befintliga riskgränser behålls; ett instruments minsta kontrakt kan överskrida gränsen. Funktionerna ska inte beskrivas som färdigverifierad handel innan Demo-inloggning och ett separat godkänt demoordertest har genomförts.

Slutkontrollen använde verkliga läsanrop mot Live: Bitcoin ($0.1) gav native punktvärde 0,1 USD, EUR/USD 100 000 USD och USD/SEK 100 000 SEK. Bitcoin och EUR/USD omräknades till SEK med samma verifierade USD/SEK bid/ask; EUR/USD-diagrammet visade fem decimaler och orderutkastets risk/mål visades i SEK. TypeScript och alla åtta testsviter passerade. Kontot har inget tillgängligt kapital och inga verkliga order har verifierats.
