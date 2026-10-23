#!/bin/bash
# Trains 3 iterations with the given code tree (its bot/ on PYTHONPATH), deterministic, into <tree>/bot/runs/eq.
set -e
python="$(cd "$(dirname "$0")/.." && pwd)/.venv-torch/bin/python"
tree=${1:?}
cd "$tree/bot"
rm -rf runs/eq
CUBLAS_WORKSPACE_CONFIG=:4096:8 PYTHONHASHSEED=0 PYTHONPATH="$tree/bot" timeout 1500 "$python" -m keeps_bot.vrpo.train --run eq   --workers 4 --groups 2 --policy-every 1   --total-iterations 3 --collect-batch-size 512 --rollout-batch-size 256 --checkpoint-interval 3 --deterministic --seed 5
