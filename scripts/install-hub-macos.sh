#!/bin/sh
# Register an existing AgentHydra Community release installation as a user LaunchAgent.
# Updates are managed by AgentHydra itself; launchd only supervises the process.
set -eu

usage() { echo "usage: $0 /absolute/path/to/extracted/AgentHydra [--dry-run|--enable-native-updates]" >&2; exit 2; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
[ "$(uname -s)" = Darwin ] || { echo 'macOS only' >&2; exit 2; }
case "$1" in /*) ;; *) usage ;; esac
DIR=$(cd "$1" && pwd -P) || usage
[ -x "$DIR/agenthydra" ] || { echo 'Missing executable agenthydra launcher in install directory' >&2; exit 2; }
# Optional browser adapter executable for the ChatGPT experiment, supplied by the operator.
# It is a path only, never a browser profile or credential.
OPENCLI=${AGENTHYDRA_CHATGPT_OPENCLI:-}
if [ -n "$OPENCLI" ]; then
  case "$OPENCLI" in /*) ;; *) echo 'AGENTHYDRA_CHATGPT_OPENCLI must be an absolute path' >&2; exit 2 ;; esac
  [ -x "$OPENCLI" ] || { echo 'OpenCLI executable not found or not executable' >&2; exit 2; }
fi
case "$DIR$OPENCLI$HOME" in *'&'*|*'<'*|*'>'*|*'"'*|*"'"*) echo 'Install path contains characters unsupported in plist XML' >&2; exit 2;; esac
case "${2-}" in ''|'--dry-run'|'--enable-native-updates') ;; *) usage ;; esac
LABEL=biz.agenthydra.community.hub
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/AgentHydraCommunity"
if [ "${2-}" = '--dry-run' ]; then
  printf 'Would install launch agent %s using %s/agenthydra\n' "$PLIST" "$DIR"
  exit 0
fi
umask 077
mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"
if [ -e "$PLIST" ]; then
  cp -p "$PLIST" "$PLIST.before-$(date -u +%Y%m%dT%H%M%SZ)"
fi
TMP="$PLIST.tmp.$$"
trap 'rm -f "$TMP"' EXIT
# Homebrew's shell PATH is not inherited by launchd; carry a safe executable search path.
# The selected OpenCLI executable is private runtime configuration, not a public repo path.
cat > "$TMP" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DIR/agenthydra</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/opt/node@22/bin</string>
EOF
if [ -n "$OPENCLI" ]; then
  printf '    <key>AGENTHYDRA_CHATGPT_OPENCLI</key><string>%s</string>\n' "$OPENCLI" >> "$TMP"
fi
cat >> "$TMP" <<EOF
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$LOGS/hub.out.log</string>
  <key>StandardErrorPath</key><string>$LOGS/hub.err.log</string>
</dict></plist>
EOF
/usr/bin/plutil -lint "$TMP" >/dev/null
chmod 600 "$TMP"
mv "$TMP" "$PLIST"
UID_NOW=$(id -u)
launchctl bootout "gui/$UID_NOW/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_NOW" "$PLIST"
launchctl kickstart -k "gui/$UID_NOW/$LABEL"
echo 'AgentHydra Community registered with launchd.'
if [ "${2-}" = '--enable-native-updates' ]; then
  # Opt-in setting is stored by the existing Hydra updater in its own database.
  # This sends no credentials, and only targets the loopback daemon.
  success=0
  attempts=0
  while [ "$attempts" -lt 12 ]; do
    attempts=$((attempts + 1))
    if curl --fail --silent --show-error --max-time 3 -o /dev/null \
      -H 'Content-Type: application/json' -X POST \
      -d '{"enabled":true}' http://127.0.0.1:7787/api/update/settings 2>/dev/null; then
      success=1
      break
    fi
    sleep 1
  done
  if [ "$success" -ne 1 ]; then
    echo 'Hub registered, but native auto-updates could not be enabled: open Settings → Updates.' >&2
    exit 1
  fi
  echo 'Native Hydra updates enabled (no cron or external updater).'
else
  echo 'Native updates are available in Settings → Updates (off until enabled).'
fi
