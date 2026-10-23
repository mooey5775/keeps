// From a real position of a replay (after its first K commands), each legal move of the decider played
// out R times on the TRUE state, e1 sampling moves for both sides (each side's belief from its own log).
//   node evaltrue.ts <replay> <weights> <K> <R>
import { readFileSync } from 'node:fs';
import { apply, eventsFor, legalCommands, newGame, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { Decision, NUM_ACTIONS, actionName, encode } from '../src/actions.ts';
import { Belief } from '../src/belief.ts';
import { encodeObservation2 } from '../src/observation2.ts';
import { Policy, sample } from '../src/policy.ts';
import { BotPlayer } from '../src/bot.ts';
import { sampleWorld, worldModel } from '../src/worlds.ts';
const [path, weights, kArg, rArg] = process.argv.slice(2);
const policy = Policy.load(readFileSync(weights!));
const K = Number(kArg), R = Number(rArg);
let x = 4242;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const lines = readFileSync(path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let { state, events } = newGame(lines[0].options) as { state: GameState; events: TraceEvent[] };
for (const { seat, command } of lines.slice(1, 1 + K)) {
  const r = apply(state, seat, command);
  if (!r.ok) throw new Error(r.error.message);
  state = r.state;
  events = [...events, ...r.events];
}
const me = state.prompts[0]!.seat;
const next = lines[1 + K];
// WORLDS=n: instead of the true state, n worlds drawn from the decider's own belief (rebuilt as the bot's is).
const worldsWanted = Number(process.env.WORLDS ?? 0);
let worlds: GameState[] = [];
if (worldsWanted) {
  let st = newGame(lines[0].options).state as GameState, ev = newGame(lines[0].options).events as TraceEvent[];
  const bot = new BotPlayer(policy, me);
  for (const { seat, command } of lines.slice(1, 1 + K)) {
    if (seat === me && bot.wantsToMove(st)) bot.choose(st, ev);
    const r = apply(st, seat, command);
    if (!r.ok) throw new Error(r.error.message);
    st = r.state;
    ev = [...ev, ...r.events];
  }
  bot.choose(st, ev);
  const belief = (bot as unknown as { belief: Belief }).belief;
  const model = worldModel(st, me, belief, viewFor(st, me));
  worlds = Array.from({ length: worldsWanted }, () => sampleWorld(model, st, belief, random));
}
function move(s: GameState, seat: Seat, belief: Belief, log: TraceEvent[]): Command {
  const view = viewFor(s, seat);
  belief.update(log).observe(view);
  const decision = new Decision(view, legalCommands(s, seat));
  const prefix: number[] = [];
  for (;;) {
    const ids = decision.next(prefix);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of ids) mask[id] = 1;
    const probs = policy.probabilities(encodeObservation2(view, belief, prefix, ids), mask);
    if (process.env.GREEDY) {
      let best = ids[0]!;
      for (const id of ids) if (probs[id]! > probs[best]!) best = id;
      prefix.push(best);
    } else prefix.push(sample(probs, random));
    const c = decision.complete(prefix);
    if (c) return c;
  }
}
const view = viewFor(state, me);
const options = new Decision(view, legalCommands(state, me)).encodings().map((ids) => ({ ids, command: new Decision(view, legalCommands(state, me)).complete(ids)! }));
console.log(`turn ${state.turnNumber}, seat ${me} to decide (${state.prompts[0]!.kind}); played next: ${next ? JSON.stringify(next.command.answer ?? next.command) : '-'}`);
for (const { ids, command } of options) {
  let wins = 0;
  for (let k = 0; k < R; k++) {
    const players = new Map<Seat, { belief: Belief; log: TraceEvent[] }>(([0, 2] as Seat[]).map((s) => [s, { belief: new Belief(s, { sound: true }), log: eventsFor(events, s) }]));
    let s = worlds.length ? worlds[k % worlds.length]! : state, c = command, seat = me;
    for (let step = 0; ; step++) {
      const r = apply(s, seat, c, { trusted: true });
      if (!r.ok) throw new Error(r.error.message);
      s = r.state;
      for (const [q, p] of players) p.log.push(...eventsFor(r.events, q));
      if (s.phase !== 'playing' && s.phase !== 'post-round') break;
      seat = s.prompts[0]!.seat;
      const p = players.get(seat)!;
      c = move(s, seat, p.belief, p.log);
    }
    if (s.lastRoundWinner === me) wins++;
  }
  const played = next && JSON.stringify(encode(next.command, view)) === JSON.stringify(ids) ? ' ← played' : '';
  console.log(`  ${ids.map(actionName).join(' ').padEnd(34)} seat ${me} wins ${(100 * wins / R).toFixed(1)}% (${R} playouts, ${worlds.length ? worlds.length + ' sampled worlds' : 'true state'}, ${process.env.GREEDY ? 'greedy' : 'sampled'} e1)${played}`);
}
