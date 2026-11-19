#!/bin/zsh
# Live relay, foreground. All secrets come from the login Keychain and are never echoed.
#   even-relay-discord-bot-token  (required)  Discord bot token for the relay bot
#   even-relay-voice-token        (required)  P1 voice client token (/v1/ask), also pasted into the iPhone Shortcut
#   even-relay-client-token       (optional)  P0 template CLI token; random per run if absent
# Tailnet identity check: RELAY_TAILSCALE_LOGINS from env, else this Mac's own tailnet login.
# Speech to text: whisper-cli + ~/.cache/whisper/ggml-small.bin (RELAY_WHISPER_BIN / RELAY_WHISPER_MODEL override).
set -eu
cd "${0:A:h}/.."
kc() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null || true; }
export RELAY_MODE=live RELAY_PORT=${RELAY_PORT:-8787} RELAY_DB_PATH=${RELAY_DB_PATH:-./data/relay.sqlite} RELAY_PRINCIPAL_ID=${RELAY_PRINCIPAL_ID:-owner}
# Discord IDs (guild, channel, relay bot, Chris bot) live in config/live.env (untracked; see config/live.env.example).
[ -f config/live.env ] || { echo "missing config/live.env (copy config/live.env.example)" >&2; exit 1; }
set -a; . ./config/live.env; set +a
for v in DISCORD_GUILD_ID DISCORD_CHANNEL_ID DISCORD_RELAY_BOT_ID DISCORD_CHRIS_BOT_ID; do
  [ -n "${(P)v:-}" ] || { echo "config/live.env: $v is empty" >&2; exit 1; }
done
export DISCORD_BOT_TOKEN="$(kc even-relay-discord-bot-token)"
export RELAY_VOICE_TOKEN="$(kc even-relay-voice-token)"
export RELAY_CLIENT_TOKEN="$(kc even-relay-client-token)"
[ -n "$RELAY_CLIENT_TOKEN" ] || RELAY_CLIENT_TOKEN="$(openssl rand -hex 24)"
[ -n "$DISCORD_BOT_TOKEN" ] || { echo "missing Keychain item even-relay-discord-bot-token" >&2; exit 1; }
[ -n "$RELAY_VOICE_TOKEN" ] || { echo "missing Keychain item even-relay-voice-token (see docs/p1/siri-shortcut.md §1)" >&2; exit 1; }
if [ -z "${RELAY_TAILSCALE_LOGINS:-}" ]; then
  RELAY_TAILSCALE_LOGINS="$(tailscale status --json | python3 -I -c 'import sys,json;d=json.load(sys.stdin);print(d["User"][str(d["Self"]["UserID"])]["LoginName"])')"
fi
export RELAY_TAILSCALE_LOGINS
# CORS for the G2 app WebView (P1-01 S2 observed origin = the dev server on this Mac's tailnet IP).
if [ -z "${RELAY_ALLOWED_ORIGIN:-}" ]; then
  RELAY_ALLOWED_ORIGIN="http://$(tailscale ip -4 | head -1):5173"
  # Installed (.ehpk) app origins, one per line, observed in data/relay-live.log (not secret; data/ is untracked).
  if [ -f data/allowed-origins.txt ]; then
    for o in $(grep -v '^#' data/allowed-origins.txt); do RELAY_ALLOWED_ORIGIN="$RELAY_ALLOWED_ORIGIN,$o"; done
  fi
fi
export RELAY_ALLOWED_ORIGIN
# Silence cutoff for /v1/transcriptions, set with `npm run admin -- set-rms <n>` (default 500 in config).
if [ -z "${RELAY_STT_MIN_RMS:-}" ] && [ -f data/stt-min-rms.txt ]; then
  RELAY_STT_MIN_RMS="$(tr -dc 0-9 < data/stt-min-rms.txt)"
  [ -n "$RELAY_STT_MIN_RMS" ] && export RELAY_STT_MIN_RMS
fi
exec node src/main.ts
