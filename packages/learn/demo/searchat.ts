// The search at a real decision of a replay (after its first K commands), with greedy and with sampled
// rollouts. The bot's belief is built as in the game: it observes at each of its own decisions.
//   node searchat.ts <replay> <weights> <K> <worlds>
import { readFileSync } from 'node:fs';
import { apply, newGame, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { BotPlayer } from '../src/bot.ts';
import { eventsFor, viewFor } from '../../engine/src/index.ts';
import { Policy } from '../src/policy.ts';
import { RolloutPool, searchChoose, setSearchLog, setSearchMode, setWorlds, type SearchReport } from './search-bot.ts';
const [path, weights, kArg, worldsArg] = process.argv.slice(2);
setSearchMode('best-q'); setWorlds(Number(worldsArg)); setSearchLog(() => {});
const lines = readFileSync(path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const K = Number(kArg);
const seat = lines[1 + K].seat as Seat;
const policy = Policy.load(readFileSync(weights!));
for (const sampled of [false, true]) {
  const pool = new RolloutPool(12, weights!, sampled);
  let { state, events } = newGame(lines[0].options) as { state: GameState; events: TraceEvent[] };
  const bot = new BotPlayer(policy, seat);
  const b = bot as unknown as { log: TraceEvent[]; read: number; belief: { update: (l: TraceEvent[]) => { observe: (v: unknown) => void } } };
  for (const { seat: s, command } of lines.slice(1, 1 + K)) {
    if (s === seat) {
      b.log.push(...eventsFor(events.slice(b.read), seat)); b.read = events.length;
      b.belief.update(b.log).observe(viewFor(state, seat));
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
