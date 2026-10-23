"""Profile VRPO self-play: time per part of a group step, and decisions/s, for a few worker/group settings.
  PYTHONPATH=bot bot/.venv-torch/bin/python sampler_profile.py [workers groups slots-in-play] ..."""
import sys
import time
import types
from collections import defaultdict

import numpy as np
import torch

torch.set_float32_matmul_precision('high')
torch.backends.cuda.matmul.allow_tf32 = True
from keeps_bot import game as keeps
from keeps_bot.vrpo import game as g, models
from keeps_bot.vrpo import sampler as sampler_mod

keeps.set_observation(2)
b = keeps.bridge()
g.configure(128, b.observation_size, b.layout, b.truth_layout)
cfg = types.SimpleNamespace(game=g, model=types.SimpleNamespace(fuse_layers=2))
torch.manual_seed(0)
agent = models.Agent(cfg).cuda()

times = defaultdict(float)


def timed(name, fn):
  def wrapper(*a, **k):
    t = time.perf_counter()
    out = fn(*a, **k)
    if torch.cuda.is_available() and 'policy' in name:
      torch.cuda.synchronize()
    times[name] += time.perf_counter() - t
    return out
  return wrapper


# Main thread only: whole group steps, waits for recordings, policy calls, finishing a collection.
sampler_mod.Sampler._step_group = timed('group step (total)', sampler_mod.Sampler._step_group)
orig_settle = sampler_mod.Sampler._settle
def settle(self, group=None):
  t = time.perf_counter(); orig_settle(self, group); times['  wait for recordings' if group is not None else 'settle at end'] += time.perf_counter() - t
sampler_mod.Sampler._settle = settle
orig_map = None
orig_probs = models.Agent.probabilities
sampler_mod.Sampler._policy = timed('  policy (GPU)', sampler_mod.Sampler._policy)
orig_rollout = sampler_mod.Sampler._rollout
sampler_mod.Sampler._rollout = timed('rollout to GPU', orig_rollout)
settings = [tuple(map(int, a.split(','))) for a in sys.argv[1:]] or [(8, 2, 512), (16, 4, 512)]
for workers, groups, slots in settings:
  times.clear()
  s = sampler_mod.Sampler(game=g, device='cuda', rollout_batch_size=slots, collect_batch_size=1024, workers=workers, groups=groups, seed=0)
  s.collect(agent_model=agent)  # warm-up
  s.stats()
  times.clear()
  t0 = time.perf_counter()
  for _ in range(2):
    s.collect(agent_model=agent)
  wall = time.perf_counter() - t0
  st = s.stats()
  s.close()
  print(f'\nworkers {workers}, groups {groups}, {slots} in play: {st["decisions"] / wall:,.0f} decisions/s ({st["decisions"]:,} in {wall:.1f} s)')
  for name, t in sorted(times.items(), key=lambda kv: -kv[1]):
    print(f'  {name:28s} {t:6.2f} s  {100 * t / wall:5.1f}%')
