# Överlämning: Mikes Trading-OS (4 oktober 2026)

Till ChatGPT och Hermes. Läs hela filen innan du gör något. Den beskriver läget, reglerna och vad som är kvar. Mike skriver svenska. Svara kort, enkelt och rakt: säg vad du gör, ge inte en lista med val. Klistra alltid in hela kommandon.

---

## 1. Vad det är

**Trading-OS** är Mikes egen kryptobot med en dashboard. Ett AI-team analyserar, föreslår affärer och lägger dem först när Mike trycker **Godkänn**.

| Vad | Var |
|---|---|
| Kod | GitHub `aiupscaleagency-max/mikael-trading-os`, gren **`claude/vibrant-noether-fgy8vh`** (huvudgren, PR:er går hit) |
| På datorn | dator1 (Mac): `~/ai_upscale_work/mikael-trading-os` |
| Sidan | **Agentic-OS → Trading: https://agentic-os.tail64d627.ts.net/trading** (fungerar från alla enheter i Tailscale). Boten direkt: https://aiupscale-dator1.tail64d627.ts.net:9443. Bara på Macen: http://localhost:3939 |
| Autostart | launchd `com.aiupscale.trading-os` (startar vid inloggning, startas om vid krasch). Tailscale: `tailscale serve --bg --https=9443 http://127.0.0.1:3939`. I `.env`: `DASHBOARD_TAILNET_HOSTS=aiupscale-dator1.tail64d627.ts.net` |
| Språk | TypeScript/Node. Kontroll: `npx tsc --noEmit -p .` |
| Logg | `data/bot.log` |

**Starta om boten** (kopiera hela raden). Boten körs av launchd, så starta ALDRIG en egen `nohup npm run agent` (då blir det två):
```
cd ~/ai_upscale_work/mikael-trading-os && git pull origin claude/vibrant-noether-fgy8vh && npx tsc --noEmit -p . && launchctl kickstart -k gui/$(id -u)/com.aiupscale.trading-os && sleep 15 && curl -s -o /dev/null -w "%{http_code}\n" localhost:3939/ && echo "BOTEN ÄR IGÅNG"
```
Om `git pull` klagar på lokala ändringar ska de inte raderas. Kör `git status` och fråga Mike.

---

## 2. Hårda regler (bryt aldrig)

1. **Bara TEST.** `MODE=paper`. Sätt aldrig `MODE=live` och ändra aldrig `.env` för LIVE. Mike vill testa klart först.
2. **Godkänn aldrig en order åt Mike**, inte ens i TEST. Mike trycker själv.
3. **Inga nycklar i chatt, kod, commits eller loggar.** Mike lägger själv in nycklar i `.env` via terminalkommando.
4. **LLM-ordningen är låst:**
   - JEV körs via **Vercel AI Gateway** först. Det är JEV som förutspår signaler och ser tidiga tecken.
   - OpenRouter är **bara reserv**, så att krediterna aldrig tar slut.
   - Agenterna använder **GPT-6 Astra** och **Claude Sonnet 5.x**.
   - Byt aldrig modell eller ordning utan att fråga. Mike följer en kurs och gör exakt som den.
5. **Lägg till, bygg inte om.** Ändra bara det Mike ber om, och säg aldrig "bygger om".
6. **Inget destruktivt utan OK.**
   - Döda processer bara via PID, aldrig `pkill -f`.
   - Rör inte Agent-OS medan Mike går kursen.
   - Rör inte Codex-kopian i `ai_upscale_work/projects/mikael-trading-os` (submodul på en annan gren).
7. **Bara Bybit EU.** Ingen Binance, ingen Alpaca.
8. **Verifiera före "klart"**: tsc grönt, starta om, kolla att sidan och API:t svarar.

---

## 3. Hur det fungerar nu

**Mäklare.** TEST är `bybit-paper`: låtsaspengar ($10 000 USDC i `data/bybit-paper.json`) som fylls mot Bybit EU:s riktiga orderbok. Avgiften är 0,25 % per köp och 0,25 % per sälj. LIVE är Bybit EU i USDC och är avstängt.

**Kedjan:**
1. Signalmotorn räknar gratis matte på alla par hela tiden.
2. Vid analys sållar JEV bort svaga signaler, och de 3 bästa paren går vidare till AI-teamet.
3. Teamet består av två specialister (Teknisk och Risk) och Hanna som Head Trader.
4. Förslagen läggs i Väntande ordrar, och Mike godkänner.

**AI körs bara på begäran.** Det sker när Mike trycker **Kör analys**, eller på fasta tider via `.env` med `ANALYSIS_SCHEDULE=09:00,15:00`. En analys kostar ungefär $0,06. Taket är $5 per dag och $20 per vecka.

