"""The policy and central critic VRPO trains, in place of MARVEL's transformers.

MARVEL's trainer builds `Agent(cfg, enable_value_head=False)` and
`CentralCritic(cfg, output_mode='qvalue')` (marvel/model/__init__.py points them
here) and calls them on rollouts: [B, T] trajectories in the fields of
keeps_bot/vrpo/game.py. Both compute only the steps a trajectory has (t < num_steps)
and leave the rest zero, as MARVEL's mask them.

  Agent          our entity network (keeps_bot/networks.py `entity`), ported line for
                 line: the policy over the 48 action ids from the mover's observation.
                 haiku_params() converts it to the Haiku parameters `entity` uses, so
                 the JAX evaluator, the exporter and the TypeScript bot read it as is.
  CentralCritic  MARVEL's central Q critic: each player's observation encoded (the
                 same entity torso, its own weights), mixed by MARVEL's ResGatedMLP,
                 and Q(a, p) the product of player p's mixed state and action a's
                 feature with a weight vector, as in marvel/model/critic.py. An
                 action's feature is a learned vector per action id, plus, for a card
                 or a position, a projection of that card's or position's rows in the
                 mover's view (the pointer heads' candidates).

Both compute each step on its own, so a rollout's steps go through in chunks of
CHUNK (MARVEL scores a whole iteration's rounds at once, ~135,000 steps): with
gradients, each chunk is checkpointed (recomputed in the backward pass), so memory
holds one chunk's activations, not the minibatch's.

Parameters are named and initialized as in the Haiku network (truncated normal,
1/sqrt(fan in)). Following MARVEL's optimizer grouping (marvel/model/trainable.py),
layers reading raw observation rows and the final logit and value layers are
marked no-weight-decay, so AdamW trains them; Muon trains the hidden matrices.
"""

import math

import numpy as np
import torch
import torch.nn as nn
from torch.utils.checkpoint import checkpoint

from marvel.model.base import BaseMarvelModule, ResGatedMLP
from marvel.model.checkpointable import CheckpointableModule
from marvel.model.trainable import TrainableModule
from marvel.model.types import AgentOutput, CriticOutput

CARD_EMBEDDING = 16
CARD_DIM = 64
PILE_DIM = 64
PLAYER_DIM = 32
TURN_DIM = 32
TRUNK = 512
BLOCKS = 3
HEAD = 64
FEATURE = 256  # the critic's state and action features (MARVEL's feature_dim)
CHUNK = 8192  # steps per chunk (see above)
_TRUNCATION = 0.87962566103423978  # Haiku's TruncatedNormal: stddev of the unit normal truncated to ±2


def _truncated_normal_(tensor, stddev):
  std = stddev / _TRUNCATION
  return nn.init.trunc_normal_(tensor, std=std, a=-2 * std, b=2 * std)


def linear(fan_in, fan_out, bias=True, no_weight_decay=False):
  """hk.Linear: weights truncated normal with stddev 1/sqrt(fan_in), zero bias."""
  layer = nn.Linear(fan_in, fan_out, bias=bias)
  _truncated_normal_(layer.weight, 1 / math.sqrt(fan_in))
  if bias:
    nn.init.zeros_(layer.bias)
  if no_weight_decay:
    TrainableModule._mark_no_weight_decay(layer)
  return layer


def mlp(sizes):
  """hk.nets.MLP(sizes[1:], activate_final=True); its first layer reads raw rows."""
  layers = []
  for i in range(len(sizes) - 1):
    layers += [linear(sizes[i], sizes[i + 1], no_weight_decay=i == 0), nn.ReLU()]
  return nn.Sequential(*layers)


