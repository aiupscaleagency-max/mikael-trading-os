# Egen plan: signalens giltighet och statistik

Den här filen gäller alla PDF-strategier vi testar. Den är separat från strategivalet.

## Signalens livslängd

En signal skapas först när alla villkor är uppfyllda på en stängd candle. Den är giltig endast så länge som strategin anger och förfaller om något av detta inträffar:

- entry-zonen lämnas utan fyllning;
- nästa candle stänger tillbaka genom nivån;
- stop eller target nås innan entry;
- den definierade sessionen tar slut;
- maximal väntetid har passerat.

### Startvärden för test, som ska kunna ändras per variant

| Variant | Initial giltighet |
|---|---|
| 1m retest-entry | 3 stängda 1m-candles efter retest |
| 5m retest-entry | 2 stängda 5m-candles efter retest |
| 15m opening-range | till sessionens slut, men aldrig över nästa session |
| Momo/MACD | nästa 5m-candle efter bekräftelse |

Detta är testparametrar, inte påståenden från PDF:erna. Vi låser dem före mätning.

## Resultat per tidshorisont

För varje signal räknar vi:

- direktutfall: första 1–5 minuterna;
- kort intradag: 15 och 30 minuter;
- längre intradag: 60 minuter och sessionens slut;
- dygnsresultat;
- veckans sammanlagda resultat.

En signal kan vara rätt på 60 minuter men fel som scalp. Därför får resultaten aldrig blandas ihop.

## Journalfält

Varje observation ska ha signal-id, instrument, timeframe, svensk tidsstämpel, riktning, entry, stop, target, spread, slippage, giltighetstid, om entry fylldes, exitorsak, resultat i R och resultat efter kostnad.

För delvinst loggar vi separat: procent stängd, pris vid delvinst, flyttad stop, slutlig exit och total R efter båda exits.

## Statistikgrupper

Resultat ska brytas ned på strategi, instrument, timeframe, session, veckodag, timme och marknadsregim. Vi jämför kort period, rullande vecka, dygn, månad och hela testperioden.

## Minimikrav

- 30 observationer: preliminär signalbild.
- 100 avslutade trades: första meningsfulla bedömning.
- Separat out-of-sample-period: krävs före livepilot.
- Alla trades, även misslyckade och ej fyllda signaler, ska finnas kvar i journalen.

## Mått

Vinstfrekvens, genomsnittlig vinst, genomsnittlig förlust, payoff, profit factor, expectancy efter kostnader, max drawdown, längsta förlustsvit, återhämtningstid, andel ej fyllda signaler och resultat per risk-enhet (R).

## Kontroll mot look-ahead

När en signal bedöms får vi endast använda data som fanns på den angivna tidsstämpeln. High/low får inte väljas från framtida candles. En signal som efteråt ser perfekt ut men inte kunde definieras i realtid markeras som ogiltig.

## Beslutsgräns

Ingen strategi går till en verklig pilot enbart på hög vinstfrekvens. Den måste visa positiv expectancy efter kostnad, acceptabel drawdown, rimlig fyllnadsgrad och stabilitet i separat data.

## Gemensam tillämpning

Denna plan tillämpas tillsammans med den andra planen enligt [gemensamt testprotokoll](TESTPROTOKOLL-PDF-STRATEGIER.md). Där finns första variantens föreslagna parametrar och journalmallar.
