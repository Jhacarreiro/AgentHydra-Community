#!/usr/bin/env bash
# End-to-end smoke test of the tray app on macOS. Run it from Terminal in a logged-in desktop session (the app puts
# an icon in the menu bar while it runs) on a Mac with the Xcode command line tools and Go:
#
#   ./test-macos.sh          (KEEP=1 keeps the scratch folder)
#
# It builds the app with build-macos.sh, then runs it against a fake hub (testdata/fakehub) serving a fake pusher
# script, signed with a key made for the run (testdata/signbuild), with HOME set to a scratch folder, so the real ~/Applications, ~/Library and LaunchAgents are never
# touched. launchctl, open and osascript are stand-ins that record what they were asked (the launchctl one starts
# the program a bootstrapped LaunchAgent names, as launchd would), so nothing is loaded into the real launchd and
# no browser, dialog or notification opens. With CODEX_HUB_E2E_LAUNCHCTL=1 it also loads a copy of the LaunchAgent
# (its own label, HOME pointed at the scratch folder) into the real gui/<uid> domain to check that launchd restarts
# a crashed tray and leaves a quit one alone, and unloads it again.
#
# Each check prints PASS or FAIL; INFO lines are for reading. The script exits non-zero if any check failed.
set -u
cd "$(dirname "$0")" || exit 1

[ "$(uname -s)" = Darwin ] || { echo "FAIL: test-macos.sh runs on macOS"; exit 1; }
for tool in go clang curl plutil codesign perl; do
	command -v "$tool" >/dev/null || { echo "FAIL: $tool is not installed"; exit 1; }
done
PB=/usr/libexec/PlistBuddy
case "$(uname -m)" in
arm64) P=darwin-arm64 ;;
x86_64) P=darwin-x64 ;;
*) echo "FAIL: no hub platform for $(uname -m)"; exit 1 ;;
esac

# Go keeps its caches where it had them; everything else gets the scratch HOME.
GOPATH=$(go env GOPATH) GOMODCACHE=$(go env GOMODCACHE) GOCACHE=$(go env GOCACHE)
export GOPATH GOMODCACHE GOCACHE
REAL_PATH=$PATH
T=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/codex-hub-tray-e2e.XXXXXX")" && pwd -P)
export HOME="$T/home"
unset AGENTHYDRA_CODEX_HUB_TOKEN
mkdir -p "$HOME" "$T/bin" "$T/fake" "$T/hub"
ID=com.example.codex-hub-tray.e2e
UIDN=$(id -u)
APPS="$HOME/Applications"
BUNDLE="$APPS/Codex Hub.app"
TRAY="$BUNDLE/Contents/MacOS/codex-hub-tray"
APP="$HOME/Library/Application Support/codex-hub"
PUSH="$APP/codex-hub-push"
LOG="$APP/tray.log"
AGENT="$HOME/Library/LaunchAgents/$ID.plist"
TOKEN="e2e-Token_0123456789abcdef"
# The hub sits behind an access proxy that wants a header of its own on every request, the tray's included.
ACCESS="X-Hub-Access: e2e-access"
export AGENTHYDRA_CODEX_HUB_HEADERS='{"X-Hub-Access":"e2e-access"}'

