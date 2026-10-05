#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Lägger in en API-nyckel i .env utan att den syns eller sparas i historiken.
#
#   ./scripts/set-key.sh ALPACA_KEY_ID
#   ./scripts/set-key.sh TYPESAFE_API_KEY
#
# Inmatningen är dold. Värdet skrivs aldrig ut, hamnar aldrig i shell-
# historiken och aldrig i ett kommandoargument (där andra processer kan läsa
# det via ps). Finns nyckeln redan ersätts raden istället för att dubbleras.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

KEY_NAME="${1:-}"
if [ -z "$KEY_NAME" ]; then
  echo "Användning: ./scripts/set-key.sh <NYCKELNAMN>"
  echo
  echo "Vanliga:"
  echo "  ALPACA_KEY_ID · ALPACA_SECRET_KEY · ALPACA_BASE_URL"
  echo "  BINANCE_API_KEY · BINANCE_API_SECRET"
  echo "  TYPESAFE_API_KEY · AI_GATEWAY_API_KEY"
  echo "  ANTHROPIC_API_KEY"
  exit 1
fi

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
[ -f "$ENV_FILE" ] || { touch "$ENV_FILE"; chmod 600 "$ENV_FILE"; }

printf "Klistra in värdet för %s (dolt): " "$KEY_NAME"
read -rs VALUE
echo

if [ -z "$VALUE" ]; then
  echo "❌ Tomt värde — inget ändrat."
  exit 1
fi

# Befintlig rad ersätts. Utan detta växer .env med dubbletter, och vilken
# som gäller beror på inläsningsordningen.
if grep -q "^${KEY_NAME}=" "$ENV_FILE" 2>/dev/null; then
  TMP="$(mktemp)"
  grep -v "^${KEY_NAME}=" "$ENV_FILE" > "$TMP"
  mv "$TMP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ACTION="uppdaterad"
else
  ACTION="tillagd"
fi

printf '%s=%s\n' "$KEY_NAME" "$VALUE" >> "$ENV_FILE"

echo "✅ ${KEY_NAME} ${ACTION} i .env (${#VALUE} tecken)"
echo "   .env är gitignorerad och kan inte pushas."
echo
echo "Kontrollera med:  npm run verify"
