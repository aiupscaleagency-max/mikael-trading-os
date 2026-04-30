# Mikael Trading OS — Handover för nästa session

**Senast uppdaterad:** 2026-04-30 09:25 UTC
**Live URL:** https://trading.aiupscale.agency/
**GitHub:** github.com/aiupscaleagency-max/mikael-trading-os
**VPS:** 72.60.36.92 (SSH: `~/.ssh/claude_key`)
**Senaste commit:** `19e699b` (Binance-only UI: rensa paper-data + spegla decisions/history)

---

## Status — vad är klart

### ✅ Backend (Fas 1–4 implementerade)
- **Binance dual-mode integration** (Testnet + Mainnet parallellt)
  - `src/server/integrations/binance.ts` — klient med signed requests
  - Auto-init från `.env` vid boot
- **Endpoints (alla verifierade live):**
  - `GET /api/binance/dual` — cash + positions för båda mode parallellt
  - `GET /api/binance/account?mode=` — enskild kontodata
  - `GET /api/binance/portfolio-trades?mode=` — **NY** trade-historik + FIFO realized PnL + W/L
  - `GET /api/binance/orders/open?mode=` — **NY** pending limit-orders
  - `GET /api/binance/orders/history?mode=&symbol=` — **NY** filled/cancelled
  - `GET /api/binance/transfers?mode=` — **NY** deposits + withdrawals (mainnet)
  - `GET /api/binance/stream` — **NY** SSE-bridge för realtid (frontend-ready)
  - `POST /api/binance/order` — order-läggning med säkerhetslås $5
  - `GET /api/binance/safety` — säkerhetslås-status
- **WS user-data-stream** kodad men **pausad auto-start** — `createListenKey` returnerar 410
  (proxy/permission-issue, debug krävs). Polling 3s/30s räcker som baseline.
- **Säkerhetslås LIVE** — `MAX_LIVE_STAKE_USD=5`, `MAX_LIVE_DAILY_LOSS_USD=10`
- **Telegram-bot** — webhook + 10 agenter (inkl Viktor forex-specialist)
- **Market context** — live RSI/SMA/MACD/OBV från Binance till agenterna
- **Pattern detection** — 25+ chart-mönster
- **Motor C cooldown** — 10-min paus vid 418/429 + 300ms throttle mellan symbols

### ✅ Frontend (`dashboard.html`)
- **Header default `—`** istället för hard-coded `$10,000` (uppdateras till Binance-saldo inom 1–2s)
- **Mode-knappar:** TEST (testnet) + LIVE (mainnet)
- **TEST-KONTO SALDO panel** speglar Binance API beroende på mode
- **Realiserat PnL / W/L / Win-rate** kopplade till `/portfolio-trades` (FIFO)
- **"Hannas beslut" + "Stängda trades"** speglar Binance trades (paper-data auto-rensas vid load)
- **Cache-busting:** version `v2026-04-30-binance-only` + auto-reload-script
- **SSE-listener** för realtid order-fills (när WS aktiveras senare)
- **Throttling:** portfolio-trades max var 30s frontend, 5min server-cache

### ✅ Mike's konton
- **Binance LIVE (mainnet):** $49.84 USDC (köpt med SEB-kort, verifiering klar)
- **Binance TESTNET:** $50,499 USDT cash + 437 demo-tokens (~$398K total)
- **Oanda:** ej skapat ännu

---

## ✅ Slutverifiering 2026-04-30 09:25 UTC

```
TESTNET portfolio-trades: ok=True  totalTrades=0 closed=0 realizedPnL=$0
LIVE portfolio-trades:    ok=True  totalTrades=0 closed=0 realizedPnL=$0
TESTNET dual:             cash=$50,499  configured=True  error=none
LIVE dual:                cash=$49.84   configured=True
TESTNET open orders:      ok=True  count=0
LIVE transfers:           ok=True  deposits=0 withdrawals=0
SSE stream:               event: hello  ✓
```

IP-ban löpte ut 09:15 UTC (efter `getPortfolioTradeStats` triggade rate-limit på 437 testnet-positioner).
Fix: top-20 positions cap + 5min server-cache + 30s frontend-throttle + Motor C cooldown.

---

## ❗ Senaste commits (i ordning)

