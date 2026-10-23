// How long the search's rollouts run with each network: greedy self-play (both sides the network's
// top move, as the rollouts play) on the same deals, decisions per round and time per decision.
//   node rolloutlength.ts <rounds> <weights>...
import { readFileSync } from 'node:fs';
import { NUM_ACTIONS } from '../src/actions.ts';
import { RoundEnv } from '../src/env.ts';
import { Policy } from '../src/policy.ts';
const [roundsArg, ...paths] = process.argv.slice(2);
for (const path of paths) {
  const policy = Policy.load(readFileSync(path));
  let decisions = 0, cut = 0;
  const lengths: number[] = [];
  const started = performance.now();
  for (let g = 0; g < Number(roundsArg); g++) {
    const env = RoundEnv.start(`rollout-length-${g}`, { checked: false, observation: 2 });
    let n = 0;
    while (!env.terminal && n < 1000) {
      const mask = new Uint8Array(NUM_ACTIONS);
      for (const id of env.legalActions()) mask[id] = 1;
      const p = policy.raw(env.observation(env.currentPlayer), mask);
      let best = env.legalActions()[0]!;
      for (const id of env.legalActions()) if (p[id]! > p[best]!) best = id;
      env.step(best);
      n++;
    }
    if (n >= 1000) cut++;
    lengths.push(n);
    decisions += n;
  }
  const ms = performance.now() - started;
  lengths.sort((a, b) => a - b);
  console.log(`${path.split('/').pop()}: ${(decisions / lengths.length).toFixed(1)} decisions per greedy round (median ${lengths[lengths.length >> 1]}, 90th percentile ${lengths[Math.floor(lengths.length * 0.9)]}, ${cut} cut at 1000), ${(ms / decisions).toFixed(2)} ms per decision`);
}
