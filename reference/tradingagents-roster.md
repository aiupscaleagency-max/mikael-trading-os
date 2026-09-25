# TradingAgents — de 13 rollerna som bollplank

Källa: `TauricResearch/TradingAgents` (Mikes fork ligger i
`~/.openclaw/workspace/TradingAgents`). Verifierat mot filerna i
`tradingagents/agents/`.

Den här filen är till för att **Hermes och trading-teamet ska kunna anropa
rätt perspektiv** utan att köra hela Python-grafen. Varje roll är reducerad
till den enda fråga den besvarar — det är den delen som är värd att låna.

---

## Varför uppdelningen fungerar

Arkitekturen bygger på **adversarial verification**: innan ett beslut fattas
måste någon argumentera emot. Det är den mekanism som sänker hallucinationer
mest i den här typen av system, och den saknas i de flesta enklare
uppsättningar — inklusive den ursprungliga `mikael-trading-os`, där åtta
analytiker körde parallellt utan att någon sa emot någon.

Samma princip gäller JEV-uppdelningen i `reference/jev/`: deterministisk kod
räknar och beslutar, det probabilistiska lagret bedömer. **Ingen roll här får
räkna** — aritmetik hör hemma i koden.

---

## Analytikerna (5) — samlar underlag

| Roll | Den enda frågan den besvarar |
|---|---|
| **market_analyst** | Vad säger pris och volym — trend, nivåer, volatilitet? |
| **news_analyst** | Vilka nyheter kan flytta det här instrumentet, och åt vilket håll? |
| **sentiment_analyst** | Vad är marknadens stämningsläge just nu? |
| **social_media_analyst** | Vad säger flödet — och är det signal eller brus? |
| **fundamentals_analyst** | Vad säger de underliggande siffrorna? |

Analytikerna **bedömer aldrig om en trade ska tas**. De levererar underlag.

## Debatten (2) — den viktigaste delen

| Roll | Uppdrag |
|---|---|
| **bull_researcher** | Bygg det starkaste möjliga argumentet FÖR positionen |
| **bear_researcher** | Bygg det starkaste möjliga argumentet EMOT |

Båda ska argumentera i god tro på samma underlag. Poängen är inte att någon
vinner — det är att svagheterna i tesen syns innan pengar riskeras.

**Som bollplank:** kör en tes genom bear_researcher innan den blir en signal.
Håller den inte för invändningen är den inte redo.

## Riskteamet (3) — tre temperament, inte tre åsikter

| Roll | Perspektiv |
|---|---|
| **aggressive_debator** | Vad kostar det att INTE ta den här positionen? |
| **conservative_debator** | Vad är värsta utfallet, och överlever kontot det? |
| **neutral_debator** | Vad säger underlaget utan att någon vill något? |

Tre temperament på samma data ger ett spann istället för en punkt. Ett beslut
som ser bra ut i alla tre är robustare än ett som bara den aggressiva gillar.

## Cheferna (2) — syntes

| Roll | Uppdrag |
|---|---|
| **research_manager** | Väg bull mot bear och avgör vilken sida som bär |
| **portfolio_manager** | Passar positionen i portföljen som helhet — eller är den korrelerad med något vi redan har? |

## Exekveringen (1)

| Roll | Uppdrag |
|---|---|
| **trader** | Omsätt beslutet till entry, stop och storlek |

---

## Hur Hermes och trading-teamet använder det här

**Som bollplank, inte som ersättare.** Mikes team har egna roller; de här
tretton är ett andra perspektiv att pröva ett beslut mot.

Tre användningar som ger mest:

1. **Bear-testet före varje signal.** Innan en LONG visas i panelen: vad hade
   bear_researcher sagt? Finns inget motargument är underlaget för tunt.
2. **Riskteamets tre temperament** på samma siffror — särskilt
   conservative_debator, som är den enda rollen vars uppgift är att fråga om
   kontot överlever värsta utfallet.
3. **portfolio_manager-frågan** när flera par ger signal samtidigt: tre
   korrelerade LONG är inte tre positioner, det är en position i tredubbel
   storlek.

**Vad rollerna aldrig ska göra:** räkna. Aritmetik, stop-nivåer och
riskgränser ligger i `signalEngine.ts` och `riskManager.ts`, där de går att
testa och inte kan hallucineras.

---

## Kopplingen till koden

| Lager | Var det bor |
|---|---|
| Ljus, stängda och verifierade | `src/server/klineStream.ts` |
| Indikatorer → riktning, stop, target | `src/server/signalEngine.ts` |
| Hård riskgräns med vetorätt | `src/risk/riskManager.ts` |
| Bedömningar och debatt | agent-lagret — de här tretton rollerna |

Ordningen är inte förhandlingsbar: **koden räknar, agenterna bedömer, koden
vetar.**
