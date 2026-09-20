---
summary: En autonom krypto-trading-agent driven av Claude (Anthropic) mot Binance spot.
---

# trading-agent

En autonom krypto-trading-agent driven av Claude (Anthropic) mot Binance spot.
Kör mot **Binance Testnet** som default (låtsaspengar, noll risk). Live trading
går att aktivera men är skyddat bakom flera explicita spärrar.

## Vad detta är

- **Claude som beslutsfattare.** Claude har verktyg (tool use) för att läsa
  marknadsdata, räkna tekniska indikatorer, läsa egen historik, och lägga
  order. Du väljer om Claude får lägga order autonomt (`auto`) eller om den
  bara får föreslå och invänta din bekräftelse (`approve` — sida-vid-sida).
- **Risk manager med vetorätt.** Oavsett vad Claude vill, sista filtret är en
  deterministisk riskmodul som:
    - Blockerar symboler som inte är whitelistade
    - Begränsar USD-storlek per position och totalt
    - Stoppar all handel om dagens förlust passerar gränsen
    - Stoppar all handel om kill-switchen är aktiv
- **Paper trading default.** Du måste aktivt sätta `MODE=live` OCH
  `LIVE_TRADING_CONFIRMED=true` för att riktiga pengar ens ska vara möjligt.
- **Persistent minne.** Varje beslut loggas till `data/decisions.jsonl` med
  motivering, tool-calls, och orderresultat. Agenten läser sin senaste
  historik som kontext — en form av in-context-lärande.

## Installation

```bash
cd trading-agent
npm install
cp .env.example .env
```

### 1. Skaffa Binance Testnet-nycklar (gratis, paper trading)

1. Gå till https://testnet.binance.vision/
2. Logga in med GitHub
3. Klicka "Generate HMAC_SHA256 Key"
4. Kopiera API Key och Secret Key till `.env`:
   ```
   BINANCE_API_KEY=din_testnet_key
   BINANCE_API_SECRET=din_testnet_secret
   ```
5. Testnet ger dig automatiskt ett startsaldo på ~100 000 USDT att leka med.

### 2. Skaffa Anthropic API-nyckel

https://console.anthropic.com/ → lägg i `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Sätt dina riskramar

I `.env` (defaults är konservativa):

```
MAX_POSITION_USD=100          # Max USD per öppnad position
MAX_TOTAL_EXPOSURE_USD=500    # Max USD totalt exponerat samtidigt
MAX_DAILY_LOSS_USD=50         # Paus hela dagen om realiserad PnL faller under detta
MAX_OPEN_POSITIONS=3
ALLOWED_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
```

### 4. Välj körläge

```
EXECUTION_MODE=approve    # Claude föreslår, du bekräftar (rekommenderat att börja med)
# eller:
EXECUTION_MODE=auto       # Claude lägger orders själv (inom riskramarna)
```

## Användning

```bash
# Verifiera att anslutningen funkar och visa kontot
npm run account

# Kör EN agent-runda och avsluta (bra för felsökning)
npm run agent:once

# Tvinga förslags-läge för en enskild runda oavsett EXECUTION_MODE
npm run propose

# Starta den kontinuerliga loopen (kör tills Ctrl+C)
npm run agent

# Kill-switch
npm run kill -- on      # Stoppa all handel omedelbart
npm run kill -- off     # Återställ
```

## Så går en "turn" till

1. Agenten laddar state från `data/state.json` (kill-switch, öppna positioner, dagens PnL)
2. Claude får en system prompt med aktuella riskramar + historik + performance-sammanfattning
3. Claude anropar verktyg: `get_account`, `get_positions`, `get_ticker`, `get_indicators`
4. Claude fattar beslut: BUY / SELL / HOLD
5. Om BUY/SELL: `place_order` skickar först förslaget till **ensemble-grinden** —
   en andra modell (MODEL_B) röstar agree/disagree på samma underlag
