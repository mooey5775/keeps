// Rollout worker for the search bot: for one sampled world, plays each candidate command out to
// the end of the round with the policy on both sides, and reports +1 or -1 for the searching seat
// per command. `sampled`: each id drawn from the policy as the bot plays it (an unbiased estimate of
// the move's value under that policy); otherwise greedy, the policy's most likely id (lower variance,
// but the opponent never plays anything but its first choice).
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { apply, eventsFor, legalCommands, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { Decision, NUM_ACTIONS } from '../src/actions.ts';
import { Belief } from '../src/belief.ts';
import { encodeObservation2 } from '../src/observation2.ts';
import { Policy, sample } from '../src/policy.ts';

const policy = Policy.load(readFileSync(workerData.weights as string));
const sampled = Boolean(workerData.sampled);
let x = (Math.random() * 2 ** 32) >>> 0;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;

function greedyMove(state: GameState, seat: Seat, belief: Belief, log: TraceEvent[]): Command {
  const view = viewFor(state, seat);
  belief.update(log).observe(view);
  const decision = new Decision(view, legalCommands(state, seat));
  const prefix: number[] = [];
  for (;;) {
    const ids = decision.next(prefix);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of ids) mask[id] = 1;
    const obs = encodeObservation2(view, belief, prefix, ids);
    if (sampled) {
      prefix.push(sample(policy.probabilities(obs, mask), random));
    } else {
      const p = policy.raw(obs, mask);
      let best = ids[0]!;
      for (const id of ids) if (p[id]! > p[best]!) best = id;
      prefix.push(best);
    }
    const command = decision.complete(prefix);
    if (command) return command;
  }
}

/** +1 if `me` wins the round after playing `first` in `world`, else -1. */
function playout(world: GameState, events: TraceEvent[], me: Seat, first: Command, myLog: TraceEvent[]): number {
  const opp = ((me + 2) % 4) as Seat;
  // My side: what I've been shown (rebuilt from my log). The opponent's real private past
  // refers to the real cards, not this world's, so it gets the public record.
  const players = new Map<Seat, { belief: Belief; log: TraceEvent[] }>([
    [me, { belief: new Belief(me, { sound: true }), log: [...myLog] }],
    [opp, { belief: new Belief(opp, { sound: true }), log: eventsFor(events, 'spectator') }],
  ]);
  let state = world;
  let command = first;
  let seat = me;
  for (let step = 0; ; step++) {
    if (step > 3000) throw new Error('playout did not end');
    const r = apply(state, seat, command, { trusted: true });
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    for (const [s, p] of players) p.log.push(...eventsFor(r.events, s));
    if (state.phase !== 'playing' && state.phase !== 'post-round') return state.lastRoundWinner === me ? 1 : -1;
    seat = state.prompts[0]!.seat;
    const p = players.get(seat)!;
    command = greedyMove(state, seat, p.belief, p.log);
  }
}

parentPort!.on('message', (job: { id: number; world: GameState; events: TraceEvent[]; myLog: TraceEvent[]; me: Seat; commands: Command[] }) => {
  try {
    parentPort!.postMessage({ id: job.id, out: job.commands.map((c) => playout(job.world, job.events, job.me, c, job.myLog)) });
  } catch (error) {
    parentPort!.postMessage({ id: job.id, error: String(error instanceof Error ? error.stack : error) });
  }
});