**Minne.** Varje analys sparas i `data/trade-memory.jsonl` och i Obsidian under `Trading-minne/`. Hanna får en kort sammanfattning av tidigare vinster och förluster före varje analys.

**Tidshorisont, nytt i PR #51.**
- Knappar för 1, 5, 15 och 30 min. Standard är 1 min, och mer än 30 min tillåts inte nu.
- När analysen är klar visas en popup med par, pris, TP, SL, vinst/förlust och en nedräkning, plus knapparna GODKÄNN och AVVISA.
- Gamla förslag går ut automatiskt.
- Ett köp säljs automatiskt när tiden är slut om TP/SL inte nåtts. Det säljer bara det köpet, aldrig mynt Mike redan ägde.
- Koden ligger i `src/server/tradeHorizon.ts`.

**Resultatfönster, nytt i PR #50.**
- Kortet "Resultat" visar alla affärer i grönt och rött, totaler, öppna innehav och en Sälj-knapp.
- API: `GET /api/results`. Koden ligger i `src/server/results.ts`.

**CALL och PUT på spot.** CALL betyder köp och ger vinst när priset stiger. PUT säljer bara mynt man redan äger, eftersom spot inte kan tjäna på fallande pris. Derivat eller marginal är inte påslaget och ska inte läggas till under TEST.

**Bybit CLI.** Bybits officiella CLI är installerad. Kommandot `bybit-eu` pekar om den mot api.bybit.eu, läser nycklarna från `.env` och tillåter **bara läsning** (`get-*`). Ordrar blockeras och går bara via Trading-OS. Exempel: `bybit-eu market get-tickers --category spot --symbol BTCUSDC --pretty`. Koden ligger i `tools/bybit-eu/`.

**Demo.** Bybit EU har ingen API för demokonton (404). Därför är TEST `bybit-paper`. Demo-raderna i `.env` är bortkommenterade.

**Minsta order (Bybit EU).** BTC/USDC $1, ETH/SOL/XRP $5. LIVE-köp kräver minsta order + 10 % (BTC $1,10, övriga $5,50) så att de går att sälja tillbaka.

**Data.** Allt kommer från Bybit EU (WebSocket och REST). Tiingo används inte i Trading-OS, bara i PTQA-kursprojektet (`~/ai_upscale_work/projects/ptqa-trading`).

---

## 4. Viktiga filer

| Fil | Vad |
|---|---|
| `src/server/api.ts` | Alla API:er, godkänn-flödet (`executeApprovedOrder`) |
| `src/server/tradeHorizon.ts` | 1/5/15/30 min, utgång, tidsstyrd försäljning |
| `src/server/results.ts` | Vinst/förlust till resultatfönstret |
| `src/server/liveTpSl.ts` | TP/SL-bevakning för LIVE |
| `src/brokers/bybitPaper.ts` | TEST-kontot |
| `src/server/analysisMode.ts` | Manuell eller schemalagd analys |
| `src/server/jevClient.ts` | JEV-vägar (låst ordning) |
| `src/llm/gateway.ts` | Modellkedjan och fallback |
| `src/memory/tradeMemory.ts` | Tradingminne |
| `dashboard.html` | Hela sidan (en fil) |

---

## 5. Pågår och kvar

| Vad | Läge |
|---|---|
| Popupen visar par, tid och klockslag. Vid "vänta" visas bästa köpläget med **"Köp ändå"** (går till Väntande för Godkänn). Alla par har 1/5/15/30 min | ✅ Klart (PR #53) |
| Mike kör TEST-trades och läser resultatfönstret | Mike gör själv |
| Vercel AI Gateway-krediter är slut (402), så allt går via OpenRouter | Mike fyller på |
| LIVE: Bybit-saldot är $0. Mike sätter in pengar och säger själv till | Väntar på Mike |
| Rekommenderad start i LIVE: **$2 per trade på BTC**, 5 per dag (tak $10/dag, $5/order) | Råd givet |
| Supabase-tabellen `trading_memory` (migration 0003) är inte applicerad, eftersom projektet saknas | Senare |
| Telegram: signaler och godkänn från mobilen | Önskemål, senare |
| Vercel-nyckeln som klistrades in i chatt 30/9 ska roteras | Mike |

---

## 6. Startprompt att klistra in

> Du jobbar med Mikes Trading-OS. Läs först `OVERLAMNING-CHATGPT-HERMES.md` och följ reglerna i avsnitt 2 exakt: bara TEST, godkänn aldrig order, inga nycklar, LLM-ordningen är låst, lägg bara till. Svara på svenska, kort och rakt. Börja med: kör `git log --oneline -5` och `curl -s https://aiupscale-dator1.tail64d627.ts.net:9443/api/results | head -c 400` i `~/ai_upscale_work/mikael-trading-os` och säg i en mening vad läget är.
