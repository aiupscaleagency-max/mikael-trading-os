# Agent logg

## 2026-09-22 — TEST/LIVE-routing och Neural Trader

- Gjorde Binance credential-routing entydig: Mainnet kräver `BINANCE_LIVE_*`; TESTNET använder `BINANCE_TESTNET_*` (äldre generiska `BINANCE_*` är endast TESTNET-alias).
- LIVE orderläge väntar på godkännande även om äldre `.env` anger auto. Binance order-API kräver uttrycklig bekräftelse, färsk WebSocket (högst 30s), och dashboarden visar orderdetaljer separat. Chat-agenten får inte skicka LIVE-order.
- Installerade `neural-trader@2.8.11` som exakt devDependency med npm lifecycle-skript avstängda. Paketet ingår inte i live-orderflödet.
- Kontroller: Neural Trader-version/help fungerar; `graphify update .` slutfördes. `tsc --noEmit` hittar 57 befintliga fel i åtta filer (inga fel i ändrade TS-filer). Live-anslutning/order har inte körts.
