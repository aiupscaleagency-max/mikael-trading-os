# Plan: två Hermes-agenter med Claude- och ChatGPT-kroppar och JEV som hjärna (2026-10-16)

> **Status: PLAN v4. Ingen kod är ändrad.** v4 = §10, Codex granskning 2. v2 innehöll kritikerns rättelser. v3 lägger till Codex granskning av PR #82 (2026-10-16), se §8. Där §8 säger något annat än §1–7 gäller §8.
> Följ reglerna i `docs/OVERLAMNING-IG-2026-10-11.md` §2. Det betyder: lägg aldrig order åt Mike, skriv aldrig nycklar i klartext, lägg till i stället för att bygga om, och ändra inte LLM- eller JEV-ordningen utan Mikes OK.

## 1. Mikes mål (hans ord, sammanfattat)

- Två Hermes-agenter med olika **kroppar**. Den ena kör **Claude**, den andra **ChatGPT-6**. Båda använder Mikes **månadsprenumerationer**, inte API-krediter.
- Den gemensamma **hjärnan** är **JEV**, som förutspår och styr.
- **Om JEV inte fungerar** fortsätter arbetet genom en **analytiker**.
- Det ska vara **enkelt att ställa in**, inte överarbetat, och inte förstöra något annat.
- Resurser: 2 ChatGPT-konton, 1 Claude-konto och 1 OmniRoute med många LLM:er.

## 2. Läget i dag (verifierat 2026-10-16 kl. 09:30–09:45)

| Sak | Läge | Bevis |
|---|---|---|
| Trading-OS på :3940 | ✅ `main` 3013c7d körs (Mike startade om med `scripts/restart-reviewed-ig.sh`) | `/api/mode` och `/api/ig/balance` svarar; Live 500 SEK |
| Vercel AI Gateway | ❌ Saldo −0,21 USD. Alla anrop får 402, även BYOK. | `GET /v1/credits` |
| OpenRouter | ❌ 13 USD köpt, 13,17 USD förbrukat | `GET /api/v1/credits` |
| OmniRoute :20128 | ❌ Alla vägar nere i dag: `aug/*` ger tomma svar, `tllm/*` 403, `ddgw/*` 429/503, `auto/*` 503 | Testanrop |
| Hermes → NVIDIA NIM | ✅ Gratis, fungerar | `hermes -z` |
| Hermes-inloggningar | ✅ `anthropic` OAuth (Claude-prenumeration: `anthropic-oauth-2`, `claude_code`) och ✅ `openai-codex` OAuth (ChatGPT-prenumeration) | `hermes auth list` |
| JEV | TypeSafe-nyckeln finns i nyckelringen (`aiupscale.typesafe.api-key`), men `bot.log` visar bara `gateway: JEV: HTTP 402` och ingen rad med `direct:`. JEV har lyckats via OpenRouter (2026-10-13). **Orsaken är okänd**: antingen saknas direkt-rutten i nohup-processen, eller så får den 401 som loggas tyst (`jevClient.ts:290-295`). | `bot.log`, kod |
| Botens AI-ordning | `src/llm/gateway.ts:156-185`: Anthropic direkt → Vercel → OpenRouter. Saknas gateway-nyckeln returneras rå Anthropic redan på rad 207-210. | Kod |

Konsekvens: agentanalysen står helt still, eftersom alla betalda API-vägar är tomma. Prenumerationerna via Hermes är den enda väg som fungerar i dag.

## 3. Lösningen i en mening

En ny, **valbar** AI-väg `LLM_ROUTE=hermes` som bara gäller fyra textanrop i trading-analysen:

| Anrop | Körs av |
|---|---|
| Teknisk analytiker och Risk | Hermes-profilen **`trading-claude`** (Claude-prenumeration) |
| Advisorn | **`trading-chatgpt`** (ChatGPT-prenumeration) |
| Hannas slutsvar | **`trading-claude`** |

**JEV** används som i dag (fail-open, låst ordning). Dess befintliga svar, alltså djup/granskning från `jevTurnPreflight` och regim/riktning/veto från signalmotorns `applyJevVerdict`, läggs överst i underlaget. Utan JEV körs allt ändå och märks "utan JEV".

```
 JEV (som i dag, låst ordning, fail-open)
   ├─ jevTurnPreflight → djup / granska
   └─ applyJevVerdict (signalmotorn) → regim / riktning / veto
                 │ (läggs överst i underlaget)
 IG-data ──► Teknisk + Risk ──► [trading-claude]  (Claude-prenumeration)
             Advisor        ──► [trading-chatgpt] (ChatGPT-prenumeration)
             Hanna slutsvar ──► [trading-claude]  → TIPS_JSON
                                             ▼
                              Tips per instrument → Mike väljer → Godkänn
 JEV nere → samma kedja, märkt "utan JEV". Kropp nere → andra kroppen. Båda nere → ärligt "analys misslyckades".
```

