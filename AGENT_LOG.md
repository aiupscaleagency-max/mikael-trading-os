# Agentlogg

2026-10-12: Kirurgisk rättning ovanpå Claudes merge #79: exakt procent från kontantbelopp, samma procentgrund i preview och kö, validering utan tyst avrundning, omräkning vid konto-/saldobyte och avvisning av gamla instrument-/miljösvar. Typkontroll, IG-svit, 28 inline-skript och isolerad regression gröna. Oberoende reviewer granskade och körde regressionen: godkänd avgränsad patch. Verklig skärmkontroll återstår. Automatisk handel är inte implementerad eller aktiverad. Inga order, nycklar, modeller eller säkerhetsgrindar ändrade.

2026-10-12: Analysmodalens missvisande Köp ändå ersatt med Öppna i orderpanelen: endast befintlig AGTIP-förifyllning, ingen order köas. Indikatoralternativ märkt separat från agentrekommendation. Lokal kandidat och revisions-/miljöskydd hindrar gamla analysresultat från fel förifyllning/återöppning. Oberoende reviewer godkände slutdiff. Typkontroll, 28 inline-skript och beloppsregression passerar. Skärmverifiering och övriga auditfynd återstår.

2026-10-12: Analysmodalens instrument binds till samma analysis.notes, inte globala team/last. Expanderbar sparad sammanfattning och resultat per analyserat instrument, full verdict/technical/trigger. Saknat urval visas explicit. Väntande order filtreras på omgångens tider, instrument och mäklarmiljö. Modalens tipsknappar binds direkt till sparat tips med instrument/miljö/actionkontroll; HOLD visas utan handelsknapp. Aktuell standardhorisont märks korrekt. Reviewer godkände slutdiff; typkontroll, inline-skript och beloppsregression passerar. Inte helplattforms- eller handelsverifierat.

2026-10-12: Befintlig positions-/resultatpanel flyttas till höger om diagrammet efter orderpanelen; knappar/ID och API-pollning återanvänds. Instrumentväljare i orderpanelen följer huvuddiagrammets val. Kontogeneration och requestrevision avvisar gamla svar; kontobyte tömmer tidigare resultat. Positions-/historikfel visas som overifierat, inte tom lista. Confirmed-stängningar binds till fångad miljö. Reviewer granskade med konkreta kontorättningar. Typkontroll, inline-skript och beloppsregression passerar. Visuell kontroll återstår.

## 2026-10-12 — orderförkontroll, diagram och kontobytesraces
- Köp/sälj verifierar riktningens storlek/marginal innan godkännandekön. Ändrat konto/instrument/belopp och saknad beräkning avbryter.
- Huvuddiagram prenumererar före historikhämtning, avvisar sena svar även A→B→A, anpassar första datan till vyn och bevarar senare zoom. Dolda flikar gör inga schemalagda huvuddiagramhämtningar.
- IGS avbryter fördröjd urvalssparning vid kontobyte och avvisar sena svar; gamla sessionskontroller töms. Start/stop kontrollerar miljön över asynkrona steg. Redan skickade urvals-POST är fortsatt bundna av backendens aktiva miljö, ingen atomisk backendändring gjord.
- Chatten avbryter före POST om konto ändras under bilageläsning och märker svar med miljö.
- Reviewer granskade och tre isolerade fixtures passerade, inklusive åtta IGS-kontroller. TypeScript, 28 skript och hela test:ig passerade. Gammal popup-testassertion uppdaterad till befintligt prefill-flöde utan direktorder.
- JEV kunde inte köras vid review (HTTP 402); befintlig modell/routing bevarad.
- Browser bekräftar rätt iframe till :9443 och uppdaterad frontend. Full visuell verifiering och faktisk IG-orderlivscykel återstår; inga order, kontobyten eller botomstarter utförda i verifieringen. ProRealTime-inbäddning ej verifierad.
