#!/usr/bin/env bash
# End-to-end test of the tray app on Linux, without a desktop: a scratch HOME, a private session bus
# (dbus-run-session) with a stand-in tray host (testdata/sniwatcher), and a fake hub (testdata/fakehub) that serves
# the tray and a fake pusher script. Each check prints PASS or FAIL; the script exits non-zero if any failed.
# It needs Go, curl and dbus-run-session (the dbus-daemon package), and touches nothing outside its scratch folder.
#
#   ./test-linux.sh          (KEEP=1 keeps the scratch folder)
set -u
cd "$(dirname "$0")" || exit 1

if [ -z "${CODEX_HUB_E2E_BUS:-}" ]; then
	for tool in go curl dbus-run-session flock; do
		command -v "$tool" >/dev/null || { echo "FAIL: $tool is not installed"; exit 1; }
	done
	export CODEX_HUB_E2E_BUS=1
	exec dbus-run-session -- "$0" "$@"
fi

# Go keeps its caches where it had them; everything else gets the scratch HOME.
GOPATH=$(go env GOPATH) GOMODCACHE=$(go env GOMODCACHE) GOCACHE=$(go env GOCACHE)
export GOPATH GOMODCACHE GOCACHE
T=$(mktemp -d "${TMPDIR:-/tmp}/codex-hub-tray-e2e.XXXXXX")
export HOME="$T/home"
export XDG_RUNTIME_DIR="$T/run"
unset XDG_DATA_HOME XDG_CONFIG_HOME DISPLAY WAYLAND_DISPLAY AGENTHYDRA_CODEX_HUB_TOKEN
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$T/bin" "$T/hub" "$T/dl"
chmod 700 "$XDG_RUNTIME_DIR"
APP="$HOME/.local/share/codex-hub"
TRAY="$APP/codex-hub-tray"
PUSH="$APP/codex-hub-push"
LOG="$APP/tray.log"
DESKTOP="$HOME/.config/autostart/codex-hub-tray.desktop"
TOKEN="e2e-Token_0123456789abcdef"
case "$(uname -m)" in
x86_64 | amd64) P=linux-x64 ;;
aarch64 | arm64) P=linux-arm64 ;;
*) echo "FAIL: no hub platform for $(uname -m)"; exit 1 ;;
esac

failures=0
pass() { echo "PASS: $*"; }
fail() {
	echo "FAIL: $*"
	failures=$((failures + 1))
}
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
alive() { [ -n "${1:-}" ] && [ -r "/proc/$1/stat" ] && ! awk 2>/dev/null '{exit $3 != "Z"}' "/proc/$1/stat"; }
dead() { ! alive "$1"; }
runs() { [ "$(readlink "/proc/$1/exe" 2>/dev/null)" = "$2" ]; } # runs PID PATH
sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
has_sha() { [ "$(sha "$1")" = "$2" ]; }
mode() { stat -c %a "$1"; }
tray_pid() { # the pid the running tray wrote into its lock, if that process is the installed tray
	local pid
	pid=$(tr -dc 0-9 2>/dev/null <"$APP/tray.lock")
	[ -n "$pid" ] && runs "$pid" "$TRAY" && echo "$pid"
}
has_tray() { [ -n "$(tray_pid)" ]; }
pusher_pid() { tr -dc 0-9 2>/dev/null <"$APP/pusher.pid"; }
has_pusher() { alive "$(pusher_pid)"; }
pusher_is() { alive "$1" && [ "$(pusher_pid)" = "$1" ]; }
log_has() { grep -q -- "$1" "$LOG" 2>/dev/null; }
log_count() { grep -c -- "$1" "$LOG" 2>/dev/null || true; }
locked() { ! flock -n "$APP/tray.lock" true; } # someone holds the tray's lock
last_item() { grep -o 'item [^ ]* icon 32x32 visible [1-9]' "$T/sni.log" | tail -1 | cut -d' ' -f2; }

BG=()
cleanup() {
	disown -a
	for p in $(pgrep -f "^$TRAY" 2>/dev/null) $(pgrep -f "$PUSH" 2>/dev/null) "${BG[@]}"; do kill -9 "$p" 2>/dev/null; done
	if [ -n "${KEEP:-}" ]; then echo "kept $T"; else rm -rf "$T"; fi
}
trap cleanup EXIT