## 4. Designval (enkelt, inte överarbetat)

1. **Valbart med en rad i `.env`:** `LLM_ROUTE=hermes`. Saknas raden fungerar allt exakt som i dag, och ingen befintlig väg tas bort. Betalda reserver (Vercel/OpenRouter) används i Hermes-läget **bara** om de uttryckligen slås på med `LLM_HERMES_PAID_FALLBACK=true`. Se §8.5.

2. **Anropet** sker i en ny fil `src/llm/hermesRoute.ts`, med `execFile` och utan skal:
   ```
   execFile(<absolut sökväg till hermes>,
     ["-p", profil, "-z", prompt, "--ignore-rules", "-t", "todo", "-m", modell, "--provider", provider,
      "--usage-file", tmpfil],
     { cwd: <tom scratch-mapp>, env: { HOME, PATH }, timeout: 90000 })
   ```
   - Svaret godtas bara om **exitkoden är 0** och **`usage.api_calls == 1`** (att `-t todo` faktiskt ger 1 verifieras i R1). Allt annat räknas som fel, även om stdout innehåller text. Hermes exitkoder: 1 = tomt, 2 = misslyckat, 130 = avbrutet.
   - Svaret formas som Anthropics: `content:[{type:"text"}]`, `stop_reason:"end_turn"`, `usage`, `model`. Då fungerar `trackClaudeCall`, `extractJson` och TIPS_JSON-parsningen utan ändring.
   - Shimmen **kastar fel om anropet har `tools`**. Den används aldrig för verktygsloopar.

3. **Säkerhetsspärr för kropparna.** `-z` sätter `HERMES_YOLO_MODE=1` och hoppar över godkännanden, och utan begränsning laddas terminalverktyget. Därför gäller **alltid** `-t todo` (enda verktyget är `todo_list`), `--ignore-rules` (ingen AGENTS.md, inget minne och inga skills från cwd), en tom `cwd` och en minimal `env`. `--safe-mode` används inte, eftersom det tappar profilens modell. Stäng av profilens `hermes fallback`-kedja, eller låt den bara innehålla prenumerations- och gratisvägar, så att den aldrig byter till en betald nyckel i tysthet.

4. **Omfång: bara dessa anrop ändras.**
   - Teknisk analytiker: `src/orchestrator/specialists.ts`.
   - Risk: `src/orchestrator/advancedSpecialists.ts`.
   - Advisorn: `advisor.ts:68-104`.
   - Hannas slutanrop: `headTrader.ts:163-171`. Här skickas inga `tools`, och prompten får raden "Inga verktyg i denna körning; svara med text och TIPS_JSON. Positioner och konto finns i underlaget." `igAgentData.positions/account` läggs i underlaget.

   Dessa rörs **inte**: `igChat.ts` (har `createPending`), `claudeAgent.ts`, `positionMonitor`, `strategyRunner` och `liveRoutes`. Hermes görs alltså **inte** till en global väg i `createLlmClient`, utan aktiveras bara för de markerade rollerna. Inga nya prompter; datan finns redan i `igRows`/`motorSignals`/`indicatorPack`.

5. **Profiler** skapas med Hermes egna kommandon. Inga nycklar läggs i repot:
   - `hermes profile create trading-claude --no-skills --no-alias` med provider `anthropic` (OAuth `claude_code`) och modell Sonnet. Exakt id tas fram i R2.
   - `hermes profile create trading-chatgpt --no-skills --no-alias` med provider `openai-codex` och modell GPT-6 eller den som prenumerationen ger (R2). Det andra ChatGPT-kontot kan läggas som fallback-uppgift.
   - **Kopiera aldrig `auth.json`.** OAuth-uppgifter är engångs och återkallar varandra, och profilen läser rotens uppgift via credential-pool-fallback. Kontrollera med `hermes -p <profil> auth list` och `hermes -p <profil> fallback list`.

6. **JEV, hjärnan, med låst ordning.** JEV-ordningen är "LÅST ORDNING (Mike 2026-10-04)" (`jevClient.ts:184-191`) och **ändras inte**. Det görs heller inget nytt JEV-anrop med marknadsdata (JEV-regeln: bara anonymiserade band). R3 tar reda på varför direkt-rutten inte syns. En loggrad för 401 läggs till; det är ett rent tillägg. Om direkt-rutten ska flyttas först krävs Mikes uttryckliga OK. Märkning:
   - JEV svarade: "Hjärna: JEV".
   - JEV `unavailable`/`skipped`: "utan JEV". Allt körs ändå (fail-open). Den befintliga timeouten på 2,5 s räcker.
   - Live-läge: Advisorn körs alltid (`jev.ts:94`), oavsett JEV.