1. `19e699b` — Binance-only UI: rensa paper-data + spegla decisions/history
2. `8cfc29d` — Skydda Binance rate-limit: pause WS auto-start + Motor C cooldown
3. `d3a7379` — Rate-limit-fix: top-20 positioner + 5min cache + 30s throttle
4. `950c2bf` — Fas 1-3: Portfolio trades + FIFO PnL + WS user-data-stream + SSE realtid
5. `c7a6b62` — Aggressive cache-bust: meta no-store + auto-reload-script vid version mismatch

---

## Tekniska detaljer

### .env på VPS (`/root/mikael-trading-os/.env`) — alla nycklar verifierade
```
ANTHROPIC_API_KEY=<satt>
BINANCE_API_KEY=<satt>
BINANCE_API_SECRET=<satt>
BINANCE_TESTNET=<satt>
BINANCE_TESTNET_API_KEY=<satt>
BINANCE_TESTNET_API_SECRET=<satt>
PERPLEXITY_API_KEY=<satt>
OANDA_API_KEY=<satt>
OANDA_ACCOUNT_ID=<satt>
OANDA_BASE_URL=<satt>
SUPABASE_URL=<satt>
SUPABASE_ANON_KEY=<satt>
TELEGRAM_BOT_TOKEN=<satt>
TELEGRAM_CHAT_ID=<satt>
PUBLIC_URL=https://trading.aiupscale.agency
MODE=paper
EXECUTION_MODE=auto
MAX_LIVE_STAKE_USD=5
MAX_LIVE_DAILY_LOSS_USD=10
```

### Hjälp-script på VPS
- `/root/update-binance-keys.sh KEY SECRET testnet|live`
- `/root/update-testnet-keys.sh KEY SECRET`

### Deploy-kommando
```bash
ssh -i ~/.ssh/claude_key root@72.60.36.92 'cd /root/mikael-trading-os && git pull --rebase && docker compose build --no-cache trading-os && docker compose up -d --force-recreate trading-os'
```

För TS-ändringar krävs `--no-cache` eftersom Dockerfile cachar `COPY src ./src`.

---

## Nästa steg / TODO

### Hög prio
1. **Mike testar första riktiga LIVE-trade** — chatta "köp BTC $5" i LIVE-mode → säkerhetslås $5 håller → faktisk order på binance.com → siffror uppdateras inom 30s
2. **Debugga WS user-data-stream 410** — `createListenKey` returnerar 410 HTML
   - Möjliga orsaker: (a) proxy blockerar POST, (b) testnet kräver annan endpoint, (c) keypermission saknar "User Data Stream"
   - Workaround idag: 3s polling + 30s portfolio-trades räcker

### Medium prio
3. Oanda demo-konto för forex-trades (Viktor-agenten väntar)
4. WS user-data-stream (när 410-felet är debugat) → millisekund-uppdateringar
5. Position-stängning via `/api/binance/order` (SELL) — endpoint finns, UI saknar knapp utöver "Stäng" i `tradePositions`
6. Insättningar/uttag-visning i UI (transfers-endpoint finns, ingen UI-yta än)

### Låg prio
7. TradingView Pine Script-strategier
8. Multi-tenant migration (Supabase service_role-key behövs)
9. Stripe billing (SaaS-tier system)

---

## Hur nästa session börjar

**Mike skriver troligen:**
> *"Fortsätt från senaste commit på mikael-trading-os, läs HANDOVER.md"*

**Du gör:**
1. Läs denna fil
2. Verifiera deploy-status:
   ```bash
   curl -s "https://trading.aiupscale.agency/api/binance/portfolio-trades?mode=testnet" | python3 -m json.tool | head -20
   curl -s "https://trading.aiupscale.agency/api/binance/dual" | python3 -m json.tool | head -10
   ```
3. Fråga Mike vad han vill prio:era

**Lärdomar:**
- Mike hatar när det sägs "fixat" men cache visar gammalt → alltid be om inkognito-test efter version-bump
- Paper-simulering är borta — TEST = Binance Testnet (riktig API)
- Säkerhetslås $5/trade är kritiska — får ALDRIG tas bort utan explicit OK
- Allt synkat 1:1 med Binance.com är icke-förhandlingsbart
- **Rate-limit:** `/myTrades` har weight 20 — max ~250 symbols/min innan ban. Cap till top-20 positions + 5min cache.
- **Motor C** scannar 15 default symbols och kan trigga ban om Binance är glad — cooldown 10min vid 418/429.
- VS Code/Cursor cachar Docker-images — alltid `--no-cache` när TS ändras.
