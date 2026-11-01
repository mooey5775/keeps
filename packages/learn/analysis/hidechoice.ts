// What a network hides with Duplicity in self-play: which card it puts face down in its OWN keep, against
// what a chance-only guess would say (one of the keep cards it could have hidden, all equally likely).
//   node hidechoice.ts <weights> <rounds> <seed>   → JSON counts
import { readFileSync } from 'node:fs';
import { CARDS } from '../../engine/src/index.ts';
import { NUM_ACTIONS, actionName, CARD } from '@keeps/bot';
import { RoundEnv } from '@keeps/bot';
import { Policy, sample } from '@keeps/bot';
const [w, roundsArg, seedArg] = process.argv.slice(2);
const policy = Policy.load(readFileSync(w!));
let x = Number(seedArg) * 7919 + 1;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const hidden: Record<string, number> = {}, chance: Record<string, number> = {};
let n = 0, withPurity = 0, purityHidden = 0;
for (let g = 0; g < Number(roundsArg); g++) {
  const env = RoundEnv.start(`hide-${seedArg}-${g}`, { checked: false, observation: 2 });
  let pendingCard: number | null = null, options: number[] = [];
  while (!env.terminal) {
    const p = env.currentPlayer, obs = env.observation(p);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of env.legalActions()) mask[id] = 1;
    const view = env.view(p);
    const prompt = view.prompts.find((q) => q.mine);
    const a = sample(policy.probabilities(obs, mask), random);
    if (prompt?.kind === 'duplicity-hide') {
      if (pendingCard === null) { pendingCard = a; options = env.legalActions().filter((id) => id < 36); }
      else if (actionName(a) === 'at-own') {
        // The card was hidden in its own keep: count it, and the chance-only expectation over its options.
        const card = actionName(pendingCard);
        hidden[card] = (hidden[card] ?? 0) + 1;
        for (const o of options) chance[actionName(o)] = (chance[actionName(o)] ?? 0) + 1 / options.length;
        n++;
        if (options.includes(CARD('purity'))) { withPurity++; if (card === 'purity') purityHidden++; }
        pendingCard = null;
      } else pendingCard = null;
    }
    env.step(a);
  }
}
console.log(JSON.stringify({ n, withPurity, purityHidden, hidden, chance }));
