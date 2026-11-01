#!/usr/bin/env bash
# The app's core, built here (ios/build/core: the TypeScript bundled, and Midstrike's weights), with the app's own copies
# of the website's card pictures and fonts (ios/build/cards, ios/build/fonts). sync.sh and test.sh build it, so the app
# they put on the phone or test is always this tree's.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "${ROOT:?}"
WEIGHTS=packages/bot/weights/midstrike.bin
pnpm -s -C ios/core typecheck
pnpm -s -C ios/core build
cp "$WEIGHTS" ios/build/core/
rm -rf ios/build/cards ios/build/fonts
mkdir -p ios/build/fonts
cp -r packages/web/public/cards ios/build/cards
cp packages/web/src/assets/fonts/HamletOrNot.ttf ios/Fonts/*.ttf ios/build/fonts/
