"""vrpo1 played raw vs with R-NaD's test-time post-processing (as e1 is evaluated), on the evaluator's own matches."""
import json, sys
from keeps_bot import evaluate as ev
from keeps_bot import game as keeps
keeps.set_observation(2)
deals = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
for name in ('vrpo1-3350.pkl', 'vrpo1-3350-pp.pkl'):
  path = f'runs/analysis/{name}'
  out = {'policy': name}
  out.update(ev.benchmark(path, ('greedy', 'timer'), deals, 6))
  me = ev.resolve(path)
  for opp in ('runs/yardsticks/e1-316500.pkl', 'runs/analysis/e1-489000.pkl'):
    out[opp.split('/')[-1]] = ev.match(me, ev.resolve(opp), deals)
  print(json.dumps({k: (v if isinstance(v, str) else {'score': round(v['score'], 4), 'ci95': round(v['ci95'], 4)}) for k, v in out.items()}), flush=True)
