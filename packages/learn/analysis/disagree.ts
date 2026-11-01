// Where vrpo1 and e1 choose differently, and whose choice wins more.
//   node disagree.ts <e1.bin> <vrpo.bin> <games> <seed> <playouts>  → one JSON line per disagreement
//
// vrpo1 and e1 play each other (seats alternate by game), each sampling from its policy as the
// evaluator plays it (e1 post-processed, vrpo1 raw). At every decision with 2+ legal ids, both
// networks give their most likely id; where they differ, each of the two ids is played out from the
// TRUE position `playouts` times, the rest of the round played by e1 on both sides and, separately,
// by vrpo1 on both sides (each side observing from its own seat), and the decider's win rate kept.
// The true position is a draw from the decider's posterior, so averaged over many positions the
// win-rate difference is an unbiased comparison of the two choices.
import { readFileSync } from 'node:fs';
import { NUM_ACTIONS, actionName } from '@keeps/bot';
import { RoundEnv } from '@keeps/bot';
import { Policy, sample } from '@keeps/bot';

const [e1Path, vrpoPath, gamesArg, seedArg, playoutsArg] = process.argv.slice(2);
const e1 = Policy.load(readFileSync(e1Path!));
const vrpo = Policy.load(readFileSync(vrpoPath!));
const games = Number(gamesArg), seed = Number(seedArg), playouts = Number(playoutsArg);
let x = seed * 7919 + 17;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;

function legalMask(env: RoundEnv): Uint8Array {
  const mask = new Uint8Array(NUM_ACTIONS);
  for (const id of env.legalActions()) mask[id] = 1;
  return mask;
}
const argmax = (p: ArrayLike<number>) => {
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i]! > p[best]!) best = i;
  return best;
};

/** The decider's win rate after `action`, the rest played by `policy` on both sides. */
function playout(env: RoundEnv, action: number, policy: Policy, n: number): number {
  const decider = env.currentPlayer;
  let wins = 0;
  for (let k = 0; k < n; k++) {
    const c = env.clone();
    c.step(action);
    while (!c.terminal) {
      const obs = c.observation(c.currentPlayer);
      c.step(sample(policy.probabilities(obs, legalMask(c)), random));
    }
    if (c.returns()[decider]! > 0) wins++;
  }
  return wins / n;
}

for (let g = 0; g < games; g++) {
  const env = RoundEnv.start(`disagree-${seed}-${g}`, { checked: false, observation: 2 });
  const vrpoPlayer = g % 2;
  let decision = 0;
  while (!env.terminal) {
    const p = env.currentPlayer;
    const obs = env.observation(p);
    const legal = legalMask(env);
    const pe = e1.probabilities(obs, legal), pv = vrpo.probabilities(obs, legal);
    const ae = argmax(pe), av = argmax(pv);
    if (env.legalActions().length > 1 && ae !== av) {
      const view = env.view(p);
      const prompt = view.prompts.find((q) => q.mine);
      const results = {
        e1: { e1: playout(env, ae, e1, playouts), vrpo: playout(env, av, e1, playouts) },
        vrpo: { e1: playout(env, ae, vrpo, playouts), vrpo: playout(env, av, vrpo, playouts) },
      };
      console.log(JSON.stringify({
        game: `${seed}-${g}`, decision, turn: env.state.turnNumber, phase: env.state.phase,
        mover: p === vrpoPlayer ? 'vrpo' : 'e1', kind: prompt?.kind ?? null,
        legal: env.legalActions().map(actionName),
        e1Choice: actionName(ae), vrpoChoice: actionName(av),
        pE: { e1Choice: pe[ae], vrpoChoice: pe[av] }, pV: { e1Choice: pv[ae], vrpoChoice: pv[av] },
        results, playouts,
      }));
    }
    env.step(sample(p === vrpoPlayer ? pv : pe, random));
    decision++;
  }
}
