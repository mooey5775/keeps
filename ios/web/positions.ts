// Positions for the spike's benchmark: decisions with a real choice from games the bot plays against itself
// (every third such decision, so the set spans whole rounds), as JSON the page can load.
//   node ios/web/positions.ts <weights> <out.json> [count]
import { readFileSync, writeFileSync } from 'node:fs';
import { apply, eventsFor, legalCommands, newGame, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../packages/engine/src/index.ts';
import { Decision } from '../../packages/learn/src/actions.ts';
import { BotPlayer } from '../../packages/learn/src/bot.ts';
import { Policy } from '../../packages/learn/src/policy.ts';
import { seeded } from '../../packages/learn/demo/random.ts';

const [weights, out, countArg] = process.argv.slice(2);
if (!weights || !out) throw new Error('usage: positions.ts <weights> <out.json> [count]');
const count = Number(countArg ?? 24);
const policy = Policy.load(readFileSync(weights));
const positions: { state: GameState; me: Seat; myLog: TraceEvent[]; commands: Command[] }[] = [];
for (let g = 0; positions.length < count; g++) {
  let { state, events } = newGame({ players: 2, seed: `spike-${g}`, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
  const random = seeded(g, 0);
  const bots = new Map<Seat, BotPlayer>();
  let choices = 0;
  while (state.phase === 'playing' && positions.length < count) {
    const me = state.prompts[0]!.seat as Seat;
    const decision = new Decision(viewFor(state, me), legalCommands(state, me));
    const encodings = decision.encodings();
    if (encodings.length > 1 && choices++ % 3 === 0) {
      positions.push({ state, me, myLog: eventsFor(events, me), commands: encodings.map((ids) => decision.complete(ids)!) });
    }
    if (!bots.has(me)) bots.set(me, new BotPlayer(policy, me, random));
    const r = apply(state, me, bots.get(me)!.choose(state, events));
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    events = [...events, ...r.events];
  }
}
writeFileSync(out, JSON.stringify(positions));
const moves = positions.reduce((s, p) => s + p.commands.length, 0) / positions.length;
console.log(`${out}: ${positions.length} positions, ${moves.toFixed(1)} moves each`);
