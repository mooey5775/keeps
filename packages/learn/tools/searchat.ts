// Midstrike's search at one decision of a saved game: every candidate with its policy probability and its chance of
// winning the round, as the search saw them from the decider's information, with sampled rollouts (Midstrike's) and
// greedy ones. The decider's belief is built as in the game: it observes at each of its decisions.
//   node packages/learn/tools/searchat.ts <replay> <K> [worlds] [weights]
// <replay>: a replay log (the server's data/replays, the app's Documents/games); <K>: the decision after its first K
// commands; worlds 512 by default; weights Midstrike's. ROLLOUTS=sampled or greedy: only that one. THREADS as match.ts.
// SEARCH_INFERENCE=<socket of training/keeps_bot/serve.py>: the playouts batched, the network served there (a GPU, or
// the CPU), as gpu03 searches for the website.
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { apply, newGame, parseReplayLog, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { BotPlayer, Policy } from '@keeps/bot';
import { BatchedPool } from '@keeps/bot/search/batch-search.ts';
import { RolloutPool } from '@keeps/bot/search/rollout-pool.ts';
import { atWorlds, searchChoose, setSearchLog, type SearchReport } from '@keeps/bot/search/search.ts';

const MIDSTRIKE = join(import.meta.dirname, '../../bot/weights/midstrike.bin');
const [path, kArg, worldsArg = '512', weights = MIDSTRIKE] = process.argv.slice(2);
if (!path || kArg === undefined) throw new Error('usage: searchat.ts <replay> <K> [worlds] [weights]');
const replay = parseReplayLog(readFileSync(path, 'utf8'));
const K = Number(kArg);
if (!(K >= 0 && K <= replay.commands.length)) throw new Error(`K must be 0 to ${replay.commands.length}`);
const threads = Number(process.env.THREADS ?? Math.max(1, availableParallelism() - 2));
const inference = process.env.SEARCH_INFERENCE || null;
const policy = Policy.load(readFileSync(weights));
setSearchLog(() => {});

/** The game after its first K commands, and the decider, its belief built as in the game. */
function position(): { state: GameState; events: TraceEvent[]; bot: BotPlayer } {
  let { state, events } = newGame(replay.options);
  const played = replay.commands.slice(0, K);
  // The decider: the seat of the next recorded command, or (at the end of the log) whoever is prompted then.
  let seat: Seat | undefined = replay.commands[K]?.seat;
  const bot = (s: Seat) => new BotPlayer(policy, s);
  const bots = new Map<Seat, BotPlayer>();
  for (const { seat: s, command } of played) {
    if (!bots.has(s)) bots.set(s, bot(s));
    const b = bots.get(s)!;
    if (b.wantsToMove(state)) b.observe(state, events);
    const r = apply(state, s, command);
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    events = [...events, ...r.events];
  }
  seat ??= state.prompts[0]?.seat;
  if (seat === undefined) throw new Error('no decision there');
  return { state, events, bot: bots.get(seat) ?? bot(seat) };
}

const kinds = process.env.ROLLOUTS === 'sampled' ? [true] : process.env.ROLLOUTS === 'greedy' ? [false] : [true, false];
for (const sampled of kinds) {
  const pool = inference ? new BatchedPool(threads, weights, inference, sampled, () => {}) : new RolloutPool(threads, weights, sampled);
  const { state, events, bot } = position();
  let report: SearchReport | null = null;
  await searchChoose(bot, state, events, atWorlds(pool, Number(worldsArg)), { report: (r) => (report = r) });
  const r = report as SearchReport | null;
  if (!r || r.moves.length === 0) console.log(`seat ${bot.seat}: one move, or a reorder (searched card by card): nothing to compare`);
  else {
    console.log(`seat ${bot.seat}, turn ${r.turn}, ${r.kind}: ${sampled ? 'sampled' : 'greedy'} rollouts, ${r.worlds} worlds, ${(r.ms / 1000).toFixed(0)} s`);
    for (const m of r.moves) console.log(`   ${m.chosen ? '→' : ' '} ${m.move.padEnd(30)} policy ${(100 * m.policy).toFixed(0).padStart(3)}%  win ${(100 * m.win).toFixed(1)}%`);
  }
  await pool.close();
}
