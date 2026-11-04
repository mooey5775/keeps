# Keeps bot: Midstrike

## Where it stands (2026-11-01)

**Midstrike** is the bot people play on playkeeps.online and in the iOS app: a network trained by self-play, and a
search at play time on top of it.

- **The network:** `vrpo1` at 40,000 iterations, trained with VRPO (Ataraxos's learner, `training/keeps_bot/vrpo`):
  the entity network on observation v2, heads-up, one round an episode. Its weights are
  `packages/bot/weights/midstrike.bin`.
- **The search** (`packages/bot/src/search`): at each decision with a real choice, worlds sampled exactly from what the
  bot knows (`worlds.ts`), every candidate played out to the round's end in each (the network on both sides, sampled
  rollouts), and the move with the best result played (best-Q; near-ties, within 0.05·√(512/worlds), go to the
  network's favourite).
- **Levels:** Easy plays the network's own move; Medium searches 64 worlds; Hard 2,048 on the website (on gpu03: a
  worker that polls the website for jobs, the network batched on a GPU) and 512 in the app (Web Workers, the network on
  the Neural Engine). A decision takes about 1.6 s on gpu03.
- **Around it:** training mode (the search's advice for your own moves, at Hard), and a review of each round of a game
  against it, move by move (`packages/bot/src/review`).

The rest of this document is the record: the plan it started from (R-NaD, 2026-10-21), its open problems, and what
building and training it taught.

## The original plan (2026-10-21)

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

## Open problems

The bot's open problems, in detail, each with what it would take. What to do next, and in what order, is in
[ROADMAP.md](ROADMAP.md).

- **Providence is sometimes missed.** The network plays it 16% of the time on average where it's playable, and under 1%
  at three positions in four, and in game XDMY (2026-10-30) it missed a swap that won the round outright: only search
  found it (100% against 78% for drawing), in the player's seat or in Midstrike's playouts of the player.
  `packages/learn/tools/providence.ts` is a benchmark for it: 327 self-play positions where Providence is playable
  (`benchmarks/providence-positions.jsonl`), reference values from Midstrike's search at 1,024 worlds, from the
  decider's information (`benchmarks/providence-reference-vrpo1-40000.jsonl`), and a scorer that rates any network
  against them in seconds: `node providence.ts score benchmarks/providence-positions.jsonl
  benchmarks/providence-reference-vrpo1-40000.jsonl <weights.bin>`. vrpo1 40,000 (2026-10-30):

  | | Positions | vrpo1 40,000 |
  |---|---|---|
  | Providence clearly best (by 3+ points) | 27 (8%) | plays it 59% |
  | Providence clearly worse | 257 (79%) | plays it 1.3% |
  | Where it's best, the best pair | 27 | 59% |
  | Expected loss of win chance a decision, Providence best | | 6.15 points |
  | Expected loss of win chance a decision, elsewhere | | 1.52 points |

  Mostly sound: rarely playing it is right, since it's clearly worse at four positions in five. The weakness is the
  rare positions where it wins: missed two times in five, and then the wrong pair two times in five. Hold the next
  trained network to it (the reference is the current network's search, so a much stronger network may want a new
  one). Likely causes: the move is two choices (play it, then the pair), the first worth only what the best pair is;
  the winning positions are rare.
- **Network rollouts miss replies only search finds.** Midstrike's search plays its candidates out with the network on
  both sides, so it overrates a move whose refutation the network doesn't see by instinct (XDMY: its Duplicity into the
  player's keep rated 52%, but the network-played opponent in its playouts never answered with the Providence swap
  that won). Possible remedies: search at key opponent decisions inside the playouts (costly), or a network that sees
  more of these replies (the Providence item).
- **Count sampler give-ups and the bot's fallbacks in production**, somewhere persistent: the console logs on Fly last
  minutes. They'd have shown the seen-pile and Duplicity-reveal sampler failures before a hunt did.
