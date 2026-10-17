# Överlämning: Mikes Trading-OS på IG (11 oktober 2026, kl. 09:15)

> **Skrivet MEDAN arbetet pågår, före det sista steget var klart.**
> Mike bad om filen nu så att ChatGPT, Hermes eller en ny Claude kan ta vid utan strul om hans veckogräns tar slut.
> Allt nedan stämde när det skrevs. Kontrollera alltid läget med kommandona i avsnitt 7 innan du gör något.
> Läs HELA filen först. Mike skriver svenska och vill ha korta, raka svar med tabeller.

---

## 1. Slutmålet (oförhandlingsbart)

Mikes egen Trading-OS (AI-team + dashboard) som handlar på **IG**. **TEST = IG Demo** och **LIVE = IG Live**. De två ska vara **exakt likadana**:

- samma instrument (allt Forex och krypto som IG erbjuder),
- samma sidor, knappar och agenter,
- samma resultatfönster och samma live-synk av priser och diagram.

Enda skillnaden är låtsaspengar eller riktiga pengar. Mike ska kunna:
1. se alla valutor och krypton, välja själv och lägga trades (Köp/Sälj → Väntande ordrar → **Godkänn**),
2. bocka i par och köra **Analysera valda** eller **Agentsession**, och få **konkreta tips per par**: rang, köp/sälj/avvakta, ingång, TP, SL, storlek, tid och säkerhet,
3. öva i Demo på exakt samma instrument som i Live.

Allt som fanns i den gamla Bybit-versionen ska finnas kvar: popup, tidshorisont 1/5/15/30 min med automatisk stängning, resultatfönster, minne, JEV, AI-team och agentträd. Mike: **"Det ska funka EXAKT likadant som förut, bara optimera layouten lite och byta till IG."**

---

## 2. Hårda regler (bryt ALDRIG)

1. **Godkänn aldrig en order åt Mike.** Lägg aldrig order själv, varken Demo eller Live. Mike trycker själv.
2. **LIVE handlar med riktiga pengar.** Mike låste upp det själv 2026-10-10. `.env` i `~/mto-ig` har `MODE=live`, `LIVE_TRADING_CONFIRMED=true`, `IG_ORDER_EXECUTION_ENABLED_LIVE=true` och `IG_ORDER_EXECUTION_ENABLED_DEMO=true`. `EXECUTION_MODE` är approve: allt kräver Godkänn. Ändra ALDRIG dessa utan att Mike uttryckligen ber om det.
3. **Inga nycklar i chatt, kod, commits eller loggar.** IG-nycklarna ligger i `~/.config/aiupscale/trading-ig.json`. Tiingo läses från `TIINGO_API_KEY` eller kursens `keys.json` (`src/data/tiingoHistory.ts` `tiingoKey()`). Skriv aldrig ut värden.
4. **Byt inte modell, LLM-ordning, JEV-ordning eller kostnadstak** utan att fråga Mike och visa priser.
5. **Lägg till, bygg inte om.** Ändra bara det Mike ber om. Gör inga "passa på"-ändringar.
6. **Rör inte skrivstoppet** i `src/integrations/igConnection.ts` (lager A och B), inte heller `igOrders.ts` eller `orderGate.ts`, utan granskning.
7. **Analys får aldrig äta orderreserven** (12 läsningar/min per miljö). Se `analysisRead` i `src/server/igAgentData.ts`.
8. **Döda processer bara via PID** (`lsof -tiTCP:3940 -sTCP:LISTEN`), aldrig `pkill -f`. Ingen destruktiv git: ingen reset --hard, ingen force-push.
9. **Arbetssätt:** kodare → **granskare (separat agent) → APPROVE** → push → driftsätt → kontrollera på skärmen → rapportera. Säg aldrig "klart" utan att ha sett det på skärmen.
10. **Rör inte den gamla boten** `com.aiupscale.trading-os` på :3939. Den är pausad med `launchctl bootout`; Mike bestämmer.

---

## 3. Var allt finns