7. **Kroppsreserv** i första versionen: Claude-kroppen → ChatGPT-kroppen → ärligt "analys misslyckades". OmniRoute och NIM byggs **inte** in i boten. Vill man ha dem läggs de som `hermes fallback` i profilen.

8. **Samtidighet:** högst en körning per profil åt gången, så att OAuth-förnyelser inte krockar. Teknisk och Risk körs efter varandra på Claude, medan Advisorn körs parallellt på ChatGPT.

9. **Kostnad:** tokens och modell läses från `--usage-file` till `trackClaudeCall` med `usd=0` och `route=hermes`. Kostnadstaket (`orchestrator.ts:122`) lämnas orört.

10. **Säkerhet för pengar:**
    - Hanna lägger **inga `place_order`-utkast** i hermes-vägen. Hon ger **bara tips**, och Mike skapar ordern själv via "Öppna i orderpanelen" och Godkänn.
    - `igOrders`, `orderGate`, `igConnection` och `.env`-flaggorna rörs inte.

## 5. Risker att granska (Codex: titta särskilt här)

| Risk | Hantering |
|---|---|
| Användarvillkor och takgränser för prenumerationerna (inte gjorda för automatisk API-användning) | Bara på begäran ("Kör analys" eller session), aldrig tät schemaläggning. Tydlig text vid takgräns. Mike godkänner villkoren själv. |
| Engångskörning tar 10–60 s | Timeout 90 s, högst en per profil, Advisorn parallellt |
| Hermes-uppdatering ändrar CLI-beteendet | `hermes --version` kontrolleras vid start och loggas. R1-testet körs igen efter uppdatering. |
| Kroppen försöker använda verktyg eller shell | `-t todo`, `--ignore-rules`, tom cwd och minimal env, och `api_calls == 1` krävs |
| Profilens fallback byter tyst till betald nyckel | `fallback list` kontrolleras i K1, utan betalda vägar |

## 6. Arbetsträd: vem gör vad

| Roll | Agent | Uppgift |
|---|---|---|
| Planerare och huvudansvarig | Claude (huvudsession) | Plan, beslut, driftsättning och webbläsartest enligt överlämningen §8 |
| **Researcher** | `researcher` | R1–R3. Bara läsning och testanrop, ingen kodändring. |
| **Kodare** | `worker` | K1–K5 på grenen `claude/hermes-kroppar`, med tester |
| **Kritiker/granskare** | `explorer` (oberoende) | Granskar varje steg mot §4–§5 och reglerna. APPROVE krävs före push och driftsättning. |
| Extern granskare | Codex (Mike) | Läser planen och PR:n och föreslår förbättringar |

### Steg

| # | Vem | Vad | Klart när |
|---|---|---|---|
| R1 | researcher | Kör exakt kommandot i §4.2 mot båda profilerna. Kontrollera stdout, exitkod och att `api_calls == 1` med `-t todo`. | Två rena textsvar med usage-JSON |
| R2 | researcher | Vilka modell-id prenumerationerna ger via `anthropic`/`claude_code` och `openai-codex`, och svarstid | Tabell: profil → modell → tid |
| R3 | researcher | JEV: finns direkt-rutten i nohup-processen (nyckelringen läsbar?) eller får den en tyst 401? Inga nycklar skrivs ut. | Orsaken känd |
| K1 | kodare | Skapa profilerna enligt §4.5 och kontrollera auth och fallback | `hermes -p trading-claude -z "OK?" -t todo --ignore-rules` svarar |
| K2 | kodare | `src/llm/hermesRoute.ts` enligt §4.2, inklusive kö per profil | Enhetstest med låtsad `hermes`-binär: exit 0/1/2, api_calls≠1, tools → fel, timeout |
| K3 | kodare | Hakar i `gateway.ts` (`hasLlmCredentials`/roll-val), `specialists.ts`, `advancedSpecialists.ts`, `advisor.ts` och `headTrader.ts` enligt §4.4, plus kroppsreserv §4.7 | Test: hermes på → de fyra rollerna via shimmen; igChat/claudeAgent oförändrade; utan `LLM_ROUTE` exakt som förut |
| K4 | kodare | JEV-etikett och 401-loggrad. JEV-ordningen ändras **inte**. | Test: JEV ok → "Hjärna: JEV", JEV nere → "utan JEV" |
| K5 | kodare | Dashboard: etikett vid topplistan "Hjärna: JEV · Kropp: Claude-prenumeration" (eller "utan JEV"). Inget annat ändras. | Webbläsartest |
| G | granskare | Granska K1–K5 mot §4 och §5 | APPROVE |
| D | Claude + Mike | Push och PR mot `main`, Codex granskar. Mike lägger in `LLM_ROUTE=hermes` och kör omstartsskriptet. Claude kör webbläsartestet och en riktig analys av 5–7 krypton. | Tips syns med etiketten |

