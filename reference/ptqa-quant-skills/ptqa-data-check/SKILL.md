---
name: ptqa-data-check
description: Check an OHLCV CSV before a backtest. Flag duplicate or unordered timestamps, missing fields, non-finite numbers and impossible price ranges.
---

# Check market data

Ask for the CSV path. Columns: timestamp with timezone, open, high, low, close, volume. Run the data command. If bar frequency is known, pass --expected-seconds. Treat gaps as review items until you know the trading calendar. Never silently fill gaps or rewrite original data.

Run `python quant_tools.py data --help` from this skill folder for arguments. Use the bundled calculation rather than mental arithmetic. Inputs stay local. Read the output note and preserve its limitations.
