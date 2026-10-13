#!/bin/bash
# Körs manuellt av Mike enligt överlämningen; startar aldrig två botar.
set -Eeuo pipefail
trap 'echo "Omstart avbruten på rad $LINENO (felkod $?)." >&2' ERR
echo "1/4: Kontrollerar Trading-OS…"
cd "$(dirname "$0")/.."
mkdir -p data-ig
if ! mkdir data-ig/restart.lock 2>/dev/null; then
  echo 'En annan omstart pågår. Ingen bot startades.' >&2
  exit 1
fi
trap 'rmdir data-ig/restart.lock' EXIT
trading_root="$(pwd -P)"
echo "2/4: Kontrollerar TypeScript. Vänta tills kontrollen är klar…"
./node_modules/.bin/tsc --noEmit -p .
echo "3/4: Kontrollerar och stoppar den befintliga boten…"
trading_pid="$(lsof -tiTCP:3940 -sTCP:LISTEN || true)"
if [[ "$trading_pid" == *$'\n'* ]]; then
  echo 'Flera processer lyssnar på 3940. Omstarten avbröts.' >&2
  exit 1
fi
if [[ -n "$trading_pid" ]]; then
  trading_command="$(ps -p "$trading_pid" -o command=)"
  trading_cwd="$(lsof -a -p "$trading_pid" -d cwd -Fn | sed -n 's/^n//p')"
  if [[ "$trading_cwd" != "$trading_root" || "$trading_command" != *'src/run.ts --serve'* ]]; then
    echo 'Port 3940 används av en annan process. Omstarten avbröts.' >&2
    exit 1
  fi
  kill "$trading_pid"
  for attempt in {1..30}; do
    if ! lsof -tiTCP:3940 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi
if lsof -tiTCP:3940 -sTCP:LISTEN >/dev/null 2>&1; then
  echo 'Den gamla boten har inte stannat. Ingen ny bot startades.' >&2
  exit 1
fi
mkdir -p data-ig
echo "4/4: Startar boten och väntar på port 3940…"
nohup ./node_modules/.bin/tsx src/run.ts --serve >>data-ig/bot.log 2>&1 </dev/null &
for attempt in {1..30}; do
  new_trading_pid="$(lsof -tiTCP:3940 -sTCP:LISTEN || true)"
  if [[ -n "$new_trading_pid" ]]; then
    new_command="$(ps -p "$new_trading_pid" -o command=)"
    new_cwd="$(lsof -a -p "$new_trading_pid" -d cwd -Fn | sed -n 's/^n//p')"
    if [[ "$new_trading_pid" == "$trading_pid" || "$new_cwd" != "$trading_root" || "$new_command" != *'src/run.ts --serve'* ]]; then
      echo 'Den nya botprocessen kunde inte verifieras.' >&2
      exit 1
    fi
    echo "Trading-OS startad på 3940: PID $new_trading_pid, kod $(git rev-parse --short HEAD)."
    exit 0
  fi
  sleep 1
done
echo 'Botstarten kunde inte bekräftas. Kontrollera den skyddade lokala loggen data-ig/bot.log.' >&2
exit 1
