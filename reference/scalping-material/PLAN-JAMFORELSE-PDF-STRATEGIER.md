# Val av scalpingstrategier från PDF-materialet

## Slutsats

Vi väljer inte en enda PDF som facit. Materialet innehåller flera varianter av tre återkommande mekanismer:

1. **High/Low-utbrott + retest** – nivåbaserad opening-range/liquidity-strategi.
2. **Trend-pullback med EMA** – 200 EMA-filter och rekyl mot 9/21 eller 20 EMA.
3. **Momentum med EMA + MACD** – utbrott i trendriktningen med delvinst och breakeven.

De tre mekanismerna går att jämföra på flera instrument och tidsupplösningar utan att blanda ihop reglerna. Vi börjar med de två första för IG/ProRealTime eftersom de passar den tillgängliga guld- och valutamarknaden bäst. Momo-strategin blir tredje kandidat efter att exitregeln är exakt definierad.

## Valda strategifamiljer

### A. High/Low Breakout + Retest

**Källor:**

- `scarface-3-boring-scalping-strategies.pdf`
- `scarface-trades-5m-breakout-retest-strategy.pdf`
- `scarface-trades-5m-breakout-retest-strategy (1).pdf`
- `daytrading-master-guide-50dollar.pdf`
- `daytrading-master-guide-50dollar 2.pdf`
- `doug-institutional-liquidity-strategy.pdf`

**Gemensam idé:** markera en bekräftad high/low-nivå, vänta på stängande utbrott, vänta därefter på retest och gå in först när prisaction bekräftar nivån.

| Variant | Nivå | Entry | Exekvering | Stop | Mål |
|---|---|---|---|---|---|
| Scarface PDH/PDL | Föregående dags high/low | Utbrott + retest | 1m kring New York-open | Under/över PDH/PDL | Minst 2R |
| Scarface PMH/PML | Förhandel 04:00–09:30 ET | Utbrott + retest | 1m | Under/över nivå eller entry-candle | HOD/LOD |
| Scarface första 5m | Första 5m-candlens high/low | Stängning utanför + retest | 1m | Bakom nivå/utbrottscandle | 2–3R |
| Doug opening range | Första 15m-boxens high/low + RH/RL/SH/SL | 5m-bekräftelse eller reversal vid extremzon | 5m | Strukturellt bakom zon | Mittbox eller nästa zon; ofta 4R+ enligt dokumentet |

**Gemensam regel som ska behållas:** köp/sälj inte det första direkta utbrottet. Retest krävs.

**Viktiga skillnader:** Scarface använder främst aktier/ETF och New York-tider. Doug använder 15m/5m, dags-SMA 50 och daglig ATR. Vi får inte kalla dem samma exakta strategi innan instrumentets öppningstid, nivådefinition och session har översatts till IG.

**Instrument att testa:** XAUUSD först, därefter EURUSD, GBPUSD och eventuellt US-index om IG:s kontraktsstorlek och spread passar. Testa inte alla samtidigt i första veckan.

### B. Trend-Pullback + EMA/RSI

**Källor:**

- `forex-scalping-low-budget-strategies.pdf`
- `forex-scalping-low-budget-strategies 2.pdf`
- `daytrading-master-guide-50dollar.pdf`
- `daytrading-master-guide-50dollar 2.pdf`

#### B1. M5/M1 20/50 EMA + RSI Snapback

- M5: köp endast om priset ligger över 20 EMA och 50 EMA och 20 EMA ligger över 50 EMA.
- M5: sälj endast om priset ligger under båda och 20 EMA ligger under 50 EMA.
- M1: vänta på rekyl till 20 EMA.
- Long: RSI(14) går ned i 40–50-zonen, därefter stänger en grön candle tillbaka över 20 EMA.
- Short: spegelvänd regel; exakt RSI-zon måste dokumenteras före test.
- Stop: 1–2 pips bakom senaste M1-swing, ungefär 3–5 pips enligt PDF.
- Target: 1,2–1,5R, cirka 5–8 pips enligt PDF.
- Hålltid: cirka 1–5 minuter.

#### B2. M5 9/21 EMA Pullback Zone + 200 EMA

- 200 EMA är huvudfilter: endast long över, endast short under.
- Zonen mellan 9 EMA och 21 EMA är pullback-zonen.
- Efter impuls väntar vi på att priset går in i zonen.
- Entry kräver reversal-candle, exempelvis pin bar eller engulfing, i trendens riktning.
- Stop: bakom 21 EMA eller senaste swing.
- Target: 1,5–2,0R.
- Hålltid: cirka 5–15 minuter.

