// At a decision of a replay: the decider's posterior over a face-down keep card, from worlds sampled
// exactly from its belief (built as the bot's is: observing at each of its own decisions).
//   node facedown.ts <replay> <weights> <K> <worlds>
import { readFileSync } from 'node:fs';
import { apply, newGame, viewFor, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { BotPlayer } from '@keeps/bot';
import type { Belief } from '@keeps/bot';
import { Policy } from '@keeps/bot';
import { sampleWorld, worldModel } from '@keeps/bot';
const [path, weights, kArg, nArg] = process.argv.slice(2);
const lines = readFileSync(path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const K = Number(kArg);
let { state, events } = newGame(lines[0].options) as { state: GameState; events: TraceEvent[] };
const me = lines[1 + K].seat as Seat;
const bot = new BotPlayer(Policy.load(readFileSync(weights!)), me);
for (const { seat, command } of lines.slice(1, 1 + K)) {
  if (seat === me && bot.wantsToMove(state)) bot.choose(state, events);
  const r = apply(state, seat, command);
  if (!r.ok) throw new Error(r.error.message);
  state = r.state;
  events = [...events, ...r.events];
}
bot.choose(state, events);
const belief = (bot as unknown as { belief: Belief }).belief;
const model = worldModel(state, me, belief, viewFor(state, me));
let x = 99;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const counts = new Map<string, number>();
const N = Number(nArg);
for (let i = 0; i < N; i++) {
  const w = sampleWorld(model, state, belief, random);
  for (const keep of w.keeps) for (const c of keep) if (c.faceDown && c.faceDown.placedBy !== me) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
}
const truth = state.keeps.flat().filter((c) => c.faceDown && c.faceDown.placedBy !== me).map((c) => c.id);
console.log(`turn ${state.turnNumber}, seat ${me} deciding (${state.prompts[0]!.kind}); the face-down card is really: ${truth.join(', ')}`);
for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${id.padEnd(14)} ${(100 * n / N).toFixed(1)}%`);