## 7. Det Mike gör (när bygget är klart)

1. Godkänna planen, gärna efter Codex granskning.
2. Lägga in en rad i `.env` (kommandot ges, inga nycklar): `LLM_ROUTE=hermes`.
3. Köra `bash ~/mto-ig/scripts/restart-reviewed-ig.sh`.
4. Trycka "Kör analys" och se tipsen.

Vercel och OpenRouter kan fyllas på senare. I Hermes-läget används de bara om `LLM_HERMES_PAID_FALLBACK=true` (§8.5).

## 8. Rättelser från Codex granskning (v3, gäller före §1–7)

### 8.1 Hanna: en egen kodväg utan verktyg
- I `headTrader.ts` (runt rad 157–173) läggs en **separat Hermes-gren före verktygsloopen**. Där skickas aldrig `tools: toolDefinitions()`, och `runTool` anropas aldrig.
- Grenen får en **egen systemprompt som bara handlar om analys**: "Du lägger inga order. Svara med analys och TIPS_JSON." Den befintliga meningen "Du har verktyg för att lägga order" följer inte med.
- Tipsparsningen (`headTips.ts`) återanvänds.
- Testet ska visa att grenen aldrig anropar `runTool` och att den aldrig skapar orderutkast eller väntande order.

### 8.2 Kostnadsregistreringen
- `trackClaudeCall` (`src/cost/tracker.ts:59-79`) utökas med valfria fält: `route` (`vercel|openrouter|anthropic|hermes`), faktisk `model` och en uttrycklig `costUsd`. När `costUsd` är satt (0 för prenumeration) används den i stället för beräkningen från tokenantalet. Tokenstatistiken behålls som förut.
- Hermes-anrop kostar 0 USD och räknas **inte** mot API-kostnadstaket.
- Har tidigare API-utgifter redan nått taket gäller detta: betalda vägar spärras som i dag, men Hermes-läget får fortsätta. Spärren för taket undantar uttryckligen rader med `route=hermes`, och kostnadssidan visar det.

### 8.3 En lyckad process räcker inte, innehållet valideras
Tre lager kontroller:
1. **Transport:** exitkod 0 och `api_calls == 1`.
2. **Innehåll:** svaret är inte tomt och har ingen verktygsbegäran i texten.
3. **Schema per roll:**
   - Teknisk, Risk och Advisor: `extractJson` ger ett giltigt objekt med de obligatoriska fälten.
   - Hanna: `TIPS_JSON` finns, kan parsas och har en rad per valt instrument.

Varje roll får en **status**: `lyckad`, `misslyckad` (med orsak) eller `överhoppad`. Statusen följer med i analysresultatet och sparas i minnet.

Orkestreraren (`orchestrator.ts:174-197`) fångar i dag specialistfel och fortsätter med reservrapporter. I Hermes-läget gäller i stället:
- Saknas en **nödvändig** rapport (Teknisk eller Hannas TIPS_JSON) visas **inte** en normal analys. Rutan visar "analys ofullständig: <roll> misslyckades (<orsak>)".
- Saknas bara Risk eller Advisor visas analysen, märkt "delvis (Risk saknas)" eller "delvis (Advisor saknas)".

Tester: tomt svar, trasig JSON, saknad TIPS_JSON, fel hos båda providers, avbruten körning (SIGTERM) och timeout.

### 8.4 Verktygsisolering: R1 är ett STOPPVILLKOR
- Ingen kodning (K1–K5) börjar förrän R1 har verifierat exakt vad Hermes laddar i den valda versionen: verktyg, regler, minne, SOUL/systemprompt, hooks och fallback.
- Finns ett **verifierat verktygsfritt läge** används det. Annars skrivs begränsningen ut ärligt, till exempel att "endast `todo_list` laddas", och vad det innebär.
- Kontrollen `api_calls == 1` är en kontroll i efterhand, inte en spärr. Spärren är det verifierade läget plus tom cwd och minimal env.
- Hermes-versionen **låses**. Botten loggar `hermes --version` vid start och vägrar Hermes-läget med en tydlig text om versionen har ändrats, tills R1 körts igen.

### 8.5 Reservordning per roll (entydig)
| Roll | 1:a | 2:a | 3:e (bara med `LLM_HERMES_PAID_FALLBACK=true`) | Annars |
|---|---|---|---|---|
| Teknisk, Risk, Hanna | `trading-claude` | `trading-chatgpt` | befintlig betald kedja (Anthropic → Vercel → OpenRouter) | status `misslyckad` |
| Advisor | `trading-chatgpt` | `trading-claude` | befintlig betald kedja | status `misslyckad` (live: analysen märks "Advisor saknas") |

