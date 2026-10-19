#!/usr/bin/env bash
# End-to-end test of the tray app on Linux, without a desktop: a scratch HOME, a private session bus
# (dbus-run-session) with a stand-in tray host (testdata/sniwatcher), and a fake hub (testdata/fakehub) that pairs
# PCs with tokens of their own and serves the tray and a fake pusher script, signed with a key made for the run
# (testdata/signbuild, as scripts/codex-hub-sign.ts signs them). A PC on the token every PC shared before moves to
# one of its own, with this tray and with the tray of the commit before PC tokens (git archive, so the checkout must
# have that commit); and the tray pairs, moves and is revoked against the real hub too
# (scripts/codex-hub-test-daemon.ts). Each check prints PASS or FAIL; the script exits non-zero if any failed.
# It needs Go, curl and dbus-run-session (the dbus-daemon package), and Bun with the root's node_modules for the
# real hub (bun install --frozen-lockfile at the root); without that commit or Bun those sections are skipped, and
# fail under CI=true. It touches nothing outside its scratch folder.
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
unset XDG_DATA_HOME XDG_CONFIG_HOME DISPLAY WAYLAND_DISPLAY AGENTHYDRA_CODEX_HUB_TOKEN AGENTHYDRA_CODEX_HUB_PC \
	CCMANAGERUI_CODEX_HUB_PC AGENTHYDRA_CODEX_HUB_INSTALL AGENTHYDRA_HOME CCMANAGERUI_HOME
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$T/bin" "$T/hub" "$T/dl"
chmod 700 "$XDG_RUNTIME_DIR"
APP="$HOME/.local/share/codex-hub"
TRAY="$APP/codex-hub-tray"
PUSH="$APP/codex-hub-push"
LOG="$APP/tray.log"
DESKTOP="$HOME/.config/autostart/codex-hub-tray.desktop"
# The hub's admin token, which no PC route takes, and the token every PC shared before PCs had tokens of their own.
ADMIN="e2e-Admin_0123456789abcdef"
LEGACY="e2e-Legacy_0123456789abcdef"
# The hub sits behind an access proxy that wants a header of its own on every request, the tray's included.
ACCESS="X-Hub-Access: e2e-access"
export AGENTHYDRA_CODEX_HUB_HEADERS='{"X-Hub-Access":"e2e-access"}'
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
field() { sed -n "s/^ *\"$2\": \"\([^\"]*\)\".*/\\1/p" "$1" 2>/dev/null; } # field FILE NAME: a string the tray wrote there
pc_token() { [[ $1 =~ ^chp_[0-9a-f]{16}_[0-9a-f]{64}$ ]]; }
env_is() { grep -qx -- "$1" "$APP/pusher-env" 2>/dev/null; } # env_is NAME=VALUE: the running pusher was started so
more() { [ "$(grep -c -- "$1" "$2" 2>/dev/null)" -gt "$3" ]; } # more TEXT FILE N: FILE has TEXT on more than N lines
status_count() { log_count "status: $1"; }
status_more() { more "status: $1" "$LOG" "$2"; } # status_more TEXT N: the headless tray said TEXT since there were N
hex() { printf '%s' "$1" | sha256sum | cut -c1-"$2"; } # hex SEED N: N hex digits, the same for the same seed
# headless [NAME=VALUE...]: starts the installed tray without a session bus, as on a PC without a desktop; it has its
# signal handlers once up_headless is true.
headless() {
	H0=$(log_count "no desktop session to show an icon in")
	(
		unset DBUS_SESSION_BUS_ADDRESS
		export XDG_RUNTIME_DIR="$T/run-empty"
		[ $# -eq 0 ] || export "$@"
		exec "$TRAY" >>"$T/headless.out" 2>&1
	) &
}
up_headless() { [ "$(log_count "no desktop session to show an icon in")" -gt "$H0" ] && has_tray; }
stop_tray() { # stops the installed tray, and its pusher
	local pid push
	pid=$(tray_pid)
	push=$(pusher_pid)
	[ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null
	wait_for 10 dead "$pid"
	wait_for 10 dead "$push"
}

BG=()
REALHUB=
cleanup() {
	disown -a
	if [ -n "$REALHUB" ]; then # it stops the daemon it started
		kill -TERM "$REALHUB" 2>/dev/null
		wait_for 20 dead "$REALHUB"
	fi
	for p in $(pgrep -f "^$TRAY" 2>/dev/null) $(pgrep -f "^$T/home2/" 2>/dev/null) $(pgrep -f "$PUSH" 2>/dev/null) "${BG[@]}"; do
		kill -9 "$p" 2>/dev/null
	done
	if [ -n "${KEEP:-}" ]; then echo "kept $T"; else rm -rf "$T"; fi
}
trap cleanup EXIT

# The stand-ins: a tray host on the private bus and the hub.
go build -o "$T/bin/fakehub" ./testdata/fakehub || exit 1
go build -o "$T/bin/sniwatcher" ./testdata/sniwatcher || exit 1
go build -o "$T/bin/signbuild" ./testdata/signbuild || exit 1
# The operator's key, which the trays are built with, and another.
KEY=$("$T/bin/signbuild" keygen "$T/update.key") || exit 1
"$T/bin/signbuild" keygen "$T/other.key" >/dev/null || exit 1
# publish SRC NAME [KEY]: puts SRC on the hub as NAME, signed with KEY (the operator's by default); the .sig goes in
# first and each file by a rename, so the hub never serves half a file.
publish() {
	mkdir -p "$T/stage"
	cp "$1" "$T/stage/$2" && "$T/bin/signbuild" sign "${3:-$T/update.key}" "$T/stage/$2" || return 1
	mv "$T/stage/$2.sig" "$T/hub/$2.sig" && mv "$T/stage/$2" "$T/hub/$2"
}
"$T/bin/sniwatcher" >"$T/sni.log" 2>&1 &
BG+=($!)
"$T/bin/fakehub" -dir "$T/hub" -admin "$ADMIN" -header "$ACCESS" -addr-file "$T/hub.addr" >"$T/hub.log" 2>&1 &
BG+=($!)
wait_for 10 test -s "$T/hub.addr" || { echo "FAIL: the fake hub did not start"; exit 1; }
HUB=$(cat "$T/hub.addr")

# Two tray builds that differ, so the hub can hand out an update.
NOKEY="-X main.hubURL=$HUB -X main.pairURL=https://inbox.example.test/codex-hub/pair -X main.inboxURL=https://inbox.example.test"
FLAGS="$NOKEY -X main.updateKey=$KEY"
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w $FLAGS" -o "$T/dl/codex-hub-tray-$P" . || exit 1
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w $FLAGS -X main.bundleID=com.example.codex-hub-tray.next" -o "$T/next" . || exit 1
V1=$(sha "$T/dl/codex-hub-tray-$P")
V2=$(sha "$T/next")
publish "$T/dl/codex-hub-tray-$P" "codex-hub-tray-$P" || exit 1
cat >"$T/push-good" <<'EOF'
#!/bin/sh
if [ "$1" = --version ]; then echo codex-hub-push; exit 0; fi
env | grep '^AGENTHYDRA_CODEX_HUB_' >pusher-env
while :; do sleep 1; done
EOF
publish "$T/push-good" "codex-hub-push-$P" || exit 1
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
check "the address says when its listener closes" bash -c "echo '$LINK' | grep -Eq '[?&]until=[0-9]{10}(&|\$)'"
check "  ...and names no old name" bash -c "! echo '$LINK' | grep -q '[?&]from='"
post() { curl -s -o "$T/post.html" -w '%{http_code}' "$@" "http://127.0.0.1:$PORT/paired"; } # post CURL-ARGS...
NEVER=$(hex never-made 64)
code=$(post -d state=wrong -d "code=$NEVER")
check "a post with the wrong state is refused (400)" test "$code" = 400
code=$(post -H "Host: localhost:$PORT" -d "state=$STATE" -d "code=$NEVER")
check "a post to another Host is refused (400)" test "$code" = 400
code=$(post -d "state=$STATE" -d "code=$NEVER")
check "a code the hub never made is refused (401)" test "$code" = 401
check "  ...saying it expired or was used" grep -q "expired or was used" "$T/post.html"
CODE=$(curl -s -X POST "$HUB/fake/pair-code?pc=E2E-PC")
code=$(post -d "state=$STATE" -d "code=$CODE")
check "the code from the hub's page is taken (200)" test "$code" = 200
check "  ...connected as the name the hub gave it" grep -q "connected as E2E-PC" "$T/post.html"
PCTOKEN=$(field "$APP/tray.json" token)
INSTALL=$(tr -d '\n' <"$HOME/.agenthydra/codex-hub-push-install")
check "tray.json holds a token of this PC's own" pc_token "$PCTOKEN"
check "  ...the name the hub has it under" test "$(field "$APP/tray.json" pc)" = E2E-PC
check "  ...its id" test "$(field "$APP/tray.json" id)" = "${PCTOKEN:4:16}"
check "  ...the install id" test -n "$INSTALL" -a "$(field "$APP/tray.json" install)" = "$INSTALL"
check "  ...and no next" bash -c "! grep -q '\"next\"' '$APP/tray.json'"
check "the config is private (600)" test "$(mode "$APP/tray.json")" = 600
cp "$APP/tray.json" "$T/paired.json"
R0=$(grep -c "POST /api/codex-hub/redeem 401" "$T/hub.log")
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$ACCESS" -H "x-codex-hub-install: $INSTALL" -H 'content-type: application/json' \
	-d "{\"code\":\"$CODE\",\"id\":\"$(hex another-id 16)\",\"hash\":\"$(hex another-hash 64)\"}" "$HUB/api/codex-hub/redeem")
check "the same code with another token is refused at the hub (401)" test "$code" = 401
check "  ...as its log says" more "POST /api/codex-hub/redeem 401" "$T/hub.log" "$R0"

echo "== pusher"
check "the pusher is downloaded and started" wait_for 20 has_pusher
PUSH1=$(pusher_pid)
check "the pusher is the hub's build" has_sha "$PUSH" "$PUSHSUM"
check "the pusher is executable (755)" test "$(mode "$PUSH")" = 755
check "the pusher gets the hub, this PC's token, its name and install id, and no updates of its own" \
	wait_for 10 env_is "AGENTHYDRA_CODEX_HUB_URL=$HUB"
check "  ...the token" env_is "AGENTHYDRA_CODEX_HUB_TOKEN=$PCTOKEN"
check "  ...the name the hub has it under" env_is "AGENTHYDRA_CODEX_HUB_PC=E2E-PC"
check "  ...the install id in ~/.agenthydra/codex-hub-push-install" env_is "AGENTHYDRA_CODEX_HUB_INSTALL=$INSTALL"
check "  ...which is private (600)" test "$(mode "$HOME/.agenthydra/codex-hub-push-install")" = 600
check "  ...and the one the hub had the redeem with" grep -q "install=$INSTALL POST /api/codex-hub/redeem 200" "$T/hub.log"
check "  ...UPDATE=off" grep -qx "AGENTHYDRA_CODEX_HUB_UPDATE=off" "$APP/pusher-env"
check "  ...and the hub's extra headers" grep -qx "AGENTHYDRA_CODEX_HUB_HEADERS=$AGENTHYDRA_CODEX_HUB_HEADERS" "$APP/pusher-env"
check "the pusher leads a process group of its own" test "$(ps -o pgid= -p "$PUSH1" | tr -d ' ')" = "$PUSH1"
check "the hub was asked for platform=$P (pusher)" grep -q "GET /api/codex-hub/pusher platform=$P 200" "$T/hub.log"
check "the hub was asked for platform=$P (tray)" wait_for 10 grep -q "GET /api/codex-hub/tray platform=$P 200" "$T/hub.log"
check "the hub was never asked without a platform" bash -c "! grep -q 'platform= ' '$T/hub.log'"
check "the tray's own requests carry the hub's extra headers (no 403)" bash -c "! grep -q ' 403\$' '$T/hub.log'"
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
sed -i 's/^X-GNOME-Autostart-enabled=true$/X-GNOME-Autostart-enabled=false/' "$DESKTOP" # turned off by the user
publish "$T/next" "codex-hub-tray-$P"
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
check "autostart turned off stays off after the restart" grep -qx "X-GNOME-Autostart-enabled=false" "$DESKTOP"
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
check "an autostart entry the user removed is not written again at start" test ! -e "$DESKTOP"
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
rm -f "$PUSH"
{ printf 'MZ\220\0'; head -c 4000000 /dev/zero; } >"$T/windows" # what a hub without ?platform= sends
publish "$T/windows" "codex-hub-push-$P"
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
publish "$T/push-good" "codex-hub-push-$P"
kill -USR1 "$PID6"
check "the hub's next build is fetched" wait_for 20 has_sha "$PUSH" "$PUSHSUM"
check "  ...and runs" wait_for 20 has_pusher
PUSH6=$(pusher_pid)
kill -TERM "$PID6"
wait_for 10 dead "$PID6"
wait_for 10 dead "$PUSH6"

echo "== signatures"
rm -f "$PUSH"
{ cat "$T/push-good"; echo "# the next build"; } >"$T/push-next"
NEXTSUM=$(sha "$T/push-next")
case "$P" in linux-x64) OTHERP=linux-arm64 ;; *) OTHERP=linux-x64 ;; esac
# sig_for NAME: the signature push-next gets when it is signed as the hub's file NAME.
sig_for() {
	mkdir -p "$T/stage"
	cp "$T/push-next" "$T/stage/$1"
	"$T/bin/signbuild" sign "$T/update.key" "$T/stage/$1" && cat "$T/stage/$1.sig"
}
refusals() { log_count "pusher build is not signed"; }
publish "$T/push-next" "codex-hub-push-$P" "$T/other.key"
D0=$(downloads)
R0=$(refusals)
"$TRAY" >/dev/null 2>&1 &
check "a tray starts" wait_for 10 has_tray
PID7=$(tray_pid)
check "  ...and refuses a build signed with another key" wait_for 10 log_has "pusher build is not signed with this build's update key"
for sig in "$(sig_for "codex-hub-tray-$P")" "$(sig_for "codex-hub-push-$OTHERP")" ""; do
	n=$(refusals)
	if [ -n "$sig" ]; then printf '%s\n' "$sig" >"$T/hub/codex-hub-push-$P.sig"; else rm -f "$T/hub/codex-hub-push-$P.sig"; fi
	kill -USR1 "$PID7"
	wait_for 10 bash -c "[ \$(grep -c 'pusher build is not signed' '$LOG') -gt $n ]"
