// e1 self-play: does the player who moves first win more, and is the value head calibrated?
//   node calib.ts <weights.bin> <rounds> <seed>  → JSON lines: per decision (bucketed) and per round
import { readFileSync } from 'node:fs';
import { NUM_ACTIONS } from '../src/actions.ts';
import { RoundEnv } from '../src/env.ts';
import { Policy, sample } from '../src/policy.ts';
const policy = Policy.load(readFileSync(process.argv[2]!));
const rounds = Number(process.argv[3]);
let x = Number(process.argv[4] ?? 1) * 7919;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const buckets = Array.from({ length: 10 }, () => ({ n: 0, wins: 0, pred: 0 }));
let starterWins = 0;
const firstValue = { starter: [] as number[], second: [] as number[] };
for (let g = 0; g < rounds; g++) {
  const env = RoundEnv.start(`calib-${process.argv[4]}-${g}`, { checked: false, observation: 2 });
  const starter = env.currentPlayer;
  const seen = new Set<number>();
  const preds: { player: number; win: number }[] = [];
  while (!env.terminal) {
    const p = env.currentPlayer;
    const obs = env.observation(p);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of env.legalActions()) mask[id] = 1;
    const win = Math.min(1, Math.max(0, (policy.value(obs)! + 1) / 2));
    if (!seen.has(p)) {
      seen.add(p);
      (p === starter ? firstValue.starter : firstValue.second).push(win);
    }
    preds.push({ player: p, win });
    env.step(sample(policy.probabilities(obs, mask), random));
  }
  const winner = env.returns()[0]! > 0 ? 0 : 1;
  if (winner === starter) starterWins++;
  for (const { player, win } of preds) {
    const b = buckets[Math.min(9, Math.floor(win * 10))]!;
    b.n++;
    b.pred += win;
    if (player === winner) b.wins++;
  }
}
console.log(JSON.stringify({ rounds, starterWins, firstValue, buckets }));
