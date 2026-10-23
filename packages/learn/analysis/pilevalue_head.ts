// e1's value head at each player's first decision of a round, with the piles in front of each player.
// Plays only until both players have decided once (the starter's opening moves, by e1's policy).
//   node pilevalue_head.ts <weights.bin> <rounds> <seed>  → one JSON line per round
import { readFileSync } from 'node:fs';
import { NUM_ACTIONS } from '../src/actions.ts';
import { RoundEnv, SEAT_OF_PLAYER } from '../src/env.ts';
import { Policy, sample } from '../src/policy.ts';
const policy = Policy.load(readFileSync(process.argv[2]!));
const rounds = Number(process.argv[3]);
let x = Number(process.argv[4] ?? 1) * 7919;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const out: string[] = [];
for (let g = 0; g < rounds; g++) {
  const env = RoundEnv.start(`pilehead-${process.argv[4]}-${g}`, { checked: false, observation: 2 });
  const starter = env.currentPlayer;
  const piles = SEAT_OF_PLAYER.map((s) => env.state.pileAt[s]);
  const value: (number | null)[] = [null, null];
  while (!env.terminal && (value[0] === null || value[1] === null)) {
    const p = env.currentPlayer;
    const obs = env.observation(p);
    if (value[p] === null) value[p] = (policy.value(obs)! + 1) / 2;  // P(win) from the value head
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of env.legalActions()) mask[id] = 1;
    env.step(sample(policy.probabilities(obs, mask), random));
  }
  out.push(JSON.stringify({ piles, starter, value }));
}
console.log(out.join('\n'));
