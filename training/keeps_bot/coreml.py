"""The bot's policy network as a Core ML model, for Apple's Neural Engine (the iOS app's search).

  python -m keeps_bot.coreml <policy.bin> <out.mlpackage> [--check obs.f32 mask.u8]

The model maps observations [B, O] to logits [B, 48], in float16 throughout (the Neural Engine computes in float16;
measured on 3,675 real decisions, that changes the network's top move in 11, all near-ties, and a 512-world search's
best move in none of 16). B is one of BATCHES: the Neural Engine runs only fixed shapes, so callers pad a batch up
to the next size. The policy file's fingerprint and step go in the model's metadata, so the app can check that the
model is the network its TypeScript side encodes observations for.

--check (macOS only: Core ML runs there) compares the model's logits with the float32 network's on real
observations (float32 [N, O]) and their legal moves (uint8 [N, 48]).
"""

import argparse

import numpy as np
import torch

from keeps_bot import kpnn

BATCHES = (16, 64, 128, 256, 512)


class Logits(torch.nn.Module):
  """The agent's logits, as a plain module holding its layers: tracing probes every attribute of the modules it
  meets, and the agent's training mixin has properties that raise outside training."""

  def __init__(self, agent):
    super().__init__()
    for name, layer in agent.named_children():
      self.add_module(name, layer)
    self.eval()

  def forward(self, obs):
    from keeps_bot.vrpo.models import Agent
    return Agent.logits(self, obs)


def convert(policy_path, out_path):
  import coremltools as ct

  header, agent = kpnn.load_agent(policy_path)
  size = header['observationSize']
  traced = torch.jit.trace(Logits(agent), torch.zeros(BATCHES[-1], size))
  model = ct.convert(
      traced,
      convert_to='mlprogram',
      inputs=[ct.TensorType(name='obs', shape=ct.EnumeratedShapes(shapes=[(b, size) for b in BATCHES], default=(256, size)), dtype=np.float16)],
      outputs=[ct.TensorType(name='logits', dtype=np.float16)],
      compute_precision=ct.precision.FLOAT16,
      minimum_deployment_target=ct.target.iOS18,
  )
  model.short_description = f'Keeps policy {header["run"]} step {header["step"]}: observations to logits'
  model.user_defined_metadata.update({
      'fingerprint': header['fingerprint'], 'step': str(header['step']), 'run': str(header['run']),
      'observationSize': str(size), 'numActions': str(header['numActions']), 'batches': ','.join(map(str, BATCHES)),
  })
  model.save(out_path)
  print(f'{out_path}: {header["run"]} step {header["step"]} (fingerprint {header["fingerprint"]}), batches {BATCHES}')
  return header, agent


def check(agent, out_path, obs_path, mask_path, size):
  import coremltools as ct

  obs = np.fromfile(obs_path, dtype='<f4').reshape(-1, size)
  legal = np.fromfile(mask_path, dtype=np.uint8).reshape(len(obs), -1).astype(bool)
  with torch.inference_mode():
    want = agent.logits(torch.from_numpy(obs)).numpy()
  for units in ('CPU_ONLY', 'CPU_AND_GPU', 'CPU_AND_NE'):
    model = ct.models.MLModel(out_path, compute_units=getattr(ct.ComputeUnit, units))
    got = []
    for start in range(0, len(obs), 256):
      part = obs[start:start + 256]
      padded = np.zeros((256, size), np.float16)
      padded[:len(part)] = part
      got.append(model.predict({'obs': padded})['logits'][:len(part)].astype(np.float32))
    got = np.concatenate(got)

    def probs(logits):
      z = np.where(legal, logits, -np.inf)
      z = np.exp(z - z.max(1, keepdims=True))
      return z / z.sum(1, keepdims=True)

    p, q = probs(want), probs(got)
    tv = 0.5 * np.abs(p - q).sum(1)
    top = (p.argmax(1) != q.argmax(1)).sum()
    print(f'{units:12} {len(obs)} observations: total variation mean {100 * tv.mean():.2f}%, max {100 * tv.max():.1f}%;'
          f' top move changed in {top}; max |logit difference| {np.abs(np.where(legal, want - got, 0)).max():.3f}')


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('policy')
  parser.add_argument('out')
  parser.add_argument('--check', nargs=2, metavar=('OBS', 'MASK'))
  args = parser.parse_args()
  header, agent = convert(args.policy, args.out)
  if args.check:
    check(agent, args.out, *args.check, header['observationSize'])


if __name__ == '__main__':
  main()
