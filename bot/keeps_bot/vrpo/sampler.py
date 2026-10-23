"""Self-play for VRPO: MARVEL's Sampler interface on our Node workers.

Like MARVEL's sampler (marvel/runtime/sampler.py), it keeps `rollout_batch_size`
rounds in play, steps them with the current policy until `collect_batch_size`
rounds have finished, and returns those as a rollout. Rounds still in play carry
over to the next collection, and so do rounds that finished beyond the batch.
Collection is synchronous (nothing plays while the learner trains), so every
step of a trajectory comes from a policy at most one iteration old.

Each worker plays its share of the rounds in `both` mode: every step, both
players' observations (the mover's, which the policy reads, and the other
player's, for the critic) and the true state (for the critic only), in float16,
as the trajectories store them. Workers are stepped a group at a time, one
policy call per group, so the other groups' workers compute while the GPU works.
Each worker's frame is received, and later recorded, on a thread of its own, so
the copies overlap the policy and the other groups (the trajectories are the
same as stepping everything on one thread, bit for bit).

Rounds longer than the horizon are dropped when they end (about 1 in 5,000 at
128): a cut trajectory would have no result to learn from.
"""

import collections
import concurrent.futures
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
    self.workers = [selfplay.Worker(m, f'vrpo-{seed}-{w}', O, A, observation=2, both=True, half=True) for w in range(workers)]
    # Each slot's round so far.
    self._obs = [np.zeros((m, T, 2, O), np.float16) for _ in self.workers]
    self._truth = [np.zeros((m, T, game.truth_layout['size']), np.float16) for _ in self.workers]
    self._legal = [np.zeros((m, T, A), np.bool_) for _ in self.workers]
    self._player = [np.zeros((m, T), np.int64) for _ in self.workers]
    self._action = [np.zeros((m, T), np.int64) for _ in self.workers]
    self._probs = [np.zeros((m, T, A), np.float32) for _ in self.workers]
    self._len = [np.zeros(m, np.int64) for _ in self.workers]
    self.finished = collections.deque()  # (worker, slot arrays..., result) in finishing order
    self._mover = [None] * workers
    self._groups = [list(range(g, workers, groups)) for g in range(min(groups, workers))]
    # Per group: the movers' views and legal moves, staged for the policy (pinned on a GPU).
    pin = self.device.type == 'cuda'
    self._stage = []
    for group in self._groups:
      n = m * len(group)
      x, legal = torch.zeros((n, O), dtype=torch.float16), torch.zeros((n, A), dtype=torch.bool)
      self._stage.append((x.pin_memory(), legal.pin_memory()) if pin else (x, legal))
    self._pool = concurrent.futures.ThreadPoolExecutor(workers)
    self._pending = [None] * workers  # each worker's recording in flight
    self._graphs = {}  # group → its policy's CUDA graph (_policy)
    self._worker_stats = [collections.Counter() for _ in self.workers]
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
        for g, group in enumerate(self._groups):
          self._step_group(g, group, agent)
      self._settle()
    self._stats['play_seconds'] += time.perf_counter() - started
    episodes = [self.finished.popleft() for _ in range(self.collect_batch_size)]
    return self._rollout(episodes)

  def stats(self):
    """Counts since the last call: rounds, decisions, cut rounds, seconds playing."""
    out, self._stats = self._stats, collections.Counter()
    for counts in self._worker_stats:
      out.update(counts)
      counts.clear()
    return dict(out)

  def _step_group(self, g, group, agent):
    # Each worker's step is received, and its mover's view gathered, on its own thread (the pipe
    # reads and the copies release the GIL); the group then makes one policy call.
    x, legal = self._stage[g]
    offsets = np.cumsum([0] + [self.workers[w].m for w in group])
    self._settle(group)
    received = list(self._pool.map(self._receive, group, offsets[:-1], [x.numpy()] * len(group), [legal.numpy()] * len(group)))
    for finished in received:
      self.finished.extend(finished)
    n = int(offsets[-1])
    probs = self._policy(g, agent, x, legal)
    actions = torch.multinomial(probs, 1)[:, 0]
    probs, actions = probs.cpu().numpy(), actions.cpu().numpy()
    # Send first, so the workers compute their next step while this one is recorded, in the
    # background: each worker's record finishes before its next receive (_settle).
    for j, w in enumerate(group):
      part = slice(offsets[j], offsets[j + 1])
      self.workers[w].send(actions[part])
      self._pending[w] = self._pool.submit(self._record, w, legal.numpy()[part], actions[part], probs[part])
    self.total_env_steps += n
    self.total_game_steps += n
    self._stats['decisions'] += n

  def _policy(self, g, agent, x, legal):
    """The policy on group g's staged views: on a GPU, a CUDA graph per group, replayed (one launch
    instead of one per layer, which the recording threads would otherwise slow down; the same
    kernels, so the same numbers). It reads the parameters in place, so training's updates show;
    it is captured again if the parameters move."""
    # The policy reads each mover's own view in float16, exactly what training will read.
    if self.device.type != 'cuda':
      return agent.probabilities(x.float(), legal)
    key = (id(agent), tuple(p.data_ptr() for p in agent.parameters()))
    if g not in self._graphs or self._graphs[g][0] != key:
      x_in, legal_in = x.to(self.device), legal.to(self.device)
      side = torch.cuda.Stream()
      side.wait_stream(torch.cuda.current_stream())
      with torch.cuda.stream(side):
        for _ in range(3):
          agent.probabilities(x_in.float(), legal_in)
      torch.cuda.current_stream().wait_stream(side)
      graph = torch.cuda.CUDAGraph()
      with torch.cuda.graph(graph):
        out = agent.probabilities(x_in.float(), legal_in)
      self._graphs[g] = (key, graph, x_in, legal_in, out)
    _, graph, x_in, legal_in, out = self._graphs[g]
    x_in.copy_(x, non_blocking=True)
    legal_in.copy_(legal, non_blocking=True)
    graph.replay()
    return out

  def _settle(self, group=None):
    """Waits for the workers' (default: all) recordings in flight."""
    for w in range(len(self.workers)) if group is None else group:
      if self._pending[w] is not None:
        self._pending[w].result()
        self._pending[w] = None

  def _receive(self, w, at, x, legal):
    """Receives worker w's step, finishes its ended rounds and stages its movers' views at `at`."""
    worker = self.workers[w]
    worker.receive()
    finished = [episode for i in np.flatnonzero(worker.done) if (episode := self._finish(w, i, int(worker.reward[i])))]
    self._mover[w] = worker.player.astype(np.int64)
    x[at:at + worker.m] = worker.obs[np.arange(worker.m), self._mover[w]]
    legal[at:at + worker.m] = worker.legal
    return finished

  def _record(self, w, legal, actions, probs):
    worker, mover, length = self.workers[w], self._mover[w], self._len[w]
    rows = np.flatnonzero(length < self.T)  # past the horizon: no longer recorded, the round will be dropped
    t = length[rows]
    self._obs[w][rows, t] = worker.obs[rows]
    self._truth[w][rows, t] = worker.truth[rows]
    self._legal[w][rows, t] = legal[rows]
    self._player[w][rows, t] = mover[rows]
    self._action[w][rows, t] = actions[rows]
    self._probs[w][rows, t] = probs[rows]
    length += 1

  def _finish(self, w, i, result):
    """Ends slot i's round: its episode, or None for a round cut at the horizon."""
    n = int(self._len[w][i])
    self._len[w][i] = 0
    stats = self._worker_stats[w]
    stats['rounds'] += 1
    stats['round_decisions'] += n
    if n > self.T:
      stats['rounds_cut'] += 1
      return None
    stats['player0_wins'] += result > 0
    return (self._obs[w][i, :n].copy(), self._truth[w][i, :n].copy(), self._legal[w][i, :n].copy(),
            self._player[w][i, :n].copy(), self._action[w][i, :n].copy(), self._probs[w][i, :n].copy(), result)

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
    self._settle()
    self._pool.shutdown()
    for w in self.workers:
      w.close()