6. Bara om BÅDA modellerna säger "agree" går ordern vidare till risk managern,
   som fortfarande kan blockera eller skala ner. Oenighet loggas som `hold`.
7. I `auto`-läge exekveras ordern. I `approve`-läge förbereds den för din bekräftelse.
8. State och beslut persisteras i `data/`

### Ensemble: 2-modell-omröstning

Varje trade granskas av en oberoende andra modell innan risk managern. Grinden
kan bara **stoppa** trades — den kan aldrig kringgå risk managerns veto eller
position-sizing-låsen.

Granskaren är **GPT-6 Astra via OpenAI** — en modell från en annan leverantör
har andra blinda fläckar än Claude, vilket är hela poängen med ensemblen.

```
MODEL_A=claude-sonnet-4-6           # föreslår (Head Trader, Claude)
MODEL_B=gpt-6-astra                 # granskar, oberoende
MODEL_B_PROVIDER=openai             # anthropic | openai (openrouter ej byggd)
OPENAI_API_KEY=sk-...               # EGEN nyckel — aldrig ANTHROPIC_API_KEY
ENSEMBLE_FALLBACK_MODEL=claude-opus-4-6  # röstar om OpenAI-vägen är nere
ENSEMBLE_REQUIRE_AGREEMENT=true     # båda måste säga "agree"
ENSEMBLE_FAIL_OPEN=false            # transient fel ⇒ ingen trade (fail-closed)
ENSEMBLE_GATE_EXITS=false           # exits gatas inte — vi låser aldrig in oss
```

**Om OpenAI-vägen inte går att använda** — `OPENAI_API_KEY` saknas, 401/403,
`insufficient_quota` eller okänd modellsträng — loggas ett tydligt fel och
`ENSEMBLE_FALLBACK_MODEL` (Claude) röstar istället för den granskningen.
Systemet kör aldrig blint vidare utan andra-åsikt: saknas även Claude-nyckeln
blir det fail-closed `disagree`, alltså ingen trade. Transienta fel (timeout,
5xx, rate limit) byter *inte* modell — de fail-closed:ar direkt.

Se grinden i aktion utan nycklar och utan riktiga ordrar (paper + approve):

```bash
npm run ensemble:demo
```

Demon visar tre fall: GPT-6 Astra röstar `agree`, GPT-6 Astra röstar
`disagree`, och OpenAI svarar `insufficient_quota` → fallback till Claude-B.

OpenRouter som MODEL_B-väg: se `TODO(model-b-provider)` i
`src/orchestrator/secondOpinion.ts`.

## Lärloop: signal-journal och automatisk avgörning (Fas 1)

Systemet minns numera vad som hände med sina egna förslag. Varje riktat
orderförslag journalförs vid `place_order` — med **båda** ensemble-rösterna —
och avgörs sedan automatiskt mot faktisk prisdata.

**Allt är shadow-läge.** Journalen observerar och mäter. Den lägger aldrig
order, rör inga nycklar, och ett journalfel kan aldrig påverka ett
orderbeslut.

```
place_order → ensemble-grind → JOURNAL → risk manager → broker
                                  ↓
                      data/learning.db (SQLite)
                                  ↓
                 avgörningsjobb var 15:e min → TP / SL / utgången / likviderad
```

Det viktigaste i tabellen är att **även nedröstade förslag journalförs och
avgörs**. Raderna med `ensemble_approved = 0` svarar på den fråga som annars
är omöjlig att besvara: räddade grinden pengar, eller kostade den pengar?

Avgörningen följer genomgående värsta rimliga fall, eftersom vi bara har OHLC
och inte tick-ordning:

- TP och SL i samma candle → **SL antas**, och tvetydigheten loggas i
  `ambiguous_bar` så Fas 3 kan mäta hur mycket statistik som vilar på antagandet
- Endast candles **efter** signalens tidsstämpel används (strikt `>` på
  `openTime` — en bar som redan var påbörjad räknas inte)
