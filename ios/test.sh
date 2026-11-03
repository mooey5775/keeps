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
# The simulator's iOS, fixed: installing a newer one (for a new device) mustn't change what the tests run on.
SIMULATOR_OS=${SIMULATOR_OS:-27.0}
# (A connection that's gone, the Mac asleep or off the network, is given up on within a minute, not waited on.)
ALIVE=(-o ServerAliveInterval=15 -o ServerAliveCountMax=4)
SSH_OPTS=(-o ControlPath="$HOME/.ssh/keeps-mac-%C" "${ALIVE[@]}")
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
export RSYNC_RSH="ssh -o ControlPath=$HOME/.ssh/keeps-mac-%C"

[ -d ios/tools/swift-types/node_modules ] || (cd ios/tools/swift-types && npm install --no-audit --no-fund --silent)
node ios/tools/swift-types/generate.ts --check
# The goldens, recorded again only when what they're made from has changed (the TypeScript, the network, the types'
# tags): they take a minute.
phase() { echo "[$(( SECONDS / 60 ))m$(( SECONDS % 60 ))s] $*"; }
inputs=$( (find packages/*/src ios/core -name '*.ts' -not -path '*/node_modules/*' | sort | xargs cat; \
  cat ios/tools/swift-types/goldens.ts ios/build/protocol-tags.json packages/bot/weights/midstrike.bin) | sha256sum | cut -c1-16)
if [ -f ios/build/goldens/inputs ] && [ "$(cat ios/build/goldens/inputs)" = "$inputs" ]; then
  phase "goldens: unchanged, kept"
elif [ -n "${GOLDENS_HOST:-}" ]; then
  phase "goldens: recording on $GOLDENS_HOST"
  command ssh "$GOLDENS_HOST" 'mkdir -p ~/src/keeps-work/ios/build'
  rsync -a --delete --exclude=.git --exclude=/training --exclude=/ios/build --exclude=/packages/learn/weights \
    --exclude=/packages/web/dist ./ "$GOLDENS_HOST:src/keeps-work/"
  rsync -a ios/build/protocol-tags.json "$GOLDENS_HOST:src/keeps-work/ios/build/"
  command ssh "$GOLDENS_HOST" 'cd ~/src/keeps-work && PATH=$HOME/.local/node24/bin:$PATH node ios/tools/swift-types/goldens.ts ios/build/goldens'
  rsync -a --delete "$GOLDENS_HOST:src/keeps-work/ios/build/goldens" ios/build/
  echo "$inputs" > ios/build/goldens/inputs
else
  phase "goldens: recording here"
  node ios/tools/swift-types/goldens.ts ios/build/goldens
  echo "$inputs" > ios/build/goldens/inputs
fi

phase "the core: building"
ios/tools/build-core.sh > /dev/null
# The website's server for the online UI tests, here, its port forwarded to the Mac's (where the simulator finds it).
node ios/tools/test-server.ts 7777 > ios/build/test-server.log 2>&1 &
TEST_SERVER=$!
trap 'kill $TEST_SERVER 2>/dev/null' EXIT
for _ in $(seq 50); do grep -q ready ios/build/test-server.log && break; sleep 0.2; done
grep -q ready ios/build/test-server.log || { cat ios/build/test-server.log; exit 1; }
ssh "$MAC" 'mkdir -p ~/src/keeps/ios/build'
phase "the Mac: building and testing"
rsync -a --delete ios/App ios/Shared ios/Tests ios/UITests ios/project.yml "$MAC:src/keeps/ios/"
rsync -a --delete ios/build/goldens ios/build/core ios/build/cards ios/build/fonts ios/build/licenses "$MAC:src/keeps/ios/build/"
# (ONLY names a test without its target: the UI tests' are in KeepsUITests, the rest in KeepsTests.)
ONLY_TESTING=""
if [ -n "${ONLY:-}" ]; then
  case "$ONLY" in *UITests*) ONLY_TESTING="-only-testing:KeepsUITests/$ONLY" ;; *) ONLY_TESTING="-only-testing:KeepsTests/$ONLY" ;; esac
fi
command ssh -o ControlPath=none "${ALIVE[@]}" -o ExitOnForwardFailure=yes -R 7777:localhost:7777 "$MAC" bash -s -- "$(printf %q "$SIMULATOR")" "$SIMULATOR_OS" "$ONLY_TESTING" <<'REMOTE'
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/src/keeps/ios
mkdir -p build/core
xcodegen generate --quiet
xcodebuild -project Keeps.xcodeproj -scheme KeepsTests -destination "platform=iOS Simulator,name=$1,OS=$2" -derivedDataPath build/derived-tests \
  -parallel-testing-enabled YES -parallel-testing-worker-count 3 ${3:+"$3"} test 2>&1 \
  | grep -iE "Test Case .*(passed|failed)|error:|XCTAssert|Executed|\*\* TEST" | sed -E 's/^.*Test [Cc]ase/Test case/'
REMOTE
phase "done"
