"""Old (HEAD) vs new sampler: same seeds and policy → identical rollouts, field by field, bit for bit.
Between collections the policy changes (as training would), identically in both runs."""
import importlib.util, sys, types
import torch, numpy as np
torch.set_float32_matmul_precision('high'); torch.backends.cuda.matmul.allow_tf32 = True
from keeps_bot import game as keeps
from keeps_bot.vrpo import game as g, models
from keeps_bot.vrpo import sampler as new_mod
spec = importlib.util.spec_from_file_location('sampler_head', sys.argv[1]); old_mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(old_mod)
keeps.set_observation(2); b = keeps.bridge(); g.configure(128, b.observation_size, b.layout, b.truth_layout)
cfg = types.SimpleNamespace(game=g, model=types.SimpleNamespace(fuse_layers=2))
workers, groups = int(sys.argv[2]), int(sys.argv[3])

def run(mod):
  torch.manual_seed(0); agent = models.Agent(cfg).cuda()
  torch.manual_seed(1)
  s = mod.Sampler(game=g, device='cuda', rollout_batch_size=512, collect_batch_size=1024, workers=workers, groups=groups, seed=7)
  out = []
  for it in range(3):
    r = s.collect(agent_model=agent)
    out.append({k: v.clone().cpu() for k, v in r.items()})
    with torch.no_grad():  # a "training step": the next collection plays a different policy
      for p in agent.parameters(): p.add_(0.05 * torch.sin(torch.arange(p.numel(), device=p.device, dtype=p.dtype).reshape(p.shape) * (it + 1)))
  st = s.stats(); s.close()
  return out, st, s.total_env_steps

old, old_st, old_n = run(old_mod)
new, new_st, new_n = run(new_mod)
print('stats equal:', old_st == new_st, {k: v for k, v in old_st.items() if k != 'play_seconds'} if False else '', 'env steps', old_n, new_n)
ok = True
for it, (a, c) in enumerate(zip(old, new)):
  for k in a:
    same = torch.equal(a[k], c[k])
    ok &= same
    if not same: print(f'collection {it}: {k} differs')
  print(f'collection {it}: {len(a)} fields, {int(a["num_steps"].sum()):,} steps, all identical: {all(torch.equal(a[k], c[k]) for k in a)}')
print('stats (without timing):', {k: (old_st[k], new_st.get(k)) for k in old_st if k != 'play_seconds'})
print('IDENTICAL' if ok and old_n == new_n else 'DIFFERENT')