done
check "  ...and one signed for the tray, for $OTHERP, or not at all" test $(($(refusals) - R0)) -eq 4
check "  ...saying so for the unsigned one" log_has "the hub's pusher build is not signed ("
kill -USR1 "$PID7"
sleep 1
check "  ...each once" test $(($(refusals) - R0)) -eq 4
check "  ...downloading none of them" test $(($(downloads) - D0)) -eq 0
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
# Without a desktop there is no menu, so no Connect this PC: a token from the hub (scripts/codex-hub-pcs.ts add) goes
# into tray.json by hand, and SIGUSR1 (or the next check) has the pusher start again with it.
ADDED=$(curl -s -X POST "$HUB/fake/add?pc=Hand-PC")
printf '{\n  "token": "%s"\n}\n' "$ADDED" >"$APP/tray.json"
kill -USR1 "$PID5"
check "a token from the hub written into tray.json by hand restarts the pusher with it" \
	wait_for 20 env_is "AGENTHYDRA_CODEX_HUB_TOKEN=$ADDED"
named() { [ "$(field "$APP/tray.json" pc)" = "$1" ] && [ "$(field "$APP/tray.json" id)" = "$2" ]; } # named PC ID
check "  ...and whoami puts its name and id in tray.json" wait_for 10 named Hand-PC "${ADDED:4:16}"
check "  ...and the pusher's environment" wait_for 20 env_is "AGENTHYDRA_CODEX_HUB_PC=Hand-PC"
S0=$(status_count "The hub refused the token: choose Connect this PC")
printf '{\n  "token": "chp_%s_%s"\n}\n' "$(hex unknown-id 16)" "$(hex unknown-secret 64)" >"$APP/tray.json"
kill -USR1 "$PID5"
check "a token the hub does not know is refused" wait_for 20 status_more "The hub refused the token: choose Connect this PC" "$S0"
check "  ...with the config still private (600)" test "$(mode "$APP/tray.json")" = 600
cp "$T/paired.json" "$APP/tray.json"
kill -USR1 "$PID5"
check "the paired config, put back the same way, is taken" \
	wait_for 20 env_is "AGENTHYDRA_CODEX_HUB_TOKEN=$PCTOKEN"