**Instrument att testa:** EURUSD och GBPUSD först på grund av dokumentets fokus på låga spreadar; XAUUSD som separat test eftersom guld har annan volatilitet och kostnadsprofil.

### C. M5 Momentum / Momo + MACD

**Källor:**

- `forex-scalping-low-budget-strategies.pdf`
- `forex-scalping-low-budget-strategies 2.pdf`
- `daytrading-master-guide-50dollar.pdf`
- `daytrading-master-guide-50dollar 2.pdf`

- M5: EMA 20.
- Long: stark candle stänger över EMA 20 och MACD-histogrammet korsar över noll.
- Short: spegelvänd regel.
- Vid +10 pips: stäng 50 % av positionen och flytta stop till breakeven.
- Resterande del: nästa motstånd/stöd; exakt exit saknas och ska inte gissas.
- Dokumentets matris beskriver cirka 2R som risk/reward vid skalning.

**Korrigering av 25 %-minnet:** i de PDF:er som granskats hittade jag inte en regel som tar ut 25 % av positionen. Jag hittade däremot **50 % delvinst vid +10 pips**. JJ Simon-dokumentet har **25 punkters stop-loss**, inte 25 % delvinst. Det måste hållas isär.

## Strategier som inte väljs i första scalpingrundan

| Dokument | Varför inte nu |
|---|---|
| Alex G 4H Head and Shoulders | 4h swing/setup, inte 1–15m scalping |
| Riley Coleman $5 Futures | NQ/MNQ-futures och annan broker-/kontraktslogik än IG-guld/forex |
| JJ Simon 1m Fair Pricing | NQ-futures, 25/38 punkter och sessionsspecifika regler; kan studeras separat |
| Ultimate Day Trading Master Encyclopedia | Referensverk med många upplägg, ingen enda ren kandidat |
| DaviddTech IG-guide | Plattform-/agentunderlag, inte en tillräckligt isolerad scalpingregel |
| Claude × TradingView OS och Fable 24/7 | Infrastruktur och automation; inte första manuella setupen |

## Hur många marknader vi väljer

För att inte överoptimera testar vi samma regel på tre marknader i taget:

1. XAUUSD.
2. EURUSD.
3. GBPUSD.

För varje marknad använder vi exakt samma parametrar. Om en familj bara fungerar efter olika specialinställningar per marknad är det en varningssignal, inte en förbättring.

## Tidsupplösningar

| Strategifamilj | Kontext | Entry | Normal hålltid |
|---|---|---|---|
| High/Low retest | 15m eller dagsnivå | 1m/5m | 5–60 minuter |
| EMA/RSI pullback | 5m trend | 1m | 1–5 minuter |
| EMA zone | 5m | 5m | 5–15 minuter |
| Momo/MACD | 5m | 5m | 5–15 minuter |

En regel får inte flyttas mellan 1m, 5m och 15m och ändå kallas samma test. Varje timeframe är en egen variant i statistiken.

## Ordning för första testet

1. High/Low retest på XAUUSD, EURUSD och GBPUSD.
2. EMA/RSI pullback på EURUSD och GBPUSD.
3. EMA zone på samma två valutapar och därefter XAUUSD.
4. Momo/MACD efter att 50 %-delvinsten och resten av exitregeln är explicit definierade.

För varje variant samlar vi minst 30 observationer utan att välja bara vinnare. Minst 100 trades krävs innan en familj bedöms statistiskt intressant.

## Exakt information som måste vara fast före första trade

- instrument och IG-symbol;
- tidszon och session;
- high/low-definition;
- hur många candles som får bilda nivån;
- vad som räknas som breakout-close;
- hur nära retest måste vara;
- vilken candle som bekräftar entry;
- stop-loss-formel och minsta avstånd;
- första delmål, eventuell delvinst och breakeven-regel;
- slutlig exit för resten;
- signalens giltighetstid;
- högsta antal trades per session och dag;
- maximal risk i kronor per trade och dag;
- spread/slippage som räknas i resultatet.

## Första val

Den första praktiska kandidaten blir **High/Low Breakout + Retest på XAUUSD, 5m nivå och 1m entry**, eftersom den bäst matchar materialets återkommande high/low-system och användarens intresse för högsta/lägsta. Därefter körs samma regel oförändrad på EURUSD och GBPUSD.

Om spread eller minsta IG-position gör XAUUSD olämpligt börjar vi med EURUSD. Vi väljer inte marknad efter vilket diagram som ser bäst ut i efterhand.

Ingen av dessa PDF:er bevisar 90 % träffsäkerhet. Exempel på 4,5R, 8,8R eller 3,24R är exempel, inte ett oberoende track record.