- **Byte sker vid:** transportfel (exit ≠ 0, timeout, SIGTERM), tomt svar eller schemafel efter ett omförsök med samma kropp, eller takgräns i prenumerationen (känns igen i Hermes felsammanfattning).
- **Inget byte vid:** giltigt svar som säger HOLD/AVVAKTA.
- Faktisk **kropp, provider och modell per roll** visas efter varje analys. Exempel: "Teknisk: Claude Sonnet (trading-claude) · Advisor: ChatGPT GPT-6 (trading-chatgpt → reserv Claude)".

### 8.6 JEV-status följer med analysen
- Två separata resultat följer med i underlaget och resultatet, vart och ett med **status och tidsstämpel**:
  1. `jevTurnPreflight` (djup och granskning).
  2. Signalmotorns `applyJevVerdict` (regim, riktning, veto) per instrument.
- Etiketten skiljer på tre lägen: **"JEV fullständig"** (båda), **"JEV delvis (preflight saknas / signal-JEV saknas)"** och **"utan JEV"**.
- Hannas Hermes-prompt får **uttryckligen** preflight-resultatet. I dag skickas det inte med (`orchestrator.ts:297-302`).
- **Veto bevaras:** har JEV satt veto för ett instrument blir tipset AVVAKTA med orsaken "JEV-veto", oavsett vad kroppen svarar. Det gäller även efter parsning och reservbyte. Detta testas.
- Den låsta JEV-ordningen behålls oförändrad.

### 8.7 Tidsbudget, samtidighet och datans ålder
- **Total tidsgräns per analys: 240 s**, inklusive kö och reservförsök.
- Per anrop gäller en timeout på 60 s (justeras efter R1/R2-mätningen) med högst 1 omförsök.
- Teknisk och Risk körs **parallellt** på olika kroppar när det går. Annars avbryts kedjan när den totala gränsen nås, och de roller som inte hann markeras som `överhoppad (tidsgräns)`.
- **Avbruten körning:** Mike eller ett kontobyte avbryter det pågående arbetet. Hermes-processen får SIGTERM, så inga hängande processer blir kvar. Detta testas.
- **Samtidiga analyser:** högst en analys per miljö åt gången, och en ny begäran under pågående analys får svaret "analys pågår". Det testas.
- **Datans ålder:** innan tips visas kontrolleras att IG-livepriset per instrument är högst 60 s gammalt. Äldre pris ger tipset varningen "⚠ gammalt pris, kontrollera mot IG", och nivåerna räknas som overifierade. Det testas.

### 8.8 Nya acceptanstester (utöver K2–K5)
| Test | Förväntat |
|---|---|
| Hermes-grenen för Hanna | 0 anrop av `runTool`, 0 orderutkast |
| Kostnad | Hermes-rader `costUsd 0, route hermes`; taket påverkas inte |
| Validering | Tomt, trasig JSON eller saknad TIPS_JSON ger rätt status och ingen "normal" analys |
| Reserv | Claude nere → ChatGPT och omvänt, båda nere → `misslyckad`, betald reserv bara med flagga |
| JEV | fullständig, delvis och utan, plus veto bevarat genom reserv |
| Tid | Totalt ≤ 240 s, timeout och SIGTERM städar processer |
| Samtidighet | Andra analysen under pågående får svaret "analys pågår" |
| Dataålder | Pris > 60 s ger varning och overifierade nivåer |

## 9. Verifierat av researchern (R1–R3, 2026-10-16, Hermes v0.21.7+500.g8f81791). Gäller före §4 och §8.

### 9.1 Rättelser till kommandot (R1 är nu godkänt med dessa villkor)
| Planen antog | Verifierat | Ny regel |
|---|---|---|
| `--ignore-rules` stänger av AGENTS.md och minne | Gör **ingenting** i `-z`. AGENTS.md i cwd lästes in (test: "OK BANAN-7731"). SOUL.md från profilen laddas alltid. | cwd = ny `mkdtemp` i `os.tmpdir()`, **utanför alla git-repon** (kontextfiler letas upp till git-roten) |
| `-t todo` = bara `todo_list` | Ger även `hermes_tool_search`/`tool_call` (bryggan) | **`-t context_engine`** = verifierat verktygsfritt (`resolve_toolset → []`, input 2433→761 tokens, MCP startas inte) |
| — | `-t ""` faller tillbaka på HELA cli-uppsättningen (terminal, write_file, execute_code …) | Shimmen hårdkodar `context_engine` och vägrar alla andra värden |
| rc 0 = ok, 1 = tomt | Providerfel ger rc 2 med text på stdout och `api_calls` 1 men `failed` true. Credentialfel ger rc 1. SIGTERM ger rc 143 utan usage-fil. | **Godkänn bara om:** rc==0, usage-filen kan läsas, `api_calls==1`, `failed==false`, `completed==true` och **`cost_status=="included"`** (fångar en tyst betald väg) |
| — | Titelgenereringen gjorde ett extra aux-anrop | Avstängt i båda profilerna (`auxiliary.title_generation.model_upgrade_enabled=false`) |
| env | `ANTHROPIC_API_KEY` (betald) exporteras i `~/.zshrc` och går före OAuth | env är strikt `{HOME, PATH}`. Lägg aldrig nyckeln i en profils `.env`. |

