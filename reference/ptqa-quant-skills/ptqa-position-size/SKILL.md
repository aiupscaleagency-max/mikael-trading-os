---
name: ptqa-position-size
description: Calculate a size from a planned loss budget, stop distance, costs and a notional cap.
---

# Calculate position size

Ask for equity, chosen risk percentage, entry, stop, direction, fee bps per side, estimated adverse slippage per unit across the trade, lot step and maximum notional. Never choose risk tolerance for the member. Use only linear shares or spot units in one currency. Explain that gaps can exceed the estimate. Do not place orders.

Run `python quant_tools.py size --help` from this skill folder for arguments. Use the bundled calculation rather than mental arithmetic. Inputs stay local. Read the output note and preserve its limitations.