failures=0
pass() { echo "PASS: $*"; }
fail() {
	echo "FAIL: $*"
	failures=$((failures + 1))
}
info() { echo "INFO: $*"; }
check() { # check "what" command...
	local what=$1
	shift
	if "$@"; then pass "$what"; else fail "$what"; fi
}
# wait_for SECONDS command...: true once the command succeeds within the time.
wait_for() {
	local end=$((SECONDS + $1))
	shift
	while [ $SECONDS -lt $end ]; do
		"$@" && return 0
		sleep 0.2
	done
	"$@"
}
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null && ! ps -o stat= -p "$1" 2>/dev/null | grep -q Z; }
dead() { ! alive "$1"; }
comm() { ps -o comm= -p "$1" 2>/dev/null; }
runs() { [ "$(comm "$1")" = "$2" ]; } # runs PID PATH: started as PATH
sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }
has_sha() { [ "$(sha "$1")" = "$2" ]; }
mode() { stat -f %Lp "$1"; }
tray_pid() { # the pid the running tray wrote into its lock, if that process is the installed tray
	local pid
	pid=$(tr -dc 0-9 2>/dev/null <"$APP/tray.lock")
	[ -n "$pid" ] && runs "$pid" "$TRAY" && echo "$pid"
}
has_tray() { [ -n "$(tray_pid)" ]; }
pusher_pid() { tr -dc 0-9 2>/dev/null <"$APP/pusher.pid"; }
has_pusher() { alive "$(pusher_pid)"; }
new_pusher() { # new_pusher OLD: a pusher runs that is not OLD
	local p
	p=$(pusher_pid)
	[ -n "$p" ] && [ "$p" != "$1" ] && alive "$p"
}
log_has() { grep -q -- "$1" "$LOG" 2>/dev/null; }
log_count() { grep -c -- "$1" "$LOG" 2>/dev/null || true; }
# locked: someone holds the tray's lock (an flock, as the tray takes it).
locked() { ! perl -e 'use Fcntl ":flock"; open(F, "<", $ARGV[0]) or exit 0; exit(flock(F, LOCK_EX | LOCK_NB) ? 0 : 1)' "$APP/tray.lock"; }
plist_get() { "$PB" -c "Print :$2" "$1" 2>/dev/null; } # plist_get FILE KEY:PATH

BG=()
cleanup() {
	disown -a 2>/dev/null
	if [ -n "${CODEX_HUB_E2E_LAUNCHCTL:-}" ]; then /bin/launchctl bootout "gui/$UIDN/$ID" 2>/dev/null; fi
	for p in $(pgrep -f "$TRAY" 2>/dev/null) $(pgrep -f "$PUSH" 2>/dev/null) "${BG[@]}"; do kill -9 "$p" 2>/dev/null; done
	if [ -n "${KEEP:-}" ]; then echo "kept $T"; else rm -rf "$T"; fi
}
trap cleanup EXIT

# Stand-ins for launchctl, open and osascript, first on PATH for everything the tray starts.
cat >"$T/fake/launchctl" <<EOF
#!/bin/sh
echo "launchctl \$*" >>"$T/launchctl.log"
if [ "\$1" = bootstrap ]; then
	prog=\$($PB -c "Print :ProgramArguments:0" "\$3") || exit 5
	nohup "\$prog" >/dev/null 2>&1 &
fi
exit 0
EOF
cat >"$T/fake/open" <<EOF
#!/bin/sh
echo "open \$*" >>"$T/open.log"
EOF
cat >"$T/fake/osascript" <<EOF
#!/bin/sh
echo "osascript \$*" >>"$T/osascript.log"
EOF
chmod 755 "$T/fake/"*
export PATH="$T/fake:$REAL_PATH"

# The hub, and the app built as it would be for the operator, with the key the hub's builds are signed with.
go build -o "$T/bin/fakehub" ./testdata/fakehub || exit 1
go build -o "$T/bin/signbuild" ./testdata/signbuild || exit 1
KEY=$("$T/bin/signbuild" keygen "$T/update.key") || exit 1
"$T/bin/signbuild" keygen "$T/other.key" >/dev/null || exit 1
# publish SRC NAME [KEY]: puts SRC on the hub as NAME, signed with KEY (the operator's by default); the .sig goes in
# first and each file by a rename, so the hub never serves half a file.
publish() {
	mkdir -p "$T/stage"
	cp "$1" "$T/stage/$2" && "$T/bin/signbuild" sign "${3:-$T/update.key}" "$T/stage/$2" || return 1
	mv "$T/stage/$2.sig" "$T/hub/$2.sig" && mv "$T/stage/$2" "$T/hub/$2"
}
"$T/bin/fakehub" -dir "$T/hub" -token "$TOKEN" -header "$ACCESS" -addr-file "$T/hub.addr" >"$T/hub.log" 2>&1 &
BG+=($!)
wait_for 10 test -s "$T/hub.addr" || { echo "FAIL: the fake hub did not start"; exit 1; }
HUB=$(cat "$T/hub.addr")
echo "== unit tests"
check "go test ./... passes" go test -count=1 ./...
echo "== build"
if HUB_URL=$HUB PAIR_URL=https://inbox.example.test/codex-hub/pair INBOX_URL=https://inbox.example.test BUNDLE_ID=$ID \
	UPDATE_KEY=$KEY OUT="$T/dist" ./build-macos.sh >"$T/build.log" 2>&1; then
	pass "build-macos.sh builds the app"
