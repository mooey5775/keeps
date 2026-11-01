// The search at a real decision of a replay (after its first K commands), with greedy and with sampled
// rollouts. The bot's belief is built as in the game: it observes at each of its own decisions.
//   node searchat.ts <replay> <weights> <K> <worlds>      (ROLLOUTS=sampled or greedy: only that one)
import { readFileSync } from 'node:fs';
import { apply, newGame, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { BotPlayer } from '@keeps/bot';
import { noteObservation } from '@keeps/bot';
import { eventsFor, viewFor } from '../../engine/src/index.ts';
import { Policy } from '@keeps/bot';
import { searchChoose, setSearchLog, setSearchMode, setWorlds, type SearchReport } from '@keeps/bot/search/search.ts';
import { RolloutPool } from '@keeps/bot/search/rollout-pool.ts';
const [path, weights, kArg, worldsArg] = process.argv.slice(2);
setSearchMode('best-q'); setWorlds(Number(worldsArg)); setSearchLog(() => {});
const lines = readFileSync(path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const K = Number(kArg);
// The decider: the seat of the next recorded command, or (at the live end of a game) whoever is prompted now.
const seat = (lines[1 + K]?.seat ?? (() => {
  let st = newGame(lines[0].options).state as GameState;
  for (const { seat: s, command } of lines.slice(1, 1 + K)) st = (apply(st, s, command) as { state: GameState }).state;
  return st.prompts[0]!.seat;
})()) as Seat;
const policy = Policy.load(readFileSync(weights!));
for (const sampled of process.env.ROLLOUTS === 'sampled' ? [true] : process.env.ROLLOUTS === 'greedy' ? [false] : [false, true]) {
  const pool = new RolloutPool(12, weights!, sampled);
  let { state, events } = newGame(lines[0].options) as { state: GameState; events: TraceEvent[] };
  const bot = new BotPlayer(policy, seat);
  const b = bot as unknown as { log: TraceEvent[]; read: number; belief: { update: (l: TraceEvent[]) => unknown } };
  for (const { seat: s, command } of lines.slice(1, 1 + K)) {
    if (s === seat) {
      b.log.push(...eventsFor(events.slice(b.read), seat)); b.read = events.length;
      b.belief.update(noteObservation(b.log, viewFor(state, seat), seat as Seat));
    }
    const r = apply(state, s, command);
    if (!r.ok) throw new Error(r.error.message);
    state = r.state; events = [...events, ...r.events];
  }
  let report: SearchReport | null = null;
  await searchChoose(bot, state, events, pool, (r) => (report = r));
  const rep = report as unknown as SearchReport;
  console.log(`${sampled ? 'sampled' : 'greedy '} rollouts, ${rep.worlds} worlds, ${(rep.ms / 1000).toFixed(0)} s:`);
  for (const m of rep.moves) console.log(`   ${m.chosen ? '→' : ' '} ${m.move.padEnd(26)} policy ${(100 * m.policy).toFixed(0).padStart(3)}%  win ${(100 * m.win).toFixed(1)}%`);
}
process.exit(0);
