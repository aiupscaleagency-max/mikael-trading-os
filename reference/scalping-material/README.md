# Scalpingmaterial och dagens strategi

Materialet i `inputs/` är kopierat från Downloads för projektets research och paper-tradingarbete.

## Dagens mål

Bygga och verifiera en första scalpingstrategi i paper mode. Inga riktiga ordrar ska läggas.

## Första kandidat: EMA 12/21 + SMA 50

Kandidaten utgår från TradingView-bilden och ska behandlas som en hypotes tills den har testats:

- Marknad: BTCUSDT på Binance, initialt.
- Tidsupplösning: 5 minuter för entries, 1 timme som trendfilter.
- Long: EMA 12 korsar upp EMA 21 och priset ligger över SMA 50 på både 5m och 1h.
- Short: EMA 12 korsar ned EMA 21 och priset ligger under SMA 50 på både 5m och 1h.
- Stop-loss: ATR(14) × 1,5 från entry.
- Mål: 1,5R; ingen trade utan stop-loss.
- Risk i paper mode: högst 0,25 % av simulerat kapital per trade.
- Filter: ett öppet trade per symbol, ingen entry på ett pågående ljus och paus efter tre förluster samma dag.

## Godkännandekrav

Strategin får bara gå vidare från paper mode efter minst 100 avslutade trades, redovisade avgifter/slippage, profit factor över 1,20, dokumenterad maximal drawdown och separat out-of-sample-test. Resultat från backtest eller skärmbilder är inte bevis på framtida lönsamhet.

## Arbetsordning idag

1. Implementera signalerna i den befintliga signalmotorn med stängda candles.
2. Lägg till parametrar så EMA-längder, SMA-filter, ATR-multipel och R:R kan ändras utan kodändring.
3. Kör testsviten och `npm run verify`.
4. Starta endast paper/proposal-läge och logga varje signal med orsak, stop-loss och mål.
5. Utvärdera efter tillräckligt många trades och justera en parameter i taget.

Detta är ett första testprotokoll, inte investeringsrådgivning. Originalmaterialet kan innehålla andra regler och ska jämföras innan en strategi namnges som samma strategi.
