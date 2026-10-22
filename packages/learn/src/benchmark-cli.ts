import { readFileSync } from 'node:fs';
import { botPlayer, heuristicPlayer, match, randomPlayer, type Player } from './benchmark.ts';
import { Policy } from './policy.ts';

// A policy against a benchmark player, for the Python evaluator:
//   node src/benchmark-cli.ts <weights.bin> <greedy|timer|random> <deals> [seed] [first deal]
// prints the match result as JSON (with per-deal scores, so shards can be combined).

const [weights, opponent, deals, seed = 'bench', first = '0'] = process.argv.slice(2);
const opponents: Record<string, Player> = { greedy: heuristicPlayer('greedy'), timer: heuristicPlayer('timer'), random: randomPlayer };
if (!weights || !opponent || !opponents[opponent] || !deals) {
  console.error('usage: benchmark-cli.ts <weights.bin> <greedy|timer|random> <deals> [seed] [first deal]');
  process.exit(2);
}
const policy = Policy.load(readFileSync(weights));
console.log(JSON.stringify(match(botPlayer(policy), opponents[opponent]!, Number(deals), seed, Number(first))));
