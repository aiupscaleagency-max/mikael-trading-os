# AITradingArena – strategier och underlag för återskapande

Granskat 8 oktober 2026. Källa: https://aitradingarena.com/, ranking, strategidetaljer och körhistorik. Åtkomstinformation: https://aitradingarena.com/prompts och https://www.skool.com/daviddtech/about?sl=aitradingarena.

## Bedömning

Det går att identifiera intressanta testkandidater, men underlaget räcker inte för att utse en verifierad vinnare för verklig handel. Ranking, kandidater och senare körningar överensstämmer inte alltid i marknad, inställningar eller tidsperiod. En senare svag körning bevisar därför inte att en tidigare konfiguration har förlorat sin fördel; den visar att reproduktionen måste kontrolleras.

Jag prioriterar granskning efter profit factor, maximal nedgång, antal affärer och möjlighet att identifiera den exakta konfigurationen. Den ordningen är min bedömning, inte sajtens ranking.

| Prioritet | Kandidat | Visat netto | PF | Maximal nedgång | Affärer | Bedömning |
|---|---|---:|---:|---:|---:|---|
| 1 | CASC–STX, 1h | +191,9 % | 1,98 | 16,4 % | 105 | Stark kandidat bland granskade entimmeskörningar; kort framåttest och signalregler saknas |
| 2 | TTF–MNT, c0fa47c3, 1h | +274,7 % | 1,78 | 24,6 % | 134 | Senare körning: +256,8 %, PF 1,69, 135 affärer; parametrar behöver verifieras |
| 3 | VQZLA–ENA, bb1d3b6e, 1h | +131,8 % | 1,73 | 16,3 % | 131 | Senare körningar visar samma resultat; ännu inget tillräckligt framåttest |
| 4 | DONB–DOGE–V1, 1h | +144,6 % | 1,82 | 8,6 % | 110 | Delvis dokumenterade regler; motsägelser mot senare körningar kräver kontroll |
| 5 | PLBK-familjen | +47,0 % | 1,77 | 4,5 % | 110 | Rankingens siffror hör till ETH 1h, trots SOL-etikett; främst intressant som byggunderlag |

Netto är kumulativt för respektive test, inte årsavkastning. Perioder och konfigurationer skiljer sig. PF är bruttovinst dividerad med bruttoförlust. Maximal nedgång avser tapp från en tidigare kapitaltopp.

## Identifiera rätt varianter

| Kortnamn | Exakt strategi-id |
|---|---|
| CASC–STX | `gpt6-casc-link-stx-95352493` |
| TTF–MNT | `gpt6-gpt6-gpt6-t3-ttf-reignite-v1-mnt-666645fc-mnt-c0fa47c3` |
| VQZLA–ENA | `gpt6-t3-vqzla-reignite-v1-ena-bb1d3b6e` |
| DONB | `daviddtech-crypto-donb-btc` – namnet kommer från familjens ursprungsmarknad; den visade kandidaten gäller DOGE |
| PLBK | `daviddtech-crypto-plbk-sol` – samma detaljkort innehåller flera marknader och konfigurationer |

## PLBK: mest användbart offentligt byggunderlag

Den dokumenterade idén är återinträde efter en rekyl i en etablerad trend. Tre komponenter används: T3 för trend, QQE för rekyl och återhämtning, Choppiness Index för att undvika sidledes marknad.

**Long:** stängningskurs över T3, stigande T3 och godkänt CHOP-filter. QQE:s snabba linje ska först falla under `50 − pullDepth` och därefter korsa upp genom sin följande linje. **Short:** spegelvänd logik. Signaler ska bygga på korsningar och bekräftade ljus, utan flera tidsupplösningar.

Parametrarna nedan beskrivs på sidan som SOL-vinnarens konfiguration som fördes oförändrad till andra marknader. De är inte bevisat samma konfiguration som ETH-radens PF 1,77.

| Parameter | Dokumenterat värde |
|---|---:|
| `lenT3PLBK` | 140 |
| `vfT3PLBK` | 0,55 |
| `rsiLenQQEPLBK` | 16 |
| `smoothQQEPLBK` | 8 |
| `factQQEPLBK` | 5,25 |
| `pullDepthPLBK` | 6,5 |
| `useChopPLBK` | true |
| `chopLenPLBK` | 15 |
| `chopThreshPLBK` | 61 |
| `ATR_LEN` | 13 |
| `ATR_RISK_MULT` | 2,475 |
| `PROFIT_FACTOR_LONG` – mål i R enligt beskrivningen | 1,4 |
| `PROFIT_FACTOR_SHORT` – mål i R enligt beskrivningen | 1,15 |
| `RISK_LEVERAGE` | 3 |

Korsningen efter en tidigare rekyl kräver ett tillstånd som kommer ihåg att rekylvillkoret uppfyllts. Exakt återställning av detta tillstånd, QQE-beräkning och exekveringsmotor behöver originalkod för identisk reproduktion. Ett eget script med dessa regler blir en dokumenterad rekonstruktion tills affärslistan matchar.

