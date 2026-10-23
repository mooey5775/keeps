#!/bin/bash
# Keeps the demo serving vrpo1's newest policy. Every hour: look for a newer policy on gpu03; if there
# is one and nobody is playing (no bot move in the last 30 minutes), export it and restart the server
# with it (BOT=vrpo1, 512 worlds, sampled rollouts). While a game is in play, it retries every 5 minutes instead.
#   setsid nohup packages/learn/demo/autoupdate.sh > /dev/null 2>&1 &      (--once: one check, then exit)
# Log: packages/learn/demo/data/autoupdate.log
set -u
DEMO="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$DEMO/../../../bot" && pwd)"
LOG="$DEMO/data/autoupdate.log"
STEP_FILE="$DEMO/weights/vrpo1.step"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# 1 if someone has played in the last 30 minutes (the bot moved), else 0 (also when the server is down).
in_play() {
  curl -s --max-time 10 http://localhost:8789/data | python3 -c '
import json, sys, time
try:
    rooms = json.load(sys.stdin)["rooms"].values()
except Exception:
    print(0); sys.exit()
print(int(any(time.time() * 1000 - r["updated"] < 30 * 60 * 1000 for r in rooms)))'
}

restart() {
  for p in $(pgrep -f '^node server.ts$'); do
    [ "$(readlink /proc/$p/cwd)" = "$DEMO" ] && kill "$p"
  done
  sleep 2
  (cd "$DEMO" && BOT=vrpo1 SEARCH_WORLDS=512 SEARCH_ROLLOUTS=sampled setsid nohup node server.ts > "$DEMO/data/server.log" 2>&1 < /dev/null &)
  sleep 10
  head -1 "$DEMO/data/server.log" | grep -q "step $1" && log "serving vrpo1 $1" || log "ERROR: the server did not come back with step $1 (see data/server.log)"
}

while :; do
  newest=$(ssh -x -o BatchMode=yes -o ConnectTimeout=20 gpu03 'ls ~/src/keeps/bot/runs/vrpo1/policy-*.pkl | sort -t- -k2 -n | tail -1' 2>/dev/null)
  step=$(sed -n 's/.*policy-\([0-9]*\)\.pkl$/\1/p' <<< "$newest")
  current=$(cat "$STEP_FILE" 2>/dev/null || echo 0)
  if [ -z "$step" ]; then
    log "could not reach gpu03; next try in an hour"
  elif [ "$step" -le "$current" ]; then
    log "vrpo1 $current is still the newest"
  elif [ "$(in_play)" = "1" ]; then
    log "vrpo1 $step is newer than $current, but a game is in play; retrying in 5 minutes"
    [ "${1:-}" = "--once" ] && exit 0
    sleep 300
    continue
  else
    tmp="$DEMO/weights/policy-$step.pkl"
    if scp -q -o BatchMode=yes "gpu03:$newest" "$tmp" 2>/dev/null &&
       (cd "$BOT_DIR" && PYTHONPATH=. .venv/bin/python -m keeps_bot.export "$tmp" --out "$DEMO/weights/vrpo1-new.bin" --fixture "$DEMO/weights/vrpo1-new-parity.bin" > /dev/null 2>&1); then
      mv "$DEMO/weights/vrpo1-new.bin" "$DEMO/weights/vrpo1.bin"
      mv "$DEMO/weights/vrpo1-new-parity.bin" "$DEMO/weights/vrpo1-parity.bin"
      rm -f "$tmp"
      echo "$step" > "$STEP_FILE"
      log "exported vrpo1 $step (was $current); restarting the server"
      restart "$step"
    else
      log "ERROR: could not fetch or export vrpo1 $step; next try in an hour"
      rm -f "$tmp"
    fi
  fi
  [ "${1:-}" = "--once" ] && exit 0
  sleep 3600
done
