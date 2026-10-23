// How noisy each network is: at the decisions of e1-vs-vrpo1 games (2+ legal ids), the mass each
// network's raw policy puts on ids it rates under 3%, its entropy, and how often its top id has < 90%.
//   node noise.ts <e1.bin> <vrpo.bin> <games> <seed>
import { readFileSync } from 'node:fs';
import { NUM_ACTIONS } from '../src/actions.ts';
import { RoundEnv } from '../src/env.ts';
import { Policy, sample } from '../src/policy.ts';
const [e1Path, vrpoPath, gamesArg, seedArg] = process.argv.slice(2);
const nets = { e1: Policy.load(readFileSync(e1Path!)), vrpo: Policy.load(readFileSync(vrpoPath!)) };
let x = Number(seedArg) * 7919 + 5;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const acc = { e1: { n: 0, low: 0, entropy: 0, unsure: 0 }, vrpo: { n: 0, low: 0, entropy: 0, unsure: 0 } };
for (let g = 0; g < Number(gamesArg); g++) {
  const env = RoundEnv.start(`noise-${seedArg}-${g}`, { checked: false, observation: 2 });
  const vrpoPlayer = g % 2;
  while (!env.terminal) {
    const p = env.currentPlayer, obs = env.observation(p);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of env.legalActions()) mask[id] = 1;
    const raw = { e1: nets.e1.raw(obs, mask), vrpo: nets.vrpo.raw(obs, mask) };
    if (env.legalActions().length > 1) {
      for (const k of ['e1', 'vrpo'] as const) {
        const a = acc[k], pr = raw[k];
        let low = 0, h = 0, top = 0;
        for (const id of env.legalActions()) {
          const q = pr[id]!;
          if (q < 0.03) low += q;
          if (q > 0) h -= q * Math.log(q);
          top = Math.max(top, q);
        }
        a.n++; a.low += low; a.entropy += h; a.unsure += top < 0.9 ? 1 : 0;
      }
    }
    const mover = p === vrpoPlayer ? 'vrpo' : 'e1';
    env.step(sample(mover === 'vrpo' ? raw.vrpo : nets.e1.probabilities(obs, mask), random));
  }
}
console.log(JSON.stringify(acc));
