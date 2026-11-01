"""vrpo1 sharpened: moves under a threshold dropped (unless all are), the rest renormalized, as R-NaD's
post-processing does at 3%; at higher thresholds. The same matches and benchmarks as the evaluator."""
import json, sys
import numpy as np
from keeps_bot import evaluate as ev, export
from keeps_bot import game as keeps
keeps.set_observation(2)
deals = int(sys.argv[1])
thresholds = [float(t) for t in sys.argv[2].split(',')]
path = 'runs/analysis/vrpo1-3350.pkl'
raw = ev.resolve(path)
original_policy_file = export.policy_file

def thresholded(t):
  def policy(obs, legal):
    p = raw(obs, legal).astype(np.float64)
    keep = (p >= t) | (p.max(axis=1, keepdims=True) < t)
    p = np.where(keep & (np.asarray(legal) > 0), p, 0.0)
    return p / p.sum(axis=1, keepdims=True)
  return policy

for t in thresholds:
  def policy_file(*a, **k):
    header, tensors = original_policy_file(*a, **k)
    header['postprocess'] = {'threshold': t, 'discretization': 0}
    return header, tensors
  export.policy_file = policy_file
  out = {'threshold': t}
  out.update(ev.benchmark(path, ('greedy', 'timer'), deals, 6))
  for opp in ('runs/yardsticks/e1-316500.pkl', 'runs/analysis/e1-489000.pkl'):
    out[opp.split('/')[-1]] = ev.match(thresholded(t), ev.resolve(opp), deals)
  print(json.dumps({k: (v if not isinstance(v, dict) else {'score': round(v['score'], 4), 'ci95': round(v['ci95'], 4)}) for k, v in out.items()}), flush=True)
