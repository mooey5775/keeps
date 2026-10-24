"""Exports a trained policy for the game server (packages/learn/src/policy.ts).

  PYTHONPATH= .venv/bin/python -m keeps_bot.export runs/r1/policy-14500.pkl

writes packages/learn/weights/bot.bin (the network) and
packages/learn/test/fixtures/bot-parity.bin (decision points from self-play with
the probabilities JAX gives them, which the TypeScript forward pass must
reproduce).

After an encoder change that leaves observations the same up to float rounding
(check by running the old and new encoders on the same rounds), the shipped
weights can be re-stamped with the new fingerprint instead of retrained:

  PYTHONPATH= .venv/bin/python -m keeps_bot.export --restamp

Don't re-stamp after a real change to what the network sees: it would play
nonsense (legally) without any error.

File format (both files): b'KPNN', a little-endian uint32 header length, the
JSON header (space-padded to a multiple of 4 bytes), then float32 tensors. The
header lists each tensor's name, shape and offset (in floats) and carries the
metadata: where the policy came from, the network shape, the post-processing
and the encoder fingerprint it was trained with.
"""

import os

if __name__ == '__main__':
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


def read(path):
  with open(path, 'rb') as f:
    data = f.read()
  assert data[:4] == b'KPNN', f'{path} is not a KPNN file'
  (length,) = struct.unpack('<I', data[4:8])
  return json.loads(data[8:8 + length]), data[8 + length:]


def restamp(paths, fingerprint):
  for path in paths:
    header, body = read(path)
    old = header['fingerprint']
    header['fingerprint'] = fingerprint
    head = json.dumps(header).encode()
    head += b' ' * (-len(head) % 4)
    with open(path, 'wb') as f:
      f.write(b'KPNN' + struct.pack('<I', len(head)) + head + body)
    print(f'{os.path.relpath(path, REPO)}: encoder {old} -> {fingerprint}')


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


def policy_file(saved, run, step, fingerprint, evals=None):
  """A saved policy as the server's weights file: (header, tensors)."""
  network = saved.get('network', 'mlp')
  header = {
      'format': 'keeps-policy',
      'version': 1,
      'run': run,
      'step': step,
      'decisions': saved.get('decisions'),
      'network': network,
      'observationVersion': saved.get('observation', 1),
      'layers': list(policies.layers_of(saved['params'])) if network == 'mlp' else [],
      'observationSize': keeps.bridge().observation_size,
      'numActions': saved['num_actions'],
      'fingerprint': fingerprint,
      # R-NaD's test-time post-processing; none (0, 0: the raw policy) for policies trained to be played as is.
      'postprocess': ({'threshold': rnad.FineTuning().policy_threshold,
                       'discretization': rnad.FineTuning().policy_discretization}
                      if saved.get('postprocess', 'rnad') == 'rnad' else {'threshold': 0, 'discretization': 0}),
      'evals': evals,
  }
  if network == 'entity':
    header['layout'] = saved['layout']
    # Every Haiku parameter, named module/parameter (the TypeScript forward pass looks them up by name).
    tensors = [(f'{module}/{name}', value) for module, group in sorted(saved['params'].items()) for name, value in sorted(group.items())]
  else:
    tensors = network_tensors(saved['params'], policies.layers_of(saved['params']))
  return header, tensors


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('policy', nargs='?', help='a policy-<step>.pkl saved by training')
  parser.add_argument('--restamp', action='store_true',
                      help="record the current encoder's fingerprint in the shipped weights (see above)")
  parser.add_argument('--out', default=WEIGHTS)
  parser.add_argument('--fixture', default=FIXTURE)
  parser.add_argument('--threshold', type=float, default=None,
                      help="play with moves under this probability dropped (and no rounding), instead of the policy's "
                           'own post-processing (the parity fixture still reflects its own)')
  args = parser.parse_args()
  if args.restamp:
    return restamp([args.out, args.fixture], keeps.bridge().fingerprint)
  if not args.policy:
    parser.error('give a policy to export (or --restamp)')

  policy, saved = policies.load(args.policy)
  keeps.set_observation(saved.get('observation', 1))
  current = keeps.bridge().fingerprint
  # Policies saved before training recorded the fingerprint were trained with the encoder as it is now.
  fingerprint = saved.get('fingerprint', current)
  if fingerprint != current:
    raise SystemExit(f'this policy was trained with encoder {fingerprint}; the encoder is now {current}')
  step = saved.get('learner_steps')
  if step is None:
    step = int(re.search(r'(\d+)\.pkl$', args.policy).group(1))
  run = os.path.basename(os.path.dirname(os.path.abspath(args.policy)))
  header, tensors = policy_file(saved, run, step, fingerprint, evals_for(args.policy, step))
  if args.threshold is not None:
    header['postprocess'] = {'threshold': args.threshold, 'discretization': 0}
  write(args.out, header, tensors)

  net = policies.build(saved)
  params = saved['params']
  entity = saved.get('network', 'mlp') == 'entity'

  def raw(o, l):
    out = net.apply(params, rnad.EnvStep(obs=o, legal=l))
    return np.asarray(out[0] if entity else out)

  obs, legal, raw_probs, probs = fixture(policy, raw)
  write(args.fixture, {'format': 'keeps-policy-parity', 'run': run, 'step': step, 'fingerprint': fingerprint},
        [('obs', obs), ('legal', legal.astype(np.float32)), ('raw', raw_probs), ('probs', probs)])
  print(json.dumps({'weights': os.path.relpath(args.out, REPO), 'bytes': os.path.getsize(args.out),
                    'fixture': os.path.relpath(args.fixture, REPO), 'rows': len(obs),
                    **{k: v for k, v in header.items() if k != 'layout'}}, indent=1))


if __name__ == '__main__':
  main()
