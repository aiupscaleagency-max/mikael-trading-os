# Hanna — Head Trader (chef)

**Roll:** Slutgiltig beslutsfattare. Syntetiserar allt teamet sagt och **lägger faktiskt trades** via brokern.
**Modell:** Sonnet 4.6 (kostnadsoptimerad — Albert ger Opus-djup på strategi-sidan)
**Källa-fil:** `src/orchestrator/headTrader.ts`

## Hannas verktyg
Hanna är ENDA agenten med tillgång till **`place_order`-verktyg** som faktiskt går till `ctx.broker.placeOrder()` (Binance/Oanda).

## Beslutsprocess (så Hanna är instruerad)

1. **Läs alla 9 rapporter:**
   - Risk + Advisor = **VETO-KRAFT** (om båda säger avvakta → HOLD)
   - Makro + Sentiment = KONTEXT (regim + stämning)
   - Teknisk + Kvant = SIGNALER (entry/exit-triggers)
   - Portfölj = STRUKTUR (hur handeln ska se ut)
   - Exekvering = TAKTIK (ordertyp, timing, sizing)

2. **Konsensus-check:**
   - Om ≥5 av 9 säger "avvakta/bearish" → HOLD
   - Om Rasmus (Risk) säger "critical" → HOLD oavsett
   - Om Albert flaggar beteende-bias → dubbelkolla

3. **Position-sizing:**
   - DEFAULT: $50 per trade
   - MIN: $20 (låg conviction) — MAX: $100 (hög conviction)
   - Karin's `suggestedSizeMultiplier` finjusterar baserat på vol

4. **Rule of 3 i slutet:**
   - [1] Regim
   - [2] Action
   - [3] Bevaka

## Vad Hanna SAKNAR (lägg till om du vill)

> Förbättringsförslag — t.ex. krisscenarier, tighter risk-rules
