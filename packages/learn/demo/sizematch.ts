// Search size against search size, with one network: side A searches WORLDS_A worlds per decision, side B
// WORLDS_B (0: the network plays its own move, sampled from its policy as the weights say). Best-Q, sampled
// rollouts, worlds as whole histories (the live bot's search). Each deal is played twice, A in one seat and
// then the other, one round each.
//   node sizematch.ts <weights> <worldsA> <worldsB> <deals> <seed> <threads>  → one JSON line per round
import { readFileSync } from 'node:fs';
import { apply, newGame, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { BotPlayer } from '../src/bot.ts';
import { Policy } from '../src/policy.ts';
import { RolloutPool, searchChoose, setSearchLog, setSearchMode, setWorlds } from './search-bot.ts';

const [weights, aArg, bArg, dealsArg, seed, threadsArg] = process.argv.slice(2);
setSearchMode('best-q');
setSearchLog(() => {});
const worlds = { A: Number(aArg), B: Number(bArg) };
const policy = Policy.load(readFileSync(weights!));
const pool = new RolloutPool(Number(threadsArg), weights!, true);
let x = 99991;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;

for (let d = 0; d < Number(dealsArg); d++) {
  for (const aSeat of [0, 2] as Seat[]) {
    const started = Date.now();
    let { state, events } = newGame({ players: 2, seed: `${seed}-${d}`, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
    const side = (s: Seat) => (s === aSeat ? 'A' : 'B');
    const bots = new Map<Seat, BotPlayer>(([0, 2] as Seat[]).map((s) => [s, new BotPlayer(policy, s, random)]));
    let decisions = 0;
    while (state.phase === 'playing' || state.phase === 'post-round') {
      const seat = state.prompts[0]!.seat;
      const n = worlds[side(seat)];
      let command;
      if (n === 0) command = bots.get(seat)!.choose(state, events);
      else {
        setWorlds(n);
        command = await searchChoose(bots.get(seat)!, state, events, pool);
      }
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