# The stand-ins: a tray host on the private bus and the hub.
go build -o "$T/bin/fakehub" ./testdata/fakehub || exit 1
go build -o "$T/bin/sniwatcher" ./testdata/sniwatcher || exit 1
"$T/bin/sniwatcher" >"$T/sni.log" 2>&1 &
BG+=($!)
"$T/bin/fakehub" -dir "$T/hub" -token "$TOKEN" -addr-file "$T/hub.addr" >"$T/hub.log" 2>&1 &
BG+=($!)
wait_for 10 test -s "$T/hub.addr" || { echo "FAIL: the fake hub did not start"; exit 1; }
HUB=$(cat "$T/hub.addr")

# Two tray builds that differ, so the hub can hand out an update.
FLAGS="-X main.hubURL=$HUB -X main.pairURL=https://inbox.example.test/codex-hub/pair -X main.inboxURL=https://inbox.example.test"
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w $FLAGS" -o "$T/dl/codex-hub-tray-$P" . || exit 1
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w $FLAGS -X main.bundleID=com.example.codex-hub-tray.next" -o "$T/next" . || exit 1
V1=$(sha "$T/dl/codex-hub-tray-$P")
V2=$(sha "$T/next")
cp "$T/dl/codex-hub-tray-$P" "$T/hub/codex-hub-tray-$P"
cat >"$T/hub/codex-hub-push-$P" <<'EOF'
#!/bin/sh
if [ "$1" = --version ]; then echo codex-hub-push; exit 0; fi
env | grep '^AGENTHYDRA_CODEX_HUB_' >pusher-env
while :; do sleep 1; done
EOF
PUSHSUM=$(sha "$T/hub/codex-hub-push-$P")

echo "== version"
check "--version prints the banner" test "$("$T/dl/codex-hub-tray-$P" --version)" = codex-hub-tray

echo "== install"
"$T/dl/codex-hub-tray-$P" >"$T/install.out" 2>&1
check "the installer exits 0" test $? -eq 0
check "it says what it did" grep -q "Installed Codex Hub at $TRAY" "$T/install.out"
check "the tray is copied to its place" has_sha "$TRAY" "$V1"
check "the installed tray is executable (755)" test "$(mode "$TRAY")" = 755
check "the autostart entry runs the installed tray" grep -qx "Exec=$TRAY" "$DESKTOP"
check "the autostart entry is enabled" grep -qx "X-GNOME-Autostart-enabled=true" "$DESKTOP"
check "the installed copy is running" wait_for 10 has_tray
PID1=$(tray_pid)
check "it runs with a tray (session bus found)" bash -c "! grep -q 'no desktop session' '$LOG'"

echo "== pairing"
check "with no display it writes the pairing address" wait_for 10 log_has "open in a browser on this PC: https://inbox.example.test/codex-hub/pair?"
LINK=$(grep -o 'https://inbox.example.test/codex-hub/pair?[^ ]*' "$LOG" | tail -1)
PORT=$(echo "$LINK" | grep -o 'port=[0-9]*' | cut -d= -f2)
STATE=$(echo "$LINK" | grep -o 'state=[0-9a-f]*' | cut -d= -f2)
code=$(curl -s -o /dev/null -w '%{http_code}' -d state=wrong -d "token=$TOKEN" "http://127.0.0.1:$PORT/paired")
check "a post with the wrong state is refused (400)" test "$code" = 400
code=$(curl -s -o /dev/null -w '%{http_code}' -d "state=$STATE" -d token=short "http://127.0.0.1:$PORT/paired")
check "a too-short token is refused (400)" test "$code" = 400
code=$(curl -s -o "$T/paired.html" -w '%{http_code}' -d "state=$STATE" -d "token=$TOKEN" "http://127.0.0.1:$PORT/paired")
check "the hub page's post is taken (200)" test "$code" = 200
check "the token is saved" grep -q "\"token\": \"$TOKEN\"" "$APP/tray.json"
check "the config is private (600)" test "$(mode "$APP/tray.json")" = 600

