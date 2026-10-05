# Check market data

Check an OHLCV CSV before a backtest. Flag duplicate or unordered timestamps, missing fields, non-finite numbers and impossible price ranges.

Open the install prompt in Resources and paste the whole prompt into your coding app. It installs the skill and runs its checks. Then use the skill with your own file or inputs.

Ask for the CSV path. Columns: timestamp with timezone, open, high, low, close, volume. Run the data command. If bar frequency is known, pass --expected-seconds. Treat gaps as review items until you know the trading calendar. Never silently fill gaps or rewrite original data.

Post one thing the check revealed in Community, with private data removed.
