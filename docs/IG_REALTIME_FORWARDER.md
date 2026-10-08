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

### Marknadsstudio: ett till fyra diagram

Handelsytan har valbara layouter med 1, 2, 3 eller 4 diagram och IG-marknadslistan till höger på dator. Huvuddiagrammet styr orderpanelen. Tre jämförelsediagram har eget instrument, intervall, Candles/Linje, SMA20, anpassning och omladdning. Knappen ”Till huvuddiagram” byter orderpanelens instrument uttryckligen. Länkning av instrument respektive intervall följer huvuddiagrammet; egen ändring i ett extradiagram kopplar ur motsvarande länkning. Diagraminställningar sparas separat för Demo/Live i den lokala webbläsaren.

Alla diagram använder samma autentiserade WebSocket. Klienten skickar `charts: [{epic, scale}]`; äldre `chart` accepteras fortfarande. Unika chart-prenumerationer dedupliceras och högst fyra delas mellan alla öppna klienter. En femte avvisas före mutation. Diagrammen använder befintliga IG-mittpriser och 1MINUTE/5MINUTE/HOUR med verifierad aggregering. Dagliga ljus och reservläge hämtas via REST tidigast efter 60 sekunder. Färskhet/källa visas per diagram; öppet nätverk betyder inte nytt pris varje sekund.

Jämförelsediagrammens laddningar sker seriellt och skyddas med miljö, kontoanslutning, instrument, intervall och lokal revision. Sena svar kan inte skriva in underlag i ett annat diagram eller konto. Vid transportavbrott eller inaktuella streamljus används begränsad REST-avstämning, med synlig reservkälla. Diagramlayouter startar inga agenter eller order och ändrar inte strategiernas underlag.

## Samlad meny- och kataloguppdatering

Valutapar, Strategier, Signaler och Agentsessioner ligger direkt i huvudmenyn. De återanvänder samma tillstånd och komponenter som handelsytan. Inställningarnas strategisektion flyttas tillbaka när inställningsdialogen stängs på strategisidan.

Nystart laddar både Krypto och Forex. Om den valda kategorin saknar ett tillgängligt instrument väljs ett faktiskt TRADEABLE-instrument i den andra kategorin, förutsatt oförändrad konto-/instrumentrevision. Ofullständiga kataloger behåller reservkällans fortsättningsinformation; båda kategorier kan återupptas efter minutgränsen. Ett fullständigt men tomt svar är fortfarande tomt.

Kryptologotyper serveras lokalt från ett CC0-paket, med explicit filallowlist. Forex visar flaggpar och okända instrument får neutral ikon. Källa och licens ligger i src/server/ui/workspace/icons.

Double Up skapar ett extra orderutkast. Roll-over ändrar en befintlig automatisk stängningsplan, inte en PocketOption-utgångstid. Ordergrindar och konto-/generationskontroller gäller fortsatt. Inga order skickas av menybyten eller kopiering.

Uppdateraren utgår fortfarande från dator 1:s installerade commit 76d91a8 och tar med den tidigare metadata-rättningen b418b00. En enda fast-forward och omstart av samma tjänst räcker. Om arbetskopian ändrats av ett annat konto avbryts uppdateraren.

### Katalogens kvotsvält rättad efter driftkontroll

Driftkontrollen efter 8e339b5 visade noll katalograder på både Demo och Live, samtidigt som direkta EUR/USD-sökningar hittade verkliga Forexinstrument. Orsaken var en andra, stateless kategoritraversal i igMarketDirectory som kunde förbruka minutbudgeten före igWorkspace:s progressiva hämtning.

Directory använder nu enbart igWorkspace.catalogue för kategorier, pagination och sökreserv. Directory berikar, rankar och cachar resultat med samma kontobindning. En regression med 12 stora sidor verifierar framsteg över flera minutbudgetar, en enda rootläsning, inga egna directory-traverseringar och båda kategorierna. Kontobyte under väntande hämtning avvisas.

Navigeringen har större klickytor, lokala linjeikoner och grön aktiv markering. Handelspanelerna ligger kvar. Uppdateraren utgår från installerad 8e339b5. Prisfördröjning och ordergrindar är oförändrade: fungerande WebSocket betyder inte automatiskt verifierad prisfördröjning.

### Tom kategorirespons och verklig sidstorlek

