# Överlämning: Mikes Trading-OS på IG (11 oktober 2026, kl. 09:15)

**Till ChatGPT och Hermes.** Den här filen skrevs av Claude **innan arbetet var helt klart**, eftersom Mikes veckogräns i Claude kan ta slut när som helst. Om Claude inte hann skriva "klart" i Mikes tråd ska du utgå från att punkterna under **4. Kvar att göra** fortfarande är öppna. Kontrollera alltid läget själv med kommandona i avsnitt 6 innan du ändrar något.

Läs hela filen innan du gör något. Mike skriver svenska. Svara kort, enkelt och rakt: säg vad du gör, ge inte en lista med val. Klistra alltid in hela kommandon och hänvisa aldrig till "kommandot jag skickade förut".

---

## 1. Slutmålet (det här ska fungera när allt är klart)

Mike ska kunna handla **allt IG erbjuder i krypto och forex**. Det ska vara **exakt likadant i DEMO och LIVE**: samma sidor, samma instrument, samma knappar, samma agenter och samma resultatfönster. Enda skillnaden är låtsaspengar eller riktiga pengar.

Konkret:
1. **Alla par** visar alla IG-instrument (just nu 38 krypto + 199 forex = 237) som kort med pris, minidiagram, signal, agenternas tips och knapparna Köp/Sälj/Analysera. Allt uppdateras **live** från IG:s ström.
2. Mike bockar i par och trycker **Analysera valda** eller **Starta agentsession med valda**. Agenterna gör en **riktig analys med riktig data** och ger per par: köp, sälj eller avvakta, varför, ingång, mål (TP), stopp (SL), storlek, tid och säkerhet. **Agenternas topplista** visas överst i Alla par med knappen "Öppna i orderpanelen".
3. Varje order väntar på Mikes **Godkänn**. Ingen order skickas automatiskt, varken i Demo eller Live.
4. Mike tränar i Demo först (små affärer, kontrollera på ig.com), sedan samma sak i Live med minsta storlek.
5. Allt syns i **Agentic-OS → Trading: https://agentic-os.tail64d627.ts.net/trading**. Ingen inloggning, ingen separat port.

---

## 2. Hårda regler (bryt aldrig, annars förstörs saker som förra gången)

1. **Lägg till, bygg inte om.** Ändra bara det Mike ber om. Säg aldrig "bygger om". Ta aldrig bort funktioner, sidor eller knappar.
2. **Godkänn eller lägg aldrig en order åt Mike**, inte ens i Demo.
3. **Rör aldrig skrivspärren för Live** i `src/integrations/igConnection.ts` (`igLiveWritesUnlocked`, `igWritesEnabled`, `IG_LIVE_WRITE_LOCKED`) eller ordergrinden `src/server/orderGate.ts` (Godkänn, kill switch, max 3 % insats, 15 % marginal, 5 % dagsförlust).
4. **Inga nycklar** i chatt, kod, commits eller loggar. Mike lägger själv in nycklar via Terminal.
5. **LLM-ordningen är låst.** Byt aldrig modell eller ordning (`src/llm/*`, `src/server/jevClient.ts`). JEV går via Vercel först, OpenRouter är bara reserv.
6. **Ingen Bybit, Binance eller Alpaca** igen. Mäklaren är IG.
7. **Kopiera aldrig Live-data in i Demo som om det vore Demo-data.** Demo-simuleringen använder Live-pris men är tydligt märkt "Demo-simulering" och skickar aldrig något till IG.
8. **Rör inte Codex-grenarna** (`codex/ig-continuation-20261007`, `codex/claude-ig-parallel-20261008`) eller Codex-kopian i `~/ai_upscale_work/projects/mikael-trading-os`.
9. **Starta inte en andra bot.** Det finns en bot på port 3940. Döda bara via PID: `kill $(lsof -tiTCP:3940 -sTCP:LISTEN)`, aldrig `pkill -f`.
10. **Säg aldrig "klart" bara för att testerna är gröna.** Klart = typkontroll grön + tester gröna + omstart + kontrollerat **på skärmen** i Agentic-OS.
11. Ge alltid Tailscale-adressen ovan, aldrig localhost eller en annan port.

---

## 3. Var vi är nu (läget kl. 09:15 den 11 oktober)