- Vid hävstång prövas **likvidation före stop loss**; en likvidation är total
  förlust av insatsen oavsett var SL låg
- Gap förbi SL fylls på öppningskursen, inte på SL-nivån

`stop_loss` och `take_profit` i `place_order` är **journal-fält**. De skickas
inte till brokern och skapar inga stop-ordrar.

```bash
npm test               # 41 tester, inga nätverksanrop och inga nycklar
npm run journal:resolve  # avgör öppna signaler + sammanfattning per tillgångsklass
```

Statistiken hålls alltid isär per tillgångsklass — krypto med 5x hävstång och
aktier är inte jämförbara storheter. Fas 1 ger rå räkning; kalibrering,
expectancy med konfidensintervall och baslinjer kommer i Fas 3.

## Från paper till live (när du är redo)

**Gör inte detta innan du kört minst några veckor på testnet och sett en
positiv track record.** När du är redo:

1. Skaffa live-nycklar på https://www.binance.com/en/my/settings/api-management
2. **Slå AV withdrawal-permissions på nyckeln.** Enable bara "Enable Spot & Margin Trading".
3. I `.env`:
   ```
   MODE=live
   LIVE_TRADING_CONFIRMED=true
   BINANCE_LIVE_API_KEY=...
   BINANCE_LIVE_API_SECRET=...
   ```
4. Börja med **mycket** låga riskramar (t.ex. `MAX_POSITION_USD=20`).
5. Kör `EXECUTION_MODE=approve` de första dagarna så du ser varje trade innan den går.

## Vad detta projektet INTE är

- Det är inte en pengamaskin. Ingen algo är det.
- Det gör inte riktig forex — Binance har spot crypto + stablecoin-par. För
  traditionell forex behövs en OANDA/IG-adapter (enkelt att lägga till, men
  inte gjort än).
- Det gör inte backtesting än. Strategivalidering sker just nu genom att köra
  på testnet och titta på `decisions.jsonl`.
- Det läser inte nyhetsflöden än. En `news`-tool går att lägga till — men
  nyhetsdata kostar och kräver eget val av källa (NewsAPI, RSS, Twitter-scrape).

## Filstruktur

```
src/
  config.ts               Laddar och validerar .env
  types.ts                Gemensamma typer
  logger.ts               Färgad konsol-logger
  brokers/
    adapter.ts            Generiskt broker-interface
    binance.ts            Binance REST-implementation (testnet + live)
  indicators/
    ta.ts                 SMA, EMA, RSI, ATR, MACD
  risk/
    riskManager.ts        Deterministisk vetorätt över alla orders
  memory/
    store.ts              JSON-baserad persistens av state + beslut
  agent/
    prompt.ts             System prompt till Claude
    tools.ts              Verktygsdefinitioner + handlers
    claudeAgent.ts        Tool-use-loopen
  scripts/
    account.ts            npm run account
    kill.ts               npm run kill
  run.ts                  Entrypoint — npm run agent
```

## Säkerhet

- Nycklar finns **bara** i `.env` (gitignored). Checka aldrig in `.env`.
- Live-nyckeln ska inte ha withdraw-permission.
- Risk managern kan inte kringgås av Claude — den sitter mellan agenten och
  brokern och kör deterministisk kod.
- Kill-switchen kan aktiveras både av dig manuellt (`npm run kill -- on`) och
  av Claude själv om den ser något katastrofalt.

## Troubleshooting

**"MODE=live men LIVE_TRADING_CONFIRMED=false"** — precis, säkerhetsspärren
funkar. Sätt den explicit i `.env` om du verkligen vill gå live.

**"Binance GET /api/v3/account 401"** — fel nycklar, eller så använder du
live-nycklar mot testnet eller tvärtom. Kom ihåg att testnet och live har
separata nycklar.

**"För lite USDT i kontot"** — testnet ger 10k–100k USDT när du skapar
nycklarna. Om saldot är 0, generera en ny key på testnet.binance.vision.
