"""Evaluates trained policies by playing them against each other.

Matches use duplicate deals: each of N deals is played twice, the policy under
test sitting at player 0 once and player 1 once, so the luck of the deal and of
going first cancels out. The score is the policy's win rate over the 2N rounds,
with a 95% interval from the per-deal scores.

  # one match
  PYTHONPATH= .venv/bin/python -m keeps_bot.evaluate runs/first/policy-5000.pkl random
  # follow a training run: evaluate each new policy as it's saved, for the dashboard
  PYTHONPATH= .venv/bin/python -m keeps_bot.evaluate --watch first

Watching evaluates every --every steps' policy (the newest, if it falls behind)
against the random player, the previously evaluated policy, the one from about
half as many steps ago, any fixed --yardstick policies (named after their files,
e.g. vs_e1-316500: a frozen reference every run is measured against), and the
rule-based benchmark players greedy and timer
(packages/learn/src/heuristics.ts, played in TypeScript on the same fixed deals
each time), and writes the results to runs/<run>/tb/eval (TensorBoard) and
runs/<run>/evals.jsonl. (It used to play the untrained network too; that
tracked the random player within a point or two.)

Each score is charted twice: by the run's own step (eval/...) and by millions of
decisions played (eval_by_decisions/...), the axis on which runs of different
learners compare at equal experience (an R-NaD step is 256 rounds, a VRPO
iteration 2,048). Evaluations from before that chart existed are added to it once,
from the decision counts their policy files recorded.
"""

import os

os.environ.setdefault('XLA_PYTHON_CLIENT_PREALLOCATE', 'false')  # share the GPU with training

import argparse
import glob
import json
import pickle
import re
import subprocess
import time

import numpy as np

from keeps_bot import export
from keeps_bot import game as keeps
from keeps_bot import policy as policies
from keeps_bot import rnad
from keeps_bot import selfplay

RUNS = os.path.join(os.path.dirname(__file__), '..', 'runs')
BENCHMARK = os.path.join(export.REPO, 'packages', 'learn', 'src', 'benchmark-cli.ts')


