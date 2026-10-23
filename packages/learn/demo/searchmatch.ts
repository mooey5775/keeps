// Search against search: network A and network B, each choosing every move with the demo's search
// (best-Q over WORLDS sampled worlds, greedy rollouts by its OWN network on both sides).
// Each deal is played twice, A in one seat and then the other, one round each.
//   node searchmatch.ts <weightsA> <weightsB> <deals> <worlds> <seed> <threads>  → one JSON line per round
import { readFileSync } from 'node:fs';
import { apply, newGame, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { BotPlayer } from '../src/bot.ts';
import { Policy } from '../src/policy.ts';
import { RolloutPool, searchChoose, setSearchLog, setSearchMode, setWorlds } from './search-bot.ts';

const [aPath, bPath, dealsArg, worldsArg, seed, threadsArg] = process.argv.slice(2);
setSearchMode('best-q');
setWorlds(Number(worldsArg));
setSearchLog(() => {});
const threads = Number(threadsArg);
const nets = {
  A: { policy: Policy.load(readFileSync(aPath!)), pool: new RolloutPool(threads, aPath!) },
  B: { policy: Policy.load(readFileSync(bPath!)), pool: new RolloutPool(threads, bPath!) },
};
let x = 99991;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;

for (let d = 0; d < Number(dealsArg); d++) {
  for (const aSeat of [0, 2] as Seat[]) {
    const started = Date.now();
    let { state, events } = newGame({ players: 2, seed: `${seed}-${d}`, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
    const side = (s: Seat) => (s === aSeat ? 'A' : 'B');
    const bots = new Map<Seat, BotPlayer>(([0, 2] as Seat[]).map((s) => [s, new BotPlayer(nets[side(s)].policy, s, random)]));
    let decisions = 0;
    while (state.phase === 'playing' || state.phase === 'post-round') {
      const seat = state.prompts[0]!.seat;
      const command = await searchChoose(bots.get(seat)!, state, events, nets[side(seat)].pool);
      const r = apply(state, seat, command);
      if (!r.ok) throw new Error(`${r.error.message} at ${JSON.stringify(state.prompts.map((p) => ({ seat: p.seat, kind: p.kind })))}: ${JSON.stringify(command)}`);
      state = r.state;
      events = [...events, ...r.events];
      decisions++;
    }
    console.log(JSON.stringify({ deal: d, aSeat, aWon: state.lastRoundWinner === aSeat, starter: state.startingSeat, decisions, seconds: (Date.now() - started) / 1000 }));
  }
}
process.exit(0);