check "  ...and the pusher runs with it" wait_for 20 has_pusher
check "  ...and the tray is pushing again" wait_for 10 bash -c "tail -1 <(grep 'status:' '$LOG') | grep -q 'Pushing this PC'"
PUSH5=$(pusher_pid)
kill -TERM "$PID5"
check "SIGTERM stops the headless tray" wait_for 10 dead "$PID5"
check "  ...and its pusher" wait_for 10 dead "$PUSH5"

echo "== a build without an update key, from an http hub"
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w $NOKEY" -o "$T/nokey" . || exit 1
rm -f "$PUSH"
D0=$(downloads)
(
	unset DBUS_SESSION_BUS_ADDRESS
	export XDG_RUNTIME_DIR="$T/run-empty"
	exec "$T/nokey" >"$T/nokey.out" 2>&1
)
check "it installs and runs" wait_for 10 has_tray
PID8=$(tray_pid)
check "  ...saying it has no update key" wait_for 10 log_has "update: this build has no update key"
check "  ...in its status (amber)" wait_for 10 log_has "status: This build has no update key: it takes no builds over http"
for i in 1 2 3; do
	kill -USR1 "$PID8"
	sleep 1
done
check "  ...in one line" test "$(log_count "update: this build has no update key")" -eq 1
check "  ...and takes no build" test $(($(downloads) - D0)) -eq 0 -a ! -e "$PUSH" -a ! -e "$PUSH.new"
kill -TERM "$PID8"
check "SIGTERM stops it" wait_for 10 dead "$PID8"

