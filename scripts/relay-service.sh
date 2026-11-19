#!/bin/zsh
# Run the live relay as a per-user LaunchAgent: starts when this user logs in, restarts after a
# crash or a failed start (e.g. Tailscale not up yet), stays stopped after a clean stop.
# Secrets still come from the login Keychain via scripts/start-live.sh (nothing secret in the plist).
#
#   scripts/relay-service.sh install    write ~/Library/LaunchAgents/local.even-relay.plist and start
#   scripts/relay-service.sh status     launchd state + /healthz
#   scripts/relay-service.sh restart    stop and start again (e.g. after a code change)
#   scripts/relay-service.sh stop       clean stop (SIGTERM); stays stopped until start or next login
#   scripts/relay-service.sh start
#   scripts/relay-service.sh uninstall  stop and remove the LaunchAgent
set -eu
ROOT="${0:A:h:h}"
LABEL=local.even-relay
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PORT="${RELAY_PORT:-8787}"

case "${1:-}" in
  install)
    mkdir -p "$ROOT/data" "$HOME/Library/LaunchAgents"
    if pgrep -f "node src/main.ts" >/dev/null && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "a relay started by hand is still running (pgrep -f 'node src/main.ts'); stop it first" >&2
      exit 1
    fi
    python3 -I - "$ROOT" "$PLIST" "$LABEL" <<'EOF'
import plistlib, sys
root, plist, label = sys.argv[1:4]
spec = {
    'Label': label,
    'ProgramArguments': ['/bin/zsh', root + '/scripts/start-live.sh'],
    'WorkingDirectory': root,
    'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
    'RunAtLoad': True,
    'KeepAlive': {'SuccessfulExit': False},
    'ThrottleInterval': 30,
    'StandardOutPath': '/dev/null',
    'StandardErrorPath': root + '/data/relay-live.log',
}
with open(plist, 'wb') as f:
    plistlib.dump(spec, f)
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "installed $PLIST"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    ;;
  start)   launchctl kickstart "$DOMAIN/$LABEL" ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL" ;;
  stop)    launchctl kill TERM "$DOMAIN/$LABEL" ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E $'^\t(state|pid|last exit code|runs) =' || echo "$LABEL not loaded"
    curl -s --max-time 3 "http://127.0.0.1:$PORT/healthz" || echo "healthz: no answer"
    echo
    ;;
  *)
    sed -n 2,11p "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
