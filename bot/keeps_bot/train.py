"""Trains the heads-up Keeps bot with R-NaD.

Run from bot/:
  PYTHONPATH= .venv/bin/python -m keeps_bot.train --run first

Self-play runs in `--workers` Node workers of `--rounds` rounds each (see
selfplay.py); the network runs on the GPU when JAX has one. Written to runs/<run>/:
  tb/train            training metrics, for TensorBoard
  log.jsonl           the same, as JSON lines
  policy-<step>.pkl   the policy every --eval-every steps (see policy.py), for evaluate.py --watch
  checkpoint-<step>.pkl  the whole solver every --save-every steps, to resume from

Live dashboard: run `evaluate.py --watch <run>` alongside, and
`tensorboard --logdir runs/<run>/tb`.
"""

import os

os.environ.setdefault('XLA_PYTHON_CLIENT_PREALLOCATE', 'false')  # share the GPU with the evaluator

import argparse
import json
import os
import pickle
import time

import jax
from tensorboardX import SummaryWriter

from keeps_bot import game as keeps
from keeps_bot import policy as policies
from keeps_bot import rnad
from keeps_bot import selfplay

RUNS = os.path.join(os.path.dirname(__file__), '..', 'runs')
# Batches are padded to the shortest of these that fits their longest round, so
# the learner compiles once per length rather than once per batch.
LENGTHS = (64, 96, 128, 160, 200, 256, 320)


class KeepsRNaD(rnad.RNaDSolver):
  """R-NaD fed by the self-play workers instead of OpenSpiel states."""

  def __init__(self, config, workers=14, rounds=128, groups=2, actors=1):
    self._workers, self._rounds, self._groups, self._actors = workers, rounds, groups, actors
    self.selfplay = None
    self.waited = 0.0  # seconds the learner has waited for self-play
    super().__init__(config)

  def __getstate__(self):
    return {**super().__getstate__(), 'workers': self._workers, 'rounds': self._rounds, 'groups': self._groups,
            'actors': self._actors}

  def __setstate__(self, state):
    self._workers, self._rounds = state['workers'], state['rounds']
    self._groups, self._actors = state.get('groups', 2), state.get('actors', 1)
    self.selfplay = None
    self.waited = 0.0
    super().__setstate__(state)

  def _policy(self, obs, legal):
    return self._network_jit_apply(self.params, rnad.EnvStep(obs=obs, legal=legal))

  def collect_batch_trajectory(self):
    if self.selfplay is None:
      game = keeps.bridge()
      self.selfplay = selfplay.SelfPlay(self._workers, self._rounds, self.config.trajectory_max,
                                        game.observation_size, game.num_actions, seed=self.config.seed,
                                        groups=self._groups)
      # Self-play runs ahead in the background with the latest parameters, at most two batches ahead.
      self.selfplay.start(self._policy, queue_max=2 * self.config.batch_size, threads=self._actors)
    play = self.selfplay
    started = time.perf_counter()
    episodes = play.wait(self.config.batch_size)
    self.waited += time.perf_counter() - started
    self.actor_steps = play.decisions
    longest = max(len(e.action) for e in episodes)
    length = next((n for n in LENGTHS if n > longest), LENGTHS[-1])
    return selfplay.batch(episodes, length, self._game.num_distinct_actions())


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--run', required=True, help='run name (folder under bot/runs)')
  parser.add_argument('--workers', type=int, default=14, help='Node self-play processes')
  parser.add_argument('--rounds', type=int, default=128, help='rounds in play per worker')
  parser.add_argument('--groups', type=int, default=2, help='worker groups (one policy call per group)')
  parser.add_argument('--actors', type=int, default=1, help='actor threads, each stepping its share of the groups')
  parser.add_argument('--steps', type=int, default=100_000, help='learner steps')
  parser.add_argument('--batch', type=int, default=256, help='rounds per learner step')
  parser.add_argument('--trajectory', type=int, default=200, help='decisions recorded per round (longer rounds are cut)')
  parser.add_argument('--layers', default='256,256')
  parser.add_argument('--lr', type=float, default=5e-5)
  parser.add_argument('--entropy-size', type=int, default=2000, help='learner steps per entropy-schedule iteration')
  parser.add_argument('--eta', type=float, default=0.2,
                      help="strength of the pull toward the regularization policy (R-NaD's eta_reward_transform)")
  parser.add_argument('--log-every', type=int, default=10)
  parser.add_argument('--eval-every', type=int, default=250, help='learner steps between saved policies (evaluated by evaluate.py --watch)')
  parser.add_argument('--save-every', type=int, default=2000, help='learner steps between full checkpoints')
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
      eta_reward_transform=args.eta,
      seed=args.seed,
  )
  if args.resume:
    with open(args.resume, 'rb') as f:
      solver = pickle.load(f)
  else:
    solver = KeepsRNaD(config, workers=args.workers, rounds=args.rounds, groups=args.groups, actors=args.actors)
  with open(os.path.join(run_dir, 'config.json'), 'w') as f:
    json.dump({**vars(args), 'observation_size': keeps.bridge().observation_size, 'fingerprint': keeps.bridge().fingerprint,
               'device': str(jax.devices()[0])}, f, indent=2)

  log_path = os.path.join(run_dir, 'log.jsonl')
  writer = SummaryWriter(os.path.join(run_dir, 'tb', 'train'))
  num_actions = keeps.bridge().num_actions

  def save_policy(step):
    play = solver.selfplay
    policies.save(os.path.join(run_dir, f'policy-{step}.pkl'), solver.params, config.policy_network_layers, num_actions,
                  learner_steps=step, decisions=play.decisions if play else 0, fingerprint=keeps.bridge().fingerprint)

  if solver.learner_steps == 0:
    save_policy(0)
  started = time.time()
  last = (started, 0, 0, 0, 0, 0.0)
  while solver.learner_steps < args.steps:
    logs = solver.step()
    step = solver.learner_steps
    play = solver.selfplay
    if step % args.log_every == 0:
      now = time.time()
      t0, d0, r0, l0, w0, idle0 = last
      rounds = play.rounds - r0
      entry = {
          'learner_steps': step,
          'decisions': play.decisions,
          'loss': float(logs['loss']),
          'decisions_per_s': round((play.decisions - d0) / max(now - t0, 1e-9)),
          'rounds': play.rounds,
          'round_length': round((play.round_decisions - l0) / max(1, rounds), 1),
          'player0_win_rate': round((play.player0_wins - w0) / max(1, rounds), 3),
          'cut_rate': round(play.rounds_cut / max(1, play.rounds), 4),
          # Near 1: self-play is the bottleneck; near 0: the learner is.
          'learner_idle': round((solver.waited - idle0) / max(now - t0, 1e-9), 3),
          'minutes': round((now - started) / 60, 1),
      }
      last = (now, play.decisions, play.rounds, play.round_decisions, play.player0_wins, solver.waited)
      print(json.dumps(entry), flush=True)
      with open(log_path, 'a') as f:
        f.write(json.dumps(entry) + '\n')
      for key in ('loss', 'decisions_per_s', 'round_length', 'player0_win_rate', 'cut_rate', 'learner_idle'):
        writer.add_scalar(f'train/{key}', entry[key], step)
      writer.add_scalar('train/decisions', play.decisions, step)
      writer.flush()
    if step % args.eval_every == 0:
      save_policy(step)
    if step % args.save_every == 0:
      with open(os.path.join(run_dir, f'checkpoint-{step}.pkl'), 'wb') as f:
        pickle.dump(solver, f)
  solver.selfplay.close()


if __name__ == '__main__':
  main()
