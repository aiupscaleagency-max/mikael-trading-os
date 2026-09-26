# mikael-trading-os

Kryptosignalsystem. Läser marknadsdata live från Binance, räknar indikatorer och
producerar LONG/SHORT/NEUTRAL med obligatorisk stop-loss. **Signaler, inte
automatisk orderläggning.** Allt är PAPER/SIM om inget annat uttryckligen sägs.

Ägare: Mikael Luengo Johansson (AI Upscale Agency). Arbetsspråk: svenska.

## Kom igång

```bash
npm install
npm run build      # tsc --outDir dist — ska ge 0 fel
npm run verify     # 9 kontroller mot live Binance-data
npm run test:signal
```

`npm run verify` är facit. Den jämför ett WebSocket-ljus mot Binance REST och
underkänner sig själv om de skiljer sig.

## Arkitektur — läs i den här ordningen

| Fil | Ansvar |
|---|---|
| `src/server/klineStream.ts` | Binance combined WebSocket. REST-seed vid start och vid varje reconnect, dedupe på `openTime`, watchdog. |
| `src/server/signalEngine.ts` | Poängsättning → signal. Stop-loss och brusfilter. |
| `src/server/jevClient.ts` | Valfritt bedömningslager (se nedan). |
| `src/server/candleSource.ts` | Broker-agnostisk ljuskälla: websocket eller polling. |
| `src/server/api.ts` | HTTP-API. Auth-gate före all routing. |

### Tre regler som inte får brytas

1. **Stängda ljus.** Signaler får bara beräknas på `k.x === true`.
   `subscribeClosedCandles()` är enda tillåtna källan. `getFormingCandle()` är
   till diagram, aldrig till beslut. Bryts detta ritas signaler om i efterhand
   och backtest blir värdelöst.
2. **Ingen signal utan stop-loss.** Saknas ATR förkastas signalen. Se
   `signalEngine.ts` — `if (!ind.atr14 || ind.atr14 <= 0) return null`.
3. **MACD-linjen bär riktning, histogrammet bara acceleration.** Histogrammet
   vänder uppåt mitt i ett fall när fallet bromsar in. Läses det som riktning
   ger ett ras LONG. Det har hänt en gång och får inte hända igen.

## JEV — valfritt, systemet ska fungera utan

`jevClient.ts` frågar en extern bedömningstjänst (TypeSafe) sju typade frågor
och får bara **nedgradera** LONG/SHORT till NEUTRAL. Den kan aldrig skapa en
signal. Går tjänsten inte att nå fortsätter systemet i `rules_only` — ett
bedömningslager som kan stoppa hela systemet när det är nere är farligare än
inget bedömningslager alls.

Två rutter, olika nycklar, båda provas med samma nyckel innan 401 tolkas som
ogiltig nyckel:

- `AI_GATEWAY_API_KEY` → Vercel AI Gateway. **Normala vägen**, ingen väntelista.
- `TYPESAFE_API_KEY` → `api.typesafe.ai` direkt. Kräver plats av TypeSafes
  väntelista, annars 401.

Fallback-nyckel: macOS Keychain, tjänst `aiupscale.typesafe.api-key`.

## Regler för dig som arbetar här

- **Inga riktiga ordrar.** Ändra inga konton, rör inga nycklar.
- **Skriv aldrig ut nyckelvärden** i loggar, commits eller svar.
- `npx tsc --noEmit` ska ge 0 fel före commit. `noUncheckedIndexedAccess` är på
  — indexering ger `T | undefined` och det ska hanteras, inte kastas bort med
  `!`.
- Kommentarer och commit-meddelanden på svenska, som resten av koden.
- Kör `npm run verify` efter ändringar i stream-, signal- eller indikatorkod.
- Påstå aldrig att något fungerar utan att ha kört det. Klistra in utdata.
