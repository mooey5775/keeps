"""What the VRPO learner trains on, checked end to end against an independent replay of the rounds.

The real Sampler (its Node workers, their binary frames, the recording into trajectories) plays with a
random-weights policy, and the rollouts it returns, exactly as the learner gets them, are checked:
  - the learner reads what the actor read: the agent's forward pass over the rollout gives the probabilities the
    acting policy recorded, so each step's observation is the mover's and its legal moves its own;
  - the fields are consistent: probabilities on legal moves only, a result only on the last step, num_steps;
  - every episode replays exactly (packages/learn/test/support/verify-trajectories.ts): from its deal, with the
    deployed bot's pieces and none of the training code, every step's mover, legal moves, both observations,
    true state, action and the round's result.

Needs PyTorch and Node: from the repo root,
  PYTHONPATH=training training/.venv-torch/bin/python -m unittest training.tests.test_trajectories
"""

import json
import os
import subprocess
import tempfile
import types
import unittest

import numpy as np

try:
  import torch
except ImportError:
  torch = None

from keeps_bot import game as keeps

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
VERIFY = os.path.join(REPO, 'packages', 'learn', 'test', 'support', 'verify-trajectories.ts')


@unittest.skipIf(torch is None, 'needs PyTorch (training/.venv-torch)')
class TrajectoryTest(unittest.TestCase):

  @classmethod
  def setUpClass(cls):
    from keeps_bot.vrpo import game as vrpo_game
    from keeps_bot.vrpo import models
    from keeps_bot.vrpo.sampler import Sampler
    keeps.set_observation(2)
    b = keeps.bridge()
    vrpo_game.configure(160, b.observation_size, b.layout, b.truth_layout)
    torch.manual_seed(0)
    cls.agent = models.Agent(types.SimpleNamespace(game=vrpo_game)).eval()
    cls.workers, cls.seed = 2, 11
    sampler = Sampler(game=vrpo_game, device='cpu', rollout_batch_size=8, collect_batch_size=10, workers=cls.workers,
                      groups=2, seed=cls.seed)
    try:
      cls.rollouts = [sampler.collect(agent_model=cls.agent) for _ in range(3)]
    finally:
      sampler.close()

  def valid(self, rollout):
    n = rollout['num_steps']
    return torch.arange(rollout['player_ids'].shape[1])[None, :] < n[:, None]

  def test_the_learner_reads_what_the_actor_read(self):
    for rollout in self.rollouts:
      with torch.inference_mode():
        probs = self.agent(rollout).avail_probs
      valid = self.valid(rollout)
      np.testing.assert_allclose(probs[valid].numpy(), rollout['avail_probs'][valid].numpy(), atol=2e-6)

  def test_the_fields_are_consistent(self):
    for rollout in self.rollouts:
      valid = self.valid(rollout)
      legal = rollout['avail_weights'] > 0
      probs = rollout['avail_probs']
      self.assertTrue(torch.all(probs[~legal] == 0))
      np.testing.assert_allclose(probs[valid].sum(-1).numpy(), 1, atol=1e-5)
      taken = rollout['action_taken'][valid]
      self.assertTrue(torch.all(legal[valid].gather(1, taken[:, None])))
      self.assertTrue(torch.equal(rollout['avail_is_commit'][valid], legal[valid]))
      last = rollout['num_steps'] - 1
      rows = torch.arange(len(last))
      self.assertTrue(torch.all(rollout['is_terminal'][rows, last]))
      self.assertEqual(int(rollout['is_terminal'].sum()), len(last))
      rewards = rollout['rewards']
      self.assertTrue(torch.all(rewards[rows, last].abs() == 1))
      self.assertTrue(torch.all(rewards[rows, last].sum(-1) == 0))
      self.assertEqual(int((rewards != 0).sum()), 2 * len(last))
      self.assertTrue(torch.all(rollout['player_ids'][valid] >= 0) and torch.all(rollout['player_ids'][valid] <= 1))

  def test_every_episode_replays_exactly(self):
    episodes, obs, truth = [], [], []
    for rollout in self.rollouts:
      for j in range(len(rollout['num_steps'])):
        n = int(rollout['num_steps'][j])
        episodes.append({
            'steps': n,
            'player': rollout['player_ids'][j, :n].tolist(),
            'action': rollout['action_taken'][j, :n].tolist(),
            'legal': [np.flatnonzero(row).tolist() for row in rollout['avail_weights'][j, :n].numpy()],
            'lastReward': rollout['rewards'][j, n - 1].tolist(),
        })
        obs.append(rollout['obs_channels'][j, :n].numpy())
        truth.append(rollout['critic_truth'][j, :n].numpy())
    with tempfile.TemporaryDirectory() as tmp:
      bases = [f'vrpo-{self.seed}-{w}' for w in range(self.workers)]
      with open(os.path.join(tmp, 'episodes.json'), 'w') as f:
        json.dump({'seedBases': bases, 'candidates': 80, 'episodes': episodes}, f)
      np.concatenate(obs).astype('<f2').tofile(os.path.join(tmp, 'obs.f16'))
      np.concatenate(truth).astype('<f2').tofile(os.path.join(tmp, 'truth.f16'))
      out = subprocess.run(['node', VERIFY, tmp], capture_output=True, text=True, check=True, cwd=os.path.dirname(VERIFY))
    report = json.loads(out.stdout.strip().splitlines()[-1])
    self.assertEqual(report['failures'], [])
    self.assertEqual(report['verified'], len(episodes))
    self.assertEqual(len(set(report['seeds'])), len(episodes), 'an episode was recorded twice')
    self.assertGreater(report['steps'], 1000)


if __name__ == '__main__':
  unittest.main()
