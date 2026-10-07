# IG Trading OS

Handelsyta för IG Forex och krypto, med Tiingo som separat historiskt referensunderlag. JEV via befintlig Vercel AI Gateway-routing följs av Teknisk analytiker och Hanna. Nya layouten används; andra mäklare och äldre motorer är borttagna.

## Start

```sh
npm ci --allow-git=all
npm run agent
```

Startar en IG-server på DASHBOARD_PORT (standard 3939). Sessionsanalys startas manuellt eller via sparade IG-scheman. Samma server används av båda datorerna och Agentic OS; starta inte flera handelsmotorer.

Befintliga IG-konton läses från lokal credential store. Nyckelvärden ska aldrig sparas i Git. Konfigurationsexempel finns i .env.example. Live-order kräver separata verifierade ordergrindar; utveckling/test får inte skicka riktiga order.

## Kontroller

```sh
npx tsc --noEmit
npm run test:workspace
npm run test:forwarder
```

Browser- och WebSocket-testerna använder lokala fixtures. Faktisk livesynk i drift kräver dessutom HTTP101, IG CONNECTED:WS-STREAMING och verkliga broker-tidsstämplade PRICE/CHART-uppdateringar. Historik och metadata använder IG REST. Ofullständiga aggregerade live-ljus används inte för analys.

## Dator 1

scripts/reconcile-dator1.sh är avsett för den särskilt granskade checkpointen b72bed0 och sammanförd målcommit. Det säkerhetskopierar den pågående sammanslagningen och uppdaterar endast den befintliga LaunchAgent-tjänsten. Kör enligt chatten; scriptet avbryter om arbetskopian eller tjänstens sökväg avviker.