- **Analysis on the batched path.** Most analysis tools search on the CPU (`RolloutPool`, minutes a position for a big
  search); with the network served on a GPU (`training/keeps_bot/serve.py`, `SEARCH_INFERENCE=<socket>`) a few seconds.
  providence.ts takes it (its reference ran on the laptop's RTX 5080 in about 25 minutes); the others don't yet.
- The two belief items under Known limitations below (a pile seen then taken from unseen; "just taken" through a
  Duplicity reveal): both change what the network sees, so they go in with the next training run.

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
- **The belief forgets a pile it saw when a card leaves it unseen.** After the player sees a pile whole (Tithes)
  or its top (Epiphany, Prayer), and the opponent then takes from it at a position they can't see (Requisition), the
  belief drops every card it knew was there (`forgetMembers`): one of them left, it can't say which. Yet the pile is
  still those cards minus one, and once the taken card shows up (played, say) the player knows the pile exactly. The
  world sampler no longer suffers from it (2026-10-30: its guided rebuild of the deal follows the places the pile ops
  remember, so these positions sample at a plan a world instead of failing), but the network's observation still
  shows those cards as unplaced. The fix: track a pile as its known places less k cards taken from unknown positions,
  and recover it when a taken card is identified. Same kind, same run: "just taken" (`justHidden`) ends when the
  Duplicity holder turns a face-down card up while the opponent chooses a keep for the HOT card they drew unseen, so
  when they play it, the belief can't tell it came from that pile (the sampler has its own `waitingTake`). It changes
  what the network sees, so it goes in with the next training run (with the encoder fingerprint changed), not into
  the live bot.

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

1. **Export** (`training/keeps_bot/export.py`): `policy-<step>.pkl` → a weights file whose header records the run, step,
   network shape, post-processing (drop actions under 3%, round to 32nds), eval results, and the **encoder version**.
   The server refuses weights whose encoder version differs from its own, so a changed observation can't silently
   feed the network garbage.
2. **Inference in TypeScript** (`packages/bot/src/policy.ts`): the forward pass on Float32Arrays, R-NaD's legal
   softmax and post-processing ported exactly, sampling. A `Bot` picks a command for a seat from the game state: its
   view and log (it rebuilds its belief from the log, so it holds no state across moves), choosing ids one at a time
   through `Decision`. The free Duplicity reveal is considered only at its own decisions, as in training.
3. **Tests:** Python writes (observation, legal, probabilities) triples from a real policy and TypeScript must
   reproduce them; the bot plays hundreds of rounds without errors or stalls.
4. **Server:** a bot player (no socket); whenever the engine waits on its seat, a move is scheduled after the delay and
   applied through the same command path as a human's. Humans start the next round. Analytics tag games with the
   bot's run and step, so human-vs-bot results measure its strength.
5. **Web:** the home button, Add/Remove bot in the lobby, a "Bot" badge and a "thinking…" hint at the table.

## What we've learned (as of 2026-10-22)

Distilled from building and training `r1`, `g1`–`g5`, `e1`. Numbers are measured unless marked as estimates.

### Where Keeps is hard and easy

Heads-up Keeps is **chess-like in its tactics, card-game-like in its hidden information**:

- **Easy compared with Dou Dizhu, poker or Stratego.**
  - It's two-player zero-sum, which fits R-NaD's and mirror descent's guarantees.
  - The action space is small: 48 ids, about 3 legal per step.
  - Rounds are short: about 55–65 decisions.
- **Hard.**
  - **36 unique cards with their own effects** and triggers: Retribution, Interest, Royal Favor.
  - **Conditional scoring:** Purity is worth 10 only if the rest of its keep sums to exactly 0; Tithes adds 1 per card in its keep; the Tokens win instantly together.
  - **Hidden information:** Duplicity's face-down card, and moves that move or reveal piles (Juggling, Pandemonium, Fiat, Prayer, Epiphany, Requisition).
  - **Chance on every draw.**
  - **Round-end timing:** whoever draws from an empty pile ends the round, and loses ties.
  - **Many decisive lines are rare and needle-precise:** Token win, Purity finisher, Last Laugh, timing Purity, ending the round while ahead. Self-play rarely produces them.
- **Hidden information is mostly about the piles** (which is which, what's left, their order) **and the opponent's hand.**
  - About 4×10³⁰ possible deals (estimate), against about 3×10²⁴ for Dou Dizhu.
  - Card counting gives a lot, but not everything (see "Belief").
- **Implication: lookahead pays off.** The tactics mostly depend on visible information (keep sums, pile sizes, your own hand), which is where search shines. A 40-ply rollout covers most of a round.

### Observation and network: what this kind of network finds easy or hard

- **Easy:**
  - Facts on the row of the entity they're about, read by a shared encoder.
  - Small categorical fields within a row (which of 4 relative piles; me or the opponent).
  - Sums over sets (the cards in a keep).
- **Hard:**
  - **Binding across positions.** "Event 17 names card id 23" requires a lookup, which this kind of network is bad at. This is why history went onto each card's own row instead of an event list of integer ids.
  - Relations split across tokens and then summed.
  - **Choices about pairs** when only one side of the pair is an input (X into keep K; swap X and Y).
  - Truncated history windows.
  - Exact arithmetic or equality tests.
- **Rules for the encoder:**
  1. Put every fact on the row of the thing it's about, including which ids are legal or already chosen and the prompt's card or pile.
  2. Anchor history to the cards and piles it happened to.
  3. Give pointer heads the decision's subject (the card being placed, or the card or pile already chosen) alongside each candidate.
  4. **No hand-engineered tactical features** (the user's call). Printed card properties are fine.
  5. **Positions must be relative everywhere, including in actions.** `POS(seat)` was absolute while the observation was relative, so every keep or pile choice sat at 50/50. A policy gave "seat 0's keep" 59% from either seat. The fix took `g5` to 0.92 against random in 2,000 steps, where buggy `g1` was at 0.87 after 63,000. **Always test that the policy treats both seats the same.**
- **A learned card embedding plus shared encoders lets cards share what they learn.** Card actions are scored against that card's own vector, so "Blunder" means the same thing whether it's being played, taken or given.

### Belief

- **Scored against the true state** under `g4` self-play, on cards it isn't certain about:
  - Overall: 0.46 probability on the true place, against 0.27 for counting alone.
  - **The opponent's hand: 0.25, with the top guess right 26%.**
  - Pile tops are known only 18% of the time.
- **The hand-written belief counts well but can't infer from behaviour** ("they drew instead of playing"). It also can't track what the opponent knows.
- **The fix: a learned belief.** Train extra heads, or a separate network as Ataraxos does, on the true hidden state from self-play. It's leak-safe because the truth is only ever a training target.
- **The belief once produced probabilities of −4.5.** It turned near-certain probability weights into hard facts, about once in 36,000 rounds. v2 uses a sound belief; v1 is frozen bit-for-bit so `g4` and the shipped bot see what they trained on.
- **Rule: anything stated as a certainty must come from logic, never from rounding.**

### R-NaD learning dynamics (our runs)

- **Regularization period length:**
  - Each period converges in about 1,500–2,000 learner steps (measured as KL between policies saved 500 steps apart).
  - The rest of the period is flat. `g1`'s 10,000-step periods wasted about half its training, so 3,000 was chosen.
  - Measure policy drift to tune the period length; don't guess.
- **η (regularization strength):**
  - η = 0.05 learned faster at first, then stalled around step 5,000, with a loss jump and policy drift near zero. Logit saturation was ruled out; stale data with unclipped importance weights is the suspect.
  - η = 0.1 (`g4`) won in the long run: 0.563 head to head at about 14,000 steps.
- **Evaluation:**
  - "vs random" saturates by about 0.95.
  - Use the `greedy`/`timer` heuristics: `g4` @ 32,000 scored 0.76 / 0.72.
  - Use the tactic probes and the seat-symmetry check.
- **Tactic probes on `g4`:**
  - **Learned:** HOT card into own keep (100%), avoiding the Retribution trap (1%).
  - **Still weak:** Prayer take-or-discard (about 50%), the Token win, Interest/Tithes interactions, round-end timing.
- **The bot learns single, frequent associations quickly; combinations and rare lines slowly.**

### Throughput lessons

- **Speeds:**
  - Engine: about 145k decisions/s per core with trusted apply.
  - Encoders: v1 about 66k/core; v2 about 52k/core.
  - `g4` (MLP, v1) about 200–230k decisions/s on `gpu03`; `e1` (entity, v2) about 85k.
  - Both are limited by their learner.
  - `e1`'s cost is mostly Python moving 3.3× larger observations, not GPU compute.
- **Watch for:**
  - **Fresh large allocations on a machine short of free memory.** Reuse buffers: a fresh 80 MB array took about 1 s on `gpu03`.
  - **XLA autotuning scratch space** (about 4 GB) failing while the learner holds memory. Give JAX headroom (memory fraction 0.8–0.95).
  - **Per-card concatenations** inside the entity network. Compute first layers as sums of linear maps.
  - **The GIL caps one Python process at about 250k decisions/s.** Beyond that needs multiple processes.
  - **Evaluators running continuously** cost about 20% throughput. Evaluate every 1,000 steps.

### Published approaches (survey in progress)

- **DeepNash** (Stratego, 2022): R-NaD with no search.
  - A U-Net with 256/320 channels and the last 40 moves as input.
  - 768 + 256 TPU nodes.
- **Ataraxos** (Nature 2026): the best fit. Code: github.com/AtaraxosAI.
  - **Training:** regularized self-play (magnet, Sokota et al. 2023) with PPO-style ratio clipping, λ-returns (0.5 / 0.8), and training only on the top-quarter-|advantage| moves.
  - **Learned belief network:** an autoregressive transformer trained on the hidden truth.
  - **Search at play time only:** 1,000 rollouts × 40 plies, then one damped magnetic-mirror-descent step. Its gain is "bounded… mimicking a single update step", and it's never trained back into the network.
  - **Sizes:**
    - Stratego move network: 14.7M parameters, 16 H100s for a week.
    - Dou Dizhu actor: 1.9M (plus a 3.3M belief network), 2 days on 4 H100s.
  - **The policy alone already beats prior state of the art** in Dou Dizhu.
- **Others:** PIMC (Frank & Basin; Long et al.), ISMCTS (Cowling et al. 2012), ReBeL / Student of Games (need public belief states, infeasible here), Learned Belief Search / SPARTA (Hanabi), PerfectDou / Suphx (privileged information in training), Obscuro (2025), Stochastic MuZero.
- **Open idea:** train regularized self-play on search-improved targets ("expert iteration" for equilibrium learning). Keeps' short rounds make it cheaper than in Stratego.

### Next

Done since: Ataraxos's learner (VRPO; `vrpo1` is Midstrike's network), and search at play time (Midstrike). Open: a
learned belief network, training on search-improved targets, and the open problems above (in order:
[ROADMAP.md](ROADMAP.md)).

### Ideas for future model improvements

- **True-state prediction heads take capacity, and Ataraxos may not need them.** Checked 2026-10-22: neither network has any. e1's entity network outputs only policy logits and a value. vrpo1's actor outputs only policy logits. The true state enters only vrpo1's central critic, as an input, in a separate network. If a learned belief model is added, keep it out of the actor's torso, as Ataraxos keeps its belief network separate.

## Layout

- `packages/bot/`: the bot at play: the network's forward pass, the action space and observation encoders, belief
  tracking, the world sampler, the search and its pools (worker threads, the GPU server, the remote worker), and the
  round reviews.
- `packages/server/src/host.ts`, `midstrike.ts`: Midstrike on the website (its levels, training mode, reviews, the
  remote worker's queue, its admin pages).
- `packages/learn/`: the training environment's bridge for Python, benchmarks, tools (`tools/`: matches, a game in the
  terminal, the search at one decision, the Providence benchmark) and analyses.
- `training/`: Python: training (VRPO and R-NaD), evaluation, export, the GPU server and the Core ML export. Its own
  virtualenvs (not committed).
