#!/usr/bin/env bash
# A screenshot of the app on the Mac's simulator, brought back here: the app launched (with KEEPS_PLAY, say), given
# some seconds, then pictured. Build and install it first: SIM='iPhone 17' ios/sync.sh --no-run.
#   ios/tools/screenshot.sh out.png [seconds] [KEY=value ...]     e.g. ios/tools/screenshot.sh /tmp/t.png 12 KEEPS_PLAY=easy:3
set -euo pipefail
OUT=$1
WAIT=${2:-8}
shift 2 || shift $#
MAC=${MAC:-edwardli@100.90.147.75}
SIM=${SIM:-iPhone 17}
APP_ID=${APP_ID:-online.playkeeps.Keeps}
ENV=""
for kv in "$@"; do ENV="$ENV SIMCTL_CHILD_$kv"; done
ssh -o ControlPath="$HOME/.ssh/keeps-mac-%C" "$MAC" bash -s -- "$(printf %q "$SIM")" "$APP_ID" "$WAIT" "$(printf %q "$ENV")" <<'REMOTE'
set -euo pipefail
SIM=$1 APP_ID=$2 WAIT=$3 ENV=$4
xcrun simctl boot "$SIM" 2>/dev/null || true
xcrun simctl terminate "$SIM" "$APP_ID" 2>/dev/null || true
env $ENV xcrun simctl launch "$SIM" "$APP_ID" > /dev/null
sleep "$WAIT"
xcrun simctl io "$SIM" screenshot --type=png /tmp/keeps-screenshot.png > /dev/null 2>&1
REMOTE
scp -q -o ControlPath="$HOME/.ssh/keeps-mac-%C" "$MAC:/tmp/keeps-screenshot.png" "$OUT"
echo "$OUT"
