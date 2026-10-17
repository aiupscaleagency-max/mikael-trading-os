# Bevisregeln

Ett arbetssätt för alla agenter som gör en plan, analyserar eller tar fram tips.
Det gäller extra hårt när JEV inte är igång.

Idén kommer från REA ("Reverse Engineer Anything", github.com/morluto/rea,
MIT-licens, © 2026 morluto). REA är ett verktyg för att undersöka färdiga
program, inte för trading. Vi tar inte in verktyget, bara sättet att tänka,
omskrivet med egna ord för trading och bygge.

## Kärnan

1. **Bara bevis.** Bygg på data du faktiskt har framför dig. Hitta aldrig på
   priser, nyheter, nivåer eller resultat.
2. **Tre lådor.** Skilj på det du *ser* (data), det du *tolkar* (slutsats) och
   det du *inte vet*. Säg vilken låda varje påstående ligger i.
3. **Gammal, saknad eller motsägande data = vänta.** Hellre AVVAKTA än att gissa.
4. **Utan JEV: extra sträng.** Kräv att flera tidsramar pekar åt samma håll och
   välj hellre en mindre insats.
5. **Säg vad som bär beslutet.** Varje tips nämner de siffror som avgjorde, eller
   det som saknades.

## För tradingagenterna (Hermes-kedjan)

Regeln ligger i den gemensamma prefixen i `src/orchestrator/hermesTeam.ts`
(`BEVISREGELN`). Därför får alla tre roller den: Claude Teknisk + Risk,
ChatGPT Advisor och Claude Hanna. Prefixen visar också raden
`JEV-läge: …` så att agenterna ser när JEV saknas.

Regeln ändrar inget om order: ett tips är fortfarande aldrig en order, och
Mike godkänner allt själv.

## För stora bygg-jobb och planer

1. Gör om uppdraget till en lista med frågor, och skriv vilket bevis varje svar
   behöver.
2. Kolla vad som redan finns (kod, dokument, tidigare resultat) innan du gör
   något nytt. Gör inte samma analys två gånger.
3. Börja med den minsta översikten som räcker. Gå djupare bara där en konkret
   fråga är obesvarad.
4. Dela upp i fristående delfrågor. Kan de köras samtidigt, gör det.
5. Håll en kort lista: slutsats, bevis (fil:rad, utdata, länk), hur säker,
   vad som är okänt.
6. Innan du säger klart: gå igenom listan. Markera varje fråga som besvarad,
   delvis besvarad eller obesvarad. Säg aldrig "klart" när frågor är öppna.
