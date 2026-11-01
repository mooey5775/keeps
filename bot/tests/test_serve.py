"""Checks for the GPU inference server (keeps_bot/serve.py) the batched search uses.

Needs PyTorch: run from the repo root with the PyTorch environment,
  PYTHONPATH=bot bot/.venv-torch/bin/python -m unittest bot.tests.test_serve
(with JAX's environment these tests are skipped). The CUDA graph path is checked when a GPU is present.
"""

import asyncio
import json
import os
import struct
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


def sparse(rows):
  """Observations as one request's parts (packages/bot/src/search/inference.ts encodeRequest): rowEnds, values, indices."""
  nonzero = [np.flatnonzero(row) for row in rows]
  ends = np.cumsum([len(i) for i in nonzero]).astype('<u4')
  values = np.concatenate([row[i] for row, i in zip(rows, nonzero)]).astype('<f4')
  indices = np.concatenate(nonzero).astype('<u2')
  return ends, values, indices


@unittest.skipIf(torch is None, 'needs PyTorch (bot/.venv-torch)')
class ServeTest(unittest.TestCase):

  @classmethod
  def setUpClass(cls):
    keeps.set_observation(2)
    from keeps_bot.vrpo import game as vrpo_game
    from keeps_bot.vrpo import models
    b = keeps.bridge()
    vrpo_game.configure(128, b.observation_size, b.layout, b.truth_layout)
    torch.manual_seed(0)
    cls.agent = models.Agent(types.SimpleNamespace(game=vrpo_game)).eval()
    cls.obs = observations(rows=96, seed='serve-test')[0][:, 0].astype(np.float32)  # player 0's views
    cls.dir = tempfile.TemporaryDirectory()
    cls.path = os.path.join(cls.dir.name, 'policy.bin')
    header = {'format': 'keeps-policy', 'version': 1, 'run': 'test', 'step': 7, 'decisions': None, 'network': 'entity',
              'observationVersion': 2, 'layers': [], 'observationSize': b.observation_size, 'numActions': b.num_actions,
              'fingerprint': 'test-fingerprint', 'postprocess': {'threshold': 0, 'discretization': 0}, 'evals': None,
              'layout': b.layout}
    params = models.haiku_params(cls.agent)
    export.write(cls.path, header, [(f'{m}/{n}', v) for m, group in sorted(params.items()) for n, v in sorted(group.items())])
    with torch.inference_mode():
      cls.expected = cls.agent.logits(torch.from_numpy(cls.obs)).numpy()

  @classmethod
  def tearDownClass(cls):
    cls.dir.cleanup()

  def server(self, device):
    from keeps_bot import serve
    header, agent = serve.load(self.path, device)
    return header, serve.Server(header, agent, device)

  def requests(self, sizes):
    out, at = [], 0
    for n in sizes:
      ends, values, indices = sparse(self.obs[at:at + n])
      out.append((n, ends, values, indices, None))
      at += n
    return out

  def check(self, server, sizes):
    replies = server.forward(self.requests(sizes))
    got = np.concatenate([np.frombuffer(r, '<f4').reshape(-1, self.expected.shape[1]) for r in replies])
    np.testing.assert_allclose(got, self.expected[:sum(sizes)], atol=2e-5, rtol=1e-5)

  def test_the_policy_file_loads_as_the_agent_that_wrote_it(self):
    header, server = self.server('cpu')
    self.assertEqual(header['fingerprint'], 'test-fingerprint')
    self.check(server, [96])

  def test_requests_batched_together_get_their_own_rows(self):
    _, server = self.server('cpu')
    self.check(server, [1, 30, 7, 58])

  @unittest.skipUnless(torch is not None and torch.cuda.is_available(), 'needs a GPU')
  def test_cuda_graphs_with_padding_give_the_eager_logits(self):
    torch.backends.cuda.matmul.allow_tf32 = False
    _, server = self.server('cuda:0')
    # 17 rows fill 32 of bucket 32's (stale rows from the 96 before must not leak into them); 96 pads to 128.
    self.check(server, [40, 56])
    self.check(server, [17])
    self.check(server, [3, 14])

  def test_the_socket_protocol(self):
    from keeps_bot import serve

    async def run():
      header, agent = serve.load(self.path, 'cpu')
      server = serve.Server(header, agent, 'cpu')
      path = os.path.join(self.dir.name, 'socket')
      listener = await asyncio.start_unix_server(server.connection, path=path)
      worker = asyncio.create_task(server.run())

      async def hello(info):
        reader, writer = await asyncio.open_unix_connection(path)
        body = json.dumps(info).encode()
        writer.write(b'KPI1' + struct.pack('<I', len(body)) + body)
        (length,) = struct.unpack('<I', await reader.readexactly(4))
        return reader, writer, json.loads(await reader.readexactly(length))

      good = {k: header[k] for k in ('fingerprint', 'step', 'observationSize', 'numActions')}
      _, bad_writer, answer = await hello({**good, 'step': 8})
      self.assertIn('step', answer['error'])
      bad_writer.close()
      reader, writer, answer = await hello(good)
      self.assertEqual(answer, {'ok': True})
      # Two requests sent back to back come back in order.
      for rows in (self.obs[:5], self.obs[5:12]):
        ends, values, indices = sparse(rows)
        writer.write(struct.pack('<II', len(rows), len(values)) + ends.tobytes() + values.tobytes() + indices.tobytes())
      first = np.frombuffer(await reader.readexactly(4 * 5 * 48), '<f4').reshape(5, 48)
      second = np.frombuffer(await reader.readexactly(4 * 7 * 48), '<f4').reshape(7, 48)
      np.testing.assert_allclose(np.concatenate([first, second]), self.expected[:12], atol=2e-5, rtol=1e-5)
      writer.close()
      worker.cancel()
      listener.close()

    asyncio.run(run())


if __name__ == '__main__':
  unittest.main()