def benchmark(policy_path, opponents, deals, shards):
  """The policy against TypeScript benchmark players (greedy, timer), each on the same fixed deals every time.

  The policy is exported to the server's weights format and played by the
  TypeScript bot (the one checked against JAX); each opponent's deals are split
  across `shards` Node processes, all running at once.
  """
  _, saved = policies.load(policy_path)
  weights = policy_path + '.bench.bin'
  header, tensors = export.policy_file(saved, 'eval', saved.get('learner_steps', 0), keeps.bridge().fingerprint)
  export.write(weights, header, tensors)
  per = -(-deals // shards)
  jobs = {(o, k): subprocess.Popen(['node', BENCHMARK, weights, o, str(min(per, deals - k * per)), f'bench-{o}', str(k * per)],
                                   stdout=subprocess.PIPE, text=True)
          for o in opponents for k in range(shards) if k * per < deals}
  try:
    out = {key: json.loads(job.communicate()[0]) for key, job in jobs.items()}
  finally:
    os.remove(weights)
  results = {}
  for o in opponents:
    parts = [out[(o, k)] for k in range(shards) if (o, k) in out]
    per_deal = np.array([x for p in parts for x in p['perDeal']])
    n = len(per_deal)
    results[o] = {'score': float(per_deal.mean()), 'ci95': float(1.96 * per_deal.std(ddof=1) / np.sqrt(n)),
                  'as_player0': sum(p['asSeat0'] * p['deals'] for p in parts) / n,
                  'as_player1': sum(p['asSeat2'] * p['deals'] for p in parts) / n, 'deals': n}
  return results


def match(policy, opponent, deals=1000, seed='eval'):
  """`policy` against `opponent` on `deals` deals, both seats. Returns its score with a 95% interval and per-seat rates."""
  b = keeps.bridge()
  # Two workers with the same seed deal the same rounds slot by slot; in the first,
  # the policy is player 0, in the second player 1. Each slot's first round counts.
  workers = [selfplay.Worker(deals, seed, b.observation_size, b.num_actions) for _ in range(2)]
  results = np.zeros((2, deals))  # the policy's result, ±1
  finished = np.zeros((2, deals), bool)
  rng = np.random.default_rng(0)
  try:
    for w in workers:
      w.send(np.full(deals, -1))
    while not finished.all():
      for side, w in enumerate(workers):
        w.receive()
        new = w.done.astype(bool) & ~finished[side]
        # reward is player 0's result; the policy is player `side`.
        results[side, new] = w.reward[new] * (1 if side == 0 else -1)
        finished[side] |= new
        mine = w.player == side
        pi = np.where(mine[:, None], policy(w.obs, w.legal), opponent(w.obs, w.legal)).astype(np.float64)
        cdf = np.cumsum(pi, axis=1)
        u = rng.random((deals, 1)) * cdf[:, -1:]
        w.send(np.minimum((cdf <= u).sum(axis=1), pi.shape[1] - 1))
  finally:
    for w in workers:
      w.close()
  wins = (results + 1) / 2  # 1 for a win, 0 for a loss
  per_deal = wins.mean(axis=0)
  return {
      'score': float(per_deal.mean()),
      'ci95': float(1.96 * per_deal.std(ddof=1) / np.sqrt(deals)),
      'as_player0': float(wins[0].mean()),
      'as_player1': float(wins[1].mean()),
      'deals': deals,
  }


def resolve(name, run_dir=None):
  if name == 'random':
    return policies.uniform
  path = name if os.path.exists(name) else os.path.join(run_dir or '', name)
  return policies.load(path)[0]


def _step_of(path):
  return int(re.search(r'policy-(\d+)\.pkl$', path).group(1))


def _by_decisions(writer, entry, decisions):
  """An evaluation's scores on the eval_by_decisions charts (step: millions of decisions played)."""
  for name, result in entry.items():
    if isinstance(result, dict) and 'score' in result:
      writer.add_scalar(f'eval_by_decisions/vs_{name}', result['score'], round(decisions / 1e6))


def _backfill_by_decisions(writer, run_dir, log_path):
  """Charts, by decisions, the evaluations made before that chart existed (once per run)."""
  marker = os.path.join(run_dir, 'tb', 'eval', '.by_decisions')
  if os.path.exists(marker) or not os.path.exists(log_path):
    return
  with open(log_path) as f:
    entries = [json.loads(line) for line in f]
  for entry in entries:
    decisions = entry.get('decisions')
    if decisions is None:
      path = os.path.join(run_dir, f'policy-{entry["step"]}.pkl')
      if not os.path.exists(path):
        continue
      with open(path, 'rb') as f:
        decisions = pickle.load(f).get('decisions')
    if decisions is not None:
      _by_decisions(writer, entry, decisions)
  writer.flush()
  open(marker, 'w').close()


def watch(run, deals, poll, every, heuristics=('greedy', 'timer'), heuristic_deals=1000, shards=4, yardsticks=()):
  from tensorboardX import SummaryWriter

  run_dir = os.path.abspath(os.path.join(RUNS, run))
  writer = SummaryWriter(os.path.join(run_dir, 'tb', 'eval'))
  log_path = os.path.join(run_dir, 'evals.jsonl')
  _backfill_by_decisions(writer, run_dir, log_path)
  done = set()
  if os.path.exists(log_path):
    with open(log_path) as f:
      done = {json.loads(line)['step'] for line in f}
  loaded = {}
  decisions = {}  # step → decisions played by then (from the policy file)
  # Fixed reference policies: name (the file's) → (policy, observation version).
  fixed = {}
  for path in yardsticks:
    policy, saved = policies.load(path)
    fixed[os.path.splitext(os.path.basename(path))[0]] = (policy, saved.get('observation', 1))

  def get(step):
    if step not in loaded:
      policy, saved = policies.load(os.path.join(run_dir, f'policy-{step}.pkl'))
      # The observation version the policy reads, for the environment servers and workers the
      # matches start (from the policy itself: the run's config.json may not exist yet).
      keeps.set_observation(saved.get('observation', 1))
      loaded[step] = policy
      decisions[step] = saved.get('decisions')
    return loaded[step]

  previous = max(done) if done else None
  while True:
    steps = sorted(_step_of(p) for p in glob.glob(os.path.join(run_dir, 'policy-*.pkl')))
    todo = [s for s in steps if s not in done and s > 0 and s % every == 0]
    if not todo:
      time.sleep(poll)
      continue
    step = todo[-1]  # the newest; skip any we fell behind on
    started = time.time()
    current = get(step)
    opponents = {'random': policies.uniform}
    if previous is not None:
      opponents['previous'] = get(previous)
    evaluated = sorted(done | {0})
    half = min(evaluated, key=lambda s: abs(s - step / 2))
    if half not in (0, previous):
      opponents['half'] = get(half)
    for name, (policy, version) in fixed.items():
      if version != keeps.OBSERVATION:  # a match runs both policies on one observation version
        raise SystemExit(f'yardstick {name} reads observation v{version}; run {run} reads v{keeps.OBSERVATION}')
      opponents[name] = policy
    entry = {'step': step}
    results = {name: match(current, opponent, deals, seed=f'eval-{step}') for name, opponent in opponents.items()}
    if heuristics:
      results.update(benchmark(os.path.join(run_dir, f'policy-{step}.pkl'), heuristics, heuristic_deals, shards))
    for name, result in results.items():
      entry[name] = {**result, **({'opponent_step': previous} if name == 'previous' else {}),
                     **({'opponent_step': half} if name == 'half' else {})}
      writer.add_scalar(f'eval/vs_{name}', result['score'], step)
      writer.add_scalar(f'eval_ci/vs_{name}_low', result['score'] - result['ci95'], step)
      writer.add_scalar(f'eval_ci/vs_{name}_high', result['score'] + result['ci95'], step)
      writer.add_scalar(f'eval_seats/vs_{name}_as_player0', result['as_player0'], step)
      writer.add_scalar(f'eval_seats/vs_{name}_as_player1', result['as_player1'], step)
    entry['seconds'] = round(time.time() - started, 1)
    if decisions.get(step) is not None:
      entry['decisions'] = decisions[step]
      _by_decisions(writer, entry, decisions[step])
    writer.flush()
    with open(log_path, 'a') as f:
      f.write(json.dumps(entry) + '\n')
    print(json.dumps(entry), flush=True)
    done.add(step)
    previous = step
    # Keep only the policies later evals may still use.
    loaded = {s: p for s, p in loaded.items() if s == step}


def backtest(run, yardstick, deals, every):
  """Plays each saved policy of a run (steps that are multiples of `every`) against a fixed yardstick,
  as watch() does (the same deals: seed eval-<step>), and adds the scores to the run's charts.

  For a yardstick added after the run started. Coarse steps go first (every 16·`every`, then 8·, …),
  so the curve's shape shows early; steps watch() already played against it are skipped. Results also
  go to runs/<run>/backtest.jsonl (evals.jsonl stays watch()'s own).
  """
  from tensorboardX import SummaryWriter

  run_dir = os.path.abspath(os.path.join(RUNS, run))
  name = os.path.splitext(os.path.basename(yardstick))[0]
  opponent, saved_yardstick = policies.load(yardstick)
  version = saved_yardstick.get('observation', 1)
  done = set()
  for log in ('evals.jsonl', 'backtest.jsonl'):
    path = os.path.join(run_dir, log)
    if os.path.exists(path):
      with open(path) as f:
        done |= {e['step'] for e in map(json.loads, f) if name in e}
  steps = [s for s in sorted(_step_of(p) for p in glob.glob(os.path.join(run_dir, 'policy-*.pkl'))) if s > 0 and s % every == 0]
  order = []
  for stride in (16, 8, 4, 2, 1):
    order += [s for s in steps if s % (stride * every) == 0 and s not in order]
  order = [s for s in order if s not in done]
  writer = SummaryWriter(os.path.join(run_dir, 'tb', 'eval'))
  print(f'{len(order)} policies to play against {name}', flush=True)
  for step in order:
    policy, saved = policies.load(os.path.join(run_dir, f'policy-{step}.pkl'))
    if saved.get('observation', 1) != version:
      continue
    keeps.set_observation(version)
    started = time.time()
    result = match(policy, opponent, deals, seed=f'eval-{step}')
    writer.add_scalar(f'eval/vs_{name}', result['score'], step)
    writer.add_scalar(f'eval_ci/vs_{name}_low', result['score'] - result['ci95'], step)
    writer.add_scalar(f'eval_ci/vs_{name}_high', result['score'] + result['ci95'], step)
    writer.add_scalar(f'eval_seats/vs_{name}_as_player0', result['as_player0'], step)
    writer.add_scalar(f'eval_seats/vs_{name}_as_player1', result['as_player1'], step)
    entry = {'step': step, name: result, 'seconds': round(time.time() - started, 1)}
    if saved.get('decisions') is not None:
      entry['decisions'] = saved['decisions']
      _by_decisions(writer, entry, saved['decisions'])
    writer.flush()
    with open(os.path.join(run_dir, 'backtest.jsonl'), 'a') as f:
      f.write(json.dumps(entry) + '\n')
    print(json.dumps({'step': step, 'score': round(result['score'], 3), 'seconds': entry['seconds']}), flush=True)


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('policy', nargs='?', help='policy file (or "random")')
  parser.add_argument('opponent', nargs='?', default='random', help='policy file (or "random")')
  parser.add_argument('--watch', metavar='RUN', help='evaluate each new policy of a training run')
  parser.add_argument('--backtest', metavar='RUN', help="play a run's saved policies against --yardstick (one), for its charts")
  parser.add_argument('--deals', type=int, default=1000)
  parser.add_argument('--poll', type=float, default=10, help='seconds between checks for new policies')
  parser.add_argument('--every', type=int, default=1000, help='evaluate only policies whose step is a multiple of this')
  parser.add_argument('--heuristics', default='greedy,timer', help='benchmark players to play (comma-separated; empty for none)')
  parser.add_argument('--heuristic-deals', type=int, default=1000)
  parser.add_argument('--shards', type=int, default=4, help='Node processes per benchmark player')
  parser.add_argument('--yardstick', action='append', default=[], metavar='POLICY',
                      help='a fixed policy file every evaluation also plays (repeatable)')
  args = parser.parse_args()
  if args.backtest:
    if len(args.yardstick) != 1:
      parser.error('--backtest takes one --yardstick')
    backtest(args.backtest, args.yardstick[0], args.deals, args.every)
  elif args.watch:
    heuristics = tuple(h for h in args.heuristics.split(',') if h)
    watch(args.watch, args.deals, args.poll, args.every, heuristics, args.heuristic_deals, args.shards, args.yardstick)
  else:
    print(json.dumps(match(resolve(args.policy), resolve(args.opponent), args.deals)))


if __name__ == '__main__':
  main()
