#!/bin/zsh
# Even Hub app dev server (P1). Listens on this Mac's Tailscale IP only (not the LAN), port 5173.
#   scripts/app-dev.sh start   start Vite detached (log: data/app-dev.log)
#   scripts/app-dev.sh stop
#   scripts/app-dev.sh qr      print the QR to scan in the Even app (Even Hub tab → Scan QR)
set -eu
ROOT="${0:A:h:h}"
IP="$(tailscale ip -4 | head -1)"
URL="http://$IP:5173"
case "${1:-}" in
  start)
    pgrep -f "vite --host $IP" >/dev/null && { echo "already running: $URL"; exit 0; }
    mkdir -p "$ROOT/data"
    cd "$ROOT/app"
    nohup npx vite --host "$IP" --port 5173 --strictPort >> "$ROOT/data/app-dev.log" 2>&1 < /dev/null &
    disown
    for i in {1..40}; do curl -sf --max-time 1 "$URL/" >/dev/null && { echo "running: $URL"; exit 0; }; sleep 0.3; done
    echo "did not start; see data/app-dev.log" >&2; exit 1
    ;;
  stop) pkill -f "vite --host $IP" && echo stopped || echo "not running" ;;
  qr)   cd "$ROOT/app" && npx evenhub qr --url "$URL" ;;
  *)    sed -n 2,6p "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