echo "== moving to a new key"
# The operator's next key. The first build that trusts it trusts the old key too and is signed with the old one, so
# a tray with the old key alone takes it; the builds after it are signed with the new key and trust it alone.
NEWKEY=$("$T/bin/signbuild" keygen "$T/new.key") || exit 1
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w $NOKEY -X main.updateKey=$KEY,$NEWKEY" -o "$T/both" . || exit 1
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w $NOKEY -X main.updateKey=$NEWKEY" -o "$T/newonly" . || exit 1
V3=$(sha "$T/both")
V4=$(sha "$T/newonly")
{ cat "$T/push-good"; echo "# signed with the new key"; } >"$T/push-new"
NEWSUM=$(sha "$T/push-new")
unsigned() { log_count "pusher build is not signed with this build's update key"; }
publish "$T/both" "codex-hub-tray-$P"
publish "$T/push-new" "codex-hub-push-$P" "$T/new.key"
rm -f "$PUSH"
R0=$(unsigned)
"$T/dl/codex-hub-tray-$P" >"$T/rotate.out" 2>&1 # the first build: the old key alone
check "a tray with the old key alone is installed" wait_for 10 has_tray
check "  ...and refuses the pusher the new key signed" wait_for 10 bash -c "[ \$(grep -c \"pusher build is not signed with this build's update key\" '$LOG') -gt $R0 ]"
check "  ...but takes the tray that trusts both keys, which the old key signed" wait_for 30 has_sha "$TRAY" "$V3"
check "that tray takes the pusher the new key signed" wait_for 30 has_sha "$PUSH" "$NEWSUM"
check "  ...and runs it" wait_for 20 has_pusher
publish "$T/newonly" "codex-hub-tray-$P" "$T/new.key"
kill -USR1 "$(tray_pid)"
check "the tray with the new key alone, which the new key signed, is taken" wait_for 30 has_sha "$TRAY" "$V4"
wait_for 10 has_tray
R1=$(unsigned)
publish "$T/push-good" "codex-hub-push-$P"
kill -USR1 "$(tray_pid)"
check "  ...and refuses a pusher the old key signed" wait_for 10 bash -c "[ \$(grep -c \"pusher build is not signed with this build's update key\" '$LOG') -gt $R1 ]"
check "  ...keeping the one it has" has_sha "$PUSH" "$NEWSUM"
PID9=$(tray_pid)
PUSH9=$(pusher_pid)
kill -TERM "$PID9"
check "SIGTERM stops it" wait_for 10 dead "$PID9"
check "  ...and its pusher" wait_for 10 dead "$PUSH9"