else
	fail "build-macos.sh builds the app"
	cat "$T/build.log"
	exit 1
fi
DIST="$T/dist/Codex Hub.app"
check "the app's program has both architectures" bash -c "lipo -archs '$DIST/Contents/MacOS/codex-hub-tray' | grep -q arm64 && lipo -archs '$DIST/Contents/MacOS/codex-hub-tray' | grep -q x86_64"
check "the hub builds are single-architecture" bash -c "[ \"\$(lipo -archs '$T/dist/codex-hub-tray-darwin-arm64')\" = arm64 ] && [ \"\$(lipo -archs '$T/dist/codex-hub-tray-darwin-x64')\" = x86_64 ]"
check "the zip holds the app" bash -c "unzip -l '$T/dist/codex-hub-tray-macos.zip' | grep -q 'Codex Hub.app/Contents/MacOS/codex-hub-tray'"
check "Info.plist is valid" plutil -lint "$DIST/Contents/Info.plist"
check "Info.plist has the bundle id" test "$(plist_get "$DIST/Contents/Info.plist" CFBundleIdentifier)" = "$ID"
check "Info.plist hides the Dock icon (LSUIElement)" test "$(plist_get "$DIST/Contents/Info.plist" LSUIElement)" = true
check "the app is signed (ad hoc)" codesign --verify --strict "$DIST"
check "the hub builds are signed" codesign --verify "$T/dist/codex-hub-tray-darwin-arm64" "$T/dist/codex-hub-tray-darwin-x64"
check "--version prints the banner" test "$("$DIST/Contents/MacOS/codex-hub-tray" --version)" = codex-hub-tray
# A second build that differs, so the hub can hand out an update.
CGO_ENABLED=1 go build -trimpath -ldflags "-s -w -X main.hubURL=$HUB -X main.bundleID=$ID -X main.inboxURL=https://next.example.test -X main.updateKey=$KEY" \
	-o "$T/next" . || exit 1
codesign --force --sign - --identifier "$ID" "$T/next"
V2=$(sha "$T/next")
cat >"$T/push-good" <<'EOF'
#!/bin/bash
if [ "$1" = --version ]; then echo codex-hub-push; exit 0; fi
env | grep '^AGENTHYDRA_CODEX_HUB_' >pusher-env
# Keeps the pusher's path as its name, as a real (compiled) pusher has.
exec -a "$0" /bin/sleep 86400
EOF
publish "$T/push-good" "codex-hub-push-$P" || exit 1
PUSHSUM=$(sha "$T/hub/codex-hub-push-$P")

echo "== install"
"$DIST/Contents/MacOS/codex-hub-tray" >"$T/install.out" 2>&1
check "the installer exits 0" test $? -eq 0
check "it says what it did" grep -q "Installed Codex Hub at $BUNDLE" "$T/install.out"
check "the app is copied to ~/Applications" has_sha "$TRAY" "$(sha "$DIST/Contents/MacOS/codex-hub-tray")"
check "  ...with its Info.plist" has_sha "$BUNDLE/Contents/Info.plist" "$(sha "$DIST/Contents/Info.plist")"
check "  ...executable (755)" test "$(mode "$TRAY")" = 755
if codesign --verify --strict "$BUNDLE" 2>/dev/null; then info "the installed copy's signature verifies"; else info "the installed copy's signature does not verify"; fi
check "the LaunchAgent is valid" plutil -lint "$AGENT"
check "  ...Label is the bundle id" test "$(plist_get "$AGENT" Label)" = "$ID"
check "  ...it runs the installed program" test "$(plist_get "$AGENT" ProgramArguments:0)" = "$TRAY"
check "  ...RunAtLoad" test "$(plist_get "$AGENT" RunAtLoad)" = true
check "  ...KeepAlive unless it exits cleanly" test "$(plist_get "$AGENT" KeepAlive:SuccessfulExit)" = false
check "  ...in the desktop session (Aqua)" test "$(plist_get "$AGENT" LimitLoadToSessionType)" = Aqua
check "  ...ProcessType Interactive" test "$(plist_get "$AGENT" ProcessType)" = Interactive
check "the installer unloads an old LaunchAgent" grep -q "launchctl bootout gui/$UIDN/$ID" "$T/launchctl.log"
check "  ...and loads the new one" grep -q "launchctl bootstrap gui/$UIDN $AGENT" "$T/launchctl.log"
check "the first install says so in a dialog" grep -q "display dialog" "$T/osascript.log"
check "the installed copy is running" wait_for 15 has_tray
PID1=$(tray_pid)
check "  ...holding its lock" locked

