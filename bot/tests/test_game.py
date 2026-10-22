"""Checks for the OpenSpiel game backed by the TypeScript engine.

Run from the repo root: PYTHONPATH= bot/.venv/bin/python -m unittest discover -s bot/tests -t bot
"""

import unittest

import numpy as np
import pyspiel

from keeps_bot import game  # registers python_keeps_heads_up


class KeepsGameTest(unittest.TestCase):

  def setUp(self):
    self.game = pyspiel.load_game('python_keeps_heads_up')

  def test_openspiel_random_simulation(self):
    # OpenSpiel's own checks: legal actions sorted, consistent players,
    # observations, returns, cloning, over random playthroughs.
    pyspiel.random_sim_test(self.game, num_sims=50, serialize=False, verbose=False)

  def test_clones_are_independent_rounds(self):
    state = self.game.new_initial_state()
    copy = state.clone()
    copy.apply_action(copy.legal_actions()[0])
    self.assertNotEqual(state.history(), copy.history())
    self.assertNotEqual(state._env.id, copy._env.id)

  def test_observations_and_returns(self):
    rng = np.random.default_rng(0)
    for _ in range(10):
      state = self.game.new_initial_state()
      while not state.is_terminal():
        obs = np.array(state.observation_tensor())
        self.assertEqual(obs.shape, (self.game.observation_tensor_size(),))
        self.assertTrue(np.all(np.isfinite(obs)))
        mask = np.array(state.legal_actions_mask())
        self.assertEqual(mask.sum(), len(state.legal_actions()))
        state.apply_action(rng.choice(state.legal_actions()))
      returns = state.returns()
      self.assertEqual(sorted(returns), [-1.0, 1.0])

  def test_same_seed_same_round(self):
    a = self.game.new_initial_state(seed='same')
    b = self.game.new_initial_state(seed='same')
    for _ in range(30):
      if a.is_terminal():
        break
      self.assertEqual(a.legal_actions(), b.legal_actions())
      np.testing.assert_array_equal(a.observation_tensor(), b.observation_tensor())
      action = a.legal_actions()[-1]
      a.apply_action(action)
      b.apply_action(action)


if __name__ == '__main__':
  unittest.main()
