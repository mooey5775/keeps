"""Fast self-play for training: many rounds per Node worker, stepped with binary frames.

Each worker (packages/learn/src/worker.ts) holds `rounds` rounds and deals a new
one in a slot as soon as its round ends, so no worker waits for a batch's
longest round. The actor steps the workers in turn: while it runs the policy on
one worker's frame, the others are computing theirs. Finished rounds queue up
as episodes; the learner builds its batches from them.

Each episode records, per decision: the observation, legal actions, player to
move, action taken and the probability the acting policy gave it (all R-NaD's
v-trace needs of the acting policy).
"""

import collections
import os
import subprocess
import threading
import time

import numpy as np

from keeps_bot import rnad

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WORKER = os.path.join(REPO, 'packages', 'learn', 'src', 'worker.ts')

Episode = collections.namedtuple('Episode', 'obs legal player action prob result')
# result: the round's result for player 0 (+1/-1), or None if it ran past the trajectory length.


class Worker:
  """One Node worker process and its frame layout."""

  def __init__(self, rounds, seed, obs_size, num_actions):
    self.m = rounds
    self._proc = subprocess.Popen(['node', WORKER, str(rounds), seed], cwd=os.path.dirname(WORKER),
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
    m, o, a = rounds, obs_size, num_actions
    self._buf = bytearray(m * o * 4 + m * a + m * 3)
    self._view = memoryview(self._buf)
    raw = np.frombuffer(self._buf, dtype=np.uint8)
    self.obs = raw[:m * o * 4].view('<f4').reshape(m, o)
    at = m * o * 4
    self.legal = raw[at:at + m * a].reshape(m, a)
    at += m * a
    self.player = raw[at:at + m].view(np.int8)
    self.done = raw[at + m:at + 2 * m]
    self.reward = raw[at + 2 * m:at + 3 * m].view(np.int8)

  def send(self, actions):
    self._proc.stdin.write(np.asarray(actions, dtype='<i4').tobytes())

  def receive(self):
    """Fills obs/legal/player/done/reward (views into one buffer, valid until the next receive)."""
    got, n = 0, len(self._buf)
    while got < n:
      k = self._proc.stdout.readinto(self._view[got:])
      if not k:
        raise RuntimeError('a self-play worker exited')
      got += k

  def close(self):
    self._proc.stdin.close()
    self._proc.stdout.close()
    self._proc.wait(timeout=10)


class SelfPlay:
  """Runs the workers with a policy and collects finished rounds as episodes."""

  def __init__(self, workers, rounds, trajectory_max, obs_size, num_actions, seed=0, groups=2):
    self.t_max = trajectory_max
    self.num_actions = num_actions
    self.workers = [Worker(rounds, f'{seed}-{w}', obs_size, num_actions) for w in range(workers)]
    m, t = rounds, trajectory_max
    # Each slot's round so far, by decision.
    self._obs = [np.zeros((m, t, obs_size), np.float32) for _ in self.workers]
    self._legal = [np.zeros((m, t, num_actions), np.uint8) for _ in self.workers]
    self._player = [np.zeros((m, t), np.int8) for _ in self.workers]
    self._action = [np.zeros((m, t), np.int32) for _ in self.workers]
    self._prob = [np.zeros((m, t), np.float32) for _ in self.workers]
    self._len = [np.zeros(m, np.int64) for _ in self.workers]
    self.episodes = collections.deque()
    self.decisions = 0
    self.rounds = 0
    self.rounds_cut = 0
    self.round_decisions = 0  # summed over finished rounds
    self.player0_wins = 0
    self._seed = seed
    self._rng = np.random.default_rng(seed)
    self._count = threading.Lock()
    for w in self.workers:
      w.send(np.full(w.m, -1))
    # Workers are stepped a group at a time, one policy call per group: while the
    # actor handles one group, the other groups' workers are computing.
    self._groups = [list(range(g, workers, groups)) for g in range(min(groups, workers))]
    self._next = 0

  def run(self, policy, episodes):
    """Steps workers in turn until at least `episodes` episodes are queued. `policy(obs, legal)` → probabilities."""
    while len(self.episodes) < episodes:
      self._step_group(self._groups[self._next], policy)
      self._next = (self._next + 1) % len(self._groups)

  def take(self, count):
    return [self.episodes.popleft() for _ in range(count)]

  def start(self, policy, queue_max, threads=1):
    """Plays in background threads (so the learner can work meanwhile), pausing while `queue_max` episodes wait.

    Each thread steps its own share of the groups. Most of the work (pipe reads,
    numpy, the policy) releases the GIL, so a few threads go faster than one.
    """
    self._error = None

    def loop(groups, rng):
      try:
        while not self._stop:
          for group in groups:
            while len(self.episodes) >= queue_max and not self._stop:
              time.sleep(0.001)
            self._step_group(group, policy, rng)
      except Exception as error:  # surfaced to the learner by wait()
        self._error = error

    self._stop = False
    threads = min(threads, len(self._groups))
    self._threads = [
        threading.Thread(target=loop, args=(self._groups[j::threads], np.random.default_rng([self._seed, j])), daemon=True)
        for j in range(threads)
    ]
    for thread in self._threads:
      thread.start()

  def wait(self, count):
    """The next `count` episodes from the background thread, once played."""
    while len(self.episodes) < count:
      if self._error:
        raise self._error
      time.sleep(0.001)
    return self.take(count)

  def _step_group(self, group, policy, rng=None):
    for w in group:
      worker = self.workers[w]
      worker.receive()
      for i in np.flatnonzero(worker.done):
        self._finish(w, i, int(worker.reward[i]))
    obs = np.concatenate([self.workers[w].obs for w in group])
    legal = np.concatenate([self.workers[w].legal for w in group])
    pi = np.asarray(policy(obs, legal), dtype=np.float64)
    # Sample one action per row (inverse CDF; u < total, so a zero-probability action is never picked).
    cdf = np.cumsum(pi, axis=1)
    u = (rng or self._rng).random((pi.shape[0], 1)) * cdf[:, -1:]
    actions = np.minimum((cdf <= u).sum(axis=1), pi.shape[1] - 1)
    probs = pi[np.arange(len(actions)), actions] / cdf[:, -1]
    at = 0
    for w in group:
      worker = self.workers[w]
      m = worker.m
      self._record(w, worker, actions[at:at + m], probs[at:at + m])
      worker.send(actions[at:at + m])
      at += m

  def _record(self, w, worker, actions, probs):
    length = self._len[w]
    rows = np.flatnonzero(length < self.t_max)
    t = length[rows]
    self._obs[w][rows, t] = worker.obs[rows]
    self._legal[w][rows, t] = worker.legal[rows]
    self._player[w][rows, t] = worker.player[rows]
    self._action[w][rows, t] = actions[rows]
    self._prob[w][rows, t] = probs[rows]
    length[:] += 1  # past t_max: no longer recorded, the episode is cut
    with self._count:
      self.decisions += worker.m

  def _finish(self, w, i, reward):
    n = int(self._len[w][i])
    cut = n > self.t_max
    with self._count:
      self.round_decisions += n
      self.player0_wins += reward > 0
      self.rounds += 1
      self.rounds_cut += cut
    n = min(n, self.t_max)
    self.episodes.append(Episode(
        obs=self._obs[w][i, :n].copy(), legal=self._legal[w][i, :n].copy(), player=self._player[w][i, :n].copy(),
        action=self._action[w][i, :n].copy(), prob=self._prob[w][i, :n].copy(), result=None if cut else reward))
    self._len[w][i] = 0

  def close(self):
    self._stop = True
    for thread in getattr(self, '_threads', []):
      thread.join()
    for w in self.workers:
      w.close()


def batch(episodes, length, num_actions):
  """Episodes as R-NaD's [T, B, ...] TimeStep, padded to `length` the way R-NaD pads finished rounds."""
  b = len(episodes)
  obs_size = episodes[0].obs.shape[1]
  obs = np.zeros((length, b, obs_size), np.float32)
  legal = np.zeros((length, b, num_actions), np.int8)
  legal[:, :, 0] = 1  # filler rows need some legal action
  player = np.zeros((length, b), np.float32)
  valid = np.zeros((length, b), np.float32)
  env_rewards = np.zeros((length, b, 2), np.float32)
  actor_rewards = np.zeros((length, b, 2), np.float32)
  action_oh = np.zeros((length, b, num_actions), np.float32)
  policy = np.zeros((length, b, num_actions), np.float32)
  for j, e in enumerate(episodes):
   n = len(e.action)
   steps = np.arange(n)
   obs[:n, j] = e.obs
   legal[:n, j] = e.legal
   player[:n, j] = e.player
   valid[:n, j] = 1
   action_oh[steps, j, e.action] = 1
   # Only the taken action's probability is ever read (v-trace's ratio pi/mu at the action).
   policy[steps, j, e.action] = e.prob
   action_oh[n:, j, 0] = 1
   policy[n:, j, 0] = 1
   if e.result is not None:
    result = (e.result, -e.result)
    env_rewards[n:, j] = result  # the terminal state and the padding after it
    actor_rewards[n - 1:, j] = result  # rewards after each step: the last one ends the round
  return rnad.TimeStep(
    env=rnad.EnvStep(obs=obs, legal=legal, player_id=player, valid=valid, rewards=env_rewards),
    actor=rnad.ActorStep(action_oh=action_oh, policy=policy, rewards=actor_rewards))
