#!/usr/bin/env bash
# The app's core, built here (ios/build/core: the TypeScript bundled, and Midstrike's weights), with the app's own copies
# of the website's card pictures and fonts (ios/build/cards, ios/build/fonts) and the licences of what it ships that
# isn't ours (ios/build/licenses, shown in Settings). sync.sh and test.sh build it, so the app they put on the phone or
# test is always this tree's.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "${ROOT:?}"
WEIGHTS=packages/bot/weights/midstrike.bin
pnpm -s -C ios/core typecheck
pnpm -s -C ios/core build
# Everything in the core is ours: a package from npm in it would need its licence in the app's Licenses
# (ios/App/LicensesView.swift) first. The source maps say what went in.
OTHERS=$(grep -ho '"[^"]*node_modules/[^"]*"' ios/build/core/*.map ios/build/core/assets/*.map 2>/dev/null | grep -v '/@keeps/' | sort -u || true)
if [ -n "$OTHERS" ]; then
  echo "the core bundles code that isn't ours; add its licence to the app's Licenses, then to this check:" >&2
  echo "$OTHERS" >&2
  exit 1
fi
cp "$WEIGHTS" ios/build/core/
rm -rf ios/build/cards ios/build/fonts ios/build/licenses
mkdir -p ios/build/fonts ios/build/licenses
cp -r packages/web/public/cards ios/build/cards
cp packages/web/src/assets/fonts/HamletOrNot.ttf ios/Fonts/*.ttf ios/build/fonts/
cp packages/web/src/assets/fonts/HamletOrNot-LICENSE.txt ios/Fonts/LibreBaskerville-OFL.txt ios/build/licenses/
