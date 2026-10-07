# Trading OS – handelsyta

Standardstart (`npm run agent`, `npm run serve`, `npm run ui`) använder IG-handelsytan på port 3939. Gamla Bybit/Binance-flöden, TP/SL-bevakare och regelbots startar endast med explicit `--legacy`, `--once` eller `--propose`. Äldre API-rutter svarar 410 i standardläget. Agentic-OS, domäner, credentials och serverkonfiguration har inte ändrats.

## Arbetsflöde

- Anslut Demo eller Live separat. Instrument och kontraktsregler hämtas från IG; diagrammet startar med IG REST-historik och uppdateras via IG Lightstreamer/WebSocket. Se aktuell synkarkitektur nedan; tidigare driftkontroller är historik.
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

## Kategorier och miljöbyte 2026-10-07

Instrumentväljaren innehåller Forex, Kryptovalutor och Favoriter, lokal sökning, diagramöppning och gemensamt analysurval (högst 10 instrument). Katalogen bygger på IG-kontosökningar över valutakoder och kryptonamn, inte enbart EUR/Bitcoin. IG:s äldre marketnavigation svarade 404; katalogen märks därför sökbaserad och fullständigheten garanteras inte. Delresultat, kvotstopp och återupptagning visas tydligt. Katalogen stannar vid 24 använda GET i arbetsytans minutbudget och reserverar 16 för andra underlag.

Explicit byte mellan Demo och Live använder respektive befintliga nyckel och HTTPS-API, med en anslutningsbegäran per användarbyte. Ingen automatisk fallback från Demo till Live. Förväntat CFD-konto verifieras från privata konfigurationens accountId; fel konto blockerar anslutning. Webbläsarens localhost/Tailscale-adress används inte som IG-API-adress.

En valfri lokal IG-inloggningsform finns i Inställningar. Den kräver loopback-socket, localhost-host, samma origin och JSON. Tomma fält bevarar befintliga uppgifter, kontomappning och den andra miljön. Uppgifter sparas atomiskt i användarägd privat 600-fil. Inga lösenord eller nycklar skickas tillbaka eller lagras i webbläsaren. IG-inloggning som nekas visas separat från lyckad lokal sparning.

Tillfälliga IG-läskvoter bevarar verifierad session men ger inget färskt konto- eller positionsunderlag. Ordergrinden kräver ett nytt lyckat kontosvar. Planerad stängning väntar minst 60 sekunder efter en känd läskvot före order-POST; okänt skickat orderutfall skickas aldrig om automatiskt. Slutkontroll: nio testsviter, TypeScript och oberoende kodgranskning godkända. Verklig Live-katalog verifierad i webbläsaren; Demo-inloggningen svarar fortfarande 401 invalid-details.


## Återställning, läskvot och kursstatus 2026-10-07

Demo och Live har nu båda verifierats separat med befintliga API-uppgifter och respektive CFD-konto. Agentic OS visar den nya arbetsytan lokalt på port 3737/trading; Tailscale var fortsatt avstängt vid senaste nätverkskontrollen. Historiska noteringar om saknade Demo-uppgifter ovan beskriver tidigare felsökning.

Vid öppning återanvänds verifierad Demo-session eller ansluts färdigt konfigurerad Demo en gång. Sparat diagraminstrument återställs per miljö även när det tillhör Forex. Inga analyser, sessioner eller order startas genom omladdning. Tillfälliga läsfel bevarar diagrammet men markerar kvoten inaktuell och blockerar order.

Central rullande GET-budget är 24/minut per miljö och 48 totalt. Katalogen lämnar reserv för kontot och diagrammet. Konto, positioner och arbetsorder har 30 sekunders visningscache; ordervalidering kräver fortsatt färskt underlag. Ett integrerat test med 5-sekunders polling, diagram och SEK-FX använder 19 av 24 GET på en minut.

Standardgränsen är en position. Analysintervall och innehavstid är separata; 1, 5 och 15 minuter finns som innehavstid. Länken IG:s signaler öppnar användarens rätta Demo-/Live-plattform. Autochartist/PIA First-data är inte importerad till agentanalysen; någon dokumenterad IG-signalsfeed har inte verifierats.

