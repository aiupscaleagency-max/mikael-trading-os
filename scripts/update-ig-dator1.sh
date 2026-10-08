#!/bin/bash
set -euo pipefail
target="${1:?Ange granskad målcommit}"
expected='f63ef80b8b55f2ad8f72db59914145c7a7c1e5a5'
label='com.aiupscale.trading-os'
plist="$HOME/Library/LaunchAgents/$label.plist"
[ -f "$plist" ] || { echo 'Avbrutet: befintlig tjänst saknas.' >&2; exit 1; }
configured=$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$plist")
[ "$(cd "$configured" && pwd -P)" = "$(pwd -P)" ] || { echo 'Avbrutet: fel arbetskopia.' >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$expected" ] || [ "$(git rev-parse HEAD)" = "c3f53753b0e96f00c3c024e997f5d825fe39b617" ] || { echo 'Avbrutet: annan version än den granskade. Skicka git status/log.' >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Avbrutet: lokala ändringar måste samordnas först.' >&2; exit 1; }
target=$(git rev-parse --verify "${target}^{commit}")
git merge-base --is-ancestor HEAD "$target"
git branch "backup/ig-fore-marknadsstudio-$(date +%Y%m%d-%H%M%S)" HEAD
git merge --ff-only "$target"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
npx tsc --noEmit
launchctl kickstart -k "gui/$(id -u)/$label"
echo 'Befintlig IG-tjänst uppdaterad. Inga nycklar eller orderflaggor ändrade.'
