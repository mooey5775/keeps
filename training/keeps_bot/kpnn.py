"""The policy file (KPNN: the bot's network as packages/learn's Policy.load reads it) as a PyTorch agent.

Only PyTorch and NumPy: tools that run the network elsewhere (serve.py on a GPU, coreml.py for Apple's Neural
Engine) don't need JAX, which the exporter that writes these files (export.py) does.
"""

import json
import struct
from types import SimpleNamespace

import numpy as np


def read(path):
  """The file's JSON header and the bytes of its tensors."""
  with open(path, 'rb') as f:
    data = f.read()
  assert data[:4] == b'KPNN', f'{path} is not a KPNN file'
  (length,) = struct.unpack('<I', data[4:8])
  return json.loads(data[8:8 + length]), data[8 + length:]


def load_agent(path):
  """The file's header and its network as the float32 PyTorch agent (on the CPU, in eval mode)."""
  from keeps_bot.vrpo.models import Agent, load_haiku_params

  header, body = read(path)
  if header.get('network') != 'entity':
    raise SystemExit(f'{path}: only entity networks run in PyTorch (this one is {header.get("network", "mlp")})')
  floats = np.frombuffer(body, dtype='<f4')
  params = {}
  for t in header['tensors']:
    size = int(np.prod(t['shape']))
    module, name = t['name'].rsplit('/', 1)
    params.setdefault(module, {})[name] = floats[t['offset']:t['offset'] + size].reshape(t['shape']).copy()
  game = SimpleNamespace(layout=header['layout'], max_available_actions=header['numActions'])
  agent = Agent(SimpleNamespace(game=game))
  load_haiku_params(agent, params)
  return header, agent.eval()
