"""Checks for VRPO on the vendored MARVEL trainer (keeps_bot/vrpo, bot/marvel).

Needs PyTorch: run from the repo root with the PyTorch environment,
  PYTHONPATH=bot bot/.venv-torch/bin/python -m unittest bot.tests.test_vrpo
(with JAX's environment these tests are skipped).
"""

import hashlib
import os
import types
import unittest

import numpy as np

try:
  import torch
except ImportError:
  torch = None

from keeps_bot import game as keeps
from keeps_bot import selfplay

MARVEL = os.path.join(os.path.dirname(__file__), '..', 'marvel')
# The vendored files we changed (each change is marked "# Keeps:"); see marvel/VENDORED.md.
EDITED = {'./buffer.py', './game_identity.py', './model/__init__.py'}


def observations(rows=96, seed='vrpo-test'):
  """Both players' observations, the mover and the legal actions at a spread of self-play moments."""
  b = keeps.bridge()
  worker = selfplay.Worker(32, seed, b.observation_size, b.num_actions, observation=2, both=True)
  rng = np.random.default_rng(0)
  obs, mover, legal = [], [], []
  try:
    worker.send(np.full(worker.m, -1))
    for frame in range(90):
      worker.receive()
      if frame % 9 == 4:
        pick = rng.choice(worker.m, size=10, replace=False)
        obs.append(worker.obs[pick].copy())
        mover.append(worker.player[pick].astype(np.int64))
        legal.append(worker.legal[pick].copy())
      worker.send(np.array([rng.choice(np.flatnonzero(l)) for l in worker.legal]))
  finally:
    worker.close()
  return np.concatenate(obs)[:rows], np.concatenate(mover)[:rows], np.concatenate(legal)[:rows].astype(bool)


