"""Two training runs, bit for bit: every tensor in the final checkpoint (models, optimizers, EMA),
every saved policy, and every logged training metric (timings aside)."""
import json, pickle, sys
import numpy as np, torch
a, b = sys.argv[1], sys.argv[2]
def flat(x, path=''):
  if isinstance(x, dict):
    for k, v in x.items(): yield from flat(v, f'{path}/{k}')
  elif isinstance(x, (list, tuple)):
    for i, v in enumerate(x): yield from flat(v, f'{path}/{i}')
  else: yield path, x
def same(x, y):
  if isinstance(x, torch.Tensor): return isinstance(y, torch.Tensor) and x.shape == y.shape and x.dtype == y.dtype and torch.equal(x, y)
  if isinstance(x, np.ndarray): return np.array_equal(x, y)
  return x == y
ca = dict(flat(torch.load(f'{a}/checkpoints/ckpt_3.pt', map_location='cpu', weights_only=False)))
cb = dict(flat(torch.load(f'{b}/checkpoints/ckpt_3.pt', map_location='cpu', weights_only=False)))
tensors = [k for k, v in ca.items() if isinstance(v, torch.Tensor)]
skip = ('time', 'wall', 'seconds', 'sampler')
diff = [k for k in ca if not any(s in k.lower() for s in skip) and (k not in cb or not same(ca[k], cb[k]))]
print(f'checkpoint: {len(tensors)} tensors ({sum(ca[k].numel() for k in tensors):,} numbers), {len(ca)} entries; differing: {diff[:8] or "none"}')
for it in (1, 2, 3):
  pa = dict(flat(pickle.load(open(f'{a}/policy-{it}.pkl', 'rb')))); pb = dict(flat(pickle.load(open(f'{b}/policy-{it}.pkl', 'rb'))))
  d = [k for k in pa if not same(pa[k], pb.get(k))]
  print(f'policy-{it}.pkl: {len(pa)} entries; differing: {d[:8] or "none"}')
la = [json.loads(l) for l in open(f'{a}/log.jsonl')]; lb = [json.loads(l) for l in open(f'{b}/log.jsonl')]
noisy = ('time/', 'decisions_per_s', 'gpu/')
for x, y in zip(la, lb):
  d = [k for k in x if not any(k.startswith(n) or n in k for n in noisy) and x[k] != y.get(k)]
  print(f'log iteration {x["iteration"]}: {len(x)} metrics; differing: {d or "none"}  (pg_loss {x.get("agent/pg_loss")}, qv_lbd_loss {x.get("critic/qv_lbd_loss")})')