Verifierat kommando (execFile, inget skal):
```
hermes -p trading-chatgpt -z "<prompt>" -t context_engine -m gpt-5.6-sol    --provider openai-codex --usage-file <tmp>.json
hermes -p trading-claude  -z "<prompt>" -t context_engine -m claude-sonnet-4-6 --provider anthropic  --usage-file <tmp>.json
```

### 9.2 Profiler (skapade av researchern, utan nycklar)
| Profil | Läge | Modeller som fungerar (svarstid för "OK") |
|---|---|---|
| `trading-chatgpt` (openai-codex OAuth via rot-poolen) | ✅ fungerar | gpt-5.6-sol 3,8–6,9 s · gpt-6-sol 3,5 s · gpt-6.1-sol 4,4 s · gpt-6-luna 5,7 s · gpt-5.6-terra 3,9 s. Avvisade (400): gpt-6, gpt-5.5, gpt-5.3-codex. |
| `trading-claude` (anthropic) | ⛔ **STOPP: Mike måste logga in** | "No Anthropic credentials found". Claude Codes egna OAuth gick ut för ca 15 dagar sedan. |

Fallback-kedjor: inga i de nya profilerna (`fallback list` är tom). Låt den vara tom.

**Modellval för ChatGPT-kroppen:** förslaget är `gpt-6-sol`, eftersom Mike vill ha "ChatGPT-6". Kontrollera med Mike innan det låses (LLM-regeln).

### 9.3 Tidsbudget (mätt)
| Storlek | Tid |
|---|---|
| Uppstart (även vid fel) | ca 2,5 s |
| ca 4k tokens in | 9–10 s |
| ca 20k tokens in, 1,5–2,7k ut | 47–49 s |

Timeout per anrop: Hanna och Risk 90 s, Teknisk 120 s. Taket för hela analysen höjs från 240 s till **300 s**.

### 9.4 JEV (R3)
| Väg (låst ordning) | Resultat |
|---|---|
| 1. TypeSafe direkt (nyckel i nyckelringen) | **401**: nyckeln avvisas, och 401 loggas aldrig (`jevClient.ts:305-311`) |
| 2. Vercel gateway | **402**: inga krediter |
| 3. OpenRouter `typesafe/jev-1.13` | **200 ✅**, 0,3–0,8 s. Det är den vägen JEV går i dag. |

Slutsats: JEV fungerar redan via OpenRouter, och ordningen ändras inte. Att lägga till en loggrad för 401 är ett tillägg som får göras.

### 9.5 Det Mike gör innan bygget (2 saker)
1. **Logga in Claude i Hermes**, en gång och interaktivt i Terminal, i roten och utan `-p`:
   ```
   hermes auth add anthropic --type oauth
   ```
   Kontrollera efteråt med `hermes -p trading-claude auth list`. Det ska stå en oauth-rad under anthropic.
2. (Valfritt) Ny TypeSafe-nyckel via `tools/jev/set-typesafe-key.sh`, om JEV ska gå direkt i stället för via OpenRouter.

## 10. Codex granskning 2 av v3 (11389e4), inarbetad i v4. Gäller före §4–§9.

> R1/R2/R3 var redan körda och resultaten står i §9 (commit ab19989). Där finns testresultat för Hermes-kompatibilitet och prenumerationsåtkomst: ChatGPT-kroppen fungerar, Claude-kroppen väntar på Mikes inloggning. Profilerna skapades i researchsteget före R1, vilket täcker punkt 6b.

### 10.1 Saknad Risk (eller Advisor i live) får aldrig se ut som en godkänd riskbedömning
- **Risk misslyckas:** analystexten visas, men **alla tips blir AVVAKTA**, föreslagen insats tas bort och orsaken anges som "Risk saknas – inga köp/sälj-tips". Knappen "Öppna i orderpanelen" döljs för de tipsen.
- **Advisorn misslyckas i live-läge:** samma regel gäller. Live kräver alltid Advisorn (`jev.ts:94`). I Demo märks analysen bara "Advisor saknas" och tipsen behålls.
- Test: Risk (eller Advisorn i live) med status `misslyckad` eller `överhoppad` ger 0 tips med KÖP/SÄLJ och 0 insatser.

