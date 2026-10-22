"""Keeps as a game for the vendored MARVEL trainer: the attributes its trainers and buffers read.

MARVEL resolves `TrainConfig(game_name='keeps')` to this module (marvel/game_identity.py).
Call configure() before building the trainer.

A trajectory is one heads-up round, a decision per step, in MARVEL's field names:
  obs_channels  [T, 2, O] float16  both players' observations (v2) at each step: the
                                   mover's is the policy's input, both are the critic's
  player_ids    [T]                the player to move (0 or 1)
  avail_weights [T, A]             1 for each legal action
  avail_probs   [T, A]             the probabilities the acting policy gave them
  action_taken  [T]
  rewards       [T, 2]             the round's result for each player, on its last step
  is_terminal   [T]
  critic_truth  [T, U] float16     the true state (packages/learn/src/truth.ts): what
                                   neither player knows, such as the piles' order, so the
                                   critic can tell the luck of a draw from the play
obs_tokens and avail_tokens are empty (MARVEL's token inputs; our networks read the rows).
critic_truth is a field MARVEL doesn't know: critic_replay_keys asks VRPO to keep it in
the critic's replay batches.
"""

import torch

GAME_IDENTIFIER = 'keeps'
num_players = 2
max_available_actions = 48
max_observation_tokens = 0
max_action_tokens = 0
critic_replay_keys = ('critic_truth',)
# Set by configure():
max_game_horizon = None
num_channels = None  # the observation size
layout = None  # observation v2's layout (packages/learn/src/observation2.ts)
truth_layout = None  # the true state's layout (packages/learn/src/truth.ts)


def configure(horizon, observation_size, observation_layout, true_state_layout):
  global max_game_horizon, num_channels, layout, truth_layout
  max_game_horizon, num_channels, layout = int(horizon), int(observation_size), observation_layout
  truth_layout = true_state_layout


def trajectory_field_specs():
  T, A, P, O = max_game_horizon, max_available_actions, num_players, num_channels
  if T is None:
    raise RuntimeError('call keeps_bot.vrpo.game.configure() first')

  def zeros(*shape, dtype=torch.float32):
    return lambda B, device: torch.zeros([B, *shape], dtype=dtype, device=device)

  return {
      'obs_tokens': zeros(T, P, 0, dtype=torch.long),
      'obs_channels': zeros(T, P, O, dtype=torch.float16),
      'player_ids': zeros(T, dtype=torch.long),
      'avail_tokens': zeros(T, A, 0, dtype=torch.long),
      'avail_weights': zeros(T, A),
      'avail_is_commit': zeros(T, A, dtype=torch.bool),
      'avail_probs': zeros(T, A),
      'action_taken': zeros(T, dtype=torch.long),
      'rewards': zeros(T, P),
      'is_terminal': zeros(T, dtype=torch.bool),
      'critic_truth': zeros(T, truth_layout['size'], dtype=torch.float16),
  }