echo "== pusher"
check "the pusher is downloaded and started" wait_for 20 has_pusher
PUSH1=$(pusher_pid)
check "the pusher is the hub's build" has_sha "$PUSH" "$PUSHSUM"
check "the pusher is executable (755)" test "$(mode "$PUSH")" = 755
check "the pusher gets the hub, the token and no updates of its own" \
	grep -qx "AGENTHYDRA_CODEX_HUB_URL=$HUB" "$APP/pusher-env"
check "  ...the token" grep -qx "AGENTHYDRA_CODEX_HUB_TOKEN=$TOKEN" "$APP/pusher-env"
check "  ...UPDATE=off" grep -qx "AGENTHYDRA_CODEX_HUB_UPDATE=off" "$APP/pusher-env"
check "the pusher leads a process group of its own" test "$(ps -o pgid= -p "$PUSH1" | tr -d ' ')" = "$PUSH1"
check "the hub was asked for platform=$P (pusher)" grep -q "GET /api/codex-hub/pusher platform=$P 200" "$T/hub.log"
check "the hub was asked for platform=$P (tray)" wait_for 10 grep -q "GET /api/codex-hub/tray platform=$P 200" "$T/hub.log"
check "the hub was never asked without a platform" bash -c "! grep -q 'platform= ' '$T/hub.log'"
check "the tray host shows a 32x32 icon that is not blank" \
	wait_for 10 grep -Eq 'icon 32x32 visible [1-9][0-9]* title "Codex Hub"' "$T/sni.log"
check "the tray holds its lock" locked

echo "== second instance"
start=$SECONDS
timeout 60 "$TRAY" >"$T/second.out" 2>&1
code=$?
took=$((SECONDS - start))
check "a second tray exits on the lock ($code after ${took}s)" test "$code" -eq 0 -a "$took" -ge 15
check "the first tray still runs" test "$(tray_pid)" = "$PID1"
check "  ...with its pusher" pusher_is "$PUSH1"

echo "== reinstall over a running tray"
"$T/dl/codex-hub-tray-$P" >"$T/reinstall.out" 2>&1
check "the installer stops the running tray" wait_for 10 dead "$PID1"
check "  ...and its pusher" wait_for 10 dead "$PUSH1"
check "the new copy runs" wait_for 30 has_tray
PID2=$(tray_pid)
check "  ...as a new process" test -n "$PID2" -a "$PID2" != "$PID1"
check "  ...with a pusher" wait_for 20 has_pusher
PUSH2=$(pusher_pid)

echo "== self-update"
wait_for 10 test -n "$(last_item)"
ITEM=$(last_item)
cp "$T/next" "$T/hub/codex-hub-tray-$P"
kill -USR1 "$PID2" # check the hub now
check "the new build is swapped in" wait_for 30 has_sha "$TRAY" "$V2"
check "the tray says so" wait_for 10 log_has "update: tray now ${V2:0:8}"
check "the update came from platform=$P" grep -q "GET /api/codex-hub/tray/download platform=$P 200" "$T/hub.log"
check "it restarts in place: the same pid runs the new file" \
	wait_for 20 bash -c "[ \$(grep -c 'tray: started, pid $PID2\$' '$LOG') -ge 2 ]"
check "  ...still the installed path" runs "$PID2" "$TRAY"
check "  ...holding the lock" test "$(tray_pid)" = "$PID2"
check "  ...really" locked
check "  ...and showing its icon again" wait_for 15 bash -c "i=\$(grep -o 'item [^ ]* icon 32x32 visible [1-9]' '$T/sni.log' | tail -1 | cut -d' ' -f2); [ -n \"\$i\" ] && [ \"\$i\" != '$ITEM' ]"
check "no .new is left" test ! -e "$TRAY.new"
check "the old pusher was stopped" wait_for 10 dead "$PUSH2"
check "a pusher runs again" wait_for 20 bash -c "p=\$(tr -dc 0-9 2>/dev/null <'$APP/pusher.pid'); [ -n \"\$p\" ] && [ \"\$p\" != '$PUSH2' ] && kill -0 \$p"
PUSH3=$(pusher_pid)
sleep 3
check "the new build does not update again" test "$(log_count 'update: tray now')" -eq 1

echo "== SIGKILL"
kill -9 "$PID2"
check "a killed tray takes its pusher down" wait_for 10 dead "$PUSH3"