Kursens sparade arbete hittades i ../projects/ptqa-trading: dag 1–3 och Luengos-12/21/50 (BTCUSD dagliga ljus), med godkänt Tiingo-dataunderlag. Ursprunglig ETH/USDT-idé och prediction är bevarade separat. Inget sparat dag 4-backtest hittades. Den dagliga BTC-strategin är inte verifierad för 1–15 minuters trades. Nuvarande IG-analys kan behandla flera instrument, men fler namngivna kursstrategier och jämförda kortsiktiga backtestresultat återstår. JEV är förkontroll, inte en marknadsmodell som tränas av Tiingo.


## Aktuell synkarkitektur – fortsättning 2026-10-07

En gemensam backend äger IG-session, analysurval, agentsessioner, scheman och favoriter. `igEvents` publicerar sparade tillståndsändringar till `igRealtime`; handelsytan konsumerar samma `readIgView` som HTTP-snapshot. Demo och Live har separat kontogeneration, lagring och streaming. Ingen IG-token skickas till browsern.

`igStreaming` använder officiella Lightstreamer-klienten med tvingad `WS-STREAMING` (ingen HTTP-transportfallback). Priser: `PRICE:{accountId}:{epic}`; konto: ACCOUNT; orderförändringar: TRADE. CHART används för verkliga OHLC-uppdateringar. Browsern visar eget WebSocket-status och IG-upstreamstatus separat, med faktisk broker-tidsstämpel. En ansluten socket garanterar inte ett färskt pris. Orderrisk fortsätter kräva färskt serververifierat REST-underlag.

`/api/ig/realtime?environment=demo|live` kräver samma origin och befintlig aktiv inloggning eller godkänd lokal/Tailnet-åtkomst. Behörighet återkontrolleras, logout stänger sockets, återanslutning hämtar snapshot och diagramhistorik. Gemensam pool: högst 30 priser, 4 diagram, konto och orderström per miljö (36 prenumerationer). Överfull pool ger uttryckligt fel. Högst 10 instrument per analys/session. Alla instrument kan listas utan att samtliga streamas samtidigt.

Frisk browser-WebSocket stoppar 5-sekunders workspace-polling. Backend avstämmer brokerstatus var 15:e sekund med befintliga cache-/läskvoter, utöver push vid ändringar. Katalog, historik, metadata och orderkommandon använder REST enligt IG:s API. Dagdiagram använder uttrycklig REST-reserv tills IG:s dygnsbrytpunkt är verifierad; 3/15/30 minuter och 4 timmar aggregerar CHART-underlag. Inga ljus tillverkas från enstaka prisuppdateringar.

Katalogen läser IG `/categories` och paginerade `/categories/{code}/instruments`, med kontobunden cache och läsreserv. Sökbaserad fallback märks alltid ofullständig. Rankningar visar verifierad förändring, absolut rörelse och spread; spread kan bara jämföras inom samma prisenhet. Vald enrichment kan hämta IG:s andel långa positioner (kundsentiment, inte köpt volym) samt SMA20/SMA50 på 50 stängda timljus. Saknade värden fabriceras inte. Realiserad strategivinst finns inte som allmän IG-marknadsranking.

Scheman är engångs- eller veckoscheman i Europe/Stockholm. Förekomst sparas före start, höstens dubbla timme dedupliceras och missade tider inklusive vårens hopp spelas inte igen. Kontobyte och serveromstart kräver återaktivering. Paus/radering under metadatahämtning avbryter start. Scheman kör analys och manuella orderförslag; befintlig orderflagga ändras inte.

### Driftsättning och verifieringsgräns

Denna fortsättning bygger på `092b0e5` i en isolerad branch. Originalcheckout och produktionscredentials har inte ändrats. TypeScript, workspace-, browser-, streaming-, WebSocket-, schema- och start-race-tester körs mot lokala fixtures. De bevisar kodvägen, inte verkliga IG-ticks eller order.

Dator2:s gamla localhost-vidarekoppling saknar WebSocket-upgrade. Uppdatera den med repo `scripts/forward-dashboard.mjs` tillsammans med backend på dator1; båda vyerna ska peka på samma backend. Agentic OS:s `/trading` iframe behöver fortfarande fungerande Tailscale-adress. Senaste åtkomstkontroll gav localhost 3939 HTTP 502 och timeout till dator1:9443. Driftsättning och end-to-end liveverifiering återstår tills dator1 är nåbar. Kör aldrig två agentbackends mot samma konto för att synka datorerna.

Officiella referenser: https://labs.ig.com/streaming-api-guide.html · https://labs.ig.com/streaming-api-reference.html · https://labs.ig.com/rest-trading-api-reference.html
