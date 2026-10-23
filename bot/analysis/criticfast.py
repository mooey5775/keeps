"""Critic chunk (8192 steps) forward + backward: as now (TF32), bf16 autocast, torch.compile; and how far Q moves."""
import types, torch
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
bi, ti = models._valid_steps(r); bi, ti = bi[:8192], ti[:8192]
obs = r['obs_channels'][bi, ti].float(); truth = r['critic_truth'][bi, ti].float(); mover = r['player_ids'][bi, ti]; legal = r['avail_weights'][bi, ti] > 0
def timed(fn, k=10):
  for _ in range(3): fn()
  torch.cuda.synchronize(); a = torch.cuda.Event(enable_timing=True); z = torch.cuda.Event(enable_timing=True); a.record()
  for _ in range(k): fn()
  z.record(); torch.cuda.synchronize(); return a.elapsed_time(z) / k
ref = critic.q_values(obs, truth, mover, legal).detach()
def bf16():
  with torch.autocast('cuda', dtype=torch.bfloat16): return critic.q_values(obs, truth, mover, legal).float()
compiled = torch.compile(critic.q_values)
for name, f in (('as now (TF32)', lambda: critic.q_values(obs, truth, mover, legal)), ('bf16 autocast', bf16), ('torch.compile', lambda: compiled(obs, truth, mover, legal))):
  ms = timed(lambda: f().square().sum().backward())
  with torch.no_grad(): q = f()
  print(f'{name:16s} {ms:6.1f} ms   max |ΔQ| vs now {float((q - ref).abs().max()):.1e}  (Q scale {float(ref.abs().max()):.2f})')