echo "== stale pidfile"
sleep 300 &
OTHER=$!
BG+=("$OTHER")
echo "$OTHER" >"$APP/pusher.pid"
rm -f "$DESKTOP"
"$TRAY" >/dev/null 2>&1 &
check "a tray starts" wait_for 10 has_tray
PID3=$(tray_pid)
check "  ...and a pusher" wait_for 20 bash -c "p=\$(tr -dc 0-9 2>/dev/null <'$APP/pusher.pid'); [ \"\$p\" != '$OTHER' ] && kill -0 \$p"
check "a pidfile naming another program does not kill it" alive "$OTHER"
check "the autostart entry is written again at start" grep -qx "Exec=$TRAY" "$DESKTOP"
PUSH4=$(pusher_pid)
kill -TERM "$PID3"
check "SIGTERM stops the tray" wait_for 10 dead "$PID3"
check "  ...and its pusher" wait_for 10 dead "$PUSH4"
check "  ...and clears the pidfile" test ! -e "$APP/pusher.pid"

cp "$(command -v sleep)" "$PUSH"
"$PUSH" 300 &
STALE=$!
disown "$STALE"
BG+=("$STALE")
echo "$STALE" >"$APP/pusher.pid"
"$TRAY" >/dev/null 2>&1 &
check "a pusher left from before is killed at start" wait_for 10 dead "$STALE"
check "  ...and the hub's pusher replaces it" wait_for 20 has_sha "$PUSH" "$PUSHSUM"
PID4=$(tray_pid)
kill -TERM "$PID4" 2>/dev/null
wait_for 10 dead "$PID4"

echo "== a pusher build that cannot run here"
cp "$T/hub/codex-hub-push-$P" "$T/push-good"
rm -f "$PUSH"
{ printf 'MZ\220\0'; head -c 4000000 /dev/zero; } >"$T/hub/codex-hub-push-$P" # what a hub without ?platform= sends
downloads() { grep -c "GET /api/codex-hub/pusher/download" "$T/hub.log"; }
checks() { grep -c "GET /api/codex-hub/pusher platform=$P 200" "$T/hub.log"; }
D0=$(downloads)
C0=$(checks)
"$TRAY" >/dev/null 2>&1 &
check "a tray starts" wait_for 10 has_tray
PID6=$(tray_pid)
check "  ...and refuses the Windows build" wait_for 10 log_has "the hub's pusher build is a windows program"
for i in 1 2 3; do
	kill -USR1 "$PID6"
	sleep 1
done
check "  ...asking the hub again at each check" test $(($(checks) - C0)) -ge 3
check "  ...but fetching that build only once" test $(($(downloads) - D0)) -eq 1
check "  ...and putting nothing in place" test ! -e "$PUSH" -a ! -e "$PUSH.new"
cp "$T/push-good" "$T/hub/codex-hub-push-$P"
kill -USR1 "$PID6"
check "the hub's next build is fetched" wait_for 20 has_sha "$PUSH" "$PUSHSUM"
check "  ...and runs" wait_for 20 has_pusher
PUSH6=$(pusher_pid)
kill -TERM "$PID6"
wait_for 10 dead "$PID6"
wait_for 10 dead "$PUSH6"

echo "== no session bus"
mkdir -p "$T/run-empty"
(
	unset DBUS_SESSION_BUS_ADDRESS
	export XDG_RUNTIME_DIR="$T/run-empty"
	exec "$TRAY" >"$T/headless.out" 2>&1
) &
check "a tray starts without a bus" wait_for 10 has_tray
PID5=$(tray_pid)
check "  ...saying it runs without an icon" wait_for 10 log_has "no desktop session to show an icon in"
check "  ...and runs the pusher" wait_for 20 has_pusher
PUSH5=$(pusher_pid)
sleep 2
check "  ...and keeps running" alive "$PID5"
check "nothing panicked" bash -c "! grep -q panic '$T/headless.out' '$LOG'"
kill -TERM "$PID5"
check "SIGTERM stops the headless tray" wait_for 10 dead "$PID5"
check "  ...and its pusher" wait_for 10 dead "$PUSH5"

echo
if [ "$failures" -eq 0 ]; then
	echo "All checks passed."
else
	echo "$failures check(s) failed. Log: $LOG"
	KEEP=1
	exit 1
fi
