# Keeps bot: MVP plan

Goal: a **heads-up (2-player) Keeps bot trained with R-NaD** (Regularized Nash Dynamics, OpenSpiel's
implementation) that clearly beats a random player, is measured honestly, and can be played against in the app.

Decisions (2026-10-21):

- **R-NaD directly.** No search bot (ISMCTS), no determinizing resampler, no mini-Keeps variant.
- **One rules engine:** the TypeScript engine. Python drives it through a bridge; there is no Python copy of the rules.
- **Episode = one round, two players (seats 0 and 2).** Reward +1 for the round winner, -1 for the loser (zero-sum).
  Marks and whole games come later.
- **The observation is computed only from the player's view and their own log** (never the game state), so it can't
  leak by construction. It includes computed beliefs: which pile is which character, and which cards are left in
  each pile. It never uses prompt ids, event numbers, or event counts.
- **Multi-part moves become a sequence of choices** by the same player, each from a fixed set of integer action ids,
  with a legal-move mask.
- **Duplicity's free reveal** (C-11, "at any time") is offered to its holder at their own decision points and in the
  engine's reveal windows, which open exactly when a reveal can matter. Revealing during the opponent's decision is
  not modelled. This is a deliberate simplification, to measure later.

## Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | **Leak test** over random two-player games (view and log; valid swaps only) | Passes; it fails on a planted leak |
| M1 | **`@keeps/learn`** (TypeScript): action ids and sequential choices; observation encoder with belief features; round environment | Every legal command is reachable exactly once; random play through the environment never gets stuck; the encoder is deterministic and leak-free |
| M2 | **Bridge and OpenSpiel game:** a Node environment server; a Python `pyspiel` game backed by it | OpenSpiel's own random-simulation checks pass; throughput measured |
| M3 | **R-NaD training**: config, checkpoints, logs | A training run completes and the loss and policy entropy behave |
| M4 | **Evaluation:** against a random player (duplicate deals, both seats) and against earlier checkpoints | Win rate with confidence intervals; improvement over checkpoints |
| M5 | **Play it:** export the trained network; run it in TypeScript (a small forward pass); "Play against the bot" | A person can play a round against it in the browser |

## Layout

- `packages/learn/`: action space, observation encoder, belief tracking, round environment, env server (TypeScript).
- `bot/`: Python. The OpenSpiel game wrapper, training and evaluation scripts. Its own virtualenv (`bot/.venv`, not committed).