| Vad | Var |
|---|---|
| GitHub | `aiupscaleagency-max/mikael-trading-os` |
| **Senaste kod (allt ihop)** | gren **`claude/ig-agent-data`**, commit **`bdbf374`** |
| Körande instans | `~/mto-ig`, detached på `bdbf374`, port **3940** (startad med `nohup`, ingen launchd) |
| Utvecklings-worktree | `~/mto-live` (gren `claude/ig-agent-data`). `~/mto-allpairs` är en äldre worktree och används inte. |
| Data och logg | `~/mto-ig/data-ig/` (`bot.log`, `ig-sessions/`, `ig-agent-notes-*.json`, `ig-demo-sim.json`, `ig-sparklines-*.json`) |
| Sidan för Mike | **Agentic-OS → Trading: https://agentic-os.tail64d627.ts.net/trading** (iframe mot :9443) |
| Direkt | https://aiupscale-dator1.tail64d627.ts.net:9443 (Tailscale serve → 127.0.0.1:3940) |
| Dator | **Dator 1** (Mikes Mac). Det är den enda han jobbar på. |

**Grenkedja och PR:er** (rörig, så läs noga):
- `claude/ig-on-vibrant`: basgrenen för IG. Där ingår PR #75 (Live-läsning).
- PR #76 slogs ihop in i `claude/ig-live-read-catalog`, inte in i basen.
- **PR #77 (`claude/ig-demo-sim`) är öppen** men ersätts av grenen `claude/ig-agent-data`, som innehåller ALLT (#75, #76, #77 och agentdata).
- **Rätt nästa steg:** EN PR från `claude/ig-agent-data` till `claude/ig-on-vibrant`. Mike slår ihop den själv. Agenterna får inte slå ihop; auto-läget stoppar det.

**Driftsätta en ny version.** Mike kör raden själv i Terminal. Agentens säkerhetsspärr stoppar omstarter när riktiga pengar är upplåsta.
```
cd ~/mto-ig && git fetch -q origin <GREN> && git checkout -q --detach <COMMIT> && npx tsc --noEmit -p . && kill $(lsof -tiTCP:3940 -sTCP:LISTEN); sleep 3; nohup npx tsx src/run.ts --serve >> data-ig/bot.log 2>&1 &
```

**Kontroller före push:** `npx tsc --noEmit -p .`, `npm run test:ig` (alla gröna, cirka 115 PASS) och `node scripts/check-dashboard-scripts.mjs` (28 skript, 0 fel).

---

## 4. Vad som FUNGERAR nu (kontrollerat på skärmen 10–11 okt)

| Funktion | Läge |
|---|---|
| Byte Demo ↔ Live | ✅ Uppdaterar saldo, märkning, instrument och orderläge. Ingen inloggning krävs. |
| Live-saldo | 500 SEK (riktiga pengar). Demo: IG Demo 100 000 SEK, simulering 100 000 SEK. |
| Alla par | ✅ Hela katalogen (Live: Krypto 38, Forex 199, Alla 237) med filter, sök och Visa fler. Kort har kryssruta, pris, minidiagram, signal, agenter, KÖP/SÄLJ och Analysera. |
| Demo = Live | ✅ Demo visar samma 38/199/237. Instrument som IG Demo saknar är märkta "Demo-simulering · Live-pris · låtsaspengar" och fylls som papper mot Lives bid/offer (`src/integrations/igDemoSim.ts`). Simuleringen gör aldrig skrivande IG-anrop. |
| Bevis för "saknas i Demo" | IG Demo-strömmen avvisar med **kod 21 "Invalid group"**, eller Demo svarar 404. Beviset gäller per Demo-konto i 6 h. Ett instrument med riktigt Demo-pris blir aldrig sim. |
| Live-synk | ✅ Korten på skärmen (högst 20) uppdateras på varje IG-tick: pris, idag-%, status och diagrammets sista punkt. |
| Minidiagram | IG först, Tiingo när IG inte kan leverera, märkt "Tiingo-diagram (ej IG-pris)". IG:s historikkvot per vecka är SLUT på både Demo och Live; den återställs av IG. |
| Agentanalys | ✅ Riktig data: IG-ljus från minnet, IG REST om kvoten tillåter, annars Tiingo med ±3 %-kontroll mot IG-livepris. Hanna ger **tips per instrument med rang** (`src/orchestrator/headTips.ts`). |
| Agenternas topplista | ✅ Överst i Alla par. "Öppna i orderpanelen" fyller bara i panelen, Godkänn krävs. Route: `GET /api/ig/agent-top`. |
| Agentsession | ✅ Kör alla valda (5 per minut). Resultat per instrument under Agentsessioner. |
| Säkerhet | Skrivstopp i 2 lager i igConnection. Kill switch. Approve-läge. Analysen kan inte äta orderreserven (granskad). |

