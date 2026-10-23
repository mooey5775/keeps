# Analysis tools (TypeScript)

One-off investigations that may be worth repeating. Each script's header says what it does and how to run it. Run them from this folder with `node <script>.ts …`; weights are TS exports (`keeps_bot.export`).

**Replays** (from the demo's `data/replays/`):
- `evaltrue.ts`: each legal move at a decision played out from the TRUE state, e1 sampling both sides.
- `lineprobs.ts`: the network's probability of each move actually played.

**Network against network:**
- `disagree.ts`: positions where vrpo1 and e1 choose differently, each choice played out from the true state, with each network playing the rest.
- `disagree_targeted.ts`: the same, at Requisition and Duplicity decisions only.
- `noise.ts`: how spread out each policy is (entropy, mass under 3%).
- `juggling.ts`: how a network uses Juggling in self-play.

**Game questions:**
- `pilevalue.ts`, `pilevalue_head.ts`, `foolcheck.ts`: the value of starting behind each pile type, and why the Fool pile does badly.
- `calib.ts`: value-head calibration and the first player's edge.

**World sampler:**
- `worldcheck.ts`: soundness.
- `worldexact.ts`: exactness against brute-force enumeration.
- `worldspeed.ts`: speed.

Python counterparts (evaluation, VRPO speed and equivalence checks) are in `bot/analysis/`.