echo "== pairing"
check "it opens the pairing page" wait_for 10 grep -q "open https://inbox.example.test/codex-hub/pair?" "$T/open.log"
LINK=$(grep -o 'https://inbox.example.test/codex-hub/pair?[^ ]*' "$T/open.log" | tail -1)
PORT=$(echo "$LINK" | grep -o 'port=[0-9]*' | cut -d= -f2)
STATE=$(echo "$LINK" | grep -o 'state=[0-9a-f]*' | cut -d= -f2)
code=$(curl -s -o /dev/null -w '%{http_code}' -d state=wrong -d "token=$TOKEN" "http://127.0.0.1:$PORT/paired")
check "a post with the wrong state is refused (400)" test "$code" = 400
code=$(curl -s -o /dev/null -w '%{http_code}' -d "state=$STATE" -d token=short "http://127.0.0.1:$PORT/paired")
check "a token the hub does not take is refused (401)" test "$code" = 401
code=$(curl -s -o "$T/shape.html" -w '%{http_code}' -d "state=$STATE" -d "token=two%0Alines" "http://127.0.0.1:$PORT/paired")
check "a token with a line break is refused (400)" test "$code" = 400
check "  ...saying so, not that the link is wrong" grep -q "shape this app cannot use" "$T/shape.html"
code=$(curl -s -o /dev/null -w '%{http_code}' -d "state=$STATE" -d "token=$TOKEN" "http://127.0.0.1:$PORT/paired")
check "the hub page's post is taken (200)" test "$code" = 200
check "the token is saved" grep -q "\"token\": \"$TOKEN\"" "$APP/tray.json"
check "the config is private (600)" test "$(mode "$APP/tray.json")" = 600

echo "== pusher"
check "the pusher is downloaded and started" wait_for 20 has_pusher
PUSH1=$(pusher_pid)
check "the pusher is the hub's build" has_sha "$PUSH" "$PUSHSUM"
check "the pusher is executable (755)" test "$(mode "$PUSH")" = 755
check "the pusher gets the hub" grep -qx "AGENTHYDRA_CODEX_HUB_URL=$HUB" "$APP/pusher-env"
check "  ...the token" grep -qx "AGENTHYDRA_CODEX_HUB_TOKEN=$TOKEN" "$APP/pusher-env"
check "  ...UPDATE=off" grep -qx "AGENTHYDRA_CODEX_HUB_UPDATE=off" "$APP/pusher-env"
check "  ...and the hub's extra headers" grep -qx "AGENTHYDRA_CODEX_HUB_HEADERS=$AGENTHYDRA_CODEX_HUB_HEADERS" "$APP/pusher-env"
check "the pusher leads a process group of its own" test "$(ps -o pgid= -p "$PUSH1" | tr -d ' ')" = "$PUSH1"
check "the hub was asked for platform=$P (pusher)" grep -q "GET /api/codex-hub/pusher platform=$P 200" "$T/hub.log"
check "the hub was asked for platform=$P (tray, none there: 404)" wait_for 10 grep -q "GET /api/codex-hub/tray platform=$P 404" "$T/hub.log"
check "the hub was never asked without a platform" bash -c "! grep -q 'platform= ' '$T/hub.log'"
check "the tray's own requests carry the hub's extra headers (no 403)" bash -c "! grep -q ' 403\$' '$T/hub.log'"

