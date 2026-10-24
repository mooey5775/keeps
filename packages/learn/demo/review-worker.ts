// Round review worker: a separate process (started at the lowest CPU priority by review.ts), playing
// rounds out to the end with the network sampling every move for both sides, each side reading its own
// log. Jobs come over IPC:
//   truth   the real position, n times (optionally after one given first move): wins by seat;
//   worlds  n worlds drawn from what `me` knows, each played on once, or once per given first move
//           (the same worlds for every move): `me`'s result per world and move, 1 won, 0 not.
//   node review-worker.ts <weights>
import { readFileSync } from 'node:fs';
import { apply, eventsFor, legalCommands, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { Decision, NUM_ACTIONS } from '../src/actions.ts';
import { Belief } from '../src/belief.ts';
import { encodeObservation2 } from '../src/observation2.ts';
import { Policy, sample } from '../src/policy.ts';
import { sampleWorld, worldModel } from '../src/worlds.ts';

export type ReviewJob =
  | { kind: 'truth'; state: GameState; logs: [Seat, TraceEvent[]][]; first: { seat: Seat; command: Command } | null; n: number }
  | { kind: 'worlds'; state: GameState; me: Seat; myLog: TraceEvent[]; publicLog: TraceEvent[]; commands: Command[] | null; n: number };
export type ReviewResult = { wins: Partial<Record<Seat, number>>; n: number } | { rows: number[][] };

const policy = Policy.load(readFileSync(process.argv[2]!));
let x = (Math.random() * 2 ** 32) >>> 0;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;

/** The network's move for `seat`, sampled id by id, as the bot plays. */
function move(state: GameState, seat: Seat, belief: Belief, log: TraceEvent[]): Command {
  const view = viewFor(state, seat);
  belief.update(log).observe(view);
  const decision = new Decision(view, legalCommands(state, seat));
  const prefix: number[] = [];
  for (;;) {
    const ids = decision.next(prefix);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of ids) mask[id] = 1;
    prefix.push(sample(policy.probabilities(encodeObservation2(view, belief, prefix, ids), mask), random));
    const command = decision.complete(prefix);
    if (command) return command;
  }
}

/** Plays `state` to the end of the round (after `first`, if given); logs: what each seat has seen. The winner, or null. */
function playout(state: GameState, logs: [Seat, TraceEvent[]][], first: { seat: Seat; command: Command } | null): Seat | null {
  const players = new Map(logs.map(([s, log]) => [s, { belief: new Belief(s, { sound: true }), log: [...log] }]));
  let next = first;
  for (let step = 0; ; step++) {
    if (step > 3000) throw new Error('a playout did not end');
    if (state.phase !== 'playing' && state.phase !== 'post-round') return state.lastRoundWinner;
    const seat = next?.seat ?? state.prompts[0]!.seat;
    const p = players.get(seat)!;
    const command = next?.command ?? move(state, seat, p.belief, p.log);
    next = null;
    const r = apply(state, seat, command, { trusted: true });
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    for (const [s, q] of players) q.log.push(...eventsFor(r.events, s));
  }
}

function run(job: ReviewJob): ReviewResult {
  if (job.kind === 'truth') {
    const wins: Partial<Record<Seat, number>> = {};
    for (let i = 0; i < job.n; i++) {
      const winner = playout(job.state, job.logs, job.first);
      if (winner !== null) wins[winner] = (wins[winner] ?? 0) + 1;
    }
    return { wins, n: job.n };
  }
  const { state, me, myLog, publicLog, commands } = job;
  const belief = new Belief(me, { sound: true });
  const view = viewFor(state, me);
  belief.update(myLog).observe(view);
  const model = worldModel(state, me, belief, view);
  const opponent = ((me + 2) % 4) as Seat;
  const logs: [Seat, TraceEvent[]][] = [
    [me, myLog],
    [opponent, publicLog],
  ];
  const rows: number[][] = [];
  for (let i = 0; i < job.n; i++) {
    const world = sampleWorld(model, state, belief, random);
    rows.push((commands ?? [null]).map((command) => (playout(world, logs, command ? { seat: me, command } : null) === me ? 1 : 0)));
  }
  return { rows };
}

process.on('message', (message: { id: number; job: ReviewJob }) => {
  try {
    process.send!({ id: message.id, result: run(message.job) });
  } catch (error) {
    process.send!({ id: message.id, error: String(error instanceof Error ? error.stack : error) });
  }
});
process.on('disconnect', () => process.exit(0));
