// One rollout of the search: a command played out to the end of the round in one sampled world, the policy on
// both sides. A generator, so whoever drives it decides how the network runs: one observation at a time
// (rollout-worker.ts), or many playouts in lockstep with one batched forward per step (batch-worker.ts). It
// yields each observation the policy must read and takes back the network's logits for it.
import { apply, eventsFor, legalCommands, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { Decision, NUM_ACTIONS } from '../src/actions.ts';
import { Belief, noteObservation } from '../src/belief.ts';
import { encodeObservation2, OBSERVATION2_SIZE } from '../src/observation2.ts';
import { sample, type Policy } from '../src/policy.ts';

/** What a playout asks the network: an observation, and the ids legal there. */
export interface Ask {
  /** Valid until the playout is resumed: each playout reuses one buffer for all its observations. */
  obs: Float32Array;
  ids: number[];
  mask: Uint8Array;
}

/** An id chosen from the network's logits at an ask. */
export type Pick = (logits: Float32Array, ask: Ask) => number;

/** Each id drawn from the policy as the bot plays it: an unbiased estimate of the move's value under that policy. */
export function sampledPick(policy: Policy, random: () => number): Pick {
  return (logits, ask) => sample(policy.probabilitiesFrom(logits, ask.mask), random);
}

/** The policy's most likely id (lower variance, but the opponent never plays anything but its first choice). */
export function greedyPick(policy: Policy): Pick {
  return (logits, ask) => {
    const p = policy.rawFrom(logits, ask.mask);
    let best = ask.ids[0]!;
    for (const id of ask.ids) if (p[id]! > p[best]!) best = id;
    return best;
  };
}

function* move(state: GameState, seat: Seat, belief: Belief, log: TraceEvent[], pick: Pick, obs: Float32Array): Generator<Ask, Command, Float32Array> {
  const view = viewFor(state, seat);
  // As BotPlayer does: the view noted in the player's own log, and learned from there.
  belief.update(noteObservation(log, view, seat));
  const decision = new Decision(view, legalCommands(state, seat));
  const prefix: number[] = [];
  for (;;) {
    const ids = decision.next(prefix);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of ids) mask[id] = 1;
    const ask = { obs: encodeObservation2(view, belief, prefix, ids, obs), ids, mask };
    prefix.push(pick(yield ask, ask));
    const command = decision.complete(prefix);
    if (command) return command;
  }
}

/** +1 if `me` wins the round after playing `first` in `world`, else -1. */
export function* playout(
  world: GameState,
  me: Seat,
  first: Command,
  myLog: TraceEvent[],
  theirLog: TraceEvent[],
  pick: Pick,
): Generator<Ask, number, Float32Array> {
  const opp = ((me + 2) % 4) as Seat;
  // Each side reads its own log: mine as I saw it; the opponent's as they saw this world's history.
  const players = new Map<Seat, { belief: Belief; log: TraceEvent[] }>([
    [me, { belief: new Belief(me, { sound: true }), log: [...myLog] }],
    [opp, { belief: new Belief(opp, { sound: true }), log: [...theirLog] }],
  ]);
  let state = world;
  let command = first;
  let seat = me;
  const obs = new Float32Array(OBSERVATION2_SIZE);
  for (let step = 0; ; step++) {
    if (step > 3000) throw new Error('playout did not end');
    const r = apply(state, seat, command, { trusted: true });
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    for (const [s, p] of players) p.log.push(...eventsFor(r.events, s));
    if (state.phase !== 'playing' && state.phase !== 'post-round') return state.lastRoundWinner === me ? 1 : -1;
    seat = state.prompts[0]!.seat;
    const p = players.get(seat)!;
    command = yield* move(state, seat, p.belief, p.log, pick, obs);
  }
}

/** A playout driven one observation at a time, the network run here. */
export function playOut(game: Generator<Ask, number, Float32Array>, policy: Policy): number {
  let r = game.next();
  while (!r.done) r = game.next(policy.logits(r.value.obs));
  return r.value;
}
