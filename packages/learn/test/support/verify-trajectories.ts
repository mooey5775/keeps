// Checks self-play trajectories, as the trainer receives them, against an independent replay of their rounds
// (training/tests/test_trajectories.py runs it on rollouts from the real Sampler and its Node workers).
//
// The replay uses none of the training code (RoundEnv, worker.ts): only what the deployed bot uses. The engine,
// with its legality checks on; Decision for the legal ids; each player's belief updated from their log and view at
// their own decisions, as BotPlayer does; the observation and truth encoders. For every step it must reproduce,
// bit for bit: who moves, the legal ids, the mover's observation and the other player's (the critic's peek: a belief
// of its own, observed whenever that player isn't moving), the true state, both in float16 as stored; the action
// must be legal; and the round must end on the episode's last step with the result recorded for the right player.
//
//   node verify-trajectories.ts <dir>   (dir: episodes.json, obs.f16, truth.f16; prints a JSON report)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, eventsFor, legalCommands, newGame, viewFor, type GameState, type Seat, type TraceEvent } from '../../../engine/src/index.ts';
import { Decision, NUM_ACTIONS } from '@keeps/bot';
import { Belief } from '@keeps/bot';
import { encodeObservation2, OBSERVATION2_SIZE } from '@keeps/bot';
import { encodeTruth, TRUTH_SIZE } from '../../src/truth.ts';

type Episode = { steps: number; player: number[]; action: number[]; legal: number[][]; lastReward: [number, number] };
type Input = { seedBases: string[]; candidates: number; episodes: Episode[] };

const dir = process.argv[2]!;
const input = JSON.parse(readFileSync(join(dir, 'episodes.json'), 'utf8')) as Input;
const bits = (path: string) => {
  const b = readFileSync(join(dir, path));
  return new Uint16Array(b.buffer, b.byteOffset, b.length / 2);
};
const obsBits = bits('obs.f16');
const truthBits = bits('truth.f16');
const O = OBSERVATION2_SIZE;
const SEATS: readonly Seat[] = [0, 2];

/** float32 values as float16 bits (round to nearest even, as NumPy and the worker round them). */
const half = (x: Float32Array) => new Uint16Array(Float16Array.from(x).buffer);
const same = (a: Uint16Array, b: Uint16Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Replays `e` from the deal of `seed`; the first difference found, or null if every step matches. */
function replay(e: Episode, obs: Uint16Array, truth: Uint16Array, seed: string, firstStepOnly = false): string | null {
  let { state, events } = newGame({ players: 2, seed, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
  const own = new Map<Seat, Belief>(SEATS.map((s) => [s, new Belief(s, { sound: true })]));
  const peek = new Map<Seat, Belief>(SEATS.map((s) => [s, new Belief(s, { sound: true })]));
  let decision: Decision | null = null;
  let prefix: number[] = [];
  const truthRow = new Float32Array(TRUTH_SIZE);
  for (let t = 0; t < e.steps; t++) {
    if (state.phase !== 'playing' && state.phase !== 'post-round') return `step ${t}: the round is already over`;
    const deciders = new Set(state.prompts.map((p) => p.seat));
    if (deciders.size !== 1) return `step ${t}: ${deciders.size} seats to decide`;
    const seat = state.prompts[0]!.seat as Seat;
    const player = SEATS.indexOf(seat);
    if (player !== e.player[t]) return `step ${t}: player ${e.player[t]} recorded, ${player} moves`;
    const view = viewFor(state, seat);
    if (!decision) {
      // A new command: the mover's belief reads their log and sees their view, once, as BotPlayer's does.
      own.get(seat)!.update(eventsFor(events, seat)).observe(view);
      decision = new Decision(view, legalCommands(state, seat));
    }
    const ids = decision.next(prefix);
    const legal = [...e.legal[t]!].sort((a, b) => a - b);
    if (JSON.stringify(legal) !== JSON.stringify([...ids].sort((a, b) => a - b))) return `step ${t}: legal ${legal} recorded, ${ids} legal`;
    const at = (t * 2) * O;
    const mine = half(encodeObservation2(view, own.get(seat)!, prefix, ids));
    if (!same(mine, obs.subarray(at + player * O, at + (player + 1) * O))) return `step ${t}: the mover's observation differs`;
    const other = SEATS[1 - player]!;
    const otherView = viewFor(state, other);
    const theirs = half(encodeObservation2(otherView, peek.get(other)!.update(eventsFor(events, other)).observe(otherView), [], []));
    if (!same(theirs, obs.subarray(at + (1 - player) * O, at + (2 - player) * O))) return `step ${t}: the other player's observation differs`;
    encodeTruth(state, truthRow, 0);
    if (!same(half(truthRow), truth.subarray(t * TRUTH_SIZE, (t + 1) * TRUTH_SIZE))) return `step ${t}: the true state differs`;
    if (firstStepOnly) return null;
    const action = e.action[t]!;
    if (!ids.includes(action)) return `step ${t}: action ${action} is not legal`;
    prefix.push(action);
    const command = decision.complete(prefix);
    if (command) {
      const r = apply(state, seat, command);
      if (!r.ok) return `step ${t}: the engine rejects ${JSON.stringify(command)}: ${r.error.message}`;
      state = r.state;
      events = [...events, ...r.events];
      decision = null;
      prefix = [];
    }
  }
  if (prefix.length) return 'the episode ends in the middle of a command';
  if (state.phase === 'playing' || state.phase === 'post-round') return `the round isn't over after ${e.steps} steps`;
  const winner = state.lastRoundWinner;
  const want = winner === 0 ? [1, -1] : [-1, 1];
  if (e.lastReward[0] !== want[0] || e.lastReward[1] !== want[1]) return `result ${e.lastReward} recorded, seat ${winner} won`;
  return null;
}

const report = { episodes: input.episodes.length, steps: 0, verified: 0, failures: [] as string[], seeds: [] as string[] };
let obsAt = 0, truthAt = 0;
for (const [i, e] of input.episodes.entries()) {
  const obs = obsBits.subarray(obsAt, obsAt + e.steps * 2 * O);
  const truth = truthBits.subarray(truthAt, truthAt + e.steps * TRUTH_SIZE);
  obsAt += e.steps * 2 * O;
  truthAt += e.steps * TRUTH_SIZE;
  report.steps += e.steps;
  if (e.legal.some((ids) => ids.some((id) => id < 0 || id >= NUM_ACTIONS))) report.failures.push(`episode ${i}: an id out of range`);
  // Which deal is it? The workers deal `<base>-<k>` in order; its first step tells them apart.
  const seeds = input.seedBases.flatMap((base) => Array.from({ length: input.candidates }, (_, k) => `${base}-${k}`));
  const matches = seeds.filter((s) => replay(e, obs, truth, s, true) === null);
  if (!matches.length) {
    report.failures.push(`episode ${i}: no deal matches its first step`);
    continue;
  }
  const results = matches.map((s) => [s, replay(e, obs, truth, s)] as const);
  const good = results.find(([, problem]) => problem === null);
  if (good) {
    report.verified++;
    report.seeds.push(good[0]);
  } else report.failures.push(`episode ${i} (${results[0]![0]}): ${results[0]![1]}`);
}
console.log(JSON.stringify(report));
