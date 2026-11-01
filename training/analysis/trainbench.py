"""One minibatch (512 rounds) of actor and critic training passes: checkpointed chunks vs not.
Time, peak memory, and whether the gradients are bit-identical."""
import time, types, torch
torch.set_float32_matmul_precision('high'); torch.backends.cuda.matmul.allow_tf32 = True
from keeps_bot import game as keeps
from keeps_bot.vrpo import game as g, models
from keeps_bot.vrpo.sampler import Sampler
keeps.set_observation(2); b = keeps.bridge(); g.configure(128, b.observation_size, b.layout, b.truth_layout)
cfg = types.SimpleNamespace(game=g, model=types.SimpleNamespace(fuse_layers=2))
torch.manual_seed(0)
agent = models.Agent(cfg).cuda()
critic = models.CentralCritic(cfg, output_mode='qvalue').cuda() if 'output_mode' in models.CentralCritic.__init__.__code__.co_varnames else models.CentralCritic(cfg).cuda()
s = Sampler(game=g, device='cuda', rollout_batch_size=512, collect_batch_size=512, workers=8, groups=2, seed=3)
r = s.collect(agent_model=agent); s.close()
print('steps in the minibatch:', int(r['num_steps'].sum()))
real_checkpoint = models.checkpoint

def run(model, loss_of, checkpointed):
  models.checkpoint = real_checkpoint if checkpointed else (lambda fn, *a, use_reentrant: fn(*a))
  model.zero_grad(set_to_none=True)
  torch.cuda.synchronize(); torch.cuda.reset_peak_memory_stats(); base = torch.cuda.memory_allocated()
  t = time.perf_counter()
  loss_of(model(rollout=r)).backward()
  torch.cuda.synchronize()
  return time.perf_counter() - t, (torch.cuda.max_memory_allocated() - base) / 2**30, [p.grad.clone() for p in model.parameters() if p.grad is not None]

for name, model, loss_of in (('actor', agent, lambda o: (o.avail_probs.float() ** 2).sum()),
                             ('critic', critic, lambda o: (o.qvalues.float() ** 2).sum())):
  for checkpointed in (True, False, True, False):
    dt, mem, grads = run(model, loss_of, checkpointed)
    if checkpointed: ref = grads
    else: same = all(torch.equal(a, c) for a, c in zip(ref, grads))
    print(f'{name} {"checkpointed" if checkpointed else "plain       "}: {dt * 1000:7.1f} ms, peak +{mem:5.2f} GB' + ('' if checkpointed else f', gradients bit-identical: {same}'))
