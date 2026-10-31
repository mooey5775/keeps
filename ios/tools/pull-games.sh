#!/usr/bin/env bash
# The games the app kept on the phone (Documents/games: each game's replay log, rewritten after every move),
# copied here through the Mac.
#   ios/tools/pull-games.sh [folder]     (default ios/build/games; APP_ID as the app was installed with)
set -euo pipefail
MAC=${MAC:-edwardli@100.90.147.75}
DEVICE=${DEVICE:-00008150-000150E83EF0401C}
APP_ID=${APP_ID:-online.playkeeps.Keeps}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-$ROOT/ios/build/games}
SSH=(ssh -o ControlPath="$HOME/.ssh/keeps-mac-%C")
"${SSH[@]}" "$MAC" "rm -rf /tmp/keeps-games && xcrun devicectl device copy from --device $DEVICE --domain-type appDataContainer \
  --domain-identifier $APP_ID --source Documents/games --destination /tmp/keeps-games > /dev/null"
mkdir -p "$OUT"
rsync -a -e "ssh -o ControlPath=$HOME/.ssh/keeps-mac-%C" "$MAC:/tmp/keeps-games/" "$OUT/"
ls -t "$OUT" | head
