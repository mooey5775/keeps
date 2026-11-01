// A match between two bots, each a network and a search size: one round a game, heads-up, each deal played twice (A in
// one seat, then the other), so the cards favour neither. Each side plays as Midstrike does (best-Q, sampled rollouts
// by its own network on both sides), or its network's own move at 0 worlds.
//   node packages/learn/tools/match.ts <A> <B> [deals] [seed]       a side: <weights.bin>[@worlds], worlds 256 by default
// e.g. midstrike.bin@2048 against midstrike.bin@64 (search size), or one network against another at the same size.
// One JSON line per round on stdout, and the score with its 95% interval on stderr as it goes.
//   THREADS (the machine's cores but two), ROLLOUTS=greedy (the policy's top move instead of a sample),
//   SEARCH_INFERENCE=<socket of training/keeps_bot/serve.py>: the playouts batched, the network on that GPU.
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { apply, newGame, type Seat } from '@keeps/engine';
import { BotPlayer, Policy } from '@keeps/bot';
import { BatchedPool } from '@keeps/bot/search/batch-search.ts';
import { RolloutPool } from '@keeps/bot/search/rollout-pool.ts';
import { atWorlds, searchChoose, setSearchLog, type Evaluator, type WorldsPool } from '@keeps/bot/search/search.ts';

const [aArg, bArg, dealsArg = '50', seed = 'match'] = process.argv.slice(2);
if (!aArg || !bArg) throw new Error('usage: match.ts <weights.bin>[@worlds] <weights.bin>[@worlds] [deals] [seed]');
const threads = Number(process.env.THREADS ?? Math.max(1, availableParallelism() - 2));
const sampled = process.env.ROLLOUTS !== 'greedy';
const inference = process.env.SEARCH_INFERENCE || null;
setSearchLog(() => {});

// One pool per network (its playouts are its own network's), shared by the sides that play it.
const pools = new Map<string, WorldsPool & { close(): Promise<void> }>();
function side(arg: string): { name: string; policy: Policy; search: Evaluator | null } {
  const [weights, worldsArg] = arg.split('@') as [string, string | undefined];
  const worlds = Number(worldsArg ?? 256);
  if (!Number.isInteger(worlds) || worlds < 0) throw new Error(`${arg}: worlds must be a whole number`);
  if (worlds > 0 && !pools.has(weights)) pools.set(weights, inference ? new BatchedPool(threads, weights, inference, sampled, () => {}) : new RolloutPool(threads, weights, sampled));
  return { name: arg, policy: Policy.load(readFileSync(weights)), search: worlds > 0 ? atWorlds(pools.get(weights)!, worlds) : null };
}
const sides = { A: side(aArg), B: side(bArg) };

let x = 99991;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
let rounds = 0;
let aWins = 0;
for (let d = 0; d < Number(dealsArg); d++) {
  for (const aSeat of [0, 2] as Seat[]) {
    const started = Date.now();
    let { state, events } = newGame({ players: 2, seed: `${seed}-${d}`, marksToWin: 1 });
    const sideAt = (s: Seat) => sides[s === aSeat ? 'A' : 'B'];
    const bots = new Map(([0, 2] as Seat[]).map((s) => [s, new BotPlayer(sideAt(s).policy, s, random)]));
    let decisions = 0;
    while (state.phase === 'playing' || state.phase === 'post-round') {
      const seat = state.prompts[0]!.seat;
      const { search } = sideAt(seat);
      const bot = bots.get(seat)!;
      const command = search ? await searchChoose(bot, state, events, search) : bot.choose(state, events);
      const r = apply(state, seat, command);
      if (!r.ok) throw new Error(`${r.error.message}: ${JSON.stringify(command)}`);
      state = r.state;
      events = [...events, ...r.events];
      decisions++;
    }
    const aWon = state.lastRoundWinner === aSeat;
    rounds++;
    if (aWon) aWins++;
    console.log(JSON.stringify({ deal: d, aSeat, aWon, starter: state.startingSeat, decisions, seconds: (Date.now() - started) / 1000 }));
    const p = aWins / rounds;
    const ci = 1.96 * Math.sqrt((p * (1 - p)) / rounds);
    console.error(`${sides.A.name} against ${sides.B.name}: ${aWins}/${rounds} = ${(100 * p).toFixed(1)}% ± ${(100 * ci).toFixed(1)}`);
  }
}
await Promise.all([...pools.values()].map((p) => p.close()));
