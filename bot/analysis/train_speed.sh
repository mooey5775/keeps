#!/bin/bash
# 5 production-mode iterations (1024 rounds each, 512 in play) with the given code tree; prints per-iteration timing.
set -e
python="$(cd "$(dirname "$0")/.." && pwd)/.venv-torch/bin/python"
tree=${1:?}
cd "$tree/bot"
rm -rf runs/speed
PYTHONPATH="$tree/bot" timeout 1500 "$python" -m keeps_bot.vrpo.train --run speed \
  --workers 8 --groups 2 --policy-every 1000 \
  --total-iterations 5 --collect-batch-size 1024 --rollout-batch-size 512 --checkpoint-interval 1000 >/dev/null 2>&1
"$python" -c "
import json
for l in open('runs/speed/log.jsonl'):
  d = json.loads(l); it = d['time/iteration_s']; p = d['time/play_share']
  print(f\"iteration {d['iteration']}: {it:5.2f} s = play {it * p:5.2f} s ({d['selfplay/decisions_per_s']:,.0f} decisions/s) + train {it * (1 - p):5.2f} s, peak {d['gpu/peak_allocated_gb']:.1f} GB\")"
rm -rf runs/speed