Efter installation av 0b0169b returnerade IG:s kategoriväg en färdig tom kategori på Live, medan EUR/USD-sökning returnerade instrument. En färdig tom eller delvis oklassificerad kategori behandlas därför som otillräckligt katalogunderlag och övergår till samma progressiva IG-kontosökning. Kända kategorirader unioneras; aktier omklassificeras aldrig till Forex/krypto. Sökbaserade resultat är fortsatt complete:false.

Pagination är nollbaserad och använder metadata.pageSize, samt totalPages när detta finns. Källa: https://labs.ig.com/reference/categories-category-id-instruments.html. Fel sidnummer ger sökreserv i stället för obegränsad upprepning. Klassificeringsbortfall exponeras vidare av directory.

Regressioner täcker tom kategori med sökträffar, aktiefilter, mindre svarssidor än begärt, bevarade kända rader, oklassificerade valutainstrument och avvikande sidmetadata. Hela workspace-sviten, forwarder, typkontroll och riktade eftertester passerar. Uppdateraren utgår från installerad 0b0169b. Inga order eller nyckeländringar.

### Bevarad instrumentmetadata och jämn katalogfortsättning

Driftkontrollen av 3dc2c46 hittade Forex på Demo och Live samt kryptoinstrument på Live. Ett senare kvotbegränsat workspace-svar kunde däremot ersätta huvuddiagrammets fullständiga instrument med ett felsvar och radera dess namn. Klienten bevarar nu metadata och det nyaste ursprungliga priset endast inom samma miljö, kontogeneration och instrument. Prisets tidsstämplar och verifiering förnyas aldrig av sammanslagningen. Instrumentrevision skyddar även sena A→B→A-svar.

Automatisk katalogfortsättning väljer den partiella kategorin som väntat längst, så att Forex och krypto delar befintlig läsbudget. Öppet kategorifilter styr fortsatt vilken kategori som laddas. Regressioner täcker metadata vid kvotfel, konto-/instrumentbyte, utgånget pris, kategorifördelning och ett verkligt WebSocket-snapshotfel i webbläsarfixturen. Workspace-sviten, TypeScript och forwarder passerar; separat granskning utan blockerande fynd. Uppdateraren utgår från installerad 3dc2c46.

### Katalogladdning oberoende av diagram och aktiv miljö

Katalogens mjuka tiogräns räknade tidigare samtliga kontoläsningar. Diagrammens fördröjningskontroller och kontoavstämning kunde därför blockera katalogen före varje försök. Katalogen har nu en egen högsta kvot på tio läsningar per miljö och minut, under samma centrala gränser på 24 konto-/48 applikationsläsningar. Katalogläsningar lämnar minst sex kontoläsningar och tolv applikationsläsningar i reserv; IG:s externa kvotstopp respekteras fortsatt.

Servern fortsätter katalogerna för båda anslutna miljöerna var 65:e sekund, även utan öppen handelsflik. Forex/krypto turas om att få första läsutrymmet. Pågående körningar delas; frånkopplade miljöer hoppas över och ny kontogeneration får ny cache. Timern stängs med HTTP-servern.

Kategorifel får begränsade återförsök med synlig progressdiagnos. Efter upprepade tillfälliga kategorifel används även sökreserven medan kategorivägen fortsatt provas. Felande söktermer får 60 sekunders cooldown och en separat retrykö efter två fel, så att en trasig Crypto-sökning inte blockerar Bitcoin/Ether. Kvotfel räknas inte som termfel. Missade söktermer ingår i remainingSearches. Sökbaserad katalog är alltid complete:false, även när alla kända söktermer har provats. Tidigare sökträffar behålls under samma kontobindning vid uppdatering utan förnyade pristidsstämplar.

Regressioner täcker tio konkurrerande ordinarie läsningar före katalogladdning i båda miljöerna, globala reserver, kategorifel/cooldown, trasig första sökterm, aktiefilter, återhämtad retrykö och serverstyrd miljö-/kategorirotation. Ingen testorder skickas. Fullständigt konto-utbud kan bara bekräftas med lyckad IG-kategoripagination; testpass eller genomgångna söktermer räcker inte som bevis. Uppdateraren utgår från installerad 5949c45.

### Vänstermeny, kortvy och kontobunden strategiverkstad

