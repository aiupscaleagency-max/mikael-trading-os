# Mikael Trading OS — Handover för nästa session

**Senast uppdaterad:** 2026-04-29 23:15 UTC
**Live URL:** https://trading.aiupscale.agency/
**GitHub:** github.com/aiupscaleagency-max/mikael-trading-os
**VPS:** 72.60.36.92 (SSH: `~/.ssh/claude_key`)

---

## Status — vad är klart

### ✅ Backend
- **Binance dual-mode integration** (Testnet + Mainnet parallellt)
  - `src/server/integrations/binance.ts` — klient med signed requests
  - Auto-init från `.env` vid boot (BINANCE_API_KEY/SECRET, BINANCE_TESTNET_API_KEY/SECRET)
  - Endpoints: `/api/binance/dual`, `/api/binance/account?mode=`, `/api/binance/order`, `/api/binance/trades`, `/api/binance/safety`
- **Oanda integration** (forex) — `src/server/integrations/oanda.ts` (men **EJ konfigurerad** ännu)
- **Säkerhetslås LIVE** — `MAX_LIVE_STAKE_USD=5`, `MAX_LIVE_DAILY_LOSS_USD=10` (i `.env`)
- **Telegram-bot** — webhook + interaktiv chat med 10 agenter (inkl Viktor forex-specialist)
- **Market context** (`src/server/marketContext.ts`) — live RSI/SMA/MACD/OBV från Binance till agenterna
- **Pattern detection** (`src/server/patternDetection.ts`) — 25+ chart-mönster

### ✅ Frontend (`dashboard.html`)
- **Mode-knappar:** TEST (testnet) + LIVE (mainnet) — PROPOSE borttagen
- **Header:** 📊 TEST $X · 💚 LIVE $Y — speglar Binance-saldon i realtid
- **Binance Live Sync card** — dual-mode display med stablecoin-breakdown
- **Saldo-card "TEST-KONTO SALDO"** — speglar Binance API beroende på mode
- **Chat-routing:** alla trades går genom `/api/binance/order`
- **Säkerhetslås** blockerar live-trades > $5
- **Cache-busting:** `Cache-Control: no-store` headers på dashboard.html

### ✅ Mike's konton
- **Binance LIVE (mainnet):** $49.84 USDC (köpt med SEB-kort, verifiering klar)
- **Binance TESTNET:** $50,499 USDT cash + 437 demo-tokens (~$398K total)
- **Oanda:** ej skapat ännu

---

## ❗ Pågående/nyligen-deployat

### Senaste commits
1. `b363cad` — Saldo-card speglar TEST/LIVE-mode från Binance API
2. `bcb2939` — Ta bort paper-card helt (sen återinfört med Binance-koppling)
3. `909d770` — Ta bort PROPOSE — bara TEST + LIVE
4. `7ca0e62` — renderPaperBadge disabled — header från Binance Testnet
5. `a65d3f6` — Unified flow: ALLT mot Binance — paper-simulering borta

### Mike's senaste klagomål (när session pausades)
- TEST-KONTO SALDO panelen visar fortfarande "$10,000.00" i hans browser
- **Orsak:** browser-cache. Server har korrekt kod (verifierat via curl)
- **Lösning:** hard-refresh (Cmd+Shift+R) eller inkognito (Cmd+Shift+N)
- **När hard-refresh klar:** panelen visar `$50,499 (testnet)` eller `$49.84 (live)`

---

## Tekniska detaljer

### .env på VPS (`/root/mikael-trading-os/.env`)
```
ANTHROPIC_API_KEY=<satt>
BINANCE_API_KEY=<live-key från binance.com>
BINANCE_API_SECRET=<live-secret>
BINANCE_TESTNET_API_KEY=XBakDluz2U1brE0MYB6MpGCaudMgLALBM4t8KKm2f3dTLN7YV35XZjNvPCzlVL0
BINANCE_TESTNET_API_SECRET=ZHJKwfFZ5P4MiaoDhyk8pK3tT7Rn8CDlKXRlvs2Ary818RNJ4XBku68rexRJWufp
PERPLEXITY_API_KEY=<satt>
OANDA_API_KEY=<satt men ev gammal>
OANDA_ACCOUNT_ID=<satt men ev gammal>
SUPABASE_ANON_KEY=<satt>
TELEGRAM_BOT_TOKEN=8763428928:AAEvZKMevT17M-tNZHyQpGdO89mkpoEOq54
TELEGRAM_CHAT_ID=1928144865
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
ssh -i ~/.ssh/claude_key root@72.60.36.92 'cd /root/mikael-trading-os && git pull --rebase && docker compose up -d --force-recreate trading-os'
```

För TS-ändringar: `docker compose build --no-cache trading-os` först.

---

## Nästa steg / TODO

### Hög prio (Mike väntar på)
1. Verifiera att TEST-KONTO SALDO panelen visar Binance-data efter hard-refresh
2. Live-trade verifiering: "köp BTC $5" i LIVE-mode → hamna på riktiga binance.com
3. Trade-historik från Binance — räkna PnL + W/L i panelen från `/api/binance/trades`
4. Win-rate-fält ("—" just nu) — fyll med riktig data

### Medium prio
5. Oanda demo-konto för forex-trades
6. Live WebSocket från Binance (millisekund-uppdateringar)
7. Position-stängning via API

### Låg prio
8. TradingView Pine Script-strategier
9. Multi-tenant migration (Supabase service_role-key behövs)
10. Stripe billing (SaaS-tier system)

---

## Hur nästa session börjar

**Mike skriver troligen:**
> *"Fortsätt från senaste commit på mikael-trading-os, läs HANDOVER.md"*

**Du gör:**
1. Läs denna fil
2. Verifiera deploy-status: `curl -s https://trading.aiupscale.agency/api/binance/dual`
3. Fråga Mike vad han vill prio:era

**Lärdomar från denna session:**
- Mike hatar när det sägs "fixat" men cache visar gammalt → alltid be om inkognito-test
- Paper-simulering är borta — TEST = Binance Testnet (riktig API)
- Mike vill 75%+ winrate men riktigt trading är 50-65%
- Säkerhetslås $5/trade är kritiska — får ALDRIG tas bort utan explicit OK
- Allt synkat 1:1 med Binance.com är icke-förhandlingsbart
