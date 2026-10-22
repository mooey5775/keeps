"""Self-play for VRPO: MARVEL's Sampler interface on our Node workers.

Like MARVEL's sampler (marvel/runtime/sampler.py), it keeps `rollout_batch_size`
rounds in play, steps them with the current policy until `collect_batch_size`
rounds have finished, and returns those as a rollout. Rounds still in play carry
over to the next collection, and so do rounds that finished beyond the batch.
Collection is synchronous (nothing plays while the learner trains), so every
step of a trajectory comes from a policy at most one iteration old.

Each worker plays its share of the rounds in `both` mode: every step, both
players' observations (the mover's, which the policy reads, and the other
player's, for the critic) and the true state (for the critic only). Workers are stepped a group at a time, one policy call
per group, so the other groups' workers compute while the GPU works.

Rounds longer than the horizon are dropped when they end (about 1 in 5,000 at
128): a cut trajectory would have no result to learn from.
"""

import collections
import time

import numpy as np
import torch

from keeps_bot import selfplay
from marvel.model.tensordict import TensorDict
from marvel.utils import unwrap_distributed_module


class Sampler:

  def __init__(self, *, game, device, rollout_batch_size, collect_batch_size, workers, groups, seed):
    if rollout_batch_size % workers:
      raise ValueError(f'rollout_batch_size ({rollout_batch_size}) must divide among the {workers} workers')
    self.game = game
    self.device = torch.device(device)
    self.rollout_batch_size = int(rollout_batch_size)
    self.collect_batch_size = int(collect_batch_size)
    self.total_env_steps = 0  # decisions played (MARVEL's counters; restored on resume)
    self.total_game_steps = 0
    T, A, O = game.max_game_horizon, game.max_available_actions, game.num_channels
    self.T, self.A = T, A
    m = self.rollout_batch_size // workers
    self.workers = [selfplay.Worker(m, f'vrpo-{seed}-{w}', O, A, observation=2, both=True) for w in range(workers)]
    # Each slot's round so far.
    self._obs = [np.zeros((m, T, 2, O), np.float16) for _ in self.workers]
    self._truth = [np.zeros((m, T, game.truth_layout['size']), np.float16) for _ in self.workers]
    self._legal = [np.zeros((m, T, A), np.bool_) for _ in self.workers]
    self._player = [np.zeros((m, T), np.int64) for _ in self.workers]
    self._action = [np.zeros((m, T), np.int64) for _ in self.workers]
    self._probs = [np.zeros((m, T, A), np.float32) for _ in self.workers]
    self._len = [np.zeros(m, np.int64) for _ in self.workers]
    self.finished = collections.deque()  # (worker, slot arrays..., result) in finishing order
    self._groups = [list(range(g, workers, groups)) for g in range(min(groups, workers))]
    self._batch = None  # pinned host buffers for the rollout, reused
    # For logging: since the last stats() call.
    self._stats = collections.Counter()
    for w in self.workers:
      w.send(np.full(w.m, -1))

  def collect(self, *, agent_model):
    """Plays until `collect_batch_size` rounds have finished; returns them as a rollout on the device."""
    agent = unwrap_distributed_module(agent_model)
    started = time.perf_counter()
    with torch.inference_mode():
      while len(self.finished) < self.collect_batch_size:
        for group in self._groups:
          self._step_group(group, agent)
    self._stats['play_seconds'] += time.perf_counter() - started
    episodes = [self.finished.popleft() for _ in range(self.collect_batch_size)]
    return self._rollout(episodes)

  def stats(self):
    """Counts since the last call: rounds, decisions, cut rounds, seconds playing."""
    out, self._stats = dict(self._stats), collections.Counter()
    return out

  def _step_group(self, group, agent):
    for w in group:
      worker = self.workers[w]
      worker.receive()
      for i in np.flatnonzero(worker.done):
        self._finish(w, i, int(worker.reward[i]))
    obs = np.concatenate([self.workers[w].obs for w in group]).astype(np.float16)  # [n, 2, O]
    truth = np.concatenate([self.workers[w].truth for w in group]).astype(np.float16)  # [n, U]
    mover = np.concatenate([self.workers[w].player for w in group]).astype(np.int64)
    legal = np.concatenate([self.workers[w].legal for w in group]).astype(np.bool_)
    n = len(mover)
    # The policy reads exactly what training will (the float16 observation).
    x = torch.from_numpy(obs[np.arange(n), mover]).to(self.device).float()
    probs = agent.probabilities(x, torch.from_numpy(legal).to(self.device))
    actions = torch.multinomial(probs, 1)[:, 0]
    probs, actions = probs.cpu().numpy(), actions.cpu().numpy()
    at = 0
    for w in group:
      worker = self.workers[w]
      m = worker.m
      self._record(w, slice(at, at + m), obs, truth, mover, legal, actions, probs)
      worker.send(actions[at:at + m])
      at += m
    self.total_env_steps += n
    self.total_game_steps += n
    self._stats['decisions'] += n

  def _record(self, w, part, obs, truth, mover, legal, actions, probs):
    length = self._len[w]
    rows = np.flatnonzero(length < self.T)  # past the horizon: no longer recorded, the round will be dropped
    t = length[rows]
    sel = np.arange(part.start, part.stop)[rows]
    self._obs[w][rows, t] = obs[sel]
    self._truth[w][rows, t] = truth[sel]
    self._legal[w][rows, t] = legal[sel]
    self._player[w][rows, t] = mover[sel]
    self._action[w][rows, t] = actions[sel]
    self._probs[w][rows, t] = probs[sel]
    length += 1

  def _finish(self, w, i, result):
    n = int(self._len[w][i])
    self._len[w][i] = 0
    self._stats['rounds'] += 1
    self._stats['round_decisions'] += n
    if n > self.T:
      self._stats['rounds_cut'] += 1
      return
    self._stats['player0_wins'] += result > 0
    self.finished.append((self._obs[w][i, :n].copy(), self._truth[w][i, :n].copy(), self._legal[w][i, :n].copy(),
                          self._player[w][i, :n].copy(), self._action[w][i, :n].copy(), self._probs[w][i, :n].copy(),
                          result))

  def _rollout(self, episodes):
    B, T, A, O = len(episodes), self.T, self.A, self.game.num_channels
    if self._batch is None:
      pin = self.device.type == 'cuda'
      fields = self.game.trajectory_field_specs()
      self._batch = {name: make(B, torch.device('cpu')) for name, make in fields.items()}
      self._batch['num_steps'] = torch.zeros(B, dtype=torch.long)
      if pin:
        self._batch = {name: t.pin_memory() for name, t in self._batch.items()}
    batch = self._batch
    # Steps past each round's end are masked everywhere (num_steps), but MARVEL sums the
    # rewards unmasked for its statistics: clear everything small; the observations are only
    # ever read where a round has steps.
    for name in ('player_ids', 'avail_weights', 'avail_is_commit', 'avail_probs', 'action_taken', 'rewards',
                 'is_terminal'):
      batch[name].zero_()
    obs, legal, player = batch['obs_channels'].numpy(), batch['avail_weights'].numpy(), batch['player_ids'].numpy()
    commit, probs, action = batch['avail_is_commit'].numpy(), batch['avail_probs'].numpy(), batch['action_taken'].numpy()
    rewards, terminal, steps = batch['rewards'].numpy(), batch['is_terminal'].numpy(), batch['num_steps'].numpy()
    truth = batch['critic_truth'].numpy()
    for j, (e_obs, e_truth, e_legal, e_player, e_action, e_probs, result) in enumerate(episodes):
      n = len(e_action)
      steps[j] = n
      obs[j, :n] = e_obs
      truth[j, :n] = e_truth
      legal[j, :n] = e_legal
      commit[j, :n] = e_legal  # every Keeps decision is a step of the game (MARVEL counts committed steps)
      player[j, :n] = e_player
      action[j, :n] = e_action
      probs[j, :n] = e_probs
      rewards[j, n - 1] = (result, -result)
      terminal[j, n - 1] = True
    # A blocking copy: the next collection overwrites these buffers.
    return TensorDict({name: t.to(self.device) for name, t in batch.items()}, batch_size=[B], device=self.device)

  def close(self):
    for w in self.workers:
      w.close()
