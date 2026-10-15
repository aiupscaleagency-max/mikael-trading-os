# Plan: jämför Telegram-guld mot EMA/ATR-scalping

## Syfte

Målet är att avgöra vilken metod som har bäst dokumenterad edge efter spread, slippage och realistisk exekvering hos IG/ProRealTime:

1. Telegram-signaler på guld mot USD.
2. Vår parametriserade EMA 12/21 + SMA 50 + ATR-strategi.
3. Eventuella strategier i projektmaterialet som använder samma idé med högsta/lägsta, trend och korta tidsupplösningar.

Vi jämför metoderna i samma tidsfönster och med samma riskregler. En snygg kurva eller en enskild lyckad signal räcker inte.

## Säkerhetsregler före test

- Ingen automatisk orderläggning och ingen kodändring behövs för jämförelsen.
- Börja med observation/paper-logg. Riktiga pengar får användas först efter ett uttryckligt beslut om maximal förlust per trade och per dag.
- Varje Telegram-signal måste tidsstämplas när den faktiskt blev synlig, inte när resultatet senare visas.
- Högsta/lägsta får aldrig definieras i efterhand med framtida candles. Annars blir testet look-ahead bias.
- Ingen signal räknas om entry, stop-loss, take-profit eller tidpunkt saknas.
- En förlust efter slippage och IG-kostnader är en riktig förlust i statistiken.

## Exakt definition av “Högsta & Lägsta”

Innan testet börjar ska vi skriva ned:

- vilken candle som används för high/low;
- om nivån bygger på föregående candle, senaste N candles eller en fast session;
- om signalen kräver utbrott, avvisning eller återtest;
- när nivån blir giltig;
- hur länge signalen får användas innan den löper ut;
- var stop-loss och take-profit placeras;
- om long och short använder spegelvända regler.

Vi får alltså inte säga “det gick upp efter högsta/lägsta” utan att först kunna säga exakt **vilken information som fanns när beslutet togs**.

## Tidsfönster för varje signal

Varje signal får tre separata resultat:

| Fönster | Fråga |
|---|---|
| 1–5 minuter | Fungerade signalen direkt efter publicering? |
| 15–60 minuter | Fanns en användbar intradag-rörelse? |
| Resten av sessionen/dygnet | Höll riktningen längre än scalpingfönstret? |

En signal som är korrekt på 4 timmar men omöjlig att fylla efter 30 sekunder ska inte blandas ihop med en scalpingvinst.

## Datainsamling

För varje Telegram-signal fyller vi i:

| Fält | Innehåll |
|---|---|
| ID | Unikt löpnummer |
| Publicerad | Datum, svensk tid, med sekunder om möjligt |
| Instrument | XAUUSD/guld, BTCUSD eller annat |
| Riktning | Long eller short |
| Entry | Exakt pris eller intervall |
| Stop-loss | Pris och avstånd |
| Take-profit | Alla mål och eventuell trailing-regel |
| Tidsupplösning | 1m, 5m, 15m, 1h osv. |
| Signalens källa | Telegramkanal och signal-id |
| Pris vid mottagning | IG bid/offer om tillgängligt |
| Fördröjning | Tid från signal till möjlig entry |
| Resultat | Vinst, förlust, ej fylld eller ogiltig |
| Kostnader | Spread, slippage, eventuell finansiering |
| Kommentar | Nyhet, låg likviditet, ändrad signal eller fel |

För EMA/ATR-metoden sparar vi samma fält och dessutom indikatorvärden vid entry.

## Testperioder

Vi använder fyra vyer samtidigt:

1. **Kort:** varje trade och 1m/5m/15m-resultat.
2. **Intradag:** resultat per timme och handelssession.
3. **Dygn:** nettoresultat, antal trades, maxförlust och signaler per dag.
4. **Vecka/månad:** stabilitet, drawdown, bästa/sämsta period och om edge försvinner.

För ett första beslut krävs minst 30 observerade signaler per metod. För att kalla en metod robust bör vi samla minst 100 avslutade trades och därefter testa en separat period som inte användes när reglerna valdes.

## Statistik vi räknar

