// A network's raw probability for every complete move at one decision of a replay, from the decider's
// own belief (built as the bot's is: observing at each of its decisions), plus its value estimate.
//   node probsat.ts <replay> <weights> <K>
import { readFileSync } from 'node:fs';
import { apply, legalCommands, newGame, viewFor, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { actionName, Decision, NUM_ACTIONS } from '../src/actions.ts';
import type { Belief } from '../src/belief.ts';
import { BotPlayer } from '../src/bot.ts';
import { encodeObservation2 } from '../src/observation2.ts';
import { Policy } from '../src/policy.ts';
const [path, weights, kArg] = process.argv.slice(2);
const policy = Policy.load(readFileSync(weights!));
const lines = readFileSync(path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const K = Number(kArg);
let { state, events } = newGame(lines[0].options) as { state: GameState; events: TraceEvent[] };
const me = lines[1 + K].seat as Seat;
const bot = new BotPlayer(policy, me);
for (const { seat, command } of lines.slice(1, 1 + K)) {
  if (seat === me && bot.wantsToMove(state)) bot.choose(state, events);
  const r = apply(state, seat, command);
  if (!r.ok) throw new Error(r.error.message);
  state = r.state;
  events = [...events, ...r.events];
}
bot.choose(state, events); // brings the belief up to date with this decision
const belief = (bot as unknown as { belief: Belief }).belief;
const view = viewFor(state, me);
const decision = new Decision(view, legalCommands(state, me));
const value = policy.value(encodeObservation2(view, belief, [], decision.next([])));
const rows = decision.encodings().map((ids) => {
  let p = 1;
  for (let i = 0; i < ids.length; i++) {
    const next = decision.next(ids.slice(0, i));
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of next) mask[id] = 1;
    p *= policy.raw(encodeObservation2(view, belief, ids.slice(0, i), next), mask)[ids[i]!]!;
  }
  return { move: ids.map(actionName).join(' '), p };
}).sort((a, b) => b.p - a.p);
console.log(`turn ${state.turnNumber}, seat ${me}, ${state.prompts[0]!.kind}; value head: ${value === null ? 'none' : `${Math.round(50 * (value + 1))}% to win`}`);
for (const r of rows.slice(0, 8)) console.log(`  ${r.move.padEnd(30)} ${(100 * r.p).toFixed(1)}%`);
