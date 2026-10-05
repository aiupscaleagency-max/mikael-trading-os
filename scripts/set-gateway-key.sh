#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# En nyckel — alla modeller.
#
#   ./scripts/set-gateway-key.sh
#
# Tar emot din Vercel AI Gateway-nyckel en gång och lägger den på alla
# ställen som behöver den. Inmatningen är dold. Värdet skrivs aldrig ut,
# hamnar aldrig i shell-historiken och aldrig i ett kommandoargument (där
# andra processer kan läsa det via ps).
#
# Gateway är OpenAI-kompatibel, så samma nyckel och samma bas-URL betjänar
# JEV, Claude-modeller och GPT-modeller. Därför räcker en nyckel för Hermes,
# jev-loop-skillen och Codex.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

KEYCHAIN_SERVICE="aiupscale.vercel.gateway-key"
GATEWAY_BASE_URL="https://ai-gateway.vercel.sh/v1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARED_ENV="$HOME/.config/aiupscale/gateway.env"
SKILL_ENV="$HOME/.claude/skills/jev-loop/.env"

echo "Vercel AI Gateway-nyckel"
echo "Hämtas på vercel.com → ditt team → AI Gateway → API Keys."
echo "Teamet måste ha ett kort registrerat, annars svarar gatewayen inte."
echo
printf 'Klistra in nyckeln (den syns inte medan du skriver): '
IFS= read -rs GATEWAY_KEY
echo

if [ -z "$GATEWAY_KEY" ]; then
  echo "Ingen nyckel angavs — inget ändrades." >&2
  exit 1
fi

# Skriver KEY=VALUE till en fil utan att värdet passerar ett kommandoargument.
# Ersätter raden om nyckeln redan finns istället för att dubblera den.
write_env_var() {
  local file="$1" name="$2" value="$3" prefix="${4:-}" tmp
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || : > "$file"
  chmod 600 "$file"
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  grep -v -E "^(export[[:space:]]+)?${name}=" "$file" > "$tmp" || true
  printf '%s%s=%s\n' "$prefix" "$name" "$value" >> "$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}

# 1. Keychain — källan jevClient.ts faller tillbaka på när .env saknas.
security delete-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1 || true
security add-generic-password -s "$KEYCHAIN_SERVICE" -a "$USER" -w "$GATEWAY_KEY" -U
echo "✓ macOS Keychain          ($KEYCHAIN_SERVICE)"

# 2. Trading-OS — Hermes och signalmotorn läser .env i repo-roten.
write_env_var "$REPO_ROOT/.env" "AI_GATEWAY_API_KEY" "$GATEWAY_KEY"
echo "✓ trading-os/.env         (AI_GATEWAY_API_KEY)"

# 3. jev-loop-skillen, om den är installerad.
if [ -d "$(dirname "$SKILL_ENV")" ]; then
  write_env_var "$SKILL_ENV" "AI_GATEWAY_API_KEY" "$GATEWAY_KEY"
  echo "✓ jev-loop-skillen        (AI_GATEWAY_API_KEY)"
else
  echo "· jev-loop-skillen        ej installerad — hoppar över"
fi

# 4. Delad env-fil för allt annat: Codex, skript, nya terminaler.
#    Gateway är OpenAI-kompatibel, så OPENAI_* pekas om hit.
write_env_var "$SHARED_ENV" "AI_GATEWAY_API_KEY" "$GATEWAY_KEY" "export "
write_env_var "$SHARED_ENV" "OPENAI_API_KEY"     "$GATEWAY_KEY" "export "
write_env_var "$SHARED_ENV" "OPENAI_BASE_URL"    "$GATEWAY_BASE_URL" "export "
echo "✓ $SHARED_ENV"

unset GATEWAY_KEY

cat <<EOF

Klart. Nyckeln finns på alla fyra ställena och har aldrig skrivits ut.

Gör den tillgänglig i varje nytt terminalfönster:

  echo 'source ~/.config/aiupscale/gateway.env' >> ~/.zshrc

Verifiera att JEV faktiskt svarar:

  npm run verify
EOF