# From here on the hub hands out the first builds again: the tray with the operator's first key, and the pusher it
# signed.
publish "$T/dl/codex-hub-tray-$P" "codex-hub-tray-$P"
publish "$T/push-good" "codex-hub-push-$P"
install -m 755 "$T/dl/codex-hub-tray-$P" "$TRAY"

echo "== moving from the legacy token"
# A PC paired before PCs had tokens of their own has the legacy token in tray.json, and its pusher pushed with the id
# in its install file, which the hub has for its key, pending. Its next check trades the token for one of its own.
"$T/bin/fakehub" -dir "$T/hub" -admin "$ADMIN" -legacy "$LEGACY" -pending "e2e-old-pc=$INSTALL" -header "$ACCESS" \
	-addr-file "$T/hub2.addr" >"$T/hub2.log" 2>&1 &
BG+=($!)
wait_for 10 test -s "$T/hub2.addr" || { echo "FAIL: the second fake hub did not start"; exit 1; }
HUB2=$(cat "$T/hub2.addr")
legacy_at() { printf '{\n  "hub": "%s",\n  "token": "%s"\n}\n' "$1" "$LEGACY" >"$APP/tray.json"; } # legacy_at HUB
cp "$T/paired.json" "$APP/tray.json"
headless
check "a tray starts without a bus" wait_for 10 up_headless
check "  ...and puts the hub's pusher in place" wait_for 30 has_sha "$PUSH" "$PUSHSUM"
check "  ...and runs it" wait_for 20 has_pusher
PUSHA=$(pusher_pid)
legacy_at "$HUB2"
kill -USR1 "$(tray_pid)"
check "with the hub's window open, the exchange is taken (200)" \
	wait_for 20 grep -q "bearer=legacy install=$INSTALL POST /api/codex-hub/exchange 200" "$T/hub2.log"
MOVED=$(field "$APP/tray.json" token)
check "tray.json holds a token of this PC's own" pc_token "$MOVED"
check "  ...the name of the key it moved" test "$(field "$APP/tray.json" pc)" = e2e-old-pc
check "  ...and the install id" test "$(field "$APP/tray.json" install)" = "$INSTALL"
check "the pusher starts again with that token" wait_for 20 env_is "AGENTHYDRA_CODEX_HUB_TOKEN=$MOVED"
check "  ...as another process" bash -c "[ \"\$(tr -dc 0-9 <'$APP/pusher.pid')\" != '$PUSHA' ]"
check "  ...with the name and the install id" bash -c "grep -qx 'AGENTHYDRA_CODEX_HUB_PC=e2e-old-pc' '$APP/pusher-env' && grep -qx 'AGENTHYDRA_CODEX_HUB_INSTALL=$INSTALL' '$APP/pusher-env'"
check "the hub has nothing pending" bash -c "curl -s '$HUB2/fake/state' | grep -q '\"pending\":\[\]'"
check "the tray says it pushes as that name" wait_for 20 status_more "Pushing this PC's Codex chats as e2e-old-pc" 0
stop_tray

