// e1's probability (raw and post-processed) of each move actually played, commands FROM..TO of a replay,
// computed from the mover's own belief and view.
import { readFileSync } from 'node:fs';
import { apply, eventsFor, legalCommands, newGame, viewFor, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { Decision, NUM_ACTIONS, actionName, encode } from '../src/actions.ts';
import { Belief } from '../src/belief.ts';
import { encodeObservation2 } from '../src/observation2.ts';
import { Policy } from '../src/policy.ts';
const [path, weights, fromArg, toArg] = process.argv.slice(2);
const policy = Policy.load(readFileSync(weights!));
const lines = readFileSync(path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let { state, events } = newGame(lines[0].options) as { state: GameState; events: TraceEvent[] };
const players = new Map<Seat, { belief: Belief; log: TraceEvent[]; read: number }>(([0, 2] as Seat[]).map((s) => [s, { belief: new Belief(s, { sound: true }), log: [], read: 0 }]));
lines.slice(1).forEach(({ seat, command }: { seat: Seat; command: never }, i: number) => {
  const k = i + 1;
  const p = players.get(seat)!;
  p.log.push(...eventsFor(events.slice(p.read), seat)); p.read = events.length;
  const view = viewFor(state, seat);
  p.belief.update(p.log).observe(view);
  if (k >= Number(fromArg) && k <= Number(toArg)) {
    const decision = new Decision(view, legalCommands(state, seat));
    const ids = encode(command, view);
    const parts: string[] = [];
    for (let j = 0; j < ids.length; j++) {
      const next = decision.next(ids.slice(0, j));
      const mask = new Uint8Array(NUM_ACTIONS); for (const id of next) mask[id] = 1;
      const pr = policy.raw(encodeObservation2(view, p.belief, ids.slice(0, j), next), mask);
      const top = next.reduce((b, id) => (pr[id]! > pr[b]! ? id : b), next[0]!);
      parts.push(`${actionName(ids[j]!)} ${(100 * pr[ids[j]!]!).toFixed(0)}%${top === ids[j] ? ' (top)' : ` (top: ${actionName(top)} ${(100 * pr[top]!).toFixed(0)}%)`}`);
    }
    console.log(`#${k} seat ${seat}: ${parts.join(' → ')}`);
  }
  const r = apply(state, seat, command);
  if (!r.ok) throw new Error(r.error.message);
  state = r.state; events = [...events, ...r.events];
});
