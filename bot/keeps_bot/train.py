"""Trains the heads-up Keeps bot with R-NaD.

Run from bot/:
  PYTHONPATH= .venv/bin/python -m keeps_bot.train --run first

Self-play runs in `--workers` Node workers of `--rounds` rounds each (see
selfplay.py); the network runs on the GPU when JAX has one. Logs go to stdout
and runs/<run>/log.jsonl; checkpoints (the pickled solver) to
runs/<run>/checkpoint-<step>.pkl.
"""

import argparse
import json
import os
import pickle
import time

import jax

from keeps_bot import game as keeps
from keeps_bot import rnad
from keeps_bot import selfplay

RUNS = os.path.join(os.path.dirname(__file__), '..', 'runs')
# Batches are padded to the shortest of these that fits their longest round, so
# the learner compiles once per length rather than once per batch.
LENGTHS = (64, 96, 128, 160, 200, 256, 320)


class KeepsRNaD(rnad.RNaDSolver):
  """R-NaD fed by the self-play workers instead of OpenSpiel states."""

  def __init__(self, config, workers=14, rounds=128):
    self._workers, self._rounds = workers, rounds
    self.selfplay = None
    super().__init__(config)

  def __getstate__(self):
    return {**super().__getstate__(), 'workers': self._workers, 'rounds': self._rounds}

  def __setstate__(self, state):
    self._workers, self._rounds = state['workers'], state['rounds']
    self.selfplay = None
    super().__setstate__(state)

  def _policy(self, obs, legal):
    return self._network_jit_apply(self.params, rnad.EnvStep(obs=obs, legal=legal))

  def collect_batch_trajectory(self):
    if self.selfplay is None:
      game = keeps.bridge()
      self.selfplay = selfplay.SelfPlay(self._workers, self._rounds, self.config.trajectory_max,
                                        game.observation_size, game.num_actions, seed=self.config.seed)
    play = self.selfplay
    play.run(self._policy, self.config.batch_size)
    episodes = play.take(self.config.batch_size)
    self.actor_steps = play.decisions
    longest = max(len(e.action) for e in episodes)
    length = next((n for n in LENGTHS if n > longest), LENGTHS[-1])
    return selfplay.batch(episodes, length, self._game.num_distinct_actions())


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--run', required=True, help='run name (folder under bot/runs)')
  parser.add_argument('--workers', type=int, default=14, help='Node self-play processes')
  parser.add_argument('--rounds', type=int, default=128, help='rounds in play per worker')
  parser.add_argument('--steps', type=int, default=100_000, help='learner steps')
  parser.add_argument('--batch', type=int, default=256, help='rounds per learner step')
  parser.add_argument('--trajectory', type=int, default=200, help='decisions recorded per round (longer rounds are cut)')
  parser.add_argument('--layers', default='256,256')
  parser.add_argument('--lr', type=float, default=5e-5)
  parser.add_argument('--entropy-size', type=int, default=2000, help='learner steps per entropy-schedule iteration')
  parser.add_argument('--log-every', type=int, default=10)
  parser.add_argument('--save-every', type=int, default=500)
  parser.add_argument('--resume', help='checkpoint to continue from')
  parser.add_argument('--seed', type=int, default=0)
  args = parser.parse_args()

  run_dir = os.path.abspath(os.path.join(RUNS, args.run))
  os.makedirs(run_dir, exist_ok=True)

  config = rnad.RNaDConfig(
      game_name='python_keeps_heads_up',
      state_representation=rnad.StateRepresentation.OBSERVATION,
      trajectory_max=args.trajectory,
      batch_size=args.batch,
      policy_network_layers=tuple(int(x) for x in args.layers.split(',')),
      learning_rate=args.lr,
      entropy_schedule_repeats=(1,),
      entropy_schedule_size=(args.entropy_size,),
      seed=args.seed,
  )
  if args.resume:
    with open(args.resume, 'rb') as f:
      solver = pickle.load(f)
  else:
    solver = KeepsRNaD(config, workers=args.workers, rounds=args.rounds)
  with open(os.path.join(run_dir, 'config.json'), 'w') as f:
    json.dump({**vars(args), 'observation_size': keeps.bridge().observation_size, 'device': str(jax.devices()[0])}, f, indent=2)

  log_path = os.path.join(run_dir, 'log.jsonl')
  started = time.time()
  last = (started, 0)
  while solver.learner_steps < args.steps:
    logs = solver.step()
    step = solver.learner_steps
    if step % args.log_every == 0:
      play = solver.selfplay
      now = time.time()
      rate = (play.decisions - last[1]) / max(now - last[0], 1e-9)
      last = (now, play.decisions)
      entry = {
          'learner_steps': step,
          'decisions': play.decisions,
          'loss': float(logs['loss']),
          'decisions_per_s': round(rate),
          'rounds': play.rounds,
          'cut_rate': round(play.rounds_cut / max(1, play.rounds), 4),
          'queued': len(play.episodes),
          'minutes': round((now - started) / 60, 1),
      }
      print(json.dumps(entry), flush=True)
      with open(log_path, 'a') as f:
        f.write(json.dumps(entry) + '\n')
    if step % args.save_every == 0:
      with open(os.path.join(run_dir, f'checkpoint-{step}.pkl'), 'wb') as f:
        pickle.dump(solver, f)
  solver.selfplay.close()


if __name__ == '__main__':
  main()
