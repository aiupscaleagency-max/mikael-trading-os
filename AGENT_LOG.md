# Agent logg

## 2026-09-22 — Diagramvy LIVE/SIMULERAD

- Lade till flera staplade valutaparsdiagram med valbar symbol, borttagning, tidsintervall, insats och procentförändring.
- LIVE-diagram hämtar historik från befintligt Binance-klines-API och tar emot OHLC-uppdateringar via Binance WebSocket; SIMULERAD-vyn använder lokala simulerade candles.
- Lade till responsiv layout och återanslutningsskydd mot gamla WebSocket-anslutningar. Ingen orderlogik ändrad.
- `git diff --check` passerade. UI kunde inte öppnas i den här sessionens webbläsarpanel; ingen LIVE-anslutning eller order skickad.

## 2026-09-22 — TEST/LIVE-routing och Neural Trader

- Gjorde Binance credential-routing entydig: Mainnet kräver `BINANCE_LIVE_*`; TESTNET använder `BINANCE_TESTNET_*` (äldre generiska `BINANCE_*` är endast TESTNET-alias).
- LIVE orderläge väntar på godkännande även om äldre `.env` anger auto. Binance order-API kräver uttrycklig bekräftelse, färsk WebSocket (högst 30s), och dashboarden visar orderdetaljer separat. Chat-agenten får inte skicka LIVE-order.
- `neural-trader@2.8.11` utvärderades och togs bort efter npm-audit: 1 critical + 10 high bland 19 sårbarheter. Det ingår inte i appen.
- Kontroller vid första ändringen: CLI version/help fungerade, `graphify update .` slutfördes. `tsc --noEmit` hittar 57 befintliga fel i åtta filer (inga fel i ändrade config/API-filer). Live-anslutning/order har inte körts.

## 2026-09-22 — Säkerhetsgranskning

- Stängde API-routes bakom Supabase access-token verifiering, aktiv profil och `SUPABASE_USER_ID`-ägarlås. SameSite/HttpOnly-cookie; credentialed CORS bara för `PUBLIC_URL`.
- Tog bort hardkodad adminlösenordsgenväg och localStorage-fallback för inloggning. API-nycklar cachas endast i minnet på klientsidan.
- Lade till migration som nekar klienter att ändra profilens admin/status-fält och tar bort e-postbaserad automatisk admin-trigger.
- Docker använder lokal npm-runtime (`npm run agent`) i stället för `npx`-hämtning; `tsx` är runtime dependency och install-skript körs inte i imagen.
- Uppdaterade Anthropic SDK till 0.91.1 och ws till 8.21.0. npm audit: inga critical/high i produktionsgrafen; en low kvar i esbuild, begränsad till esbuild dev-server på Windows.
- Pin:ade Supabase browser-SDK CDN till exakt 2.105.0; Telegram webhook kräver nu `TELEGRAM_WEBHOOK_SECRET`.
- Verifierade Binance publika WS: färska BTCUSDT-värden hamnade i appens cache. Fixade en bugg där manuellt stopp ändå återanslöt; ordergrinden kräver nu även ett färskt pris för den exakta symbolen.
- Återstår: köra migrationen i Supabase, sätta `SUPABASE_USER_ID`, verifiera Supabase-login/WS på den riktiga servern; ändringarna i denna sektion har inte deployats.

## 2026-09-22 — Fail-closed LIVE

- Binance LIVE-order stoppas server-side även efter UI-bekräftelse tills en daglig PnL-spärr kan mätas och återställas säkert över omstarter. Safety-API och dashboard säger uttryckligen att order är låsta; tog bort den falska dagliga loss-cap-räknaren.
- Oanda LIVE-setup/order och LIVE auto-sell nekas server-side. Oanda-setup accepterar endast Practice.
- Uppdaterade README så den inte längre beskriver LIVE som tillgängligt.
- `graphify update .` klart. `npx tsc --noEmit` visar 54 fel i broker/orchestrator/monitor-moduler; inga fel i ändrade API/auth/WS/Telegram-filer. `git diff --check` passerade. `npm audit --omit=dev` rapporterar en låg esbuild-devserverrisk på Windows; inga riktiga order eller deploy kördes.
