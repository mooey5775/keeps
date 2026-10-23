"""Policy call cost: eager vs a CUDA graph, by batch size; and whether the graph's output is bit-identical."""
import time, types, torch
torch.set_float32_matmul_precision('high'); torch.backends.cuda.matmul.allow_tf32 = True
from keeps_bot import game as keeps
from keeps_bot.vrpo import game as g, models
keeps.set_observation(2); b = keeps.bridge(); g.configure(128, b.observation_size, b.layout, b.truth_layout)
cfg = types.SimpleNamespace(game=g, model=types.SimpleNamespace(fuse_layers=2))
torch.manual_seed(0); agent = models.Agent(cfg).cuda()
O = b.observation_size
gen = torch.Generator().manual_seed(0)
def timeit(fn, k=50):
  for _ in range(5): fn()
  torch.cuda.synchronize(); t = time.perf_counter()
  for _ in range(k): fn()
  torch.cuda.synchronize(); return 1000 * (time.perf_counter() - t) / k
with torch.inference_mode():
  for n in (128, 256, 512):
    x = (torch.rand(n, O, generator=gen) < 0.1).half().cuda(); legal = torch.rand(n, 48, generator=gen).cuda() < 0.3; legal[:, 0] = True
    eager = timeit(lambda: agent.probabilities(x.float(), legal))
    sx, sl = x.clone(), legal.clone()
    s = torch.cuda.Stream(); s.wait_stream(torch.cuda.current_stream())
    with torch.cuda.stream(s):
      for _ in range(3): agent.probabilities(sx.float(), sl)
    torch.cuda.current_stream().wait_stream(s)
    graph = torch.cuda.CUDAGraph()
    with torch.cuda.graph(graph): out = agent.probabilities(sx.float(), sl)
    def replay(): sx.copy_(x); sl.copy_(legal); graph.replay(); return out
    gtime = timeit(replay)
    replay(); ref = agent.probabilities(x.float(), legal)
    print(f'n {n}: eager {eager:.2f} ms, graph {gtime:.2f} ms, bit-identical: {torch.equal(ref, out)}')