echo "== second instance"
start=$SECONDS
"$TRAY" >"$T/second.out" 2>&1 &
SECOND=$!
wait_for 60 dead "$SECOND"
took=$((SECONDS - start))
check "a second tray exits on the lock (after ${took}s)" test "$took" -ge 15 -a "$took" -lt 60
check "the first tray still runs" test "$(tray_pid)" = "$PID1"
check "  ...with its pusher" alive "$PUSH1"

echo "== reinstall over a running tray"
"$DIST/Contents/MacOS/codex-hub-tray" >"$T/reinstall.out" 2>&1
check "the installer stops the running tray" wait_for 15 dead "$PID1"
check "  ...and its pusher" wait_for 10 dead "$PUSH1"
check "the new copy runs" wait_for 30 has_tray
PID2=$(tray_pid)
check "  ...as a new process" test -n "$PID2" -a "$PID2" != "$PID1"
check "  ...with a pusher" wait_for 20 new_pusher "$PUSH1"
PUSH2=$(pusher_pid)
check "a reinstall shows no dialog again" test "$(grep -c 'display dialog' "$T/osascript.log")" -eq 1

echo "== self-update"
INFOSUM=$(sha "$BUNDLE/Contents/Info.plist")
FILES=$(cd "$BUNDLE" && find . | sort)
publish "$T/next" "codex-hub-tray-$P"
kill -USR1 "$PID2" # check the hub now
check "the new build is swapped in" wait_for 30 has_sha "$TRAY" "$V2"
check "the tray says so" wait_for 10 log_has "update: tray now ${V2:0:8}"
check "it restarts in place: the same pid runs the new file" \
	wait_for 20 bash -c "[ \$(grep -c 'tray: started, pid $PID2\$' '$LOG') -ge 2 ]"
check "  ...holding the lock" test "$(tray_pid)" = "$PID2"
check "  ...really" locked
check "the rest of the bundle is untouched" test "$(sha "$BUNDLE/Contents/Info.plist")" = "$INFOSUM" -a "$(cd "$BUNDLE" && find . | sort)" = "$FILES"
check "the old pusher was stopped" wait_for 10 dead "$PUSH2"
check "a pusher runs again" wait_for 20 new_pusher "$PUSH2"
PUSH3=$(pusher_pid)
sleep 3
check "the new build does not update again" test "$(log_count 'update: tray now')" -eq 1
if codesign --verify --strict "$BUNDLE" 2>/dev/null; then info "after the update the bundle's signature verifies"; else info "after the update the bundle's signature no longer verifies (its program was replaced)"; fi

echo "== SIGKILL"
kill -9 "$PID2"
sleep 2
if alive "$PUSH3"; then info "a killed tray leaves its pusher (macOS has no parent-death signal)"; fi
"$TRAY" >/dev/null 2>&1 &
check "the next tray kills the pusher left from before" wait_for 15 dead "$PUSH3"
check "  ...and starts its own" wait_for 20 new_pusher "$PUSH3"
PID3=$(tray_pid)

echo "== stale pidfile"
PUSH4=$(pusher_pid)
kill -TERM "$PID3"
check "SIGTERM stops the tray" wait_for 10 dead "$PID3"
check "  ...and its pusher" wait_for 10 dead "$PUSH4"
check "  ...and clears the pidfile" test ! -e "$APP/pusher.pid"
sleep 300 &
OTHER=$!
BG+=("$OTHER")
echo "$OTHER" >"$APP/pusher.pid"
rm -f "$AGENT"
"$TRAY" >/dev/null 2>&1 &
check "a tray starts" wait_for 15 has_tray
PID4=$(tray_pid)
check "  ...and a pusher" wait_for 20 new_pusher "$OTHER"
check "a pidfile naming another program does not kill it" alive "$OTHER"
check "the LaunchAgent is written again at start" plutil -lint "$AGENT"
check "  ...but only an install loads it" test "$(grep -c 'launchctl bootstrap' "$T/launchctl.log")" -eq 2
PUSH5=$(pusher_pid)
kill -TERM "$PID4"
wait_for 10 dead "$PID4"
wait_for 10 dead "$PUSH5"