class EntityTorso(nn.Module):
  """networks.entity up to the trunk's output, plus the pieces its heads read."""

  def __init__(self, layout):
    super().__init__()
    self.blocks_layout = layout['blocks']
    places = layout['places']
    self.my_keep, self.opponent_keep = places.index('my-keep'), places.index('opponent-keep')
    b = self.blocks_layout
    card_width, pile_width = b['cards']['width'], b['piles']['width']
    pools = len(places) * CARD_DIM
    trunk_inputs = (pools + b['piles']['rows'] * PILE_DIM + b['players']['rows'] * PLAYER_DIM + TURN_DIM
                    + b['decision']['width'] + CARD_DIM + PILE_DIM)

    self.card_embedding = nn.Parameter(_truncated_normal_(torch.empty(b['cards']['rows'], CARD_EMBEDDING), 0.1))
    self.card_in = linear(card_width, 128, no_weight_decay=True)
    self.card_embed = linear(CARD_EMBEDDING, 128, bias=False)
    self.card_out = linear(128, CARD_DIM)
    self.pile = mlp([pile_width, 64, PILE_DIM])
    self.player = mlp([b['players']['width'], 32, PLAYER_DIM])
    self.turn = mlp([b['turns']['width'], 32, TURN_DIM])
    self.trunk_in = linear(trunk_inputs, TRUNK)
    self.blocks = nn.ModuleList(
        nn.ModuleDict({'norm': nn.LayerNorm(TRUNK), 'a': linear(TRUNK, TRUNK), 'b': linear(TRUNK, TRUNK)})
        for _ in range(BLOCKS))
    self.trunk_norm = nn.LayerNorm(TRUNK)

  def rows(self, obs, name):
    b = self.blocks_layout[name]
    return obs[:, b['offset']:b['offset'] + b['rows'] * b['width']].reshape(obs.shape[0], b['rows'], b['width'])

  def column(self, x, block, name):
    start, width = self.blocks_layout[block]['columns'][name]
    return x[..., start:start + width]

  def forward(self, obs):
    """obs [n, O] float32 → the trunk's output x [n, 512] and the entity features the heads use."""
    n = obs.shape[0]
    cards = self.rows(obs, 'cards')  # [n, 36, Wc]
    piles = self.rows(obs, 'piles')  # [n, 4, Wp]
    players = self.rows(obs, 'players')  # [n, 2, Wq]
    turns = self.rows(obs, 'turns')  # [n, 6, Wt]
    decision = self.rows(obs, 'decision')[:, 0]  # [n, Wd]

    hidden = self.card_in(cards) + self.card_embed(self.card_embedding)
    h_card = torch.relu(self.card_out(torch.relu(hidden)))  # [n, 36, 64]
    h_pile = self.pile(piles)  # [n, 4, 64]
    h_player = self.player(players)  # [n, 2, 32]
    h_turns = self.turn(turns).sum(-2)  # [n, 32]

    location = self.column(cards, 'cards', 'location')  # [n, 36, 13]
    pools = torch.einsum('ncp,ncd->npd', location, h_card)  # [n, 13, 64]
    card_weight = self.column(cards, 'cards', 'subject')[..., 0] + self.column(cards, 'cards', 'chosen')[..., 0]
    subject_card = torch.einsum('nc,ncd->nd', card_weight, h_card)
    subject_pile = torch.einsum('nr,nrd->nd', self.column(piles, 'piles', 'chosen')[..., 0], h_pile)

    x = torch.cat([pools.reshape(n, -1), h_pile.reshape(n, -1), h_player.reshape(n, -1), h_turns,
                   decision, subject_card, subject_pile], -1)
    x = self.trunk_in(x)
    for block in self.blocks:
      y = block['norm'](x)
      y = block['a'](torch.relu(y))
      y = block['b'](torch.relu(y))
      x = x + y
    x = torch.relu(self.trunk_norm(x))
    # Positions: own, left, opposite, right. Seats 0 and 2 (relative) are the players, with keeps.
    zeros_keep = torch.zeros_like(pools[:, 0])
    zeros_player = torch.zeros_like(h_player[:, 0])
    keep_at = torch.stack([pools[:, self.my_keep], zeros_keep, pools[:, self.opponent_keep], zeros_keep], 1)
    player_at = torch.stack([h_player[:, 0], zeros_player, h_player[:, 1], zeros_player], 1)
    positions = torch.cat([h_pile, player_at, keep_at], -1)  # [n, 4, 160]
    return x, h_card, positions, subject_card, subject_pile


def _by_chunks(fn, *rows):
  """fn(*rows) for row-independent fn, a chunk of rows at a time (checkpointed when computing gradients)."""
  n = rows[0].shape[0]
  if n <= CHUNK:
    return fn(*rows)
  out = []
  for start in range(0, n, CHUNK):
    part = [r[start:start + CHUNK] for r in rows]
    out.append(checkpoint(fn, *part, use_reentrant=False) if torch.is_grad_enabled() else fn(*part))
  return torch.cat(out)


def _valid_steps(rollout):
  """The (trajectory, step) indices of the steps trajectories have."""
  num_steps, player_ids = rollout['num_steps'], rollout['player_ids']
  t_max = player_ids.shape[1]
  valid = torch.arange(t_max, device=num_steps.device)[None, :] < num_steps[:, None]
  return valid.nonzero(as_tuple=True)


