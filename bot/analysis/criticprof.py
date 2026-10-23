"""Where the critic's training pass spends GPU time (one 8192-step chunk, forward + backward), by module."""
import types, torch, time
torch.set_float32_matmul_precision('high'); torch.backends.cuda.matmul.allow_tf32 = True
from keeps_bot import game as keeps
from keeps_bot.vrpo import game as g, models
from keeps_bot.vrpo.sampler import Sampler
keeps.set_observation(2); b = keeps.bridge(); g.configure(128, b.observation_size, b.layout, b.truth_layout)
cfg = types.SimpleNamespace(game=g, model=types.SimpleNamespace(fuse_layers=2))
torch.manual_seed(0)
agent = models.Agent(cfg).cuda(); critic = models.CentralCritic(cfg).cuda()
s = Sampler(game=g, device='cuda', rollout_batch_size=256, collect_batch_size=256, workers=8, groups=2, seed=3)
r = s.collect(agent_model=agent); s.close()
bi, ti = models._valid_steps(r)
bi, ti = bi[:8192], ti[:8192]
obs = r['obs_channels'][bi, ti].float(); truth = r['critic_truth'][bi, ti].float(); mover = r['player_ids'][bi, ti]; legal = r['avail_weights'][bi, ti] > 0
n = obs.shape[0]
def ev(): e = torch.cuda.Event(enable_timing=True); e.record(); return e
def timed(label, fn, k=10):
  for _ in range(3): fn()
  torch.cuda.synchronize(); a = ev()
  for _ in range(k): fn()
  z = ev(); torch.cuda.synchronize(); print(f'  {label:44s} {a.elapsed_time(z) / k:7.2f} ms')
print(f'critic, one chunk of {n} steps:')
timed('whole q_values, forward', lambda: critic.q_values(obs, truth, mover, legal))
timed('whole q_values, forward + backward', lambda: critic.q_values(obs, truth, mover, legal).square().sum().backward())
o2 = obs.reshape(2 * n, -1)
timed('torso on both views, forward', lambda: critic.torso(o2))
timed('torso on both views, forward + backward', lambda: critic.torso(o2)[0].square().sum().backward())
timed('truth encoder, forward + backward', lambda: critic.truth(truth).square().sum().backward())
st = torch.randn(n, 3 * models.FEATURE, device='cuda', requires_grad=True)
timed('mixer, forward + backward', lambda: critic.critic_mixer(st).square().sum().backward())
timed('agent probabilities, forward + backward', lambda: agent.probabilities(obs[torch.arange(n), mover], legal).square().sum().backward())
from torch.profiler import profile, ProfilerActivity
with profile(activities=[ProfilerActivity.CUDA]) as prof:
  for _ in range(3): critic.q_values(obs, truth, mover, legal).square().sum().backward()
  torch.cuda.synchronize()
print(prof.key_averages().table(sort_by='cuda_time_total', row_limit=18, max_name_column_width=70))
