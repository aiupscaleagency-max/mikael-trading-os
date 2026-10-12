# Agentlogg

2026-10-12: Kirurgisk rättning ovanpå Claudes merge #79: exakt procent från kontantbelopp, samma procentgrund i preview och kö, validering utan tyst avrundning, omräkning vid konto-/saldobyte och avvisning av gamla instrument-/miljösvar. Typkontroll, IG-svit, 28 inline-skript och isolerad regression gröna. Oberoende reviewer granskade och körde regressionen: godkänd avgränsad patch. Verklig skärmkontroll återstår. Automatisk handel är inte implementerad eller aktiverad. Inga order, nycklar, modeller eller säkerhetsgrindar ändrade.

2026-10-12: Analysmodalens missvisande Köp ändå ersatt med Öppna i orderpanelen: endast befintlig AGTIP-förifyllning, ingen order köas. Indikatoralternativ märkt separat från agentrekommendation. Lokal kandidat och revisions-/miljöskydd hindrar gamla analysresultat från fel förifyllning/återöppning. Oberoende reviewer godkände slutdiff. Typkontroll, 28 inline-skript och beloppsregression passerar. Skärmverifiering och övriga auditfynd återstår.