# The build's hub, which has no legacy token: the exchange is refused.
printf '{\n  "token": "%s"\n}\n' "$LEGACY" >"$APP/tray.json"
S0=$(status_count "This PC must be paired again: choose Connect this PC")
# That hub does not know the token, so its log names it "other".
X0=$(grep -c "bearer=other install=$INSTALL POST /api/codex-hub/exchange 401" "$T/hub.log")
headless
check "without the legacy token on the hub: This PC must be paired again" \
	wait_for 30 status_more "This PC must be paired again: choose Connect this PC" "$S0"
check "  ...after the hub refused the exchange (401)" more "bearer=other install=$INSTALL POST /api/codex-hub/exchange 401" "$T/hub.log" "$X0"
check "  ...keeping the legacy token" test "$(field "$APP/tray.json" token)" = "$LEGACY"
X1=$(grep -c "POST /api/codex-hub/exchange 401" "$T/hub.log")
wait_for 10 up_headless
kill -USR1 "$(tray_pid)"
check "  ...and asking again at the next check" wait_for 20 more "POST /api/codex-hub/exchange 401" "$T/hub.log" "$X1"
stop_tray

# Another install id in the pusher's file than the one the hub has for the pending key: refused too.
curl -s -X POST "$HUB2/fake/pending?pc=E2E-Elsewhere&install=e2e-elsewhere-install" >/dev/null
cp "$HOME/.agenthydra/codex-hub-push-install" "$T/install.kept"
echo e2e-another-install-1 >"$HOME/.agenthydra/codex-hub-push-install"
legacy_at "$HUB2"
S0=$(status_count "This PC must be paired again: choose Connect this PC")
headless
check "with another install id in the pusher's file, the exchange is refused (401)" \
	wait_for 30 grep -q "bearer=legacy install=e2e-another-install-1 POST /api/codex-hub/exchange 401" "$T/hub2.log"
check "  ...and the status says so" wait_for 10 status_more "This PC must be paired again: choose Connect this PC" "$S0"
stop_tray
cp "$T/install.kept" "$HOME/.agenthydra/codex-hub-push-install"

