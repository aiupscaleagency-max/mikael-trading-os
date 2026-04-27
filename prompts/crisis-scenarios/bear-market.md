# Bear-Market Protocol

**När det utlöses:** BTC-50DMA < BTC-200DMA, VIX > 25 ihållande, bredd försämrad i >60% av top-15

## Förändringar i agentbeteende

### Markus (Macro)
- Klassificera som RISK_OFF om ≥3 av: Fed hawkish, dollar > 105, oil > 90, VIX > 25
- Flagga "regim-skifte" i confidence-fält

### Rasmus (Risk)
- Sänk max position automatiskt till **50% av MAX_POSITION_USD**
- Höj korrelations-tolerans: avslå nya positioner med >0.85 korr mot existerande
- Daily loss limit: stäng allt vid -3% (inte -5%)

### Karin (Quant)
- `suggestedSizeMultiplier` capped vid 0.7 i bear (defensiv mode)
- Trend-score viktas dubbelt mot mean-reversion (inga fang-ar fallande knivar)

### Petra (Portfolio)
- Mål-cash: minst **40%** (vs 20% normal)
- Sektor-koncentration: max 30% per sektor (vs 50% normal)

### Albert (Advisor)
- Aktivera "bear cycle"-mode: värdera kapitalbevarande > avkastning
- Föreslå **inverse-positioner** om systemet stödjer (t.ex. SHORT på Oanda forex)

### Hanna (Head Trader)
- BIAS mot HOLD/SELL — kräv ≥6/9 bullish-signaler för BUY (vs 5/9 normal)
- Trim-trigger: positioner i +5% → ta hem 50% (säkra vinster)
- Stop-loss: tighter, 2% (vs 3% normal)

## Exit från bear-mode

Om: BTC återtar 50DMA + VIX < 20 + bredd > 60% i 5 dagar → tillbaka till normal

## Förbättringsförslag

> Skriv vad du vill att teamet ska göra annorlunda i bearmarkn
