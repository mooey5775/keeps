"""Networks for the Keeps bot, as Haiku functions of an R-NaD EnvStep.

  mlp      R-NaD's own: an MLP torso on the flat observation (observation v1).
  entity   for observation v2 (packages/bot/src/observation2.ts): shared MLPs
           over the card rows and over the pile rows, pooled by place, a residual
           trunk, and pointer-style heads: each card id is scored from that card's
           own vector, each position from that pile's (and that seat's keep and
           player's) vector, both alongside the decision's subject (the card the
           prompt is about, or the card and pile already chosen in this move).

Both return (pi, v, log_pi, logit) like R-NaD's network, v with shape [..., 1].
The TypeScript forward pass (packages/bot/src/policy.ts) must match this
exactly; its parity test checks it against JAX.
"""

import haiku as hk
import jax
import jax.numpy as jnp

from keeps_bot import rnad

CARD_EMBEDDING = 16
CARD_DIM = 64
PILE_DIM = 64
PLAYER_DIM = 32
TURN_DIM = 32
TRUNK = 512
BLOCKS = 3
HEAD = 64


def mlp(layers, num_actions):
  """R-NaD's network (RNaDSolver._network_function's default)."""

  def forward(env_step):
    torso = hk.nets.MLP(layers, activate_final=True)(env_step.obs)
    logit = hk.nets.MLP([num_actions])(torso)
    v = hk.nets.MLP([1])(torso)
    return rnad._legal_policy(logit, env_step.legal), v, rnad.legal_log_policy(logit, env_step.legal), logit

  return forward


def entity(layout, num_actions):
  """The entity network for observation v2; `layout` is LAYOUT2 (from the environment server's info)."""
  blocks = layout['blocks']
  places = layout['places']
  my_keep, opponent_keep = places.index('my-keep'), places.index('opponent-keep')
  first_special = min(layout['specialIds'])

  def rows(obs, name):
    b = blocks[name]
    flat = obs[..., b['offset']:b['offset'] + b['rows'] * b['width']]
    return flat.reshape(obs.shape[:-1] + (b['rows'], b['width']))

  def column(x, block, name):
    start, width = blocks[block]['columns'][name]
    return x[..., start:start + width]

  def forward(env_step):
    obs = env_step.obs.astype(jnp.float32)
    lead = obs.shape[:-1]
    logit, v = body(obs.reshape((-1, obs.shape[-1])))
    logit = logit.reshape(lead + (num_actions,))
    v = v.reshape(lead + (1,))
    legal = env_step.legal
    return rnad._legal_policy(logit, legal), v, rnad.legal_log_policy(logit, legal), logit

  def body(obs):
    n = obs.shape[0]
    cards = rows(obs, 'cards')  # [n, 36, Wc]
    piles = rows(obs, 'piles')  # [n, 4, Wp]
    players = rows(obs, 'players')  # [n, 2, Wq]
    turns = rows(obs, 'turns')  # [n, 6, Wt]
    decision = rows(obs, 'decision')[:, 0]  # [n, Wd]

    embedding = hk.get_parameter('card_embedding', [cards.shape[1], CARD_EMBEDDING],
                                 init=hk.initializers.TruncatedNormal(0.1))
    # The card encoder's first layer on [card row, embedding], as a sum of two linear maps
    # (the same function as one on the concatenation, without building it for every position).
    hidden = hk.Linear(128, name='card_in')(cards) + hk.Linear(128, with_bias=False, name='card_embed')(embedding)
    h_card = jax.nn.relu(hk.Linear(CARD_DIM, name='card_out')(jax.nn.relu(hidden)))  # [n, 36, 64]
    h_pile = hk.nets.MLP([64, PILE_DIM], activate_final=True, name='pile')(piles)  # [n, 4, 64]
    h_player = hk.nets.MLP([32, PLAYER_DIM], activate_final=True, name='player')(players)  # [n, 2, 32]
    h_turns = hk.nets.MLP([32, TURN_DIM], activate_final=True, name='turn')(turns).sum(-2)  # [n, 32]

    # Pool the cards by where they (probably) are: my keep, their hand, each pile, ...
    location = column(cards, 'cards', 'location')  # [n, 36, 13]
    pools = jnp.einsum('ncp,ncd->npd', location, h_card)  # [n, 13, 64]
    # The decision's subject: the card the prompt is about, and cards and piles already chosen.
    card_weight = column(cards, 'cards', 'subject')[..., 0] + column(cards, 'cards', 'chosen')[..., 0]
    subject_card = jnp.einsum('nc,ncd->nd', card_weight, h_card)
    subject_pile = jnp.einsum('nr,nrd->nd', column(piles, 'piles', 'chosen')[..., 0], h_pile)

    x = jnp.concatenate([pools.reshape(n, -1), h_pile.reshape(n, -1), h_player.reshape(n, -1), h_turns,
                         decision, subject_card, subject_pile], -1)
    x = hk.Linear(TRUNK, name='trunk_in')(x)
    for i in range(BLOCKS):
      y = hk.LayerNorm(-1, True, True, name=f'block{i}_norm')(x)
      y = hk.Linear(TRUNK, name=f'block{i}_a')(jax.nn.relu(y))
      y = hk.Linear(TRUNK, name=f'block{i}_b')(jax.nn.relu(y))
      x = x + y
    x = jax.nn.relu(hk.LayerNorm(-1, True, True, name='trunk_norm')(x))

    v = hk.nets.MLP([128, 1], name='value')(x)  # [n, 1]
    # Pointer heads: a hidden layer on [decision query, candidate, subject], summed per part
    # (the decision and subject terms once per position, the candidate term per candidate).
    query = hk.Linear(HEAD, name='query')(x)  # [n, 64]
    card_hidden = (hk.Linear(HEAD, name='card_head_candidate')(h_card) + query[:, None, :]
                   + hk.Linear(HEAD, with_bias=False, name='card_head_subject')(subject_card)[:, None, :])
    card_logit = hk.Linear(1, name='card_head_out')(jax.nn.relu(card_hidden))[..., 0]  # [n, 36]
    # Positions: own, left, opposite, right. Seats 0 and 2 (relative) are the players, with keeps.
    zeros_keep = jnp.zeros_like(pools[:, 0])
    zeros_player = jnp.zeros_like(h_player[:, 0])
    keep_at = jnp.stack([pools[:, my_keep], zeros_keep, pools[:, opponent_keep], zeros_keep], 1)  # [n, 4, 64]
    player_at = jnp.stack([h_player[:, 0], zeros_player, h_player[:, 1], zeros_player], 1)  # [n, 4, 32]
    pos_hidden = (hk.Linear(HEAD, name='pos_head_candidate')(jnp.concatenate([h_pile, player_at, keep_at], -1))
                  + hk.Linear(HEAD, with_bias=False, name='pos_head_decision')(query)[:, None, :]
                  + hk.Linear(HEAD, with_bias=False, name='pos_head_subject')(
                      jnp.concatenate([subject_card, subject_pile], -1))[:, None, :])
    pos_logit = hk.Linear(1, name='pos_head_out')(jax.nn.relu(pos_hidden))[..., 0]  # [n, 4]
    special_logit = hk.Linear(num_actions - first_special, name='special')(x)  # [n, 8]
    return jnp.concatenate([card_logit, pos_logit, special_logit], -1), v

  return forward
