# Prompts — Mikael Trading OS

Läsbar dokumentation av varje agents systemprompt + krisscenarier.

> **OBS:** Detta är **dokumentation som speglar koden**. Den faktiska prompten lever i TypeScript-filerna. När du vill ändra en prompt: redigera `.md`-filen, sen mapppa över ändringen till motsvarande `.ts`-fil (jag hjälper). Det här ger dig en plats att läsa, jämföra och föreslå förbättringar utan att navigera kod.

## Struktur

```
prompts/
├── agents/                    Varje agent-roll, en fil per person
│   ├── lars-research.md       Lars (Perplexity) — färsk webbresearch
│   ├── markus-macro.md        Markus — makroanalys
│   ├── tomas-technical.md     Tomas — teknisk analys
│   ├── sara-sentiment.md      Sara — sentiment + politiker-trades
│   ├── rasmus-risk.md         Rasmus — risk + sizing
│   ├── karin-quant.md         Karin — kvant + volatilitets-multiplier
│   ├── petra-portfolio.md     Petra — portföljbalans
│   ├── emma-execution.md      Emma — order-exekvering
│   ├── albert-advisor.md      Albert (Opus 4.7) — strategisk
│   └── hanna-head-trader.md   Hanna (Sonnet 4.6) — slutbeslut + lägger trades
└── crisis-scenarios/          Hur teamet beter sig i kris
    ├── bear-market.md         Långsam bearmarkn
    ├── flash-crash.md         Plötsliga ras
    ├── war-geopolitics.md     Krig, sanktioner
    ├── liquidity-crisis.md    Likviditetskris
    ├── stagflation.md         Stagflation
    └── dollar-collapse.md     Dollar-krasch / FX-stress
```

## Vem gör vad

| Person | Roll | Modell | Trade-makt |
|---|---|---|---|
| **Lars** | Research-Analytiker | Perplexity Sonar Pro | – |
| **Markus** | Makro-Analytiker | Haiku 4.5 | – |
| **Tomas** | Teknisk Analytiker | Haiku 4.5 | – |
| **Sara** | Sentiment-Analytiker | Haiku 4.5 | – |
| **Rasmus** | Risk-Analytiker | Haiku 4.5 | **VETO** (kan blocka trades) |
| **Karin** | Kvant-Analytiker | Haiku 4.5 | sizing-multiplier |
| **Petra** | Portfölj-Strateg | Haiku 4.5 | – |
| **Emma** | Exekverings-Optimerare | Haiku 4.5 | – |
| **Albert** | Strategisk Advisor | **Opus 4.7** | – (men strategisk vägledning) |
| **Hanna** | Head Trader | **Sonnet 4.6** | **SLUTBESLUT + lägger trades** |

## Flöde per session (var 12:e timme)

```
1. Lars   → färsk research (Perplexity)
2. 8 specialister  → analyserar parallellt med Lars som kontext
3. Albert → strategisk djupanalys
4. Hanna  → syntetiserar allt → BUY/SELL/HOLD → lägger ordrar via Binance/Oanda
```
