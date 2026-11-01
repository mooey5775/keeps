"""Trains the Keeps bot with VRPO: MARVEL's trainer (marvel/training/vrpo.py), unchanged.

Run from training/ with the PyTorch environment:
  PYTHONPATH=. .venv-torch/bin/python -m keeps_bot.vrpo.train --run v1
  PYTHONPATH=. .venv-torch/bin/python -m keeps_bot.vrpo.train --run v1 --total-iterations 100   # any TrainConfig field

Keeps' own options (--run, --workers, --groups, --horizon, --policy-every) come first;
the rest are MARVEL's TrainConfig (marvel/config.py), defaulting to the settings of
VRPO's Dou Dizhu run (arXiv 2605.19235, Appendix E and Table 3; the same as Ataraxos's
Dou Dizhu policy, Table S27):
  40,000 iterations of 2,048 rounds (512 in play), 4 minibatches
  4 actor epochs (PPO clip 0.02) and 4 critic epochs, λ 0.95 for both
  Muon, learning rate 4e-4, both held for 5,000 iterations and then decayed as 1/t
  KL to uniform 0.1, held for 500 iterations and then decayed as 1/sqrt(t)
  weight decay 0.01, gradient norm clipped at 1
  the evaluated policy an exponential moving average of the weights (0.999)
One deliberate difference: the critic's replay buffer holds one iteration's rounds
(replay_buffer_scale 1), not 64. Their ablation (Appendix K.1) found 1 as good, and
64 iterations of our rounds (both players' observations at every step) would need
about 180 GB.

Written to runs/<run>/: tb/train (TensorBoard), log.jsonl, policy-<iteration>.pkl
(evaluated by `evaluate.py --watch <run> --every <policy-every>`, in the JAX
environment), checkpoints/ (resume with --resume-from <checkpoint>).
"""

import os

# Rollouts are a few GB each and come and go every iteration: without this, the freed
# blocks fragment and a 16 GB GPU runs out (it ran out at iteration 4 with 3.7 GB free but in pieces).
os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')

import argparse
import dataclasses
import json

import torch
import tyro

from keeps_bot import game as keeps
from keeps_bot.vrpo import game as vrpo_game
from keeps_bot.vrpo.workflow import Workflow
from marvel.config import TrainConfig
from marvel.training import registry
from marvel.utils import configure_torch

RUNS = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'runs'))


def dou_dizhu_settings(run_dir):
  """VRPO's Dou Dizhu settings (the rest are MARVEL's defaults, which are the paper's)."""
  return TrainConfig(
      algo_name='vrpo',
      game_name='keeps',
      run_name=os.path.basename(run_dir),
      logging_dir=run_dir,
      total_iterations=40_000,
      lr_stable_iterations=5_000,
      reg_stable_iterations=500,
      collect_batch_size=2048,
      rollout_batch_size=512,
      mini_batches=4,
      replay_buffer_scale=1,
      agent_merging_beta=0.999,
      checkpoint_interval=250,
      evaluation_interval=-1,  # MARVEL's evaluation routines are Dou Dizhu's; we save policies instead
      use_compile=False,
  )


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--run', required=True, help='run name (folder under training/runs)')
  parser.add_argument('--workers', type=int, default=8, help='Node self-play processes (sharing the rounds in play)')
  parser.add_argument('--groups', type=int, default=2, help='worker groups (one policy call per group)')
  parser.add_argument('--horizon', type=int, default=128, help='decisions recorded per round (longer rounds are dropped)')
  parser.add_argument('--policy-every', type=int, default=25, help='iterations between saved policies')
  args, rest = parser.parse_known_args()

  run_dir = os.path.join(RUNS, args.run)
  os.makedirs(run_dir, exist_ok=True)
  keeps.set_observation(2)
  b = keeps.bridge()
  vrpo_game.configure(args.horizon, b.observation_size, b.layout, b.truth_layout)
  cfg = tyro.cli(TrainConfig, default=dou_dizhu_settings(run_dir), args=rest)
  configure_torch(cfg)
  torch.set_float32_matmul_precision('high')  # as marvel/train.py
  torch.backends.cuda.matmul.allow_tf32 = True

  with open(os.path.join(run_dir, 'config.json'), 'w') as f:
    json.dump({'keeps': vars(args), 'marvel': dataclasses.asdict(cfg), 'observation_size': b.observation_size,
               'fingerprint': b.fingerprint, 'device': str(cfg.device)}, f, indent=2, default=str)

  trainer = registry.resolve(cfg.algo_name)(cfg, runtime_factory=lambda c: Workflow(c, keeps_args=args))
  trainer.run()


if __name__ == '__main__':
  main()
