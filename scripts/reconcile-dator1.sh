#!/bin/bash
set -euo pipefail
# Run from the existing dator1 checkout. Never starts a second engine.
target="${1:?Ange verifierad commit från FETCH_HEAD}"
expected='b72bed0f5703b1902a6a7f6d624e1e91f69a5ec1'
repo=$(pwd -P)
label='com.aiupscale.trading-os'
plist="$HOME/Library/LaunchAgents/$label.plist"
[ -f "$plist" ] || { echo 'Avbrutet: befintlig tjänst saknas.' >&2; exit 1; }
configured=$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$plist")
[ "$(cd "$configured" && pwd -P)" = "$repo" ] || { echo 'Avbrutet: tjänsten använder en annan arbetskopia.' >&2; exit 1; }
target=$(git rev-parse --verify "${target}^{commit}")
head=$(git rev-parse HEAD)
[ "$head" = "$expected" ] || { echo 'Avbrutet: dator 1 har ändrats sedan granskningen. Skicka ny git status/log.' >&2; exit 1; }
git merge-base --is-ancestor "$expected" "$target" || { echo 'Avbrutet: uppdateringen innehåller inte dator 1:s commit.' >&2; exit 1; }
# Preserve current conflict resolutions, index, untracked non-ignored files and merge metadata.
stamp=$(date +%Y%m%d-%H%M%S)
backup="$HOME/ai_upscale_work/trading-os-backups/$stamp"
mkdir -p "$backup"
chmod 700 "$backup"
git status --short --branch > "$backup/status.txt"
git diff --binary HEAD > "$backup/worktree.patch"
git ls-files --unmerged > "$backup/unmerged.txt"
git diff --name-only --diff-filter=ACMRTUXB -z HEAD > "$backup/paths.nul"
git ls-files --others --exclude-standard -z >> "$backup/paths.nul"
if [ -s "$backup/paths.nul" ]; then tar --null -T "$backup/paths.nul" -czf "$backup/working-files.tar.gz"; fi
for name in index MERGE_HEAD MERGE_MSG ORIG_HEAD; do
  source=$(git rev-parse --git-path "$name")
  if [ -f "$source" ]; then cp "$source" "$backup/git-$name"; fi
done
git branch "backup/dator1-fore-sammanfogning-$stamp" HEAD
echo "Säkerhetskopia: $backup"
if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  merging=$(git rev-parse MERGE_HEAD)
  git merge-base --is-ancestor "$merging" "$target" || { echo 'Avbrutet: annan sammanslagning än den granskade.' >&2; exit 1; }
  git merge --abort
fi
[ -z "$(git status --porcelain)" ] || { echo 'Avbrutet: andra lokala ändringar finns kvar och är säkerhetskopierade.' >&2; exit 1; }
git merge --ff-only "$target"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
npm ci --allow-git=all
npx tsc --noEmit
launchctl kickstart -k "gui/$(id -u)/$label"
echo 'Sammanförd kod installerad; befintlig tjänst omstartad. Inga nycklar eller orderflaggor ändrade.'
echo 'Skicka detta resultat i chatten så verifieras WebSocket och riktiga IG-prisuppdateringar.'
