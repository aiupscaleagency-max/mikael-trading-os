#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Installerar Trading OS som en alltid-på-tjänst på macOS.
#
#   ./scripts/launchd/install-service.sh
#
# Samma mönster som com.aiupscale.agentos-dashboard: en LaunchAgent som
# startar vid inloggning och startas om automatiskt om den kraschar.
#
# Tjänsten kör --serve: dashboard och marknadsströmmar, INGEN agent-loop.
# En alltid-på-tjänst som kör agenten skulle kosta LLM-anrop dygnet runt.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

LABEL="com.aiupscale.trading-os"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOGDIR="$HOME/Library/Logs/aiupscale"
PORT="${DASHBOARD_PORT:-3939}"

command -v node >/dev/null || { echo "❌ node hittades inte i PATH"; exit 1; }
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NPM_BIN}</string>
    <string>run</string>
    <string>serve</string>
  </array>

  <key>WorkingDirectory</key><string>${REPO}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
    <key>DASHBOARD_PORT</key><string>${PORT}</string>
  </dict>

  <!-- Startar vid inloggning och startas om vid krasch. Systemet ska vara
       nåbart utan att man tänker på det. -->
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>

  <!-- Tio sekunder mellan omstartsförsök. Utan detta kan en trasig start
       snurra i en tight loop och belasta maskinen. -->
  <key>ThrottleInterval</key><integer>10</integer>

  <key>StandardOutPath</key><string>${LOGDIR}/trading-os.log</string>
  <key>StandardErrorPath</key><string>${LOGDIR}/trading-os.error.log</string>
</dict>
</plist>
PLIST_EOF

# Ladda om ifall den redan fanns
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}"

echo "✅ ${LABEL} installerad"
echo "   Dashboard:  http://localhost:${PORT}"
echo "   Loggar:     ${LOGDIR}/trading-os.log"
echo
echo "Kommandon:"
echo "  launchctl kickstart -k gui/\$(id -u)/${LABEL}   # starta om"
echo "  launchctl bootout   gui/\$(id -u)/${LABEL}      # stoppa"
echo "  tail -f ${LOGDIR}/trading-os.log               # följ loggen"
