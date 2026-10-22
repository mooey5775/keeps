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
- **Duplicity's free reveal** (C-11, "at any time") is offered to its holder only at their own decision points and in
  the engine's reveal windows. Revealing while the opponent is deciding is not modelled, to keep one player acting
  at a time as OpenSpiel requires.

## Known limitations

- **The bot can't reveal a hidden Shackles to end the opponent's turn (C-14).** The official trick is: Duplicity's
  holder reveals a face-down Shackles in the turn player's keep after their first action, which ends their turn. That
  moment is the opponent's decision, not one of the engine's reveal windows (the engine needs none there, because the
  turn player's next action is already a pause), so the simplification above rules it out. Accepted for the MVP (user,
  2026-10-21). The fix, if it matters: give the Duplicity holder a reveal-or-pass choice before the turn player's
  second action whenever a face-down Shackles sits in their keep.
- Every other reveal timing the clarifications describe (Interest when a Coin card enters, Retribution when the
  triggering card is played, Last Laugh at round end) happens in a reveal window or on the holder's own decision, so
  it's available.

## Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | **Leak test** over random two-player games (view and log; valid swaps only) | Passes; it fails on a planted leak |
| M1 | **`@keeps/learn`** (TypeScript): action ids and sequential choices; observation encoder with belief features; round environment | Every legal command is reachable exactly once; random play through the environment never gets stuck; the encoder is deterministic and leak-free |
| M2 | **Bridge and OpenSpiel game:** a Node environment server; a Python `pyspiel` game backed by it | OpenSpiel's own random-simulation checks pass; throughput measured |
| M3 | **R-NaD training**: config, checkpoints, logs | A training run completes and the loss and policy entropy behave |
| M4 | **Evaluation:** against a random player (duplicate deals, both seats) and against earlier checkpoints | Win rate with confidence intervals; improvement over checkpoints |
| M5 | **Play it:** export the trained network; run it in TypeScript (a small forward pass); "Play against the bot" | A person can play a round against it in the browser |

## M5: play against the bot

Decisions (2026-10-21):

- **The bot runs on the server**, as a seat in an ordinary room. In the browser it would need its own hand there, so
  anyone could read it, and that rules out rated games later. As a room seat it gets replays, analytics, disputes and
  reconnection for free. Cost: a few ms of CPU per bot move, ~3 MB of weights in memory.
- **2-player rooms only** (that's what it's trained for). Live 2-player games seat players at 0 and 2 like training,
  each round gives one mark, and the observation has nothing about marks, so rounds 2+ of a longer game are in
  distribution and maximizing round wins is right for the match.
- **No undo in games against the bot.**
- **Entry:** "Play against the bot" on the home page (a room with the bot added), and Add/Remove bot in the lobby of a
  2-player room.
- **Weights committed to git as float32** (~2.8 MB for 512×512), replaced when a better policy ships.
- **The bot waits about a second before each move** (less for the later parts of a multi-step choice) so it can be
  followed.

Parts:

1. **Export** (`bot/keeps_bot/export.py`): `policy-<step>.pkl` → a weights file whose header records the run, step,
   network shape, post-processing (drop actions under 3%, round to 32nds), eval results, and the **encoder version**.
   The server refuses weights whose encoder version differs from its own, so a changed observation can't silently
   feed the network garbage.
2. **Inference in TypeScript** (`packages/learn/src/policy.ts`): the forward pass on Float32Arrays, R-NaD's legal
   softmax and post-processing ported exactly, sampling. A `Bot` picks a command for a seat from the game state: its
   view and log (it rebuilds its belief from the log, so it holds no state across moves), choosing ids one at a time
   through `Decision`. The free Duplicity reveal is considered only at its own decisions, as in training.
3. **Tests:** Python writes (observation, legal, probabilities) triples from a real policy and TypeScript must
   reproduce them; the bot plays hundreds of rounds without errors or stalls.
4. **Server:** a bot player (no socket); whenever the engine waits on its seat, a move is scheduled after the delay and
   applied through the same command path as a human's. Humans start the next round. Analytics tag games with the
   bot's run and step, so human-vs-bot results measure its strength.
5. **Web:** the home button, Add/Remove bot in the lobby, a "Bot" badge and a "thinking…" hint at the table.

## Layout

- `packages/learn/`: action space, observation encoder, belief tracking, round environment, env server (TypeScript).
- `bot/`: Python. The OpenSpiel game wrapper, training and evaluation scripts. Its own virtualenv (`bot/.venv`, not committed).
