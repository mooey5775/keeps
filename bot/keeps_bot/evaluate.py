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
against the random player, the previously evaluated policy and the one from
about half as many steps ago, and writes the results to runs/<run>/tb/eval
(TensorBoard) and runs/<run>/evals.jsonl. (It used to play the untrained
network too; that tracked the random player within a point or two.)
"""

import os

os.environ.setdefault('XLA_PYTHON_CLIENT_PREALLOCATE', 'false')  # share the GPU with training

import argparse
import glob
import json
import re
import time

import numpy as np

from keeps_bot import game as keeps
from keeps_bot import policy as policies
from keeps_bot import selfplay

RUNS = os.path.join(os.path.dirname(__file__), '..', 'runs')


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


def watch(run, deals, poll, every):
  from tensorboardX import SummaryWriter

  run_dir = os.path.abspath(os.path.join(RUNS, run))
  writer = SummaryWriter(os.path.join(run_dir, 'tb', 'eval'))
  log_path = os.path.join(run_dir, 'evals.jsonl')
  done = set()
  if os.path.exists(log_path):
    with open(log_path) as f:
      done = {json.loads(line)['step'] for line in f}
  loaded = {}

  def get(step):
    if step not in loaded:
      loaded[step] = policies.load(os.path.join(run_dir, f'policy-{step}.pkl'))[0]
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
    entry = {'step': step}
    for name, opponent in opponents.items():
      result = match(current, opponent, deals, seed=f'eval-{step}')
      entry[name] = {**result, **({'opponent_step': previous} if name == 'previous' else {}),
                     **({'opponent_step': half} if name == 'half' else {})}
      writer.add_scalar(f'eval/vs_{name}', result['score'], step)
      writer.add_scalar(f'eval_ci/vs_{name}_low', result['score'] - result['ci95'], step)
      writer.add_scalar(f'eval_ci/vs_{name}_high', result['score'] + result['ci95'], step)
      writer.add_scalar(f'eval_seats/vs_{name}_as_player0', result['as_player0'], step)
      writer.add_scalar(f'eval_seats/vs_{name}_as_player1', result['as_player1'], step)
    entry['seconds'] = round(time.time() - started, 1)
    writer.flush()
    with open(log_path, 'a') as f:
      f.write(json.dumps(entry) + '\n')
    print(json.dumps(entry), flush=True)
    done.add(step)
    previous = step
    # Keep only the policies later evals may still use.
    loaded = {s: p for s, p in loaded.items() if s == step}


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('policy', nargs='?', help='policy file (or "random")')
  parser.add_argument('opponent', nargs='?', default='random', help='policy file (or "random")')
  parser.add_argument('--watch', metavar='RUN', help='evaluate each new policy of a training run')
  parser.add_argument('--deals', type=int, default=1000)
  parser.add_argument('--poll', type=float, default=10, help='seconds between checks for new policies')
  parser.add_argument('--every', type=int, default=1000, help='evaluate only policies whose step is a multiple of this')
  args = parser.parse_args()
  if args.watch:
    watch(args.watch, args.deals, args.poll, args.every)
  else:
    print(json.dumps(match(resolve(args.policy), resolve(args.opponent), args.deals)))


if __name__ == '__main__':
  main()