- Antal signaler och antal möjliga/fyllda trades.
- Vinstfrekvens.
- Genomsnittlig vinst, genomsnittlig förlust och payoff.
- Profit factor.
- Expectancy per trade efter kostnader.
- Nettoresultat i kronor och procent.
- Största sammanhängande vinst- och förlustsvit.
- Maximal drawdown och tid till återhämtning.
- Resultat per timeframe: 1m, 5m, 15m och högre.
- Resultat per dygn, veckodag, session och marknadsregim.
- Resultat före och efter en realistisk fördröjning på 15, 30 och 60 sekunder.
- Andel signaler som aldrig blev fyllda utan att priset redan hade lämnat entry.

Profit factor och vinstfrekvens ska alltid visas tillsammans med antal trades. Fem vinster av fem är en observation, inte ett bevis.

## Jämförbara riskregler

För att jämförelsen ska bli rättvis använder båda metoderna:

- samma simulerade startkapital;
- samma risk per trade, till exempel 0,25 % i observationsfasen;
- samma maximala dagsförlust;
- högst en position per instrument;
- samma behandling av spread och slippage;
- ingen ny trade efter tre förluster samma dag;
- ingen hävstångsökning för att förbättra en svag strategi.

För riktiga IG-trades ska positionsstorleken räknas från stoppavstånd och tillåten kronrisk. Positionen får inte bestämmas från önskad vinst.

## Hur vi testar “90 % säkerhet”

Påståendet testas som en förutsägelse, inte som en känsla:

1. Definiera high/low-regeln i förväg.
2. Lås signalen vid den tidpunkt då den blev synlig.
3. Mät riktning inom 5, 15, 30 och 60 minuter.
4. Räkna även felriktning, sidledes rörelse och om stop-loss träffades först.
5. Dela upp resultatet i träningsperiod och out-of-sample-period.
6. Rapportera konfidensintervall eller åtminstone osäkerhet när antalet signaler är lågt.

90 % får bara användas som beskrivning om minst 90 % av ett tillräckligt stort, tidsstämplat och kostnadsjusterat urval faktiskt uppfyller den fördefinierade regeln. Resultat som bygger på efterhandsval av toppar och bottnar räknas som ogiltigt.

## IG och ProRealTime: vad vi kontrollerar innan första riktiga testet

- Rätt guldinstrument, valuta och kontraktstyp.
- Minsta position och vilket belopp en punkt motsvarar.
- aktuell bid/offer-spread vid signalen.
- stoppavstånd, möjlig garanterad stop och eventuell kostnad.
- om ordern fylls på bid, offer eller mittpris.
- handelstider och perioder med tunn likviditet.
- om stop-loss och take-profit ligger kvar efter frånkoppling.
- dagsgräns och maxförlust i kronor.
- att orderbekräftelsen visar rätt storlek, riktning och stop-loss.

Den slutliga köp- eller säljåtgärden gör Mike själv i IG. Vi kan kontrollera beräkningen före ordern, men en signal är inte en order.

## Beslutsregler efter testet

| Resultat | Beslut |
|---|---|
| Färre än 30 signaler | Fortsätt observera |
| PF under 1 efter kostnader | Förkasta eller ändra hypotesen; ingen riktig teststorlek |
| PF över 1 men hög drawdown | Endast fortsatt paper/observation |
| Stabilt resultat på kort och längre fönster | Separat out-of-sample-test |
| Positivt out-of-sample med minst 100 trades | Överväg mycket liten livepilot efter ny riskkontroll |
| Stora skillnader mellan publicerad och möjlig entry | Behandla Telegrammet som ej verifierat |

## Första arbetsordning

1. Samla nästa 30 Telegram-signaler utan att följa dem med riktiga pengar.
2. Lägg in vår EMA/ATR-hypotes i samma journal med samma tidsstämplar.
3. Kontrollera high/low-regeln candle för candle.
4. Sammanställ dygns- och veckostatistik.
5. Gå igenom resultatet tillsammans innan någon livepilot övervägs.

Det här är ett forsknings- och riskprotokoll, inte ett löfte om lönsamhet.
