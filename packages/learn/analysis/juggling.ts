// How a network uses Juggling in self-play: where it puts Juggling when it draws it (HOT: into a keep at once),
// and how often it swaps piles when it can (Juggling in its keep, at an action decision).
//   node juggling.ts <weights> <rounds> <seed> <raw|pp>
import { readFileSync } from 'node:fs';
import { NUM_ACTIONS, actionName, CARD } from '@keeps/bot';
import { RoundEnv } from '@keeps/bot';
import { Policy, sample } from '@keeps/bot';
const [w, roundsArg, seedArg, mode] = process.argv.slice(2);
const policy = Policy.load(readFileSync(w!));
let x = Number(seedArg) * 7919 + 3;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const J = CARD('juggling');
const out = { rounds: 0, placed: {} as Record<string, number>, canSwap: 0, swapped: 0, pSwap: 0, swapsPerRound: [] as number[], holderWins: 0, holderRounds: 0 };
for (let g = 0; g < Number(roundsArg); g++) {
  const env = RoundEnv.start(`jug-${seedArg}-${g}`, { checked: false, observation: 2 });
  let swaps = 0, holder: number | null = null;
  while (!env.terminal) {
    const p = env.currentPlayer, obs = env.observation(p);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of env.legalActions()) mask[id] = 1;
    const probs = mode === 'raw' ? policy.raw(obs, mask) : policy.probabilities(obs, mask);
    const view = env.view(p);
    const prompt = view.prompts.find((q) => q.mine);
    const a = sample(probs, random);
    if (prompt?.kind === 'hot-target' && (prompt as { card?: string }).card === 'juggling') {
      out.placed[actionName(a)] = (out.placed[actionName(a)] ?? 0) + 1;
    }
    if (prompt?.kind === 'action' && mask[J] && env.legalActions().length > 1) {
      out.canSwap++; out.pSwap += probs[J]!;
      if (a === J) { out.swapped++; swaps++; }
    }
    env.step(a);
    // Who holds Juggling now (face up in a keep)?
    for (const [i, s] of [[0, 0], [1, 2]] as const) if (env.state.keeps[s]!.some((c) => c.id === 'juggling' && !c.faceDown)) holder = i;
  }
  out.rounds++;
  if (holder !== null) { out.holderRounds++; if (env.returns()[holder]! > 0) out.holderWins++; out.swapsPerRound.push(swaps); }
}
console.log(JSON.stringify(out));
