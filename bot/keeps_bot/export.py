"""Exports a trained policy for the game server (packages/learn/src/policy.ts).

  PYTHONPATH= .venv/bin/python -m keeps_bot.export runs/r1/policy-14500.pkl

writes packages/learn/weights/bot.bin (the network) and
packages/learn/test/fixtures/bot-parity.bin (decision points from self-play with
the probabilities JAX gives them, which the TypeScript forward pass must
reproduce).

File format (both files): b'KPNN', a little-endian uint32 header length, the
JSON header (space-padded to a multiple of 4 bytes), then float32 tensors. The
header lists each tensor's name, shape and offset (in floats) and carries the
metadata: where the policy came from, the network shape, the post-processing
and the encoder fingerprint it was trained with.
"""

import os

os.environ.setdefault('JAX_PLATFORMS', 'cpu')  # the reference probabilities: plain float32, like the server

import argparse
import json
import re
import struct

import numpy as np

from keeps_bot import game as keeps
from keeps_bot import policy as policies
from keeps_bot import rnad
from keeps_bot import selfplay

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WEIGHTS = os.path.join(REPO, 'packages', 'learn', 'weights', 'bot.bin')
FIXTURE = os.path.join(REPO, 'packages', 'learn', 'test', 'fixtures', 'bot-parity.bin')


def write(path, header, tensors):
  entries, data, offset = [], [], 0
  for name, array in tensors:
    array = np.ascontiguousarray(array, dtype='<f4')
    entries.append({'name': name, 'shape': list(array.shape), 'offset': offset})
    data.append(array.tobytes())
    offset += array.size
  head = json.dumps({**header, 'tensors': entries}).encode()
  head += b' ' * (-len(head) % 4)
  os.makedirs(os.path.dirname(path), exist_ok=True)
  with open(path, 'wb') as f:
    f.write(b'KPNN' + struct.pack('<I', len(head)) + head + b''.join(data))


def network_tensors(params, layers):
  """The torso's layers then the policy head, as (name, array); the value head isn't needed to play."""
  tensors = []
  for i in range(len(layers)):
    linear = params[f'mlp/~/linear_{i}']
    tensors += [(f'torso.{i}.w', linear['w']), (f'torso.{i}.b', linear['b'])]
  head = params['mlp_1/~/linear_0']
  return tensors + [('policy.w', head['w']), ('policy.b', head['b'])]


def evals_for(policy_path, step):
  path = os.path.join(os.path.dirname(policy_path), 'evals.jsonl')
  if not os.path.exists(path):
    return None
  with open(path) as f:
    for line in f:
      entry = json.loads(line)
      if entry['step'] == step:
        return {k: {'score': v['score'], 'ci95': round(v['ci95'], 4)} for k, v in entry.items() if isinstance(v, dict)}
  return None


def fixture(policy, raw, rows=64, seed=0):
  """`rows` decision points from self-play with `policy`, with its raw and post-processed probabilities."""
  b = keeps.bridge()
  worker = selfplay.Worker(32, f'parity-{seed}', b.observation_size, b.num_actions)
  rng = np.random.default_rng(seed)
  obs, legal = [], []
  try:
    worker.send(np.full(worker.m, -1))
    for frame in range(60):
      worker.receive()
      if frame % 6 == 5:  # a spread of moments in the rounds
        pick = rng.choice(worker.m, size=rows // 10 + 1, replace=False)
        obs.append(worker.obs[pick].copy())
        legal.append(worker.legal[pick].copy())
      pi = policy(worker.obs, worker.legal).astype(np.float64)
      cdf = np.cumsum(pi, axis=1)
      u = rng.random((worker.m, 1)) * cdf[:, -1:]
      worker.send(np.minimum((cdf <= u).sum(axis=1), pi.shape[1] - 1))
  finally:
    worker.close()
  obs = np.concatenate(obs)[:rows]
  legal = np.concatenate(legal)[:rows]
  return obs, legal, raw(obs, legal), policy(obs, legal)


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('policy', help='a policy-<step>.pkl saved by training')
  parser.add_argument('--out', default=WEIGHTS)
  parser.add_argument('--fixture', default=FIXTURE)
  args = parser.parse_args()

  policy, saved = policies.load(args.policy)
  current = keeps.bridge().fingerprint
  # Policies saved before training recorded the fingerprint were trained with the encoder as it is now.
  fingerprint = saved.get('fingerprint', current)
  if fingerprint != current:
    raise SystemExit(f'this policy was trained with encoder {fingerprint}; the encoder is now {current}')
  step = saved.get('learner_steps', int(re.search(r'(\d+)\.pkl$', args.policy).group(1)))
  run = os.path.basename(os.path.dirname(os.path.abspath(args.policy)))
  header = {
      'format': 'keeps-policy',
      'version': 1,
      'run': run,
      'step': step,
      'decisions': saved.get('decisions'),
      'layers': list(saved['layers']),
      'observationSize': keeps.bridge().observation_size,
      'numActions': saved['num_actions'],
      'fingerprint': fingerprint,
      'postprocess': {'threshold': rnad.FineTuning().policy_threshold,
                      'discretization': rnad.FineTuning().policy_discretization},
      'evals': evals_for(args.policy, step),
  }
  write(args.out, header, network_tensors(saved['params'], saved['layers']))

  net = policies.network(saved['layers'], saved['num_actions'])
  params = saved['params']
  raw = lambda o, l: np.asarray(net.apply(params, rnad.EnvStep(obs=o, legal=l)))
  obs, legal, raw_probs, probs = fixture(policy, raw)
  write(args.fixture, {'format': 'keeps-policy-parity', 'run': run, 'step': step, 'fingerprint': fingerprint},
        [('obs', obs), ('legal', legal.astype(np.float32)), ('raw', raw_probs), ('probs', probs)])
  print(json.dumps({'weights': os.path.relpath(args.out, REPO), 'bytes': os.path.getsize(args.out),
                    'fixture': os.path.relpath(args.fixture, REPO), 'rows': len(obs), **header}, indent=1))


if __name__ == '__main__':
  main()
