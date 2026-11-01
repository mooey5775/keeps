"""The entity network as the deployed bot runs it (TypeScript, packages/bot/src/entity.ts) against the PyTorch
network VRPO trains (keeps_bot/vrpo/models.py), through the policy file between them (KPNN: models.haiku_params,
export.write, Policy.load).

The observations are real (both players' views over self-play rounds); the weights are random, at two scales: as
initialized, where the layer norms see small activations (so their details, such as epsilon, show), and three times
that, where every layer drives large logits. The networks must agree to float32 rounding.

Needs PyTorch and Node: from the repo root,
  PYTHONPATH=training training/.venv-torch/bin/python -m unittest training.tests.test_parity
"""

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

from keeps_bot import export
from keeps_bot import game as keeps

from tests.test_vrpo import observations

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
LOGITS = os.path.join(REPO, 'packages', 'learn', 'test', 'support', 'logits.ts')


@unittest.skipIf(torch is None, 'needs PyTorch (training/.venv-torch)')
class ParityTest(unittest.TestCase):

  def test_the_deployed_network_computes_the_trained_one(self):
    keeps.set_observation(2)
    from keeps_bot.vrpo import game as vrpo_game
    from keeps_bot.vrpo import models
    b = keeps.bridge()
    vrpo_game.configure(128, b.observation_size, b.layout, b.truth_layout)
    obs = observations(rows=200, seed='parity')[0].reshape(-1, b.observation_size).astype(np.float32)
    for seed, scale in ((0, 1), (1, 3)):
      torch.manual_seed(seed)
      agent = models.Agent(types.SimpleNamespace(game=vrpo_game)).eval()
      with torch.no_grad():
        for p in agent.parameters():
          p.mul_(scale if p.dim() > 1 else 1)
      with torch.inference_mode():
        want = agent.logits(torch.from_numpy(obs)).numpy()
      with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'policy.bin')
        header = {'format': 'keeps-policy', 'version': 1, 'run': 'parity', 'step': seed, 'decisions': None,
                  'network': 'entity', 'observationVersion': 2, 'layers': [], 'observationSize': b.observation_size,
                  'numActions': b.num_actions, 'fingerprint': b.fingerprint,
                  'postprocess': {'threshold': 0, 'discretization': 0}, 'evals': None, 'layout': b.layout}
        params = models.haiku_params(agent)
        export.write(path, header, [(f'{m}/{n}', v) for m, group in sorted(params.items()) for n, v in sorted(group.items())])
        obs.tofile(os.path.join(tmp, 'obs.f32'))
        subprocess.run(['node', LOGITS, path, os.path.join(tmp, 'obs.f32'), os.path.join(tmp, 'out.f32')], check=True,
                       cwd=os.path.dirname(LOGITS))
        got = np.fromfile(os.path.join(tmp, 'out.f32'), dtype='<f4').reshape(want.shape)
      self.assertGreater(np.abs(want).max(), 1, 'the logits are too small to tell anything')
      np.testing.assert_allclose(got, want, atol=1e-4 * max(1, np.abs(want).max()), rtol=1e-4)
      self.assertTrue(np.array_equal(got.argmax(1), want.argmax(1)))


if __name__ == '__main__':
  unittest.main()