### 10.2 Validera rå TIPS_JSON före normaliseringen
- En ny `validateRawTips(raw, selectedEpics)` körs **före** `parseHeadTips`. Den kräver:
  - **exakt ett** objekt per valt instrument,
  - inga dubbletter och inga okända EPIC,
  - rätt fälttyper (`action` ∈ KÖP/SÄLJ/AVVAKTA, siffror är siffror, `horizonMin` ∈ {1, 5, 15, 30}),
  - nivåer som går ihop med riktningen.
- Om valideringen fallerar får Hanna status `misslyckad (ogiltig TIPS_JSON: <orsak>)`. Ett omförsök görs med samma kropp, sedan byts kropp enligt §8.5. `parseHeadTips` används som förut, men bara för presentation och säker normalisering.
- Tester: svar med bara 1 av 3 instrument, dubblett, okänt EPIC, sträng i stället för siffra, KÖP med SL över ingången.

### 10.3 Kostnadsspärren gäller före varje betalt försök
- `canSpend` (`orchestrator.ts:123-133`) står kvar före analysen men **släpper igenom** Hermes-läget när API-taket är nått.
- **Precis före varje betalt försök**, även omförsök, kontrolleras två saker:
  1. att `LLM_HERMES_PAID_FALLBACK=true`,
  2. att `canSpend` har budget kvar.
- Nej på något av dem ger rollen status `misslyckad (betald reserv spärrad: tak/flagga)`.
- Reservens faktiska rutt och kostnad registreras med `trackClaudeCall` (`route`, `model`, `costUsd`).
- Test: API-taket är nått, Hermes är nere och betald reserv är på. Resultatet ska bli spärrad med noll betalda anrop. Samma fall med budget kvar ska ge exakt ett betalt anrop som registreras.

### 10.4 Avbrott, tidsgräns och providerfel är tre olika saker
| Händelse | Effekt |
|---|---|
| **Användaravbrott eller konto/miljöbyte** | Hela kedjan stoppas. Köade jobb töms. **Inga nya försök och ingen reserv.** Sena svar publiceras aldrig (de jämförs mot körnings-ID och konto). Status `avbruten`. |
| **Total tidsgräns (300 s)** | Pågående anrop stoppas. Inga nya försök. De roller som inte hann får status `överhoppad (tidsgräns)`. Regel 10.1 gäller. |
| **Providerfel, tomt svar eller schemafel** | Det enda som utlöser omförsök eller reserv enligt §8.5 |

**Processstädning:**
- Hermes startas i en egen processgrupp (`detached: true`).
- Vid stopp skickas först `SIGTERM` till gruppen. Lever den efter 5 s skickas `SIGKILL` till gruppen.
- Ett slutligt rc 143 eller 137 räknas aldrig som providerfel.
- Test: efter avbrott startar 0 nya försök, inga Hermes-processer lever kvar och sena svar ignoreras.

### 10.5 Underlagets färskhet (inte bara slutpriset)
- Underlaget får en **tidsstämpel per del**: kvot, ljus/indikatorer, positioner och konto. Det knyts till **körnings-ID, konto och miljö**.
- Före visning gäller:
  - **Konto, miljö eller körnings-ID ändrat:** analysen kastas och ingenting visas.
  - **Ljus eller indikatorer äldre än 2 × intervallet, eller positioner/konto äldre än 120 s:** nivåerna blir overifierade och tipset får varningen "⚠ gammalt underlag".
  - **Livepriset har rört sig mer än 0,5 × ATR (eller mer än 1 %) från priset nivåerna byggdes på:** tipset blir AVVAKTA med orsaken "priset har rört sig – kör ny analys".
- Test: ett färskt slutpris tillsammans med gamla ljus ger varning, och ett stort prisrörelse ger AVVAKTA.

### 10.6 En gemensam schemaläggning (ersätter §8.7 punkt 3 och §4.8)
- **Profillås:** högst ett anrop åt gången per profil. Det gäller **även** omförsök och reservförsök.
- **Ordning:**
  1. **Teknisk** på `trading-claude` och **Advisor** på `trading-chatgpt` startar parallellt.
  2. **Risk** körs på `trading-claude` efter Teknisk, eller på `trading-chatgpt` efter Advisorn om Claude-låset är upptaget i över 30 s.
  3. **Hanna** körs på `trading-claude` när Teknisk och Risk är klara.
