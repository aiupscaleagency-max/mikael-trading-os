# Gemensamt testprotokoll för PDF-strategier

Status: förberett för historiskt test/paperanalys. Ingen orderläggning har startats.

## Underlag och företräde

[Strategival](PLAN-JAMFORELSE-PDF-STRATEGIER.md) och [signalgiltighet och statistik](PLAN-SIGNALGILTIGHET-OCH-STATISTIK.md) hör ihop och gäller tillsammans. Detta protokoll preciserar mätningen. PDF-tolkningarna i strategivalet är tillhandahållet underlag; originalens innehåll har inte granskats på nytt här.

README:s äldre BTC/EMA-kandidat gäller ett separat test och styr inte denna PDF-serie.

## Första variant: A-OR5-M1-v1

Samtliga exakta regler nedan är egna föreslagna testparametrar, inte påståenden från PDF:erna. Lås en daterad parameterfil före första mätningen. Ändring skapar nytt variant-id och ny testperiod.

| Parameter | Föreslaget startvärde |
|---|---|
| Ordning | XAUUSD först; därefter EURUSD och GBPUSD med samma regler |
| Session | 09:30–11:30 America/New_York; egen forskningssession för guld/FX |
| Nivå | High/low från 09:30–09:35, byggt av fem avslutade M1-candles |
| Prisunderlag | Samma dokumenterade prisserie för nivå och signal; bid/ask för fyllnad |
| Utbrott | Senare M1 stänger strikt över high för long eller under low för short |
| Retest | En senare candle berör nivån och stänger på utbrottssidan; long grön, short röd |
| Retestfrist | Högst fem efterföljande M1-candles efter utbrott; annars nytt utbrott krävs |
| Entry | Limit på nivån, först efter retestcandlens stängning |
| Stop | Long: retest-low minus ett verifierat prissteg; short: retest-high plus ett prissteg |
| Target | 2 gånger initialt prisavstånd entry–stop |
| Delvinst/breakeven | Ingen i denna variant |
| Entrygiltighet | Nästa tre M1-intervall efter bekräftelsestängningen |
| Tids-exit | 60 minuter efter fyllnad eller sessionsslut, det som inträffar först |
| Begränsning | En väntande signal eller öppen trade per instrument; högst tre fyllningar per session |

Signal bildas vid retestcandlens stängning, aldrig retroaktivt. Utbrott och retest får inte vara samma candle. Long/short speglas exakt. Retestcandle stängd tillbaka på fel sida av nivån upphäver utbrottssetupen.

Entry-zon definieras för denna variant som området mellan den fasta stoppen och targeten. Limitnivån är en separat exakt prisnivå. Före fyllnad förfaller signalen vid första stop-/targetberöring, M1-stängning på fel sida om breakoutnivån, sessionsslut eller giltighetstidens slut. Efter fyllnad gäller enbart trade-exitreglerna; signalens väntetid får inte avsluta en redan fylld trade.

Om bekräftelsen stänger 09:42 är tillåtna fyllnadsintervall [09:42,09:43), [09:43,09:44), [09:44,09:45). Vid 09:45 förfaller signalen före ny fyllning. Historiska data måste kunna visa händelseordningen; annars märks utfallet tvetydigt.

## Obligatoriskt före första mätning

| Uppgift | Status |
|---|---|
| IG-epic, kontrakt, valuta, prissteg, punktvärde och minsta storlek | Ej verifierat |
| Datakälla, datumintervall, bid/ask och saknade candles | Ej valt |
| Simulerat kapital samt maxrisk i SEK per trade och dag | Ska fastställas |
| Slippagemodell, avgifter, spread och eventuell valutakonvertering | Ska fastställas |
| Kronologisk träningsperiod och separat orörd out-of-sample-period | Ska fastställas före test |
| Numerisk gräns för drawdown och lägsta fyllnadsgrad | Ska fastställas före test |