Senaste riktiga analys: 2026-10-11 08:41 av 7 krypton (Arbitrum, Sui, Near, Cardano $1, Cardano E1, Avalanche, Bitcoin Cash). Alla blev AVVAKTA med konkreta nivåer, till exempel Arbitrum köp över 0,1955, TP 0,1975, SL 0,1938.

---

## 5. Kvar att göra (i prioritetsordning)

| # | Vad | Detalj |
|---|---|---|
| 1 | **Skapa EN PR** `claude/ig-agent-data` → `claude/ig-on-vibrant` | Stäng #77 som ersatt. Mike slår ihop. |
| 2 | ✅ KLART: eurokontrakt (E1) | IG prissätter E1 i USD, samma kurs som $1 (kontrollerat live). De mappas nu till USD-tickern. |
| 3 | Tiingo HTTP 400 på några minidiagram | Cosmos, Dogecoin, Litecoin, Near, Polkadot. Retry per ticker finns nu för agenterna; kontrollera att minidiagrammen också gör så. |
| 4 | IG Live-läsbudgeten är ofta full | Katalogkrypning + diagram + sim. Katalogen står kvar på "delvis". Överväg att spara katalogen längre och krypa mer sällan. |
| 5 | Weekend EUR/USD utan priser | IG-sidan: IG uppdaterar inte priset. Visas ärligt som "inaktuellt". |
| 6 | Mike testar en riktig liten order | Först i Demo, sedan Live. **Agenten gör det INTE.** Kontrollera efteråt i `bot.log` och på ig.com. |
| 7 | Launchd för instans 2 | Bara om Mike ber om det. Den gamla boten `com.aiupscale.trading-os` på :3939 är pausad. |

Kravlistan i sin helhet: `docs/KRAV-IG-2026-10-09.md`. Strategy Library, scheman, PTQA-kursen och resten där är INTE genomgångna punkt för punkt. Gör en funktionsmatris mot den listan när ovanstående är klart.

---

## 6. Lärdomar (det som gick fel, gör inte om)

- Live var först låst även för **läsning**, så Demo/Live-bytet "funkade inte". Läsning och order är NU separerade.
- Agenterna fick **ingen data** (IG:s läsgräns + slut veckokvot) och svarade bara HOLD. Lös dataproblem först, inte prompten.
- Alla par visade bara bevakade instrument. Mike vill se **hela katalogen** i den gamla kortlayouten.
- Säg aldrig "klart" innan du har sett det på skärmen. Mike har märkt varje överdrift.
- Fråga Mike direkt när en gammal regel krockar med vad han vill nu. Exempel: "inga riktiga order under utveckling" gentemot "jag ska kunna köra live". Jobba inte vidare i flera timmar på en gissning.

---

## 7. Starta här (ny agent)

1. `cd ~/mto-ig && git rev-parse --short HEAD`: ska vara `bdbf374` eller nyare.
2. `curl -s https://aiupscale-dator1.tail64d627.ts.net:9443/api/mode`: visar `execution` och `executionMode`, som ska vara approve.
3. `curl -s https://aiupscale-dator1.tail64d627.ts.net:9443/api/ig/agent-top`: visar senaste tipsen.
4. Läs avsnitt 2 igen. Fortsätt sedan med avsnitt 5, punkt 1.
5. Rapportera kort till Mike på svenska med en tabell: vad som är gjort, kontrollerat och kvar.

---

## 8. Webbläsartest EFTER VARJE ÄNDRING (Mike-krav 2026-10-11: "allting måste funka och livesynkas")

