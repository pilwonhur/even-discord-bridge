#!/bin/zsh
# Even Hub app dev server (P1). Listens on this Mac's Tailscale IP only (not the LAN), port 5173.
#   scripts/app-dev.sh start   start Vite detached (log: data/app-dev.log)
#   scripts/app-dev.sh stop
#   scripts/app-dev.sh qr [page]  print the QR to scan in the Even app (Even Hub tab → Scan QR)
#                                 page: index.html (default, Chris app) | spike.html | tts-spike.html
set -eu
ROOT="${0:A:h:h}"
IP="$(tailscale ip -4 | head -1)"
URL="http://$IP:5173"
# B-side sample for tts-spike.html (docs/p1/tts-design.md T0); same sentence as SHORT in app/src/tts-spike.ts.
SAMPLE="$ROOT/app/spike-assets/tts-sample.m4a"
SAMPLE_TEXT='안녕하세요, 크리스입니다. 지금은 음성 읽기 시험 중입니다. 이 문장이 들리면 아이폰에서 소리가 나오는 것입니다.'
case "${1:-}" in
  start)
    pgrep -f "vite --host $IP" >/dev/null && { echo "already running: $URL"; exit 0; }
    mkdir -p "$ROOT/data" "${SAMPLE:h}"
    [ -s "$SAMPLE" ] || say -v Yuna --file-format=m4af --data-format=aac -o "$SAMPLE" "$SAMPLE_TEXT"
    cd "$ROOT/app"
    nohup npx vite --host "$IP" --port 5173 --strictPort >> "$ROOT/data/app-dev.log" 2>&1 < /dev/null &
    disown
    for i in {1..40}; do curl -sf --max-time 1 "$URL/" >/dev/null && { echo "running: $URL"; exit 0; }; sleep 0.3; done
    echo "did not start; see data/app-dev.log" >&2; exit 1
    ;;
  stop) pkill -f "vite --host $IP" && echo stopped || echo "not running" ;;
  qr)   cd "$ROOT/app" && npx evenhub qr --url "$URL/${2:-}" ;;
  *)    sed -n 2,7p "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
