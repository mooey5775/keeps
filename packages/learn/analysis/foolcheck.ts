// e1 self-play: who sat behind which pile at the deal, who moved first, who won, final scores.
//   node pilevalue.ts <weights.bin> <rounds> <seed>  → one JSON line per round
import { readFileSync } from 'node:fs';
import { NUM_ACTIONS } from '@keeps/bot';
import { RoundEnv, SEAT_OF_PLAYER } from '@keeps/bot';
import { Policy, sample } from '@keeps/bot';
const policy = Policy.load(readFileSync(process.argv[2]!));
const rounds = Number(process.argv[3]);
let x = Number(process.argv[4] ?? 1) * 7919;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const out: string[] = [];
for (let g = 0; g < rounds; g++) {
  const env = RoundEnv.start(`fool-${process.argv[4]}-${g}`, { checked: false, observation: 2 });
  const starter = env.currentPlayer;
  const piles = SEAT_OF_PLAYER.map((s) => env.state.pileAt[s]);
  const ghosts = [env.state.pileAt[1], env.state.pileAt[3]];
  while (!env.terminal) {
    const obs = env.observation(env.currentPlayer);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of env.legalActions()) mask[id] = 1;
    env.step(sample(policy.probabilities(obs, mask), random));
  }
  const winner = env.returns()[0]! > 0 ? 0 : 1;
  const keeps = SEAT_OF_PLAYER.map((s) => env.state.keeps[s]!.map((c) => c.id));
  const pilesEnd = SEAT_OF_PLAYER.map((s) => env.state.pileAt[s]);
  const where = (id: string) => (env.state.piles[env.state.pileAt[0]] && false) || null;
  const inPiles = Object.fromEntries(['juggling', 'blunder', 'shackles'].map((id) => [id, Object.values(env.state.piles).find((p) => p.cards.some((c) => c.id === id))?.id ?? null]));
  out.push(JSON.stringify({ piles, starter, winner, keeps, pilesEnd, inPiles }));
}
console.log(out.join('\n'));