echo "== signatures"
rm -f "$PUSH"
{ cat "$T/push-good"; echo "# the next build"; } >"$T/push-next"
NEXTSUM=$(sha "$T/push-next")
case "$P" in darwin-arm64) OTHERP=darwin-x64 ;; *) OTHERP=darwin-arm64 ;; esac
# sig_for NAME: the signature push-next gets when it is signed as the hub's file NAME.
sig_for() {
	mkdir -p "$T/stage"
	cp "$T/push-next" "$T/stage/$1"
	"$T/bin/signbuild" sign "$T/update.key" "$T/stage/$1" && cat "$T/stage/$1.sig"
}
refusals() { log_count "pusher build is not signed"; }
downloads() { grep -c "GET /api/codex-hub/pusher/download" "$T/hub.log"; }
publish "$T/push-next" "codex-hub-push-$P" "$T/other.key"
D0=$(downloads)
R0=$(refusals)
"$TRAY" >/dev/null 2>&1 &
check "a tray starts" wait_for 15 has_tray
PID7=$(tray_pid)
check "  ...and refuses a build signed with another key" wait_for 10 log_has "pusher build is not signed with this build's update key"
for sig in "$(sig_for "codex-hub-tray-$P")" "$(sig_for "codex-hub-push-$OTHERP")" ""; do
	n=$(refusals)
	if [ -n "$sig" ]; then printf '%s\n' "$sig" >"$T/hub/codex-hub-push-$P.sig"; else rm -f "$T/hub/codex-hub-push-$P.sig"; fi
	kill -USR1 "$PID7"
	wait_for 10 bash -c "[ \$(grep -c 'pusher build is not signed' '$LOG') -gt $n ]"
done
check "  ...and one signed for the tray, for $OTHERP, or not at all" test $(($(refusals) - R0)) -eq 4
kill -USR1 "$PID7"
sleep 1
check "  ...each once, downloading none of them" test $(($(refusals) - R0)) -eq 4 -a $(($(downloads) - D0)) -eq 0
check "  ...and putting nothing in place" test ! -e "$PUSH" -a ! -e "$PUSH.new"
publish "$T/push-next" "codex-hub-push-$P"
kill -USR1 "$PID7"
check "the build signed for it is fetched" wait_for 20 has_sha "$PUSH" "$NEXTSUM"
check "  ...in one download" test $(($(downloads) - D0)) -eq 1
check "  ...and runs" wait_for 20 has_pusher
PUSH7=$(pusher_pid)
kill -TERM "$PID7"
wait_for 10 dead "$PID7"
wait_for 10 dead "$PUSH7"

if [ -n "${CODEX_HUB_E2E_LAUNCHCTL:-}" ]; then
	echo "== launchd (gui/$UIDN, label $ID)"
	cp "$AGENT" "$T/launchd.plist"
	"$PB" -c "Add :EnvironmentVariables dict" -c "Add :EnvironmentVariables:HOME string $HOME" \
		-c "Add :EnvironmentVariables:PATH string $T/fake:/usr/bin:/bin:/usr/sbin:/sbin" "$T/launchd.plist"
	/bin/launchctl bootout "gui/$UIDN/$ID" 2>/dev/null
	check "launchd takes the LaunchAgent" /bin/launchctl bootstrap "gui/$UIDN" "$T/launchd.plist"
	check "  ...and starts the tray (RunAtLoad)" wait_for 20 has_tray
	L1=$(tray_pid)
	kill -9 "$L1"
	check "launchd restarts a crashed tray" wait_for 30 bash -c "p=\$(tr -dc 0-9 2>/dev/null <'$APP/tray.lock'); [ -n \"\$p\" ] && [ \"\$p\" != '$L1' ] && [ \"\$(ps -o comm= -p \$p)\" = '$TRAY' ]"
	L2=$(tray_pid)
	kill -TERM "$L2"
	wait_for 10 dead "$L2"
	sleep 15
	check "launchd leaves a tray that exited cleanly stopped" bash -c "! pgrep -f '$TRAY' >/dev/null"
	/bin/launchctl bootout "gui/$UIDN/$ID" 2>/dev/null
else
	info "set CODEX_HUB_E2E_LAUNCHCTL=1 to also check the LaunchAgent in the real launchd"
fi

echo
if [ "$failures" -eq 0 ]; then
	echo "All checks passed."
else
	echo "$failures check(s) failed. Log: $LOG"
	KEEP=1
	exit 1
fi
