"""A trained policy from its saved weights, without the rest of the solver.

Training saves `policy-<step>.pkl` (weights and shape) next to its checkpoints;
`load()` rebuilds the network R-NaD trains (same modules, so the same parameter
names) and returns a function from observations and legal masks to action
probabilities, post-processed the way R-NaD plays at test time (actions under
3% dropped, the rest rounded to 32nds).
"""

import os
import pickle

import haiku as hk
import jax
import jax.numpy as jnp
import numpy as np

from keeps_bot import networks
from keeps_bot import rnad


def network(layers, num_actions):
  """R-NaD's network (RNaDSolver.init), returning the policy only."""

  def forward(env_step):
    torso = hk.nets.MLP(layers, activate_final=True)(env_step.obs)
    logit = hk.nets.MLP([num_actions])(torso)
    hk.nets.MLP([1])(torso)  # the value head: unused here, built so the parameters match
    return rnad._legal_policy(logit, env_step.legal)

  return hk.without_apply_rng(hk.transform(forward))


def build(saved):
  """The Haiku network a saved policy was trained with (R-NaD's MLP, or the entity network)."""
  if saved.get('network', 'mlp') == 'entity':
    return hk.without_apply_rng(hk.transform(networks.entity(saved['layout'], saved['num_actions'])))
  net = network(layers_of(saved['params']), saved['num_actions'])
  return net


def layers_of(params):
  """The torso's layer sizes, read from the weights (a saved label can be wrong; the weights can't)."""
  sizes = []
  while f'mlp/~/linear_{len(sizes)}' in params:
    sizes.append(int(params[f'mlp/~/linear_{len(sizes)}']['w'].shape[1]))
  return tuple(sizes)


def save(path, params, layers, num_actions, **info):
  """Writes the policy atomically (the evaluator may be watching for it)."""
  tmp = path + '.tmp'
  with open(tmp, 'wb') as f:
    pickle.dump({'params': jax.device_get(params), 'layers': tuple(layers), 'num_actions': num_actions, **info}, f)
  os.replace(tmp, path)


def load(path):
  """(policy function, saved info). The function maps (obs [B, O], legal [B, A]) to probabilities [B, A]."""
  with open(path, 'rb') as f:
    saved = pickle.load(f)
  if saved.get('network', 'mlp') == 'mlp':
    saved['layers'] = layers_of(saved['params'])
  net = build(saved)
  entity = saved.get('network', 'mlp') == 'entity'
  params = jax.device_put(saved['params'])
  finetune = rnad.FineTuning()

  @jax.jit
  def probabilities(params, obs, legal):
    out = net.apply(params, rnad.EnvStep(obs=obs, legal=legal))
    pi = out[0] if entity else out
    return finetune.post_process_policy(pi, legal)

  return (lambda obs, legal: np.asarray(probabilities(params, jnp.asarray(obs), jnp.asarray(legal)))), saved


def uniform(obs, legal):
  """The random player: every legal action equally likely."""
  legal = np.asarray(legal, dtype=np.float64)
  return legal / legal.sum(axis=1, keepdims=True)
