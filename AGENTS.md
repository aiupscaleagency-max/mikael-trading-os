# IG Trading OS

Endast IG för Forex/krypto och order; Tiingo ger separat historiskt referensunderlag. `npm run agent`, `npm run serve` och `npm run ui` startar samma IG-server. Äldre mäklare och legacy-startvägar är borttagna.

Bevara nya layouten. JEV → Teknisk analytiker → Hanna, exakt två agenter. Signaler använder verifierade stängda ljus; ofullständiga live-ljus får enbart visas i diagram. Befintlig modellrouting, budget, kill-switch och Demo/Live-separering gäller. Strategier utan backtest får aldrig beskrivas som verifierat lönsamma.

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

Fallback-nycklar i macOS Keychain: `aiupscale.vercel.gateway-key` (Gateway-rutten
först) och `aiupscale.typesafe.api-key` (direkt-rutten först).

### En nyckel, alla modeller

Vercel AI Gateway är OpenAI-kompatibel. Samma nyckel och samma bas-URL
(`https://ai-gateway.vercel.sh/v1`) betjänar JEV, Claude-modeller och
GPT-modeller — alltså räcker en nyckel för Hermes, jev-loop-skillen och Codex.

`./scripts/set-gateway-key.sh` tar emot nyckeln en gång med dold inmatning och
lägger den i Keychain, i `.env`, i jev-loop-skillens `.env` och i
`~/.config/aiupscale/gateway.env`. Den sista exporterar även `OPENAI_API_KEY`
och `OPENAI_BASE_URL` så att OpenAI-kompatibla verktyg går via gatewayen.

Lägg aldrig in nyckeln för hand och skriv aldrig ut dess värde.

## Verifiering

Kör `npx tsc --noEmit`, `npm run test:workspace` och `npm run test:forwarder`. Testerna använder lokala fixtures. Driftsatt streaming kräver dessutom HTTP101, IG CONNECTED:WS-STREAMING och verkliga broker-tidsstämplade pris-/ljusuppdateringar.

Inga riktiga order under utveckling/test. Ändra inga konton eller nycklar och skriv aldrig ut nyckelvärden. Kommentarer och commit-meddelanden på svenska. Påstå aldrig att något fungerar utan verifiering.
