"""A policy sharpened at threshold t (moves under t dropped unless all are; renormalized) against the
benchmarks and against others, also sharpened. Usage: sharpen_both.py <deals> <t> <policy> [<opponent>...]"""
import json, sys
import numpy as np
from keeps_bot import evaluate as ev, export
from keeps_bot import game as keeps
keeps.set_observation(2)
deals, t, path, opponents = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3], sys.argv[4:]

def sharpened(p_path):
  raw = ev.resolve(p_path)
  def policy(obs, legal):
    p = raw(obs, legal).astype(np.float64)
    keep = (p >= t) | (p.max(axis=1, keepdims=True) < t)
    p = np.where(keep & (np.asarray(legal) > 0), p, 0.0)
    return p / p.sum(axis=1, keepdims=True)
  return policy

original_policy_file = export.policy_file
def policy_file(*a, **k):
  header, tensors = original_policy_file(*a, **k)
  header['postprocess'] = {'threshold': t, 'discretization': 0}
  return header, tensors
export.policy_file = policy_file
out = {'policy': path.split('/')[-1], 'threshold': t}
out.update(ev.benchmark(path, ('greedy', 'timer'), deals, 6))
me = sharpened(path)
for opp in opponents:
  out[opp.split('/')[-1] + f'@{t}'] = ev.match(me, sharpened(opp), deals)
print(json.dumps({k: (v if not isinstance(v, dict) else {'score': round(v['score'], 4), 'ci95': round(v['ci95'], 4)}) for k, v in out.items()}), flush=True)