class Agent(CheckpointableModule, TrainableModule):
  """The policy: networks.entity's policy head (its value head isn't trained: MARVEL's critic is separate)."""

  checkpoint_state_key = 'agent_state_dict'

  def __init__(self, cfg, *, enable_value_head=False):
    super().__init__()
    if enable_value_head:
      raise ValueError('the Keeps agent has no value head (VRPO uses the central critic)')
    game = cfg.game
    layout = game.layout
    self.num_actions = int(game.max_available_actions)
    self.first_special = min(layout['specialIds'])
    self.torso = EntityTorso(layout)
    self.query = linear(TRUNK, HEAD)
    self.card_head_candidate = linear(CARD_DIM, HEAD)
    self.card_head_subject = linear(CARD_DIM, HEAD, bias=False)
    self.card_head_out = linear(HEAD, 1, no_weight_decay=True)
    self.pos_head_candidate = linear(PILE_DIM + PLAYER_DIM + CARD_DIM, HEAD)
    self.pos_head_decision = linear(HEAD, HEAD, bias=False)
    self.pos_head_subject = linear(CARD_DIM + PILE_DIM, HEAD, bias=False)
    self.pos_head_out = linear(HEAD, 1, no_weight_decay=True)
    self.special = linear(TRUNK, self.num_actions - self.first_special, no_weight_decay=True)

  def logits(self, obs):
    """obs [n, O] float32 → logits [n, 48]."""
    x, h_card, positions, subject_card, subject_pile = self.torso(obs)
    query = self.query(x)
    card_hidden = self.card_head_candidate(h_card) + query[:, None, :] + self.card_head_subject(subject_card)[:, None, :]
    card_logit = self.card_head_out(torch.relu(card_hidden))[..., 0]  # [n, 36]
    pos_hidden = (self.pos_head_candidate(positions) + self.pos_head_decision(query)[:, None, :]
                  + self.pos_head_subject(torch.cat([subject_card, subject_pile], -1))[:, None, :])
    pos_logit = self.pos_head_out(torch.relu(pos_hidden))[..., 0]  # [n, 4]
    return torch.cat([card_logit, pos_logit, self.special(x)], -1)

  def probabilities(self, obs, legal):
    """A softmax over the legal actions (rnad._legal_policy): obs [n, O], legal [n, 48] bool → [n, 48] float32."""
    return torch.softmax(self.logits(obs).float().masked_fill(~legal, float('-inf')), -1)

  def forward(self, rollout, *, use_cache=False, past_key_values=None, cache_only=False):
    if use_cache or cache_only:
      raise ValueError('the Keeps agent keeps no cache (it reads each step on its own)')
    b, t = _valid_steps(rollout)
    mover = rollout['player_ids'][b, t]
    obs = rollout['obs_channels'][b, t, mover]  # float16 until its chunk
    legal = rollout['avail_weights'][b, t] > 0
    probs = _by_chunks(lambda o, l: self.probabilities(o.float(), l), obs, legal)
    out = probs.new_zeros(rollout['player_ids'].shape + (self.num_actions,))
    out[b, t] = probs
    return AgentOutput(avail_probs=out)


class CentralCritic(CheckpointableModule, TrainableModule):
  """Q(s, a) for both players at each step, from both players' observations."""

  checkpoint_state_key = 'critic_state_dict'

  def __init__(self, cfg, *, output_mode='qvalue'):
    super().__init__()
    if output_mode != 'qvalue':
      raise ValueError('the Keeps critic gives Q values only')
    game = cfg.game
    self.num_actions = int(game.max_available_actions)
    self.num_players = int(game.num_players)
    first_special = min(game.layout['specialIds'])
    self.num_specials = self.num_actions - first_special
    self.torso = EntityTorso(game.layout)
    self.state_proj = linear(TRUNK, FEATURE)
    # MARVEL's critic mixer (critic.py, architecture v1.2+): its ResGatedMLP over the players' features.
    self.critic_mixer = ResGatedMLP(self.num_players * FEATURE, n_layers=cfg.model.fuse_layers, expansion_ratio=1)
    action_embedding = torch.empty(self.num_actions, FEATURE)
    nn.init.normal_(action_embedding)  # as MARVEL's embeddings (TrainableModule._init_module)
    self.action_embedding = nn.Parameter(action_embedding)
    self.card_action = linear(CARD_DIM, FEATURE)
    self.pos_action = linear(PILE_DIM + PLAYER_DIM + CARD_DIM, FEATURE)
    # MARVEL's value head: an output projection, std 0.01 (critic.py).
    self.value_head = BaseMarvelModule._build_output_proj(FEATURE, std=0.01)

  def q_values(self, obs, mover, legal):
    """obs [n, 2, O] float32 (player 0's, player 1's), mover [n], legal [n, 48] → Q [n, 48, 2]."""
    n = obs.shape[0]
    x, h_card, positions, _, _ = self.torso(obs.reshape(n * self.num_players, -1))
    state = self.state_proj(x).reshape(n, self.num_players * FEATURE)
    mixed = self.critic_mixer(state).reshape(n, self.num_players, FEATURE)
    # Action features from the mover's view.
    pick = torch.arange(n, device=obs.device) * self.num_players + mover
    entity = torch.cat([self.card_action(h_card[pick]), self.pos_action(positions[pick]),
                        h_card.new_zeros(n, self.num_specials, FEATURE)], 1)
    actions = self.action_embedding[None] + entity  # [n, 48, F]
    q = torch.einsum('npd,nad,d->nap', mixed, actions, self.value_head.weight[0]) + self.value_head.bias
    return q.masked_fill(~legal[..., None], 0.0)

  def forward(self, rollout, *, use_cache=False, past_key_values=None):
    if use_cache:
      raise ValueError('the critic keeps no cache')
    b, t = _valid_steps(rollout)
    obs = rollout['obs_channels'][b, t]  # float16 until its chunk
    legal = rollout['avail_weights'][b, t] > 0
    q = _by_chunks(lambda o, m, l: self.q_values(o.float(), m, l), obs, rollout['player_ids'][b, t], legal)
    out = q.new_zeros(rollout['player_ids'].shape + (self.num_actions, self.num_players))
    out[b, t] = q
    return CriticOutput(qvalues=out)