Viktig resultatkontroll: PF 1,77/+47,0 %/110 affärer finns i ETH-körningen 2026-08-29. SOL-körningen 2026-10-05 visar −26,0 %, PF 0,93, DD 48,1 %, 212 affärer. Skillnaden får inte automatiskt tolkas som försämring av samma variant. Även kandidatens ETH-anteckning beskriver ett svagt äldre marknadsregimtest.

## DONB: delvis dokumenterat byggunderlag

Dokumenterade komponenter: Donchian-utbrott, ATR-baserad volatilitetsgräns och EMA-bekräftelse av trend. Kandidaten gäller DOGEUSDT perpetual på Bybit, 1h.

| Inställning | Dokumenterat värde |
|---|---:|
| Donchian-kanal | 28 |
| Volatilitetsgräns, benämnd floor | 0,95 |
| EMA-trendperiod | 105 |
| ATR-stoppmultiplikator | 4,0 |
| Long-mål i R | 2,6 |
| Short-mål i R | 1,2 |

ATR-period 14 nämns i parameterstudierna, men behöver bekräftas i kandidatens slutliga input-export. Exakt formel och enhet för floor 0,95 saknas. Även om utbrott mäts med stängningskurs eller högsta/lägsta kurs, om aktuell stapel ingår i kanalen och hur EMA-bekräftelsen definieras måste verifieras. Därför går det inte att ange en exakt köp-/säljformel utan att göra antaganden.

Kandidatanteckningen anger ett separat femårstest på +233 %, PF 1,69, 176 affärer. Senare körning 2026-09-24 visar +21,1 %, PF 1,01, DD 90,6 %, 673 affärer. Det stora skiftet i antal affärer och risk gör matchning av kod och inställningar nödvändig före slutsatser.

## CASC, TTF och VQZLA

Detaljerna för de utvalda varianterna innehåller resultat, historik och kandidatreferenser, men inga fullständiga signalformler eller input-exporter. Namnen bevisar inte vilka indikatorer eller korsningsregler som används. CASC:s grundkort innehåller parameterstudier, men de räcker inte för att återskapa STX-varianten exakt.

CASC–STX har en 1h-körning 2026-09-11 på +201,0 %, PF 2,00 och 107 affärer. Samma detaljkort innehåller också 15m-körningar med betydligt högre nedgång. Statistik från 15m ska inte tilldelas 1h-kandidaten.

## Det som krävs för samma strategier och samma testresultat

| Underlag | Varför det behövs |
|---|---|
| Pine Script med versions-id eller hash, inklusive gemensam motor | Exakta indikatorformler, tillstånd och orderregler |
| Samtliga inputs per kandidat | Skiljer optimerade varianter från grundstrategier |
| Symbol, handelsplats, tidsupplösning och testdatum | Säkerställer jämförbara priser och perioder |
| Kapital, positionsstorlek, hävstång och återinvestering | Bestämmer kapitalutveckling och maximal nedgång |
| Stop loss, vinstmål, trailing stop, stopptak, återinträde och pyramidering | Bestämmer när och hur positioner avslutas eller utökas |
| Courtage, slippage, funding och marginal-/likvidationsmodell | Avgör hur realistiskt resultatet är för perpetualkontrakt |
| Ordertyp, tidpunkt för order och TradingViews beräknings-/fyllnadsinställningar | Påverkar vilka affärer som faktiskt fylls |
| Affärslista med inträde, utträde, storlek och resultat | Gör en reproduktion verifierbar affär för affär |
| Separat framåttest för exakt samma kod och inputs | Prövar strategin på data som inte styrde inställningarna |

Sidan anger generella motorstandarder: ATR 14 × 2,5, R:R 1,3, portföljandel 10 % och fast hävstång 10×. De är sajtens teststandarder och gäller inte automatiskt varje kandidat. PLBK:s konceptkort nämner exempelvis R:R 1,2 och dess senare variant andra värden. Portföljandel är inte samma sak som kapitalrisk vid stopp.

Som kandidatgränser anger sidan minst 100 avslutade affärer, PF minst 1,2, vinstfrekvens minst 40 % och genomsnittlig vinst större än genomsnittlig förlust. Det är ett urvalsfilter, inte ett bevis på lönsam framtida handel.

## Rekommenderat nästa byggsteg

PLBK har mest dokumenterad signallogik och lämpar sig bäst för en egen tydligt märkt rekonstruktion. CASC–STX är mitt första val för att begära originalkod och exakt konfiguration bland de granskade rankingkandidaterna. Innan en reproduktion godkänns ska dess affärslista matchas mot rätt originalkörning och därefter testas på en separat period med redovisade handelskostnader.

Full kod och strategitillgång hänvisas till DaviddTech-communityn. Den offentliga sidan räcker inte till identiska kopior av alla fem. Ingen medlemsåtkomst har köpts och inga handelsorder har lagts.

JEV-förhandsgranskning genomfördes: standarddjup/medelbudget med låg säkerhet i valen och sannolikhet 0,67 för behov av oberoende granskning. Resultaten ovan är därför ett forsknings- och byggunderlag; reproduktion och oberoende kod-/resultatgranskning återstår innan handel.