@unittest.skipIf(torch is None, 'needs PyTorch (bot/.venv-torch)')
class VrpoTest(unittest.TestCase):

  @classmethod
  def setUpClass(cls):
    keeps.set_observation(2)
    from keeps_bot.vrpo import game as vrpo_game
    b = keeps.bridge()
    vrpo_game.configure(128, b.observation_size, b.layout)
    cls.cfg = types.SimpleNamespace(game=vrpo_game, model=types.SimpleNamespace(fuse_layers=2))
    cls.obs, cls.mover, cls.legal = observations()

  def test_vendored_marvel_matches_upstream_except_marked_edits(self):
    with open(os.path.join(MARVEL, 'UPSTREAM.sha256')) as f:
      expected = dict(reversed(line.split()) for line in f)
    changed = set()
    for path, digest in expected.items():
      with open(os.path.join(MARVEL, path), 'rb') as f:
        if hashlib.sha256(f.read()).hexdigest() != digest:
          changed.add(path)
    self.assertEqual(changed, EDITED)
    for path in EDITED:
      with open(os.path.join(MARVEL, path)) as f:
        self.assertIn('# Keeps:', f.read(), path)

  def test_agent_matches_the_haiku_entity_network(self):
    # Random Haiku parameters (norms and all) in both networks give the same policy.
    import haiku as hk
    import jax
    from keeps_bot import networks, rnad
    from keeps_bot.vrpo import models
    b = keeps.bridge()
    net = hk.without_apply_rng(hk.transform(networks.entity(b.layout, b.num_actions)))
    obs = self.obs[np.arange(len(self.mover)), self.mover]
    step = rnad.EnvStep(obs=obs, legal=self.legal.astype(np.int8))
    params = net.init(jax.random.PRNGKey(1), step)
    rng = np.random.default_rng(1)
    params = jax.tree_util.tree_map(lambda p: np.asarray(p) + rng.normal(0, 0.05, p.shape).astype(np.float32), params)
    expected = np.asarray(net.apply(params, step)[0])

    agent = models.Agent(self.cfg)
    models.load_haiku_params(agent, params)
    with torch.no_grad():
      got = agent.probabilities(torch.as_tensor(obs), torch.as_tensor(self.legal)).numpy()
    np.testing.assert_allclose(got, expected, atol=2e-6)
    # And back: every Haiku parameter, with the same values (but the untrained value head, zero).
    back = models.haiku_params(agent)
    self.assertEqual(set(back), set(params))
    for module, group in params.items():
      self.assertEqual(set(back[module]), set(group), module)
      for name, value in group.items():
        if not module.startswith('value/'):
          np.testing.assert_array_equal(back[module][name], np.asarray(value), f'{module}/{name}')

  def test_rollout_forward_reads_the_movers_view_and_skips_padding(self):
    from keeps_bot.vrpo import models
    from marvel.model.tensordict import TensorDict
    torch.manual_seed(0)
    agent, critic = models.Agent(self.cfg), models.CentralCritic(self.cfg)
    # Two trajectories of 4 and 2 steps in a [2, 5] rollout (the rest padding).
    rows = torch.as_tensor(self.obs[:6], dtype=torch.float16)
    channels = torch.zeros(2, 5, 2, rows.shape[-1], dtype=torch.float16)
    channels[0, :4], channels[1, :2] = rows[:4], rows[4:]
    legal = torch.zeros(2, 5, 48)
    legal[0, :4], legal[1, :2] = torch.as_tensor(self.legal[:4]).float(), torch.as_tensor(self.legal[4:6]).float()
    players = torch.zeros(2, 5, dtype=torch.long)
    players[0, :4], players[1, :2] = torch.as_tensor(self.mover[:4]), torch.as_tensor(self.mover[4:6])
    rollout = TensorDict({'num_steps': torch.tensor([4, 2]), 'player_ids': players, 'obs_channels': channels,
                          'avail_weights': legal}, batch_size=[2])
    with torch.no_grad():
      probs = agent(rollout=rollout).avail_probs
      q = critic(rollout=rollout).qvalues
      direct = agent.probabilities(rows[torch.arange(6), torch.as_tensor(self.mover[:6])].float(),
                                   torch.as_tensor(self.legal[:6]))
      direct_q = critic.q_values(rows.float(), torch.as_tensor(self.mover[:6]), torch.as_tensor(self.legal[:6]))
    self.assertEqual(tuple(probs.shape), (2, 5, 48))
    self.assertEqual(tuple(q.shape), (2, 5, 48, 2))
    torch.testing.assert_close(probs[0, :4], direct[:4])
    torch.testing.assert_close(probs[1, :2], direct[4:])
    torch.testing.assert_close(q[0, :4], direct_q[:4])
    self.assertEqual(float(probs[0, 4:].abs().sum() + probs[1, 2:].abs().sum()), 0.0)
    self.assertEqual(float(q[0, 4:].abs().sum() + q[1, 2:].abs().sum()), 0.0)
    # Illegal actions get no probability and no Q value.
    self.assertEqual(float(probs[legal == 0].abs().sum()), 0.0)
    self.assertEqual(float(q[legal == 0].abs().sum()), 0.0)

  def test_chunks_give_the_same_outputs_and_gradients(self):
    from keeps_bot.vrpo import models
    from marvel.model.tensordict import TensorDict
    torch.manual_seed(0)
    agent, critic = models.Agent(self.cfg), models.CentralCritic(self.cfg)
    n = 10  # one trajectory of 10 steps
    rollout = TensorDict({'num_steps': torch.tensor([n]), 'player_ids': torch.as_tensor(self.mover[None, :n]),
                          'obs_channels': torch.as_tensor(self.obs[None, :n], dtype=torch.float16),
                          'avail_weights': torch.as_tensor(self.legal[None, :n]).float()}, batch_size=[1])

    def run():
      for model in (agent, critic):
        model.zero_grad()
      probs = agent(rollout=rollout).avail_probs
      q = critic(rollout=rollout).qvalues
      (probs.square().sum() + q.square().sum()).backward()
      grads = [p.grad.clone() for model in (agent, critic) for p in model.parameters() if p.grad is not None]
      return probs.detach(), q.detach(), grads

    whole = run()
    saved = models.CHUNK
    models.CHUNK = 3
    try:
      chunked = run()
    finally:
      models.CHUNK = saved
    torch.testing.assert_close(chunked[0], whole[0])
    torch.testing.assert_close(chunked[1], whole[1])
    self.assertEqual(len(chunked[2]), len(whole[2]))
    for a, b in zip(chunked[2], whole[2]):
      torch.testing.assert_close(a, b, atol=1e-6, rtol=1e-4)

  def test_both_mode_gives_the_mover_the_usual_observation(self):
    # The critic's second view mustn't change what the mover sees (RoundEnv.peekInto).
    b = keeps.bridge()
    plain = selfplay.Worker(48, 'peek', b.observation_size, b.num_actions, observation=2)
    both = selfplay.Worker(48, 'peek', b.observation_size, b.num_actions, observation=2, both=True)
    rng = np.random.default_rng(0)
    actions, finished = np.full(48, -1), 0
    try:
      for _ in range(300):
        plain.send(actions)
        both.send(actions)
        plain.receive()
        both.receive()
        np.testing.assert_array_equal(plain.player, both.player)
        np.testing.assert_array_equal(plain.legal, both.legal)
        np.testing.assert_array_equal(plain.done, both.done)
        np.testing.assert_array_equal(plain.reward, both.reward)
        np.testing.assert_array_equal(plain.obs, both.obs[np.arange(48), plain.player.astype(int)])
        finished += int(plain.done.sum())
        actions = np.array([rng.choice(np.flatnonzero(l)) for l in plain.legal])
    finally:
      plain.close()
      both.close()
    self.assertGreater(finished, 100)


if __name__ == '__main__':
  unittest.main()
