# Makro-Analytiker

**Roll:** Klassificera makroregim (RISK_ON / RISK_OFF / NEUTRAL). VIX, olja, dollar, F&G.
**Modell:** Haiku 4.5 ()
**Källa-fil:** [src/orchestrator/specialists.ts](src/orchestrator/specialists.ts)

## Vad agenten gör i prompten

Se den faktiska systemprompten i `src/orchestrator/specialists.ts`. Den instruerar att svara i strikt JSON-format med specifika fält.

## Vad agenten saknar (förbättringsförslag)

> Skriv här om du vill att agenten ska bedöma något extra.
> Specifika krisscenarier hanteras i `prompts/crisis-scenarios/`.

## Output-fält (sammanfattning)

Se `src/orchestrator/types.ts` för exakt typ-definition.
