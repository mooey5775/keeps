"""Heads-up Keeps as an OpenSpiel game, backed by the TypeScript engine.

The rules exist only in the TypeScript engine (packages/engine). This module
runs the environment server (packages/learn/src/server.ts) as a Node child
process and forwards every state to it. One episode is one two-player round:
player 0 sits at seat 0, player 1 at seat 2; the winner gets +1, the loser -1.

The deal and Legerdemain's random steal come from the engine's seeded
generator, so the game is "sampled stochastic": new_initial_state() deals a
fresh random round, and there are no chance nodes.

Each step returns the player to move, their legal actions and observation in
one round trip; OpenSpiel's per-step queries are answered from that. For
training, `set_workers(n)` runs n servers and `new_states` / `step_states`
deal and step many rounds at once, spread across them, so the servers work
in parallel.
"""

import base64
import json
import os
import random
import subprocess
import threading

import numpy as np
import pyspiel

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SERVER = os.path.join(REPO, 'packages', 'learn', 'src', 'server.ts')


class Bridge:
  """A Node process running the environment server; one per Python process."""

  def __init__(self):
    self._proc = subprocess.Popen(
        ['node', SERVER],
        cwd=os.path.dirname(SERVER),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    self._lock = threading.Lock()
    self._pending_free = []
    info = self.call([{'op': 'info'}])[0]
    self.observation_size = info['observationSize']
    self.num_actions = info['numActions']
    self.action_names = info['actionNames']
    self.fingerprint = info['fingerprint']  # the encoder's (see packages/learn/src/fingerprint.ts)

  def send(self, ops):
    """Sends a request; read its results with receive(). Lets several servers work at once."""
    self._lock.acquire()
    if self._pending_free:
      ops = [{'op': 'free', 'ids': self._pending_free}] + ops
      self._drop = 1
      self._pending_free = []
    else:
      self._drop = 0
    self._proc.stdin.write(json.dumps({'ops': ops}) + '\n')

  def receive(self):
    try:
      line = self._proc.stdout.readline()
    finally:
      self._lock.release()
    if not line:
      raise RuntimeError('the environment server exited')
    response = json.loads(line)
    if 'error' in response:
      raise RuntimeError(f"environment server: {response['error']}")
    return response['results'][self._drop:]

  def call(self, ops):
    self.send(ops)
    return self.receive()

  def free(self, env_id):
    # Sent with the next request, to avoid a round trip per state.
    self._pending_free.append(env_id)

  def close(self):
    self._proc.stdin.close()
    self._proc.wait(timeout=10)


_bridges = []


def set_workers(n):
  """Runs n environment servers (new rounds are spread across them)."""
  while len(_bridges) < n:
    _bridges.append(Bridge())


def bridge(index=0):
  set_workers(index + 1)
  return _bridges[index]


_next_worker = 0


def _pick_worker():
  global _next_worker
  index = _next_worker % max(1, len(_bridges))
  _next_worker += 1
  return index


class EnvHandle:
  """Owns one environment in the server: copying it clones the round there, and it's freed with the handle.

  OpenSpiel clones a Python state by making a new initial state and deep-copying
  each attribute onto it, so the environment must live in an attribute whose deep
  copy is a real copy of the round.
  """

  def __init__(self, env_id, worker=0):
    self.id = env_id
    self.worker = worker

  def __deepcopy__(self, memo):
    return EnvHandle(bridge(self.worker).call([{'op': 'clone', 'id': self.id}])[0]['id'], self.worker)

  def __copy__(self):
    return self.__deepcopy__({})

  def __del__(self):
    if self.worker < len(_bridges):
      _bridges[self.worker].free(self.id)


def decode_obs(text):
  return np.frombuffer(base64.b64decode(text), dtype='<f4')


_NUM_PLAYERS = 2
# A round is rarely longer than a few hundred ids; this is a generous bound.
_MAX_GAME_LENGTH = 3000

_GAME_TYPE = pyspiel.GameType(
    short_name='python_keeps_heads_up',
    long_name='Keeps (heads-up round)',
    dynamics=pyspiel.GameType.Dynamics.SEQUENTIAL,
    chance_mode=pyspiel.GameType.ChanceMode.SAMPLED_STOCHASTIC,
    information=pyspiel.GameType.Information.IMPERFECT_INFORMATION,
    utility=pyspiel.GameType.Utility.ZERO_SUM,
    reward_model=pyspiel.GameType.RewardModel.TERMINAL,
    max_num_players=_NUM_PLAYERS,
    min_num_players=_NUM_PLAYERS,
    provides_information_state_string=False,
    provides_information_state_tensor=False,
    provides_observation_string=True,
    provides_observation_tensor=True,
    parameter_specification={'seed': -1},
)


class KeepsGame(pyspiel.Game):
  """One heads-up round of Keeps."""

  def __init__(self, params=None):
    params = params or {}
    b = bridge()
    info = pyspiel.GameInfo(
        num_distinct_actions=b.num_actions,
        max_chance_outcomes=0,
        num_players=_NUM_PLAYERS,
        min_utility=-1.0,
        max_utility=1.0,
        utility_sum=0.0,
        max_game_length=_MAX_GAME_LENGTH,
    )
    super().__init__(_GAME_TYPE, info, params)
    seed = params.get('seed', -1)
    self._rng = random.Random(None if seed is None or seed < 0 else seed)

  def new_initial_state(self, seed=None):
    """A freshly dealt round (from `seed`, or a random one)."""
    if seed is None:
      seed = f'{self._rng.getrandbits(64):016x}'
    worker = _pick_worker()
    return KeepsState(self, bridge(worker).call([{'op': 'new', 'seed': str(seed)}])[0], worker)

  def new_states(self, count, workers=None):
    """`count` freshly dealt rounds, spread across the servers `workers` (default: all), one request each."""
    workers = list(workers if workers is not None else range(max(1, len(_bridges))))
    by_worker = {w: [] for w in workers}
    for i in range(count):
      by_worker[workers[i % len(workers)]].append({'op': 'new', 'seed': f'{self._rng.getrandbits(64):016x}'})
    by_worker = {w: ops for w, ops in by_worker.items() if ops}
    for w, ops in by_worker.items():
      bridge(w).send(ops)
    return [KeepsState(self, status, w) for w in by_worker for status in bridge(w).receive()]

  def make_py_observer(self, iig_obs_type=None, params=None):
    return KeepsObserver(bridge().observation_size)


class KeepsState(pyspiel.State):
  """A round in progress: a handle to an environment in the Node server."""

  def __init__(self, game, status, worker=0):
    super().__init__(game)
    self._env = EnvHandle(status['id'], worker)
    self._set(status)

  def _set(self, status):
    self._player = status['player']
    self._legal = status['legal']
    self._terminal = status['terminal']
    self._returns = status['returns']
    self._obs = decode_obs(status['obs']) if status.get('obs') else None

  def current_player(self):
    return pyspiel.PlayerId.TERMINAL if self._terminal else self._player

  def _legal_actions(self, player):
    return list(self._legal) if player == self._player and not self._terminal else []

  def _apply_action(self, action):
    self._set(bridge(self._env.worker).call([{'op': 'step', 'id': self._env.id, 'action': int(action)}])[0])

  def _action_to_string(self, player, action):
    return bridge().action_names[action]

  def is_terminal(self):
    return self._terminal

  def returns(self):
    return list(map(float, self._returns))

  def observation_for(self, player):
    if player == self._player and self._obs is not None:
      return self._obs
    return decode_obs(bridge(self._env.worker).call([{'op': 'obs', 'id': self._env.id, 'player': int(player)}])[0]['obs'])

  def __str__(self):
    return bridge(self._env.worker).call([{'op': 'describe', 'id': self._env.id}])[0]['text']


def send_steps(states, actions):
  """Sends one action for each live state, a request per server, without waiting.

  For training only: it updates the states directly, bypassing OpenSpiel's
  history bookkeeping (R-NaD doesn't use it). Finish with receive_steps(); a
  server takes one request at a time, so receive before sending it another.
  """
  by_worker = {}
  for state, action in zip(states, actions):
    if not state.is_terminal():
      by_worker.setdefault(state._env.worker, []).append((state, int(action)))
  for w, items in by_worker.items():
    bridge(w).send([{'op': 'step', 'id': s._env.id, 'action': a} for s, a in items])
  return by_worker


def receive_steps(pending):
  """Updates the states sent by send_steps(); returns how many stepped."""
  for w, items in pending.items():
    for (state, _), status in zip(items, bridge(w).receive()):
      state._set(status)
  return sum(len(items) for items in pending.values())


def step_states(states, actions):
  """Applies one action to each live state, all servers working at once."""
  return receive_steps(send_steps(states, actions))


class KeepsObserver:
  """Observer (OpenSpiel's PyObserver interface): the encoder's vector."""

  def __init__(self, size):
    self.tensor = np.zeros(size, np.float32)
    self.dict = {'observation': self.tensor}

  def set_from(self, state, player):
    self.tensor[:] = state.observation_for(player)

  def string_from(self, state, player):
    return f'player {player}: {state}'


pyspiel.register_game(_GAME_TYPE, KeepsGame)