echo "== an old tray moving"
# The tray of the commit before PC tokens, installed and paired the way it was: the legacy token in tray.json. It
# fetches the pusher and this tray with the legacy token (the hub hands builds to it while a PC is pending), and this
# tray then moves it.
OLD=24227516
if git -C .. cat-file -e "$OLD^{commit}" 2>/dev/null && mkdir -p "$T/old" &&
	git -C .. archive "$OLD" codex-hub-tray | tar -x -C "$T/old" &&
	(cd "$T/old/codex-hub-tray" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w $FLAGS" -o "$T/old-tray" .); then
	# An install id of its own: $INSTALL is e2e-old-pc's since its exchange, so the hub would not let it move again.
	OLDINST=e2e-old-tray-install-1
	cp "$HOME/.agenthydra/codex-hub-push-install" "$T/install.kept"
	echo "$OLDINST" >"$HOME/.agenthydra/codex-hub-push-install"
	check "the hub's rule: an install id a PC has is not pending again" \
		test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HUB2/fake/pending?pc=E2E-Old-Tray&install=$INSTALL")" = 409
	curl -s -X POST "$HUB2/fake/pending?pc=E2E-Old-Tray&install=$OLDINST" >/dev/null
	install -m 755 "$T/old-tray" "$TRAY"
	rm -f "$PUSH"
	legacy_at "$HUB2"
	E0=$(grep -c "bearer=legacy install=$OLDINST POST /api/codex-hub/exchange 200" "$T/hub2.log")
	headless
	check "the old tray starts" wait_for 10 up_headless
	kill -USR1 "$(tray_pid)"
	check "it fetches the pusher with the legacy token" \
		wait_for 30 grep -q "bearer=legacy install=- GET /api/codex-hub/pusher/download platform=$P 200" "$T/hub2.log"
	check "it replaces itself with this tray" wait_for 30 has_sha "$TRAY" "$V1"
	check "  ...fetched with the legacy token" grep -q "bearer=legacy install=- GET /api/codex-hub/tray/download platform=$P 200" "$T/hub2.log"
	check "this tray's exchange is taken, with the id in codex-hub-push-install" \
		wait_for 30 more "bearer=legacy install=$OLDINST POST /api/codex-hub/exchange 200" "$T/hub2.log" "$E0"
	MOVED=$(field "$APP/tray.json" token)
	check "tray.json holds a token of this PC's own" pc_token "$MOVED"
	check "  ...and its name" test "$(field "$APP/tray.json" pc)" = e2e-old-tray
	check "the pusher gets the token, the name and the install id" wait_for 20 env_is "AGENTHYDRA_CODEX_HUB_TOKEN=$MOVED"
	check "  ...the name" env_is "AGENTHYDRA_CODEX_HUB_PC=e2e-old-tray"
	check "  ...the install id" env_is "AGENTHYDRA_CODEX_HUB_INSTALL=$OLDINST"
	stop_tray
	cp "$T/install.kept" "$HOME/.agenthydra/codex-hub-push-install"

	# The same old tray with a token from the hub's command line, written in by hand: it updates itself as well.
	install -m 755 "$T/old-tray" "$TRAY"
	ADDED=$(curl -s -X POST "$HUB2/fake/add?pc=E2E-Old-Hand")
	printf '{\n  "hub": "%s",\n  "token": "%s"\n}\n' "$HUB2" "$ADDED" >"$APP/tray.json"
	headless
	check "an old tray with a token of its own replaces itself with this tray" wait_for 30 has_sha "$TRAY" "$V1"
	check "  ...fetched with that token" grep -q "bearer=chp_${ADDED:4:16} install=- GET /api/codex-hub/tray/download platform=$P 200" "$T/hub2.log"
	check "  ...which this tray names (whoami)" wait_for 20 named E2E-Old-Hand "${ADDED:4:16}"
	stop_tray
elif [ "${CI:-}" = true ]; then
	fail "the tray of $OLD could not be built (the workflow checks out with fetch-depth: 0)"
else
	echo "SKIP: the tray of $OLD could not be built (a shallow checkout?)"
fi

echo "== revoked"
cp "$T/paired.json" "$APP/tray.json"
S0=$(status_count "Pushing this PC's Codex chats as E2E-PC")
headless
check "the paired tray starts" wait_for 10 up_headless
check "  ...and pushes" wait_for 30 status_more "Pushing this PC's Codex chats as E2E-PC" "$S0"
curl -s -X POST "$HUB/fake/revoke?pc=E2E-PC" >/dev/null
{ cat "$T/push-good"; echo "# a build after the revoke"; } >"$T/push-late"
publish "$T/push-late" "codex-hub-push-$P"
D0=$(downloads)
S0=$(status_count "The hub revoked this PC: choose Connect this PC to pair it again")
kill -USR1 "$(tray_pid)"
check "the status says the hub revoked this PC" \
	wait_for 20 status_more "The hub revoked this PC: choose Connect this PC to pair it again" "$S0"
check "  ...and the hub's new pusher build is never downloaded" test $(($(downloads) - D0)) -eq 0 -a "$(sha "$PUSH")" = "$PUSHSUM"
stop_tray
publish "$T/push-good" "codex-hub-push-$P"

echo "== against the real hub"
if command -v bun >/dev/null && [ -e ../node_modules ]; then
	RADMIN="e2e-Real-Admin_0123456789"
	RLEGACY="e2e-Real-Legacy_0123456789"
	mkdir -p "$T/realhub"
	bun ../scripts/codex-hub-test-daemon.ts --admin "$RADMIN" --legacy "$RLEGACY" --home "$T/realhub" \
		>"$T/realhub.url" 2>"$T/realhub.err" &
	REALHUB=$!
	if wait_for 60 test -s "$T/realhub.url"; then
		RHUB=$(head -1 "$T/realhub.url")
		RDIR=$(sed -n 's/^hub folder: //p' "$T/realhub.err")
		pass "the hub starts ($RHUB)"
		printf '{\n  "hub": "%s"\n}\n' "$RHUB" >"$APP/tray.json"
		L0=$(log_count "open in a browser on this PC: https://inbox.example.test/codex-hub/pair?")
		headless AGENTHYDRA_CODEX_HUB_PC=E2E-Real-PC
		check "a tray with no token opens the pairing page" \
			wait_for 20 more "open in a browser on this PC: https://inbox.example.test/codex-hub/pair?" "$LOG" "$L0"
		LINK=$(grep -o 'https://inbox.example.test/codex-hub/pair?[^ ]*' "$LOG" | tail -1)
		RPORT=$(echo "$LINK" | grep -o 'port=[0-9]*' | cut -d= -f2)
		RSTATE=$(echo "$LINK" | grep -o 'state=[0-9a-f]*' | cut -d= -f2)
		# The inbox's proxy forwards the page with Host 127.0.0.1.
		code=$(curl -s -o "$T/realpage.html" -w '%{http_code}' -H "Host: 127.0.0.1" "$RHUB/codex-hub/pair?${LINK#*\?}")
		RCODE=$(grep -o 'name="code" value="[0-9a-f]*"' "$T/realpage.html" | head -1 | sed 's/.*value="//; s/"$//')
		check "the hub's page (200) holds a code" test "$code" = 200 -a -n "$RCODE"
		code=$(curl -s -o "$T/post.html" -w '%{http_code}' -d "state=$RSTATE" -d "code=$RCODE" "http://127.0.0.1:$RPORT/paired")
		check "the tray takes it (200)" test "$code" = 200
		check "  ...connected as the name it asked for" grep -q "connected as E2E-Real-PC" "$T/post.html"
		RTOKEN=$(field "$APP/tray.json" token)
		check "  ...with a token of its own in tray.json" pc_token "$RTOKEN"
		code=$(curl -s -o "$T/whoami.json" -w '%{http_code}' -H "Authorization: Bearer $RTOKEN" -H "x-codex-hub-install: $INSTALL" "$RHUB/api/codex-hub/whoami")
		check "whoami with that token is 200" bash -c "[ '$code' = 200 ] && grep -q '\"pc\":\"E2E-Real-PC\"' '$T/whoami.json'"
		check "the tray pushes as that name" wait_for 30 status_more "Pushing this PC's Codex chats as E2E-Real-PC" 0

		# A second PC, still on the legacy token, which pushed from its own install: the hub has its folder, pending.
		HOME2="$T/home2"
		APP2="$HOME2/.local/share/codex-hub"
		mkdir -p "$APP2" "$HOME2/.agenthydra" "$RDIR/e2e-moving-pc"
		echo e2e-second-install-1 >"$HOME2/.agenthydra/codex-hub-push-install"
		printf '{"pc":"E2E-Moving-PC","install":"e2e-second-install-1","pushedAt":"%s","threads":[],"files":{}}' \
			"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >"$RDIR/e2e-moving-pc/manifest.json"
		: >"$RDIR/e2e-moving-pc/session_index.jsonl"
		cp "$T/dl/codex-hub-tray-$P" "$APP2/codex-hub-tray"
		printf '{\n  "hub": "%s",\n  "token": "%s"\n}\n' "$RHUB" "$RLEGACY" >"$APP2/tray.json"
		(
			unset DBUS_SESSION_BUS_ADDRESS
			export HOME="$HOME2" XDG_RUNTIME_DIR="$T/run-empty"
			exec "$APP2/codex-hub-tray" >"$T/second-pc.out" 2>&1
		) &
		BG+=($!)
		if wait_for 10 grep -qs "no desktop session to show an icon in" "$APP2/tray.log"; then
			kill -USR1 "$(tr -dc 0-9 <"$APP2/tray.lock")"
		fi
		moved2() { pc_token "$(field "$APP2/tray.json" token)" && [ "$(field "$APP2/tray.json" pc)" = E2E-Moving-PC ]; }
		check "a second PC on the legacy token moves to a token of its own" wait_for 30 moved2
		code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(field "$APP2/tray.json" token)" \
			-H "x-codex-hub-install: e2e-second-install-1" "$RHUB/api/codex-hub/whoami")
		check "  ...which the hub knows (whoami 200)" test "$code" = 200
		kill -TERM "$(tr -dc 0-9 <"$APP2/tray.lock")" 2>/dev/null

		S0=$(status_count "The hub revoked this PC: choose Connect this PC to pair it again")
		AGENTHYDRA_CODEX_HUB_TOKEN=$RADMIN bun ../scripts/codex-hub-pcs.ts revoke E2E-Real-PC --hub "$RHUB" >"$T/revoke.out" 2>&1
		check "scripts/codex-hub-pcs.ts revokes the first PC" test $? -eq 0
		kill -USR1 "$(tray_pid)"
		check "  ...and the tray says the hub revoked it" \
			wait_for 20 status_more "The hub revoked this PC: choose Connect this PC to pair it again" "$S0"
	else
		fail "the real hub did not start: $(cat "$T/realhub.err")"
	fi
	stop_tray
	kill -TERM "$REALHUB" 2>/dev/null
	check "the real hub stops" wait_for 20 dead "$REALHUB"
	REALHUB=
elif [ "${CI:-}" = true ]; then
	fail "the real hub needs bun and the root's node_modules (bun install --frozen-lockfile at the root)"
else
	echo "SKIP: the real hub needs bun and the root's node_modules (bun install --frozen-lockfile at the root)"
fi

echo "== the fake hub"
CLOSING=$(curl -s -X POST "$HUB/fake/add?pc=E2E-Closing")
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CLOSING" "$HUB/api/codex-hub/pusher?platform=$P")
check "it refuses a request without the access header (403)" test "$code" = 403
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$ACCESS" -H "Authorization: Bearer $CLOSING" "$HUB/api/codex-hub/pusher?platform=")
check "it refuses an empty platform (400), as the hub does" test "$code" = 400
code=$(curl -s -o "$T/none.json" -w '%{http_code}' -H "$ACCESS" -H "Authorization: Bearer $CLOSING" "$HUB/api/codex-hub/pusher")
check "no platform is windows-x64 (no build of it here: 404)" bash -c "[ '$code' = 404 ] && grep -q windows-x64 '$T/none.json'"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$ACCESS" -H "Authorization: Bearer $ADMIN" "$HUB/api/codex-hub/pusher?platform=$P")
check "it refuses the admin token (401), as the hub does" test "$code" = 401

echo
if [ "$failures" -eq 0 ]; then
	echo "All checks passed."
else
	echo "$failures check(s) failed. Log: $LOG"
	KEEP=1
	exit 1
fi