Saknade värden innebär att ingen tillförlitlig körning eller positionsstorlek kan redovisas. För liten tillåten position i förhållande till IG-minimum loggas som avvisad; stoppen flyttas inte för att få plats. Övriga strategier behåller sina egna villkor och behöver egna kompletta parameterblad före körning.

## Journal och exekvering

[JOURNAL-PDF-SIGNALER.csv](JOURNAL-PDF-SIGNALER.csv) har en rad per signal. [JOURNAL-PDF-EXITS.csv](JOURNAL-PDF-EXITS.csv) har en rad per fyllning av exit/delvinst. Koppla på signal_id och använd unika exit_id. Spara även avvisade, ofyllda och tvetydiga signaler.

Tidsstämplar lagras i UTC och Europe/Stockholm med UTC-offset. Sessionen räknas i America/New_York så skillnader i sommartidsbyte hanteras utan fast svensk klocktid. Marknadsregim definieras med en låst regel och endast data kända vid signalen.

Long-limit fylls när ask når limit, short-limit när bid når limit. Long-exit värderas på bid och short-exit på ask. Spread som redan ingår i dessa priser dras inte igen. Slippage appliceras enligt den låsta modellen, även vid gap; en normal stop antas inte garantera stoppriset. Limitfyllnad utan tillräcklig exekveringsinformation märks som modellerad.

Om både stop och target ligger inom samma candle och ordningen saknas: använd finare data eller markera tvetydigt och redovisa bästa/sämsta utfall separat. Gissa inte ordningen. Dataluckor markeras, candles fabriceras inte.

## Två separata resultatserier

1. Signaldiagnostik: prisrörelse från signalens stängning efter 1, 2, 3, 4, 5, 15, 30 och 60 minuter samt sessionsslut. Ange referenspris och faktisk mättid. Ej tillgänglig horisont lämnas tom med orsak. Ingen horisont skapar en fiktiv trade.
2. Traderesultat: faktisk modellerad fyllnad till exit med kostnader. Dygn och vecka summerar traderesultat; ej fyllda signaler ger ingen handelsvinst/förlust.

En stoppad trade behåller sitt utfall även om priset senare återhämtar sig. Daglig equity och drawdown ska inkludera öppna positioners marknadsvärde när sådana finns.

## Beräkningar och rapport

R0 är initial risk i SEK från faktisk entry till ursprunglig stop för hela positionen, före extra avgifter. R0 ändras aldrig efter delvinst eller stopflytt. Netto-R = total netto-PnL i SEK / R0. För delvinst används faktisk kvantitet per exit; kostnader och återstående position får inte dubbelräknas.

Vinstfrekvens = antal netto-vinnare / avslutade trades; nollresultat redovisas separat. Payoff = genomsnittlig nettovinst / absolut genomsnittlig nettoförlust. Profit factor = summa positiva nettoresultat / absolut summa negativa nettoresultat. Expectancy = medelvärde av netto-R. Saknas förluster rapporteras profit factor som ej ändligt skattningsbar, inte som bevis på robusthet. Fyllnadsgrad = fyllda signaler / alla giltigt skapade signaler; visa avvisade och tvetydiga separat.

Rapportera antal signaler och trades i varje grupp: strategi, instrument, timeframe, session, veckodag, timme och fördefinierad regim. Små delgrupper är beskrivande, inte stöd för parameteroptimering. Visa kort period, dag, rullande vecka, månad och hela perioden med explicit datumintervall.

30 observationer är en preliminär kontroll; 100 avslutade trades är en första bedömningspunkt per variant och instrument. Redovisa även osäkerhet, max drawdown, längsta förlustsvit och återhämtningstid. Ingen livepilot utan positiv expectancy efter kostnader, förutbestämda risk- och fyllnadsgränser samt stabilitet på separat data. Efterhandsjustering mot out-of-sample gör perioden till utvecklingsdata och kräver ny orörd period. Mike godkänner själv eventuell senare verklig pilot.
