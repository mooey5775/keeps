# Analysis (TypeScript)

Investigations that may be worth repeating, not maintained: each ran against the code of its day, and none is
typechecked. Those whose results aren't in docs/BOT.md are kept until they are. The maintained tools (a match, a game
in the terminal, the search at one decision, the Providence benchmark) are in `../tools`. Each script's header says
what it does and how to run it, from this folder, with `node <script>.ts …`; weights are TS exports (`keeps_bot.export`).

**Replays** (the server's `data/replays/`, the app's `Documents/games`):
- `lineprobs.ts`: the network's probability of each move actually played.
- `probsat.ts`: the raw probability of every move at one decision.
- `valuetrace.ts`: the win rate from the true state, move by move.
- `pileat.ts`: which pile sits at each seat through a game.

**Network against network:**
- `disagree.ts`: positions where vrpo1 and e1 choose differently, each choice played out from the true state, with each network playing the rest.
- `disagree_targeted.ts`: the same, at Requisition and Duplicity decisions only.
- `noise.ts`: how spread out each policy is (entropy, mass under 3%).
- `juggling.ts`, `hidechoice.ts`: how a network uses Juggling in self-play; what it hides with Duplicity.
- `rolloutlength.ts`: a greedy round's length and the time a decision takes, by network.

**Game questions:**
- `pilevalue.ts`, `pilevalue_head.ts`, `foolcheck.ts`: the value of starting behind each pile type, and why the Fool pile does badly.
- `calib.ts`: value-head calibration and the first player's edge.

The world sampler's soundness and exactness are tests now (`packages/bot/test/worlds*.test.ts`). Python counterparts
(evaluation, VRPO speed and equivalence checks) are in `training/analysis/`.
