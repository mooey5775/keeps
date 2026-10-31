#!/usr/bin/env bash
# One-time setup on the Mac: a keychain of its own for building the app, so builds over ssh can sign without the
# login keychain (which every ssh session would need unlocked, with your password). It holds a copy of your Apple
# Development identity and is unlocked by a password of its own, made here and kept in ~/.keeps-build-keychain
# (readable by you only); ios/sync.sh unlocks it before each build.
#
# Run it yourself, in a terminal (it asks for your login password, to export the identity):
#   ssh -t edwardli@100.90.147.75 bash src/keeps/ios/tools/setup-build-keychain.sh
# macOS usually won't export the identity over ssh ("User interaction is not allowed"): export it from Keychain
# Access on the Mac instead (My Certificates, the "Apple Development" certificate, File > Export Items, as .p12,
# with a password of your choice) and give the file:
#   ssh -t edwardli@100.90.147.75 bash src/keeps/ios/tools/setup-build-keychain.sh ~/Desktop/Certificates.p12
set -euo pipefail
umask 077
NAME=keeps-build.keychain
PASSFILE=$HOME/.keeps-build-keychain
# The keychain's password: the one already kept, if a keychain was made with it, else a new one (kept below, once
# the keychain exists).
if [ -f "$PASSFILE" ]; then PASS=$(cat "$PASSFILE"); else PASS=$(openssl rand -base64 24); fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ $# -ge 1 ]; then
  P12=$1
  read -r -s -p "The .p12 file's password: " P12PASS
  echo
else
  echo "Unlocking your login keychain, to export your Apple Development identity:"
  security unlock-keychain login.keychain
  P12=$TMP/identity.p12
  P12PASS=$(openssl rand -base64 18)
  security export -k login.keychain -t identities -f pkcs12 -P "$P12PASS" -o "$P12"
fi

if [ ! -f "$HOME/Library/Keychains/$NAME-db" ]; then
  security create-keychain -p "$PASS" "$NAME"
fi
echo "$PASS" > "$PASSFILE"
security set-keychain-settings "$NAME"  # no lock after a timeout
security unlock-keychain -p "$PASS" "$NAME"
security import "$P12" -k "$NAME" -P "$P12PASS" -T /usr/bin/codesign -T /usr/bin/security
# Lets codesign use the key without asking (there is no one to ask over ssh).
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASS" "$NAME" >/dev/null
# Searched first, before the login keychain.
others=$(security list-keychains -d user | tr -d '"' | grep -v "$NAME" || true)
# shellcheck disable=SC2086
security list-keychains -d user -s "$NAME" $others
echo
security find-identity -v -p codesigning "$NAME"
echo "Done: builds can sign with $NAME."