- Reserv tar bara en ledig profil, eller väntar på låset inom den totala tidsgränsen.
- §4.8 och tabellen i §8.5 följer denna ordning: förstavalet gäller när profilen är ledig.
- §6 är uppdaterat: R0 = profiler skapade (gjort), R1–R3 = gjorda (§9), och K1 = endast kontroll av profilerna, inte skapande.

## 11. Test av Claude-kroppen efter Mikes inloggning (2026-10-16 12:37)
- Mikes `hermes auth add anthropic --type oauth` hamnade i **rotens** pool (`anthropic-oauth-3`, hermes_pkce). Rotprofilen (aktiv profil "hector") svarar: `claude-sonnet-4-6`, rc 0, api_calls 1, failed false.
- **Profilen `trading-claude` ser inte pkce-uppgiften.** Via poolens fallback syns bara `claude_code`, som har gått ut, och anropet ger "No Anthropic credentials found". Kopiera **inte** auth.json. Mike loggar in en gång till direkt i profilen: `hermes -p trading-claude auth add anthropic --type oauth`.
- **Acceptregeln behöver justeras.** Anthropic-OAuth rapporterar `cost_status: "estimated"`, inte `"included"`. Regeln blir:
  - `openai-codex`: kräv `"included"`.
  - `anthropic`: godta `"estimated"` bara när `ANTHROPIC_API_KEY` saknas i barnprocessens env och profilens enda anthropic-uppgift är av typen oauth (kontrolleras vid start med `hermes -p trading-claude auth list`).
  - Kostnaden registreras alltid som 0 USD, med `route=hermes`.
- **2026-10-16 12:45, efter Mikes inloggning i `trading-claude`:** båda kropparna fungerar via prenumeration.
  - `trading-claude`: `claude-sonnet-4-6`, rc 0, svarar "OK" på 4 s. Uppgiften är `anthropic-oauth-2` (hermes_pkce).
  - `trading-chatgpt` och `team-trading`: `gpt-6-sol`, rc 0, `cost_status: included`, 5 s.
  - `team-trading` har ingen Claude-OAuth (den anthropic-körningen gav `failed: true`).
  - **Beslut: kropparna körs i profilerna `trading-claude` och `trading-chatgpt`.** Mikes `team-trading` lämnas orörd.

## 12. Mikes beslut 2026-10-16 15:41: modell, tokenfokus och samarbete (gäller före allt ovan)
- **Claude-kroppen är `claude-sonnet-5-5`** (verifierad: rc 0, 4–6 s). Sonnet 4.6 används **inte**. **ChatGPT-kroppen är `gpt-6-sol`** (verifierad, 3,5–5 s). Båda är satta som `model.default` i profilerna.
- **Tokenfokus: tipset ska komma i tid så att Mike hinner lägga ordern.**
  - **Tidsmål:** första rangordnade tips inom **≤ 60 s** från "Kör analys" för 5 instrument. Det hårda taket är 300 s.
  - **Kompakt underlag:** per instrument en rad med siffror (IG-pris och ålder, RSI/EMA/ATR per tidsram, trend och signal), plus JEV-raden. Ingen rå ljushistorik. Mål: ≤ 2 500 tokens in per anrop (mätt: ~4k in ≈ 10 s, ~20k in ≈ 48 s).
  - **Kort svar:** bara JSON, inget resonemang i fritext. Mål: ≤ 600 tokens ut per anrop. `why` är högst 1 mening.
  - **Gemensam prefix** (system, JEV och underlag först, rollinstruktion sist), så att promptcachen kan återanvändas mellan rollerna.
  - **Tokens och tid** per roll loggas från `--usage-file` och visas på kostnadssidan som "tokens/tid per analys", inte som kronor.
- **Kropparna samarbetar** i en kedja där var och en ser den andras resultat:
  1. **Claude (Teknisk + Risk i ETT anrop)** läser JEV och underlaget och svarar med en JSON-rad per instrument: riktning, nivåer, risk och insats.
  2. **ChatGPT (Advisor)** får Claudes JSON plus JEV. Den bekräftar eller invänder per instrument (`agree/object` + 1 mening) och kan bara skärpa: AVVAKTA, mindre insats eller ett snävare SL. Den kan aldrig öka risken.
  3. **Claude (Hanna, beslut)** får båda och JEV och svarar med slutlig TIPS_JSON, rangordnad. Har ChatGPT invänt måste Hanna antingen följa invändningen eller ange skälet i en mening. Ett JEV-veto gäller alltid.

  Det blir 3 anrop och ~3 × 10–15 s, alltså ≤ 60 s. Det ersätter "Teknisk och Risk separat" i §8.7/§10.6. Reserv och lås enligt §8.5/§10.6 gäller per steg.
