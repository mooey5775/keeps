#!/usr/bin/env bash
# The app, from this machine (the source of truth) to the phone: builds its TypeScript here, copies it and the Swift
# sources to the Mac, exports the Core ML model there if the weights changed, builds and installs the app, and runs it
# with its log streamed here until it says DONE.
#   ios/sync.sh                      the app (Keeps): build, install and run
#   ios/sync.sh --no-run             build and install only
#   KEEPS_SELFTEST=1 ios/sync.sh     run the app's self-test (KEEPS_SELFTEST_GAMES='hard:1,easy:1': level:marks, ...)
#   TARGET=KeepsSpike ios/sync.sh    the spike (SPIKE_QUERY='positions=4&worlds=256': its plan, see ios/web/main.ts)
set -euo pipefail
MAC=${MAC:-edwardli@100.90.147.75}  # the Mac, on Tailscale
TARGET=${TARGET:-Keeps}
# The bundle id to build it as (APP_ID: another one, as long as there's no profile for its own; see ios/README.md).
APP_ID=${APP_ID:-online.playkeeps.$TARGET}
# Signing uses the build keychain (ios/tools/setup-build-keychain.sh, once). Without it, codesign needs the login
# keychain unlocked in this very ssh session: a shared connection in which you unlocked it is reused, if there is one.
SSH_OPTS=(-o ControlPath="$HOME/.ssh/keeps-mac-%C")
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
export RSYNC_RSH="ssh -o ControlPath=$HOME/.ssh/keeps-mac-%C"
DEVICE=${DEVICE:-00008150-000150E83EF0401C}
WEIGHTS=packages/learn/demo/weights/midstrike.bin
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "${ROOT:?}"

VITE=packages/learn/node_modules/.bin/vite
if [ "$TARGET" = KeepsSpike ]; then
  $VITE build --config ios/web/vite.config.mjs
  [ -f ios/build/positions.json ] || node ios/web/positions.ts "$WEIGHTS" ios/build/positions.json 24
  cp ios/build/positions.json "$WEIGHTS" ios/build/web/
  BUNDLE=web
else
  packages/learn/node_modules/.bin/tsc -p ios/tsconfig.json
  $VITE build --config ios/core/vite.config.mjs
  cp "$WEIGHTS" ios/build/core/
  BUNDLE=core
fi

ssh "$MAC" 'mkdir -p ~/src/keeps/ios/build ~/src/keeps/bot ~/src/keeps/packages/learn/demo/weights'
rsync -a --delete ios/App ios/Shared ios/Spike ios/project.yml "$MAC:src/keeps/ios/"
rsync -a --delete "ios/build/$BUNDLE" "$MAC:src/keeps/ios/build/"
rsync -a --delete --exclude=__pycache__ bot/keeps_bot bot/marvel "$MAC:src/keeps/bot/"
rsync -a "$WEIGHTS" "$MAC:src/keeps/$WEIGHTS"

ssh "$MAC" bash -s -- "$DEVICE" "$WEIGHTS" "$TARGET" "$APP_ID" <<'EOF'
set -euo pipefail
DEVICE=$1 WEIGHTS=$2 TARGET=$3 APP_ID=$4
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/src/keeps
if [ ! -d ios/build/KeepsPolicy.mlpackage ] || [ "$WEIGHTS" -nt ios/build/KeepsPolicy.mlpackage ]; then
  rm -rf ios/build/KeepsPolicy.mlpackage
  (cd bot && PYTHONPATH=. ~/src/keeps-ios-venv/bin/python -m keeps_bot.coreml "../$WEIGHTS" ../ios/build/KeepsPolicy.mlpackage 2>&1 | grep -v "^\s*$\|Torch version\|it/s\]\|passes/s\]\|ops/s\]")
fi
cd ios
# Each target's resources must exist for the project to generate (the other target's may not be built).
mkdir -p build/web build/core
# Signing: the build keychain (ios/tools/setup-build-keychain.sh) if it's set up, else whatever this session has.
if [ -f ~/.keeps-build-keychain ]; then
  security unlock-keychain -p "$(cat ~/.keeps-build-keychain)" keeps-build.keychain
  SIGN=(OTHER_CODE_SIGN_FLAGS=--keychain="$HOME/Library/Keychains/keeps-build.keychain-db")
else
  SIGN=()
fi
xcodegen generate --quiet
xcodebuild -project Keeps.xcodeproj -scheme "$TARGET" -configuration Release -destination "id=$DEVICE" \
  -derivedDataPath build/derived -allowProvisioningUpdates -quiet PRODUCT_BUNDLE_IDENTIFIER="$APP_ID" ${SIGN[@]+"${SIGN[@]}"} build
xcrun devicectl device install app --device "$DEVICE" "build/derived/Build/Products/Release-iphoneos/$TARGET.app" | tail -2
EOF

[ "${1:-}" = "--no-run" ] && exit 0
if [ "$TARGET" = KeepsSpike ]; then
  ENV="{\"SPIKE_QUERY\": \"${SPIKE_QUERY:-}\"}"
elif [ -n "${KEEPS_SELFTEST:-}" ]; then
  ENV="{\"KEEPS_SELFTEST\": \"1\", \"KEEPS_SELFTEST_GAMES\": \"${KEEPS_SELFTEST_GAMES:-hard:1,easy:1}\"}"
else
  ENV='{}'
fi
# (The JSON reaches the Mac's shell in single quotes.)
ssh "$MAC" "xcrun devicectl device process launch --device $DEVICE --console --terminate-existing \
  --environment-variables '$ENV' $APP_ID" 2>&1 | sed -u 's/\r$//; /^DONE$/q'
