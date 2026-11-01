"""MARVEL's training workflow for Keeps: their checkpointing, resume and metrics, our sampler and outputs.

VRPOTrainer (marvel/training/vrpo.py) drives this through MARVEL's runtime
interface, as it does their TrainingWorkflow; we change only:
  _make_sampler   our self-play (sampler.py) in place of MARVEL's environment sampler
  log_metrics     also to TensorBoard (runs/<run>/tb/train) and runs/<run>/log.jsonl
  evaluate        saves the policy MARVEL evaluates (the EMA of the weights,
                  agent_merging_beta) as runs/<run>/policy-<iteration>.pkl, the format
                  evaluate.py --watch, export.py and the bot read
"""

import json
import os
import time

import torch
from tensorboardX import SummaryWriter

from keeps_bot import game as keeps
from keeps_bot import policy as policies
from keeps_bot.vrpo import models
from keeps_bot.vrpo.sampler import Sampler
from marvel.training.workflow import TrainingWorkflow
from marvel.utils import unwrap_distributed_module


class Workflow(TrainingWorkflow):

  def __init__(self, cfg, *, keeps_args):
    self.keeps_args = keeps_args
    super().__init__(cfg, game=cfg.game)
    self.run_dir = str(cfg.logging_dir)
    self.writer = SummaryWriter(os.path.join(self.run_dir, 'tb', 'train')) if self.is_primary else None
    self._last = time.perf_counter()

  def _make_sampler(self):
    a = self.keeps_args
    return Sampler(game=self.game, device=self.device, rollout_batch_size=self.cfg.rollout_batch_size,
                   collect_batch_size=self.cfg.collect_batch_size, workers=a.workers, groups=a.groups,
                   seed=self.cfg.seed + self.rank)

  def log_metrics(self):
    iteration = self._require_iteration()
    now = time.perf_counter()
    seconds, self._last = now - self._last, now
    play = self.sampler.stats()
    rounds = max(play.get('rounds', 0), 1)
    self.capture_metrics({
        'selfplay/decisions_per_s': play.get('decisions', 0) / max(play.get('play_seconds', 0), 1e-9),
        'selfplay/round_length': play.get('round_decisions', 0) / rounds,
        'selfplay/cut_rate': play.get('rounds_cut', 0) / rounds,
        'selfplay/player0_win_rate': play.get('player0_wins', 0) / rounds,
        # Seconds per iteration, and the share of them spent playing (the rest is learning).
        'time/iteration_s': seconds,
        'time/play_share': play.get('play_seconds', 0) / max(seconds, 1e-9),
    })
    if torch.cuda.is_available() and self.device.type == 'cuda':
      self.capture_metrics({'gpu/peak_allocated_gb': torch.cuda.max_memory_allocated(self.device) / 2**30,
                            'gpu/peak_reserved_gb': torch.cuda.max_memory_reserved(self.device) / 2**30})
      torch.cuda.reset_peak_memory_stats(self.device)
    if self.writer is not None:
      metrics = {k: v for k, v in self._metric_buffer.items() if isinstance(v, (int, float)) and v is not None}
      for key, value in metrics.items():
        self.writer.add_scalar(key, value, iteration)
      self.writer.flush()
      with open(os.path.join(self.run_dir, 'log.jsonl'), 'a') as f:
        f.write(json.dumps({'iteration': iteration, **metrics}) + '\n')
    super().log_metrics()

  def evaluation_due(self):
    return self.is_primary and self._require_iteration() % self.keeps_args.policy_every == 0

  def evaluate(self, *, agent_policy):
    iteration = self._require_iteration()
    agent = unwrap_distributed_module(agent_policy)
    b = keeps.bridge()
    policies.save(os.path.join(self.run_dir, f'policy-{iteration}.pkl'), models.haiku_params(agent), (), b.num_actions,
                  learner_steps=iteration, decisions=int(self.env_steps_total), fingerprint=b.fingerprint,
                  network='entity', observation=2, layout=b.layout, algorithm='vrpo', postprocess='none')
