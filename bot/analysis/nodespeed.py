"""Node alone: workers stepped with a random legal move, no recording. Upper bound on self-play speed."""
import sys, time, numpy as np
from keeps_bot import game as keeps, selfplay
keeps.set_observation(2); b = keeps.bridge()
for spec in sys.argv[1:]:
  workers, m, both, half = map(int, spec.split(","))
  ws = [selfplay.Worker(m, f'speed-{w}', b.observation_size, 48, observation=2, both=bool(both), half=bool(half)) for w in range(workers)]
  rng = np.random.default_rng(0)
  for w in ws: w.send(np.full(m, -1))
  n = 0; t0 = None
  for step in range(300):
    if step == 50: t0 = time.perf_counter(); n = 0
    for w in ws:
      w.receive()
      a = np.argmax(w.legal * rng.random(w.legal.shape), axis=1)
      w.send(a); n += m
  dt = time.perf_counter() - t0
  print(f'workers {workers} × {m} rounds, both={both} half={half}: {n / dt:,.0f} decisions/s')
  for w in ws: w.close()
