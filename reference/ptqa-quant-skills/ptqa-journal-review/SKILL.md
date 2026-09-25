---
name: ptqa-journal-review
description: Read closed trades and report net results, R-multiples and patterns worth investigating.
---

# Review a trade journal

Ask for a CSV with trade_id, exit_time with timezone, gross_pnl, costs, initial_risk and optional setup. Require sorted exits and unique IDs. Confirm amounts share one currency. Run the journal command. Separate observed facts from hypotheses. Do not claim a small sample proves an edge or issue new trading instructions.

Run `python quant_tools.py journal --help` from this skill folder for arguments. Use the bundled calculation rather than mental arithmetic. Inputs stay local. Read the output note and preserve its limitations.
