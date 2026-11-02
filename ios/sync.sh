#!/usr/bin/env bash
# The app, from this machine (the source of truth) to the phone: builds its TypeScript here, copies it and the Swift
# sources to the Mac, exports the Core ML model there if the weights changed, builds and installs the app, and runs it
# with its log streamed here until it says DONE.
#   ios/sync.sh                      the app (Keeps): build, install and run
#   ios/sync.sh --no-run             build and install only
#   KEEPS_SELFTEST=1 ios/sync.sh     run the app's self-test (KEEPS_SELFTEST_GAMES='hard:1,easy:1': level:marks, ...)
#   SIM='iPhone 17' ios/sync.sh      on the Mac's iOS simulator instead of the phone (no signing needed)
#   KEEPS_PLAY=easy:3 ios/sync.sh    straight into a game against Midstrike at that level, to that many marks
#   STORE=1 ios/sync.sh --no-run     as the App Store would have it: without the KEEPS_* switches (Internal.swift)
# The Mac (MAC), the phone (DEVICE) and the bundle id to build as (APP_ID) come from the environment or ios/local.env.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "${ROOT:?}"
[ -f ios/local.env ] && . ios/local.env
MAC=${MAC:?the Mac to build on (user@host): set it in ios/local.env (see ios/README.md)}
DEVICE=${DEVICE:-}
[ -n "${SIM:-}" ] || : "${DEVICE:?the phone to install on (an id from xcrun devicectl list devices): set it in ios/local.env, or SIM= for the simulator}"
# Another bundle id, while the developer account has no profile for the app's own (see ios/README.md).
APP_ID=${APP_ID:-online.playkeeps.Keeps}
# Signing uses the build keychain (ios/tools/setup-build-keychain.sh, once). Without it, codesign needs the login
# keychain unlocked in this very ssh session: a shared connection in which you unlocked it is reused, if there is one.
# (A connection that's gone, the Mac asleep or off the network, is given up on within a minute, not waited on.)
ALIVE=(-o ServerAliveInterval=15 -o ServerAliveCountMax=4)
SSH_OPTS=(-o ControlPath="$HOME/.ssh/keeps-mac-%C" "${ALIVE[@]}")
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
export RSYNC_RSH="ssh -o ControlPath=$HOME/.ssh/keeps-mac-%C"
WEIGHTS=packages/bot/weights/midstrike.bin

ios/tools/build-core.sh

ssh "$MAC" 'mkdir -p ~/src/keeps/ios/build ~/src/keeps/training ~/src/keeps/packages/bot/weights'
rsync -a --delete ios/App ios/Shared ios/project.yml "$MAC:src/keeps/ios/"
rsync -a --delete ios/build/core ios/build/cards ios/build/fonts "$MAC:src/keeps/ios/build/"
rsync -a --delete --exclude=__pycache__ training/keeps_bot training/marvel "$MAC:src/keeps/training/"
rsync -a "$WEIGHTS" "$MAC:src/keeps/$WEIGHTS"

SIM=${SIM:-}
# The build's number: the commit count, so each build of a later commit counts higher. Ours have the KEEPS_* switches.
SETTINGS="CURRENT_PROJECT_VERSION=$(git rev-list --count HEAD)"
[ -n "${STORE:-}" ] || SETTINGS="$SETTINGS SWIFT_ACTIVE_COMPILATION_CONDITIONS=INTERNAL"
ssh "$MAC" bash -s -- "$DEVICE" "$WEIGHTS" "$APP_ID" "$(printf %q "$SIM")" "$SETTINGS" <<'EOF'
set -euo pipefail
DEVICE=$1 WEIGHTS=$2 APP_ID=$3 SIM=$4
read -r -a SETTINGS <<< "$5"
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/src/keeps
if [ ! -d ios/build/KeepsPolicy.mlpackage ] || [ "$WEIGHTS" -nt ios/build/KeepsPolicy.mlpackage ]; then
  rm -rf ios/build/KeepsPolicy.mlpackage
  (cd training && PYTHONPATH=. ~/src/keeps-ios-venv/bin/python -m keeps_bot.coreml "../$WEIGHTS" ../ios/build/KeepsPolicy.mlpackage 2>&1 | grep -v "^\s*$\|Torch version\|it/s\]\|passes/s\]\|ops/s\]")
fi
cd ios
# The resources must exist for the project to generate (the tests' goldens may not be there).
mkdir -p build/core build/cards build/fonts build/goldens
# Signing: the build keychain (ios/tools/setup-build-keychain.sh) if it's set up, else whatever this session has.
if [ -f ~/.keeps-build-keychain ] && [ -f ~/Library/Keychains/keeps-build.keychain-db ]; then
  security unlock-keychain -p "$(cat ~/.keeps-build-keychain)" keeps-build.keychain
  SIGN=(OTHER_CODE_SIGN_FLAGS=--keychain="$HOME/Library/Keychains/keeps-build.keychain-db")
else
  SIGN=()
fi
xcodegen generate --quiet
if [ -n "$SIM" ]; then
  xcodebuild -project Keeps.xcodeproj -scheme Keeps -configuration Release -destination "platform=iOS Simulator,name=$SIM" \
    -derivedDataPath build/derived-sim -quiet PRODUCT_BUNDLE_IDENTIFIER="$APP_ID" "${SETTINGS[@]}" build
  xcrun simctl boot "$SIM" 2>/dev/null || true
  xcrun simctl install "$SIM" "build/derived-sim/Build/Products/Release-iphonesimulator/Keeps.app"
else
  xcodebuild -project Keeps.xcodeproj -scheme Keeps -configuration Release -destination "id=$DEVICE" \
    -derivedDataPath build/derived -allowProvisioningUpdates -quiet PRODUCT_BUNDLE_IDENTIFIER="$APP_ID" "${SETTINGS[@]}" ${SIGN[@]+"${SIGN[@]}"} build
  xcrun devicectl device install app --device "$DEVICE" "build/derived/Build/Products/Release-iphoneos/Keeps.app" | tail -2
fi
EOF

[ "${1:-}" = "--no-run" ] && exit 0
if [ -n "$SIM" ]; then
  # The simulator passes SIMCTL_CHILD_* variables to the app, without the prefix.
  RUN_ENV=""
  [ -n "${KEEPS_SELFTEST:-}" ] && RUN_ENV="SIMCTL_CHILD_KEEPS_SELFTEST=1 SIMCTL_CHILD_KEEPS_SELFTEST_GAMES=${KEEPS_SELFTEST_GAMES:-hard:1,easy:1}"
  [ -n "${KEEPS_PLAY:-}" ] && RUN_ENV="SIMCTL_CHILD_KEEPS_PLAY=$KEEPS_PLAY"
  ssh "$MAC" "$RUN_ENV xcrun simctl launch --console-pty --terminate-running-process $(printf %q "$SIM") $APP_ID" 2>&1 | sed -u 's/\r$//; /^DONE$/q'
  exit 0
fi
if [ -n "${KEEPS_SELFTEST:-}" ]; then
  ENV="{\"KEEPS_SELFTEST\": \"1\", \"KEEPS_SELFTEST_GAMES\": \"${KEEPS_SELFTEST_GAMES:-hard:1,easy:1}\"}"
else
  ENV='{}'
fi
# (The JSON reaches the Mac's shell in single quotes.)
ssh "$MAC" "xcrun devicectl device process launch --device $DEVICE --console --terminate-existing \
  --environment-variables '$ENV' $APP_ID" 2>&1 | sed -u 's/\r$//; /^DONE$/q'
