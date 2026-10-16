#!/usr/bin/env bash
# Builds the macOS tray app. It runs on a Mac with the Xcode command line tools (xcode-select --install) and Go,
# because the menu bar code is Objective-C (cgo and Cocoa). It makes, in OUT (default dist):
#
#   Codex Hub.app                   arm64 and x86_64 in one program, ad-hoc signed: what a Mac installs from
#   codex-hub-tray-macos.zip        that app, to hand out (opened once, it installs itself)
#   codex-hub-tray-darwin-arm64     the builds the hub serves for updates, put in <config>/codex-hub/.pusher/
#   codex-hub-tray-darwin-x64
#
# The addresses come from HUB_URL, PAIR_URL and INBOX_URL, and the bundle identifier, which also names the
# LaunchAgent, from BUNDLE_ID (default com.example.codex-hub-tray):
#
#   HUB_URL=http://hub:18788 PAIR_URL=https://inbox.example/codex-hub/pair INBOX_URL=https://inbox.example \
#     ./build-macos.sh
#
# Without a paid Apple Developer account the app is not notarized: the first open of the downloaded app needs
# System Settings > Privacy & Security > Open Anyway. The copy it installs in ~/Applications does not.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(uname -s)" != Darwin ]; then
	echo "build-macos.sh runs on macOS: the menu bar code needs cgo and Cocoa." >&2
	exit 1
fi
for tool in go clang lipo codesign ditto plutil; do
	if ! command -v "$tool" >/dev/null; then
		echo "$tool is missing: install the Xcode command line tools (xcode-select --install) and Go." >&2
		exit 1
	fi
done

BUNDLE_ID=${BUNDLE_ID:-com.example.codex-hub-tray}
OUT=${OUT:-dist}
# Go supports macOS 11 and later; without this the C side would require the macOS this build runs on.
export MACOSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-11.0}
LDFLAGS="-s -w -X main.hubURL=${HUB_URL:-} -X main.pairURL=${PAIR_URL:-} -X main.inboxURL=${INBOX_URL:-} -X main.bundleID=$BUNDLE_ID"
[ -n "${HUB_URL:-}" ] || echo "warning: HUB_URL is empty; each Mac then needs the hub address in its tray.json" >&2

mkdir -p "$OUT"
for arch in arm64 amd64; do
	name=$arch
	[ "$arch" = amd64 ] && name=x64
	echo "building darwin/$arch"
	CGO_ENABLED=1 GOOS=darwin GOARCH=$arch go build -trimpath -ldflags "$LDFLAGS" -o "$OUT/codex-hub-tray-darwin-$name" .
done

# The build prints its own Info.plist, the one it also writes when it installs the app. It is made outside the
# bundle: the first run of a newly signed program, writing into its own bundle's Info.plist, leaves that file empty.
host=arm64
[ "$(uname -m)" = x86_64 ] && host=x64
"$OUT/codex-hub-tray-darwin-$host" --info-plist >"$OUT/Info.plist"
plutil -lint "$OUT/Info.plist" >/dev/null

APP="$OUT/Codex Hub.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
BIN="$APP/Contents/MacOS/codex-hub-tray"
lipo -create -output "$BIN" "$OUT/codex-hub-tray-darwin-arm64" "$OUT/codex-hub-tray-darwin-x64"
chmod 755 "$BIN"
codesign --force --sign - --identifier "$BUNDLE_ID" "$BIN"
mv "$OUT/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
codesign --verify --strict "$APP"

# The hub's builds replace the program inside an installed app, so they carry the same identifier.
for name in arm64 x64; do
	codesign --force --sign - --identifier "$BUNDLE_ID" "$OUT/codex-hub-tray-darwin-$name"
done

rm -f "$OUT/codex-hub-tray-macos.zip"
ditto -c -k --keepParent "$APP" "$OUT/codex-hub-tray-macos.zip"

echo
echo "$APP: $(lipo -archs "$BIN")"
echo "$OUT/codex-hub-tray-macos.zip"
for name in arm64 x64; do
	f="$OUT/codex-hub-tray-darwin-$name"
	echo "$f: $(shasum -a 256 "$f" | cut -d' ' -f1) $(stat -f %z "$f") bytes"
done
