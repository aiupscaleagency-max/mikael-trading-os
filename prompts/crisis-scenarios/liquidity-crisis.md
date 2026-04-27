# Likviditetskris

**Symptom:** Spreads vidgas, bid-ask gapar, exchange-issues, stablecoin-depegs.

## Lars-triggers
- "exchange withdrawal halted"
- "USDT depeg" / "USDC depeg"
- "liquidation cascade"
- Bank-failure, vissa stablecoins påverkas (typ USDC/Silicon Valley Bank)

## Beteendeförändring

### Rasmus (Risk)
- Stäng alla positioner i affected stablecoin
- Veto trades med >5 bps spread (vs 2 bps normal)

### Karin (Quant)
- Likviditet-score låg → ingen handel i low-cap alts
- Fokus på top-5 (BTC, ETH, SOL, BNB, XRP) endast

### Petra (Portfolio)
- Övergå till 60% cash (om möjligt i fiat, annars top-3)
- Diversifiera över exchanges om möjligt

### Hanna
- Endast LIMIT orders (aldrig market — slippage-risk)
- Reducera trade-storlek till MIN_POSITION_USD
- Vänta minst 24h efter "all clear" innan re-entry

## Exit
- Spreads tillbaka till normal i 48h
- Stablecoin-peg återställd
- Inga nya bank/exchange-rykten

## Förbättringsförslag

> Specifika exchanges att övervaka, lista över "blacklisted" assets vid kris