Säg aldrig "klart" innan detta är gjort i en riktig webbläsare (Playwright/Chromium mot https://agentic-os.tail64d627.ts.net/trading). Gör det i **både TEST och LIVE**:

| # | Kontroll | Godkänt när |
|---|---|---|
| 1 | Byt instrument i huvuddiagrammet (`#sym-select`) | Diagrammets etikett och EPIC, orderpanelen `#bet-sym`, Köp/Sälj-panelens kvot och TP/SL (tömda) byts samtidigt |
| 2 | Byt instrument i orderpanelen | Huvuddiagrammet följer |
| 3 | Byt tid (1m/5m/15m/1h) | Diagrammet och Snabb-tradens tid följer. Köp/Sälj-innehavstiden (`ot-tf`) är medvetet separat. |
| 4 | Vänta 30–60 s | Priser, idag-% och sista ljuset ändras i takt med IG (Trade, Alla par, bevakning) |
| 5 | Byt TEST ↔ LIVE | Saldo, märkning, katalogantal (samma i båda), orderläge och resultat byts |
| 6 | Alla par | Hela katalogen visas. Demo har sim-märkning på Live-instrument. Diagram (IG eller Tiingo, märkt). Agenternas topplista syns. |
| 7 | Inga JS-fel | `pageerror` tom |

---

## 9. UPPDATERING 2026-10-17: läget nu (läs detta FÖRST, det ersätter §3–§5 där de krockar)

**Huvudgren:** `main` (Codex PR #81 och tidigare IG-arbete). **Pågående PR:** #83 `claude/hermes-kroppar` → `main` (senaste commit `9fd1062`). Plan: `docs/PLAN-HERMES-KROPPAR-JEV-2026-10-16.md` (prioritet §13 > §12 > … > §8).

| Del | Läge |
|---|---|
| Boten | `~/mto-ig` på :3940. Startas **bara** av Mike med `bash ~/mto-ig/scripts/restart-reviewed-ig.sh`. Agenter får inte starta om (säkerhetsspärr). Byte av version görs med `git fetch -q origin <gren> && git checkout -q --detach <commit>` före skriptet. |
| AI-krediter | Vercel AI Gateway −0,21 USD och OpenRouter slut (16/10). JEV går ändå via OpenRouter `typesafe/jev-1.13`. |
| **Agenternas AI** | `LLM_ROUTE=hermes` i `~/mto-ig/.env`. Hermes-profilerna `trading-claude` (claude-sonnet-5-5) och `trading-chatgpt` (gpt-6-sol) körs på Mikes **prenumerationer** och kostar 0 kr. Kedja: Claude Teknik+Risk → ChatGPT Advisor (får bara skärpa, bindande i Live) → Claude Hanna (TIPS_JSON). JEV är hjärnan, med låst ordning. Verifierad analys av 5 krypton: 32–35 s. |
| Hermes-version | Låst till **0.22.2**. Uppdateras Hermes stängs agentläget av automatiskt tills R1 körts om (planen §9/§13) och `HERMES_PINNED_VERSION` eller `LLM_HERMES_VERSION` uppdaterats. |
| Säkerhet | Kropparna har inga verktyg (`-t context_engine`, tom cwd utanför git, env bara HOME/PATH). Inloggningen kontrolleras före start, och en betald nyckel i profilen ger 0 processer. Ett tips är aldrig en order; Godkänn krävs alltid. Kill switch och knappen "Avbryt analys" stoppar hela kedjan. |
| Stänga av agentläget | Ta bort raden `LLM_ROUTE=hermes` i `~/mto-ig/.env` och kör omstartsskriptet. Då gäller det gamla beteendet. |
| Tailscale | Krånglade efter en uppdatering 16/10 ("network is down"). Lösning: Mike avslutar Tailscale och startar om appen. |

**Arbetsträd som gäller:** Claude (huvud) → researcher → kodare → **kritiker (APPROVE krävs)** → Codex granskar PR:n → Mike slår ihop. Webbläsartestet i §8 görs efter varje driftsättning.

**Kvar efter PR #83:**
- Codex slutgranskar `9fd1062`.
- Mike slår ihop PR:n och driftsätter `9fd1062`.
- Riktig analys och en agentsession vid öppen marknad.
- Mike testar en liten Demo-order själv.
- Hectors uppdrag (vakthund, kostnadsrapport, backtest), se chatten 16/10.
