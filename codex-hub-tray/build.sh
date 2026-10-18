#!/usr/bin/env bash
# Builds the tray app for each system a hub hands it out for, the same bytes every time from the same source, Go,
# addresses and keys: anyone can build a commit again and compare the SHA-256 of what a PC runs with theirs. The
# addresses and keys are the operator's own, given at build time:
#
#   HUB_URL       the hub the PCs push to: the address of its /api/codex-hub/ forward (https://hub.example.test)
#   PAIR_URL      the pairing page as the browser reaches it behind the operator's sign-in
#                 (https://inbox.example.test/codex-hub/pair); without it a PC takes its token from its tray.json
#   INBOX_URL     the page the menu's "Open the inbox" opens; without it the item is hidden
#   UPDATE_KEY    the public key the hub's builds are signed with (bun ../scripts/codex-hub-sign.ts pubkey <key file>),
#                 or two, comma-separated, while moving to a new key; without one the tray takes builds only from an
#                 https hub
#   OLD_HUB_URLS  the hubs earlier builds were made with, comma-separated, once the hub has moved
#   BUNDLE_ID     macOS only: the app's identifier, which also names its LaunchAgent (com.example.codex-hub-tray)
#   TARGETS       what to build: windows-x64 linux-x64 linux-arm64 (the default), and macos on a Mac
#   OUT           where (dist, which git ignores: a build holds the operator's addresses)
#
#   HUB_URL=https://hub.example.test PAIR_URL=https://inbox.example.test/codex-hub/pair \
#     INBOX_URL=https://inbox.example.test UPDATE_KEY=$(bun ../scripts/codex-hub-sign.ts pubkey ~/codex-hub/update.key) \
#     ./build.sh
#
# It writes codex-hub-tray.exe, codex-hub-tray-linux-x64 and codex-hub-tray-linux-arm64, the names the hub serves
# them under from <config dir>/codex-hub/.pusher/, and SHA256SUMS. "macos" runs build-macos.sh, which needs cgo and
# the Xcode command line tools, so it builds on a Mac only; its two hub builds go into SHA256SUMS too.
#
# Two builds are the same because nothing of the machine goes in: -trimpath leaves out this checkout's folder,
# -buildvcs=false the commit and whether the tree had changes, -buildid= the build id; cgo is off for these targets,
# GOFLAGS, GOAMD64 and GOARM64 from the environment are not used, and the Go is the one go.mod's toolchain line
# names (GOTOOLCHAIN, which the go command downloads when it is not the one installed). The signatures are made
# after this, beside each build (bun ../scripts/codex-hub-sign.ts sign <key file> dist/...), and change nothing in it.
set -euo pipefail
cd "$(dirname "$0")"

OUT=${OUT:-dist}
if [ -z "${TARGETS:-}" ]; then
	TARGETS="windows-x64 linux-x64 linux-arm64"
	[ "$(uname -s)" != Darwin ] || TARGETS="$TARGETS macos"
fi

fail() {
	echo "build.sh: $*" >&2
	exit 1
}

# One Go for every build: the toolchain line of go.mod.
GOTOOLCHAIN=$(sed -n 's/^toolchain //p' go.mod)
[ -n "$GOTOOLCHAIN" ] || fail "go.mod has no toolchain line, so the Go this builds with is not pinned"
export GOTOOLCHAIN
unset GOFLAGS GOAMD64 GOARM64 GOEXPERIMENT
export GOFLAGS=-mod=readonly

# Each value goes into -ldflags, which splits at spaces.
for name in HUB_URL PAIR_URL INBOX_URL UPDATE_KEY OLD_HUB_URLS BUNDLE_ID; do
	case "${!name:-}" in
	*[[:space:]]*) fail "$name has a space in it" ;;
	esac
done
for name in HUB_URL PAIR_URL INBOX_URL; do
	case "${!name:-}" in
	"" | http://* | https://*) ;;
	*) fail "$name is not an http:// or https:// address" ;;
	esac
done
# A key is base64 of 32 bytes: 43 characters and "=". A list with one entry that is not a key is refused here, as the
# tray would refuse it, taking no builds at all.
if [ -n "${UPDATE_KEY:-}" ]; then
	case "$UPDATE_KEY" in
	,* | *, | *,,*) fail "UPDATE_KEY has an empty entry between its commas" ;;
	esac
	IFS=, read -r -a keys <<<"$UPDATE_KEY"
	for key in "${keys[@]}"; do
		[[ $key =~ ^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]] ||
			fail "UPDATE_KEY: \"$key\" is not a public key (base64 of 32 bytes, as codex-hub-sign.ts pubkey prints it)"
	done
fi
[ -n "${HUB_URL:-}" ] || echo "warning: HUB_URL is empty; each PC then needs the hub's address in its tray.json" >&2
[ -n "${PAIR_URL:-}" ] || echo "warning: PAIR_URL is empty; Connect this PC then has no page to open" >&2
case "${PAIR_URL:-}" in
http://*) echo "warning: PAIR_URL is not https; the pairing page hands out the hub token" >&2 ;;
esac
case "${UPDATE_KEY:-}:${HUB_URL:-}" in
:https://*) ;;
:*) echo "warning: UPDATE_KEY is empty; the tray then takes no builds from a hub that is not https" >&2 ;;
esac

FLAGS="-s -w -buildid= -X main.hubURL=${HUB_URL:-} -X main.pairURL=${PAIR_URL:-} -X main.inboxURL=${INBOX_URL:-}"
FLAGS="$FLAGS -X main.updateKey=${UPDATE_KEY:-} -X main.oldHubURLs=${OLD_HUB_URLS:-}"
[ -z "${BUNDLE_ID:-}" ] || FLAGS="$FLAGS -X main.bundleID=$BUNDLE_ID"

mkdir -p "$OUT"
built=()
for target in $TARGETS; do
	case "$target" in
	windows-x64) goos=windows goarch=amd64 file=codex-hub-tray.exe extra=-H=windowsgui ;;
	linux-x64) goos=linux goarch=amd64 file=codex-hub-tray-linux-x64 extra= ;;
	linux-arm64) goos=linux goarch=arm64 file=codex-hub-tray-linux-arm64 extra= ;;
	macos)
		[ "$(uname -s)" = Darwin ] || fail "macos builds on a Mac only: the menu bar code needs cgo and Cocoa"
		OUT=$OUT ./build-macos.sh
		built+=(codex-hub-tray-darwin-arm64 codex-hub-tray-darwin-x64)
		continue
		;;
	*) fail "unknown target $target (windows-x64, linux-x64, linux-arm64, macos)" ;;
	esac
	echo "building $target"
	CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -buildvcs=false -ldflags "$FLAGS $extra" -o "$OUT/$file" .
	built+=("$file")
done

if command -v sha256sum >/dev/null; then sum() { sha256sum "$@"; }; else sum() { shasum -a 256 "$@"; }; fi
(cd "$OUT" && sum "${built[@]}") >"$OUT/SHA256SUMS"
echo
echo "$(go version), from $(git rev-parse --short HEAD 2>/dev/null || echo "a tree outside git")"
cat "$OUT/SHA256SUMS"