# The Haiku module each layer of the agent is, in networks.entity.
_HAIKU_LINEARS = {
    'card_in': 'torso.card_in', 'card_embed': 'torso.card_embed', 'card_out': 'torso.card_out',
    'pile/~/linear_0': 'torso.pile.0', 'pile/~/linear_1': 'torso.pile.2',
    'player/~/linear_0': 'torso.player.0', 'player/~/linear_1': 'torso.player.2',
    'turn/~/linear_0': 'torso.turn.0', 'turn/~/linear_1': 'torso.turn.2',
    'trunk_in': 'torso.trunk_in',
    **{f'block{i}_{part}': f'torso.blocks.{i}.{part}' for i in range(BLOCKS) for part in 'ab'},
    'query': 'query', 'card_head_candidate': 'card_head_candidate', 'card_head_subject': 'card_head_subject',
    'card_head_out': 'card_head_out', 'pos_head_candidate': 'pos_head_candidate',
    'pos_head_decision': 'pos_head_decision', 'pos_head_subject': 'pos_head_subject', 'pos_head_out': 'pos_head_out',
    'special': 'special',
}
_HAIKU_NORMS = {**{f'block{i}_norm': f'torso.blocks.{i}.norm' for i in range(BLOCKS)}, 'trunk_norm': 'torso.trunk_norm'}


def haiku_params(agent):
  """The agent as networks.entity's Haiku parameters (numpy), the value head zero (it isn't trained)."""
  modules = dict(agent.named_modules())
  out = {'~': {'card_embedding': agent.torso.card_embedding.detach().cpu().numpy().copy()}}
  for name, path in _HAIKU_LINEARS.items():
    layer = modules[path]
    out[name] = {'w': layer.weight.detach().cpu().numpy().T.copy()}
    if layer.bias is not None:
      out[name]['b'] = layer.bias.detach().cpu().numpy().copy()
  for name, path in _HAIKU_NORMS.items():
    norm = modules[path]
    out[name] = {'scale': norm.weight.detach().cpu().numpy().copy(), 'offset': norm.bias.detach().cpu().numpy().copy()}
  out['value/~/linear_0'] = {'w': np.zeros((TRUNK, 128), np.float32), 'b': np.zeros(128, np.float32)}
  out['value/~/linear_1'] = {'w': np.zeros((128, 1), np.float32), 'b': np.zeros(1, np.float32)}
  return out


@torch.no_grad()
def load_haiku_params(agent, params):
  """Sets the agent's weights from networks.entity's Haiku parameters (the inverse of haiku_params)."""
  modules = dict(agent.named_modules())
  agent.torso.card_embedding.copy_(torch.as_tensor(np.asarray(params['~']['card_embedding'])))
  for name, path in _HAIKU_LINEARS.items():
    layer = modules[path]
    layer.weight.copy_(torch.as_tensor(np.asarray(params[name]['w'])).T)
    if layer.bias is not None:
      layer.bias.copy_(torch.as_tensor(np.asarray(params[name]['b'])))
  for name, path in _HAIKU_NORMS.items():
    modules[path].weight.copy_(torch.as_tensor(np.asarray(params[name]['scale'])))
    modules[path].bias.copy_(torch.as_tensor(np.asarray(params[name]['offset'])))