Handelsytans nya paneler behålls. En permanent vänstermeny öppnar Handelsyta, Valutapar, Strategier, Strategy Library, Signaler, Agentsessioner och Agentchatt samt befintlig marknadskatalog/verktyg/inställningar. På smala skärmar används en smal ikonmeny. Valutapar visas som symmetriska kort med logotyp/flagga, pris, observerad IG-prisserie, dataålder, senaste agentbeslut och tydliga knappar. Nio instrument per kategori visas per sida; samtliga hämtade instrument går att söka och bläddra mellan. Synliga kort ansluts till samma högst 30 instrument stora streamingpool. Den gränsen exponeras; historik eller livepunkter fabriceras inte när underlag saknas. Designläget är fortsatt uttryckligen simulerat.

Köp/Sälj öppnar manuella orderutkast. Instrumentanalys använder den befintliga agentkedjan och urvalet; sena kontobyten stoppar fortsättningen. Marknadsminidiagram töms vid kontobyte. Inga nya ordervägar eller ändrade orderflaggor.

Strategy Library sparar strategiutkast, TXT/MD/JSON/CSV-källor (max 20 000 tecken) och HTTPS-länkreferenser i ett bibliotek per privat fullständigt konto-ID och miljö. Länkar hämtas inte automatiskt och körbar kod accepteras inte. En regelkontroll kör vald registrerad basstrategi på stängda IG-ljus och verifierad instrumentmetadata, inte utkastets fria text och inte en historisk vinstsimulator. Resultatet sparas tydligt märkt tillsammans med utkastet. Ingen strategi aktiveras av sparande.

Agentchatten går att öppna från alla huvudsidor. Samma JEV-förkontroll → Teknisk analytiker → Hanna används via befintlig modellrouting. Budget, nödstopp och kontobindning kontrolleras före modellanrop och publicering. Chattens kontext är forskning: inga livepriser, orderverktyg eller påståenden om genomförda affärer. Senaste tre källor/utkast och begränsad historik skickas som opålitligt underlag, aldrig som systeminstruktioner; JEV får endast en anonymiserad uppgiftsklassificering.

Lagringen använder hash av privat fullkontoidentitet, 0600-filer, 0700-katalog, O_NOFOLLOW, storleksgräns, elementvalidering och atomisk skrivning. Korrupt data bevaras. Revisionskontroll, singleflight och kontogeneration stoppar dubbla/sena skrivningar. WebSocket-snapshot skickar bara biblioteksrevision; klienten hämtar ändrat bibliotek via autentiserad HTTP. Råa källfiler broadcastas inte i marknadsströmmen.

Tester täcker två konton med samma maskerade suffix, omstart/reconnect, Demo/Live-isolering, fil-/URL-validering, symlänk/korrupt fil, budget-/nödstopp, kontobyte under väntande budget/AI/filinläsning, HTML-escaping och dubbel formulärinskickning. Uppdateraren accepterar endast granskad 5949c45 eller 9428755 som bas, ren arbetskopia och befintlig LaunchAgent. Komplett IG-utbud och faktisk agentrouting måste fortfarande efterkontrolleras på dator 1; lokala tester bevisar inte brokerutbud eller produktionsmodellernas åtkomst.

## Separata katalogkvoter för Forex och krypto

Ett HTTP-anrop för krypto kunde tidigare ta alla tio katalogläsningar innan Forex fick hämta data; 60-sekunderscache och bakgrundens växling var 65:e sekund garanterade ingen rättvisa. Sökreserven har nu högst fyra läsningar per kategori och miljö under den gemensamma tioläsningsbudgeten och den centrala konto-/appreserven. Kvoten debiteras före nätverksanropet. Den officiella kategoritraversalen förblir gemensam, eftersom båda kategorierna använder samma resultat. IG:s egna kvotavbrott respekteras fortfarande.

Regressionen konkurrerar med två kryptoklienter, kontoläsningar och bakgrundshämtning i båda miljöerna och verifierar att Forex fortsätter varje budgetperiod. Detta bevisar inte komplett mäklarutbud eller ofördröjda produktionspriser.

Historikens `error.public-api.exceeded-account-historical-data-allowance` har nu en egen begränsad återförsökspaus för `prices/`. Den utlöser inte den generella GET-pausen och raderar inte sessionen. Katalog, konton, positioner och prisernas metadata kan fortsätta hämtas; saknade historiska ljus förblir saknade och får inte användas som verifierat analysunderlag. [IG:s prisreferens](https://labs.ig.com/reference/prices-epic.html) skiljer historikkvoten från konto-/API-trafikkvoten. Detta rättar ett verifierat kodfel; det exakta historiska felmeddelandet från driftens tidigare avbrott har inte loggats.