| Vad | Var |
|---|---|
| Kod | GitHub `aiupscaleagency-max/mikael-trading-os` |
| Basgren (huvudgren för IG) | `claude/ig-on-vibrant` (senaste: 0197842, PR #75 och #76 ihopslagna) |
| Gren som körs nu | `claude/ig-agent-data`, commit **bdbf374**. Den innehåller även `claude/ig-demo-sim` (b03beb2) och Alla par-arbetet. 17 commits före basgrenen. |
| På datorn | dator1 (Mac): `~/mto-ig`, utcheckad som *detached* på bdbf374 |
| Port | 3940 (nohup). Tailscale: `:9443 → 3940`, inbäddad i Agentic-OS /trading |
| Logg | `~/mto-ig/data-ig/bot.log` |
| Inställningar | `~/mto-ig/.env`. Orderläge PÅ i både Demo och Live: `IG_ORDER_EXECUTION_ENABLED_DEMO=true`, `IG_ORDER_EXECUTION_ENABLED_LIVE=true`, `MODE=live`, `LIVE_TRADING_CONFIRMED=true` |
| IG-inloggning | `~/.config/aiupscale/trading-ig.json` (rör inte) |
| Live-saldo | 500 SEK |

**Fungerar och är kontrollerat på skärmen:**
- Ingen inloggning. Byte Demo↔Live ändrar allt på sidan.
- Orderläge PÅ i Demo och Live. Varje order kräver Godkänn.
- Alla par: 38 krypto, 199 forex, 237 totalt, i både Demo och Live. Filter och sök.
- Demo-simulering: 36 krypto som IG Demo saknar handlas med låtsaspengar mot Live-priset, märkta "Demo-simulering · Live-pris · låtsaspengar". 2 är IG Demos egna. Simuleringen skickar aldrig något till IG.
- Priser följer IG:s live-ström i både Demo och Live.
- Agenterna får nu riktig data (IG live först, Tiingo som märkt reserv när IG:s historikkvot är slut). Analysen har förtur i IG:s läskö.
- Riktig analys av Mikes 7 valda par kl. 08:41 gav konkreta nivåer. Topplistan syns överst i Alla par.

**Viktiga fakta om IG:**
- IG har en veckogräns för prishistorik. Den tog slut för både Demo och Live den 10 oktober. Därför finns Tiingo som reserv för diagram och agentdata. Order prissätts alltid av IG.
- IG stoppar läsningar vid för många anrop ("försök igen om en minut"). Bakgrundsjobb (katalog, diagram) pausas när agenterna analyserar.
- Forex är stängt på helgen (fredag kväll till söndag kväll).

---

## 4. Kvar att göra (i den här ordningen)

1. **Eurokontrakt (E1) får fel jämförelsepris.** Syns som felaktig topp i slutet av minidiagrammet (t.ex. Ether E1) och "ingen pålitlig data" för Cardano E1 i agentanalysen. Claude höll på att rätta detta när filen skrevs. Kontrollera om det finns en ny commit på `claude/ig-agent-data` efter bdbf374.
2. **Tomma minidiagram** på några kort (Cosmos, Dogecoin, Litecoin, Near, Polkadot) där Tiingo svarar 400. Kontrollera om det redan rättats.
3. **Skapa PR och slå ihop.** `claude/ig-agent-data` → `claude/ig-on-vibrant`. Den innehåller hela demo-sim-grenen, så PR #77 (`claude/ig-demo-sim`) kan stängas när den större PR:n är ihopslagen. Kontrollera först om en PR redan finns. Slå inte ihop något Mike inte bett om.
4. **Mikes första testaffärer.** Liten affär i Demo först, kontrollera på ig.com, sedan minsta storlek i Live. Godkänn gör Mike själv.
5. Senare (bara om Mike ber om det): Telegram-signaler och godkänn från mobilen.

---

## 5. Så startar du om boten efter en ändring

Datorns säkerhetsspärr hindrar Claude från att starta om boten när riktiga pengar är upplåsta, så **Mike kör raden själv**. Ersätt `<GREN>` och `<COMMIT>` med det du pushat och ge Mike hela raden:

```
cd ~/mto-ig && git fetch -q origin <GREN> && git checkout -q --detach <COMMIT> && npx tsc --noEmit -p . && kill $(lsof -tiTCP:3940 -sTCP:LISTEN); sleep 3; nohup npx tsx src/run.ts --serve >> data-ig/bot.log 2>&1 &
```

Senaste raden Mike körde (bdbf374):
```
cd ~/mto-ig && git fetch -q origin claude/ig-agent-data && git checkout -q --detach bdbf374 && npx tsc --noEmit -p . && kill $(lsof -tiTCP:3940 -sTCP:LISTEN); sleep 3; nohup npx tsx src/run.ts --serve >> data-ig/bot.log 2>&1 &
```

**Innan du ber Mike köra något:** `npx tsc --noEmit -p .`, `npm run -s test:ig` och `node scripts/check-dashboard-scripts.mjs` måste vara gröna, och någon annan modell eller agent ska ha granskat ändringen.

---

## 6. Startprompt att klistra in

> Du jobbar med Mikes Trading-OS på IG. Läs först `OVERLAMNING-IG-2026-10-11.md` och följ reglerna i avsnitt 2 exakt: lägg bara till, godkänn aldrig order, rör aldrig Live-spärren eller ordergrinden, inga nycklar, LLM-ordningen är låst, ingen Bybit/Binance/Alpaca. Svara på svenska, kort och rakt. Börja med att köra `cd ~/mto-ig && git log --oneline -3 && tail -n 30 data-ig/bot.log | grep -iE "fel|error|analys" ; curl -s -o /dev/null -w "%{http_code}\n" localhost:3940/` och säg i en mening vilket läge vi är i och vilken punkt under "4. Kvar att göra" du tar först.
