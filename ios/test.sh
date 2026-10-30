#!/usr/bin/env bash
# The app's tests, from this machine: the generated Swift types checked against the TypeScript ones they come from,
# golden messages recorded from whole games on the core (ios/tools/swift-types/goldens.ts), and the Swift tests
# (ios/Tests) run on the Mac's iOS simulator with them.
#   ios/test.sh
#   GOLDENS_HOST=gpu03 ios/test.sh   the games recorded there (a copy of this tree in ~/src/keeps-work), not here
set -euo pipefail
MAC=${MAC:-edwardli@100.90.147.75}  # the Mac, on Tailscale (MAC=edwardli@10.16.19.95 on the local network)
SIMULATOR=${SIMULATOR:-iPhone 17}
SSH_OPTS=(-o ControlPath="$HOME/.ssh/keeps-mac-%C")
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
export RSYNC_RSH="ssh -o ControlPath=$HOME/.ssh/keeps-mac-%C"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "${ROOT:?}"

[ -d ios/tools/swift-types/node_modules ] || (cd ios/tools/swift-types && npm install --no-audit --no-fund --silent)
node ios/tools/swift-types/generate.ts --check
if [ -n "${GOLDENS_HOST:-}" ]; then
  command ssh "$GOLDENS_HOST" 'mkdir -p ~/src/keeps-work/ios/build ~/src/keeps-work/packages/learn/demo/weights'
  rsync -a --delete --exclude=.git --exclude=/bot --exclude=/ios/build --exclude='/packages/learn/demo/weights/*' --exclude=/packages/learn/demo/data \
    --exclude=/packages/web/dist ./ "$GOLDENS_HOST:src/keeps-work/"
  rsync -a ios/build/protocol-tags.json "$GOLDENS_HOST:src/keeps-work/ios/build/"
  rsync -a packages/learn/demo/weights/midstrike.bin "$GOLDENS_HOST:src/keeps-work/packages/learn/demo/weights/"
  command ssh "$GOLDENS_HOST" 'cd ~/src/keeps-work && PATH=$HOME/.local/node24/bin:$PATH node ios/tools/swift-types/goldens.ts ios/build/goldens'
  rsync -a --delete "$GOLDENS_HOST:src/keeps-work/ios/build/goldens" ios/build/
else
  node ios/tools/swift-types/goldens.ts ios/build/goldens
fi

ssh "$MAC" 'mkdir -p ~/src/keeps/ios/build'
rsync -a --delete ios/App ios/Shared ios/Spike ios/Tests ios/project.yml "$MAC:src/keeps/ios/"
rsync -a --delete ios/build/goldens "$MAC:src/keeps/ios/build/"
ssh "$MAC" bash -s -- "$(printf %q "$SIMULATOR")" <<'REMOTE'
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/src/keeps/ios
mkdir -p build/web build/core
xcodegen generate --quiet
xcodebuild -project Keeps.xcodeproj -scheme KeepsTests -destination "platform=iOS Simulator,name=$1" -derivedDataPath build/derived-tests test 2>&1 \
  | grep -E "Test Case .*(passed|failed)|error:|XCTAssert|Executed|\*\* TEST" | sed 's/^.*Test Case/Test Case/'
REMOTE
