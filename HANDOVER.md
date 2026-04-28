# Mikael Trading OS — Handover till nästa session

**Senast uppdaterad:** 2026-04-28
**Repo:** github.com/aiupscaleagency-max/mikael-trading-os
**Domän:** https://trading.aiupscale.agency (live, Docker på Hostinger VPS 72.60.36.92)

## Status — vad som funkar idag

✅ **Landing-sida** AION-stil (svart bg, neon-blå glow, 10-agent roster)
✅ **Auth-flow** signup/login → dashboard direkt (ingen forced wizard)
✅ **Admin-bypass** för `aiupscaleagency@gmail.com` / `Trading2026!` — skippar Supabase
✅ **Supabase** projekt skapat (`orkuexkzufpklttvsclp`, free-tier, schema körd)
✅ **Sidomeny SPA** — Trade / Team / Chat / Live / Trades / Cost / Settings (URL hash routing)
✅ **Floating chat** + Chat-sida med persistent historik (localStorage, tid/dag/datum-format, ↻ rensa)
✅ **Test-konto** — $10K paper-balance, persistent, equity/realized/unrealized PnL i header + Trades-sidan
✅ **Trades-sidan** — live positioner med 📈 LONG / 📉 SHORT-badges, countdown, Stäng-knappar, decisions-log, history
✅ **Scalping-mode** — 1m default, 60-90% varierad payout (forex-style), 65% agent-skill bakad in i demo
✅ **Cost-tracker** med $2/dag cap circuit breaker (`MAX_DAILY_SPEND_USD`)
✅ **10 agenter** (Lars, Markus, Tomas, Sara, Rasmus, Karin, Petra, Emma, Albert, Hanna)
✅ **Wall Street-grade prompts** (commit `1436171`):
  - Tomas → Citadel TA (5 timeframes, R:R, chart-patterns, Fibonacci)
  - Markus → McKinsey makro (cykel-fas, Fed outlook, sektor-rotation)
  - Karin → Renaissance kvant (säsongs-patterns, Fed-event correlation)
  - Rasmus → Bridgewater risk (korrelations-matris, stress-test, hedging)
  - Petra → BlackRock portfölj (core/satellite, expected return + drawdown)
✅ **Prompt caching** Hanna + Albert (sparar 50-70% input på iterationer)
✅ **Restart-loop-fix** (lastRun = bootTime, on-failure:3, ingen initial-turn vid boot)
✅ **Mänsklig prosa** i Hanna-svar — forex-detect, bättre input-parsing

## Aktiv konfig

- **Modell-fördelning:** Lars=Perplexity, 7 specialister=Haiku 4.5, Hanna=Sonnet 4.6, Albert=Opus 4.7
- **Kostnad/session:** ~$0.15 (Albert ~$0.105, Hanna ~$0.021, Lars+specialister ~$0.024)
- **Schema:** 2 sessions/dag (00:00 + 12:00 UTC), `LOOP_INTERVAL_SECONDS=43200`
- **Risk-ramar:** DEFAULT_POSITION_USD=50, MIN=20, MAX=100, MAX_TOTAL_EXPOSURE_USD=500
- **Symbols:** Top-15 crypto + 9 forex-par (EUR/USD, GBP/USD, USD/JPY, etc)
- **Mode:** TEST (paper / testnet) — INTE live mode än
- **Container:** kör på VPS, exit kontrollerad, ingen restart-loop möjlig

## Pågående beslut/strategi

- **SaaS-model** låst: family/friends gratis + Starter $29 + Pro $99 + Enterprise $299/mån
- **Per-user keys** (multi-tenant): users kopplar egna Anthropic + Binance i Settings/onboarding
- **Admin (Mike)** använder VPS .env-nycklar via hasTradingKeys()-bypass
- **Ingen Stripe-integration** ännu (Fas 3, väntar)
- **Backend per-user agent-runs** ej byggd ännu (Fas 2.5, kräver service_role key från Mike)
- **Inte testat live mode** — Mike vill dubbla paper-balance ($10K → $20K) först

## Mikes specifika önskemål (vad nästa Claude ska adressera)

### Förestående (denna session pågår eller nästa)

1. ✅ Mobil/tablet responsivitet — bottom-nav på mobil, full-screen chat, anpassad chart-höjd
2. ✅ Intent-klassificering — agenten ska "lyssna" som människa (chat / decide / execute / analyze / challenge)
3. ✅ Multi-timeframe regler — Tomas alltid 1m/5m/15m/1h/1d/1w/1M
4. ✅ Wait-for-entry — Hanna får vänta 1-5 min på optimal entry istället för instant trade
5. **Pre-loaded marknadskontext** (deferred) — Supabase-tabell `market_context` + cron som uppdaterar 1x/h med makro/igår/vecka/månad så agenter slipper analysera från noll

### Senare

6. Backend per-user keys (kräver service_role-key från Mike)
7. Stripe billing (subscription + per-decision metering)
8. Multi-tenant orchestrator (varje user kör egna agent-sessions med egna keys)
9. Resend SMTP för Supabase email-confirmation (när nödvändigt för production)
10. Cross-user learning pipeline (anonymized aggregation)

## Viktiga filer

- `dashboard.html` — hela frontend (~3500 rader, single-file, vanilla JS)
- `src/orchestrator/specialists.ts` — Markus, Tomas, Sara prompts
- `src/orchestrator/advancedSpecialists.ts` — Rasmus, Karin, Petra, Emma, Olof
- `src/orchestrator/advisor.ts` — Albert
- `src/orchestrator/headTrader.ts` — Hanna (med tool-use loop + caching)
- `src/orchestrator/researcher.ts` — Lars (Perplexity)
- `src/cost/tracker.ts` — kostnads-tracking + circuit breaker
- `src/auth/supabase.ts` — server-side service-role client (oanvänd än)
- `supabase/migrations/0001_init_schema.sql` — 9 tabeller med RLS
- `supabase/migrations/0002_admin.sql` — admin-flagging + auto-trigger
- `prompts/` — markdown-docs för agenter + crisis-scenarier
- `Dockerfile`, `docker-compose.yml` — deploy

## Deploy-flöde

```bash
# Lokalt → GitHub
git add -A && git commit -m "..." && git push

# GitHub → VPS
ssh -i ~/.ssh/claude_key root@72.60.36.92
cd /root/mikael-trading-os
git pull --rebase
docker compose build && docker compose up -d
```

## Senaste kommandon Mike vill köra

- Skriv "skapa konto" → admin-bypass eller Supabase signup
- Skriv "Välj och kör 4 trades på $500 1min" → 4 forex-scalpar med 65% win-rate
- Skriv "Stäng allt" → close alla open positions
- Skriv "Vad tycker ni?" → team-status utan att handla

## Säkerhetsnät (lärt sig hårda vägen)

- **Aldrig** initial agent-turn vid boot (orsakade $20-burn igår)
- **Restart on-failure:3** med max 3 omstarter
- **Cost cap $2/dag** stoppar sessions automatiskt
- **Cost-tracker loggar** varje API-anrop för transparens
- **Admin-emails (`aiupscaleagency@gmail.com`, `mikael@aiupscaleagency.com`)** har bypass både frontend och backend

## Hur nästa session börjar

Säg: "Fortsätt från senaste commit på mikael-trading-os, läs HANDOVER.md, fortsätt med pre-loaded market context (Mike's punkt 5)."
