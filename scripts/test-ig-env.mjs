// Laddas före varje IG-test: testerna räknar med kodens standardbudget för IG-läsningar,
// oberoende av instansens .env. Tom sträng = kodens standard, och dotenv skriver inte över en satt variabel.
for (const k of ["IG_READ_BUDGET_PER_ENV", "IG_READ_BUDGET_TOTAL", "IG_READ_RESERVE_PER_ENV"]) process.env[k] = "";
// Tiingo-reserven för minidiagram: ingen riktig nyckel i testerna (inga nätverksanrop). Tom sträng = saknas.
process.env.TIINGO_API_KEY = "";
