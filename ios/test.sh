#!/usr/bin/env bash
# The app's tests, from this machine: the generated Swift types checked against the TypeScript ones they come from,
# golden messages recorded from whole games on the core (ios/tools/swift-types/goldens.ts), and the Swift tests
# (ios/Tests) run on the Mac's iOS simulator with them.
#   ios/test.sh
#   GOLDENS_HOST=gpu03 ios/test.sh   the games recorded there (a copy of this tree in ~/src/keeps-work), not here
#   ONLY=TableUITests/testAGameOfFourShowsEveryPlayer ios/test.sh   one test (or class) only: KeepsTests/… or KeepsUITests/…
# The app tested is this tree's: its core is built here too (ios/tools/build-core.sh), not whatever sync.sh last sent.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "${ROOT:?}"
[ -f ios/local.env ] && . ios/local.env
MAC=${MAC:?the Mac to test on (user@host): set it in ios/local.env (see ios/README.md)}
SIMULATOR=${SIMULATOR:-iPhone 17}
SSH_OPTS=(-o ControlPath="$HOME/.ssh/keeps-mac-%C")
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
export RSYNC_RSH="ssh -o ControlPath=$HOME/.ssh/keeps-mac-%C"

[ -d ios/tools/swift-types/node_modules ] || (cd ios/tools/swift-types && npm install --no-audit --no-fund --silent)
node ios/tools/swift-types/generate.ts --check
if [ -n "${GOLDENS_HOST:-}" ]; then
  command ssh "$GOLDENS_HOST" 'mkdir -p ~/src/keeps-work/ios/build'
  rsync -a --delete --exclude=.git --exclude=/training --exclude=/ios/build --exclude=/packages/learn/weights \
    --exclude=/packages/web/dist ./ "$GOLDENS_HOST:src/keeps-work/"
  rsync -a ios/build/protocol-tags.json "$GOLDENS_HOST:src/keeps-work/ios/build/"
  command ssh "$GOLDENS_HOST" 'cd ~/src/keeps-work && PATH=$HOME/.local/node24/bin:$PATH node ios/tools/swift-types/goldens.ts ios/build/goldens'
  rsync -a --delete "$GOLDENS_HOST:src/keeps-work/ios/build/goldens" ios/build/
else
  node ios/tools/swift-types/goldens.ts ios/build/goldens
fi

ios/tools/build-core.sh > /dev/null
# The website's server for the online UI tests, here, its port forwarded to the Mac's (where the simulator finds it).
node ios/tools/test-server.ts 7777 > ios/build/test-server.log 2>&1 &
TEST_SERVER=$!
trap 'kill $TEST_SERVER 2>/dev/null' EXIT
for _ in $(seq 50); do grep -q ready ios/build/test-server.log && break; sleep 0.2; done
grep -q ready ios/build/test-server.log || { cat ios/build/test-server.log; exit 1; }
ssh "$MAC" 'mkdir -p ~/src/keeps/ios/build'
rsync -a --delete ios/App ios/Shared ios/Tests ios/UITests ios/project.yml "$MAC:src/keeps/ios/"
rsync -a --delete ios/build/goldens ios/build/core ios/build/cards ios/build/fonts "$MAC:src/keeps/ios/build/"
# (ONLY names a test without its target: the UI tests' are in KeepsUITests, the rest in KeepsTests.)
ONLY_TESTING=""
if [ -n "${ONLY:-}" ]; then
  case "$ONLY" in TableUITests*) ONLY_TESTING="-only-testing:KeepsUITests/$ONLY" ;; *) ONLY_TESTING="-only-testing:KeepsTests/$ONLY" ;; esac
fi
command ssh -o ControlPath=none -o ExitOnForwardFailure=yes -R 7777:localhost:7777 "$MAC" bash -s -- "$(printf %q "$SIMULATOR")" "$ONLY_TESTING" <<'REMOTE'
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/src/keeps/ios
mkdir -p build/core
xcodegen generate --quiet
xcodebuild -project Keeps.xcodeproj -scheme KeepsTests -destination "platform=iOS Simulator,name=$1" -derivedDataPath build/derived-tests ${2:+"$2"} test 2>&1 \
  | grep -E "Test Case .*(passed|failed)|error:|XCTAssert|Executed|\*\* TEST" | sed 's/^.*Test Case/Test Case/'
REMOTE
