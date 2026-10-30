#!/usr/bin/env bash
# The spike, from this machine (the source of truth) to the phone: builds the page here, copies it and the app's
# sources to the Mac, exports the Core ML model there if the weights changed, builds and installs the app, and runs
# it with its log streamed here until the page says DONE.
#   ios/sync.sh            build, install and run
#   ios/sync.sh --no-run   build and install only
#   SPIKE_QUERY='positions=4&worlds=256' ios/sync.sh   change the page's plan (see ios/web/main.ts)
set -euo pipefail
MAC=${MAC:-edwardli@10.0.0.25}
# Every ssh connection to a Mac is its own security session, and codesign needs the login keychain unlocked in
# this one: reuse a shared connection in which you unlocked it (ios/README.md), when there is one.
SSH_OPTS=(-o ControlPath="$HOME/.ssh/keeps-mac-%C")
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
export RSYNC_RSH="ssh -o ControlPath=$HOME/.ssh/keeps-mac-%C"
DEVICE=${DEVICE:-00008150-000150E83EF0401C}
WEIGHTS=packages/learn/demo/weights/midstrike.bin
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "${ROOT:?}"

packages/learn/node_modules/.bin/vite build --config ios/web/vite.config.mjs
[ -f ios/build/positions.json ] || node ios/web/positions.ts "$WEIGHTS" ios/build/positions.json 24
cp ios/build/positions.json "$WEIGHTS" ios/build/web/

ssh "$MAC" 'mkdir -p ~/src/keeps/ios/build ~/src/keeps/bot ~/src/keeps/packages/learn/demo/weights'
rsync -a --delete ios/Spike ios/project.yml "$MAC:src/keeps/ios/"
rsync -a --delete ios/build/web "$MAC:src/keeps/ios/build/"
rsync -a --delete --exclude=__pycache__ bot/keeps_bot bot/marvel "$MAC:src/keeps/bot/"
rsync -a "$WEIGHTS" "$MAC:src/keeps/$WEIGHTS"

ssh "$MAC" bash -s -- "$DEVICE" "$WEIGHTS" <<'EOF'
set -euo pipefail
DEVICE=$1 WEIGHTS=$2
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/src/keeps
if [ ! -d ios/build/KeepsPolicy.mlpackage ] || [ "$WEIGHTS" -nt ios/build/KeepsPolicy.mlpackage ]; then
  rm -rf ios/build/KeepsPolicy.mlpackage
  (cd bot && PYTHONPATH=. ~/src/keeps-ios-venv/bin/python -m keeps_bot.coreml "../$WEIGHTS" ../ios/build/KeepsPolicy.mlpackage 2>&1 | grep -v "^\s*$\|Torch version\|it/s\]\|passes/s\]\|ops/s\]")
fi
cd ios
xcodegen generate --quiet
xcodebuild -project KeepsSpike.xcodeproj -scheme KeepsSpike -configuration Release -destination "id=$DEVICE" \
  -derivedDataPath build/derived -allowProvisioningUpdates -quiet build
xcrun devicectl device install app --device "$DEVICE" build/derived/Build/Products/Release-iphoneos/KeepsSpike.app | tail -2
EOF

[ "${1:-}" = "--no-run" ] && exit 0
QUERY=${SPIKE_QUERY:-}
ssh "$MAC" "xcrun devicectl device process launch --device $DEVICE --console --terminate-existing \
  --environment-variables '{\"SPIKE_QUERY\": \"$QUERY\"}' online.playkeeps.KeepsSpike" 2>&1 | sed -u 's/\r$//; /^DONE$/q'
