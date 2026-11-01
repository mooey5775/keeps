import { NUM_ACTIONS } from '@keeps/bot';
import { RoundEnv } from '@keeps/bot';
import { observationSize, type ObservationVersion } from '@keeps/bot';
import { encodeTruth, TRUTH_SIZE } from './truth.ts';

// The training worker: many heads-up rounds at once, stepped in lockstep with
// binary frames, for self-play at speed. (server.ts is the general, JSON
// interface OpenSpiel's per-state API uses.)
// Run: node src/worker.ts <rounds> <seed> [observation version] [both] [half].
//
// Each slot holds one round; when it ends, the slot deals a new one at once.
// Protocol, repeated: read M int32 actions (little-endian; -1 = none, as on the
// first frame), apply each to its slot, then write one frame:
//   obs     float32 [M, OBSERVATION_SIZE]  the player to move's observation
//           (with `both`: [M, 2, OBSERVATION_SIZE], player 0's then player 1's,
//           for a critic that sees both. The mover's is exactly what it is
//           without `both`; the other player's is a peek, RoundEnv.peekInto.)
//   truth   float32 [M, TRUTH_SIZE]        only with `both`: the true state (truth.ts), for
//           the critic
//           (with `half`, obs and truth are float16 instead, rounded to nearest even, as
//           NumPy rounds them: half the bytes, for a learner that stores float16 anyway)
//   legal   uint8   [M, NUM_ACTIONS]       their legal actions (1 = legal)
//   player  int8    [M]                    the player to move (0 or 1)
//   done    uint8   [M]                    1 if this step ended the slot's round (obs etc. are the next round's)
//   reward  int8    [M]                    that round's result for player 0 (+1 or -1), else 0

const M = Number(process.argv[2]);
const seedBase = process.argv[3] ?? 'w';
const version = Number(process.argv[4] ?? 1) as ObservationVersion;
const both = process.argv.slice(5).includes('both');
const half = process.argv.slice(5).includes('half');
const OBSERVATION_SIZE = observationSize(version);
const VIEWS = both ? 2 : 1;
if (!Number.isInteger(M) || M <= 0) throw new Error('usage: worker.ts <rounds> <seed> [version] [both] [half]');

let dealt = 0;
const deal = () => RoundEnv.start(`${seedBase}-${dealt++}`, { checked: false, observation: version });
const envs = Array.from({ length: M }, deal);

const floats = M * VIEWS * OBSERVATION_SIZE + (both ? M * TRUTH_SIZE : 0);
const obsBytes = floats * (half ? 2 : 4);
const frame = Buffer.alloc(obsBytes + M * NUM_ACTIONS + M * 3);
// obs and truth are encoded as float32 (into the frame, or a scratch copied over as float16).
const encoded = half ? new Float32Array(floats) : new Float32Array(frame.buffer, frame.byteOffset, floats);
const obs = encoded.subarray(0, M * VIEWS * OBSERVATION_SIZE);
const truth = encoded.subarray(M * VIEWS * OBSERVATION_SIZE);
const halves = half ? new Float16Array(frame.buffer, frame.byteOffset, floats) : null;
const legal = new Uint8Array(frame.buffer, frame.byteOffset + obsBytes, M * NUM_ACTIONS);
const player = new Int8Array(frame.buffer, frame.byteOffset + obsBytes + M * NUM_ACTIONS, M);
const done = new Uint8Array(frame.buffer, frame.byteOffset + obsBytes + M * NUM_ACTIONS + M, M);
const reward = new Int8Array(frame.buffer, frame.byteOffset + obsBytes + M * NUM_ACTIONS + 2 * M, M);

function step(actions: Int32Array): void {
  legal.fill(0);
  done.fill(0);
  reward.fill(0);
  for (let i = 0; i < M; i++) {
    let env = envs[i]!;
    if (actions[i]! >= 0) {
      env.step(actions[i]!);
      if (env.terminal) {
        done[i] = 1;
        reward[i] = env.returns()[0];
        env = envs[i] = deal();
      }
    }
    const p = env.currentPlayer;
    player[i] = p;
    if (both) {
      env.observeInto(p, obs, (2 * i + p) * OBSERVATION_SIZE);
      env.peekInto(1 - p, obs, (2 * i + 1 - p) * OBSERVATION_SIZE);
      encodeTruth(env.state, truth, i * TRUTH_SIZE);
    } else {
      env.observeInto(p, obs, i * OBSERVATION_SIZE);
    }
    for (const a of env.legalActions()) legal[i * NUM_ACTIONS + a] = 1;
  }
  halves?.set(encoded);
}

// Exit quietly when the trainer goes away (it closes our pipes).
process.stdout.on('error', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));

// Read fixed-size action blocks from stdin.
const want = M * 4;
let pending: Buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (pending.length >= want) {
    const block = Buffer.from(pending.subarray(0, want)); // aligned copy
    pending = pending.subarray(want);
    step(new Int32Array(block.buffer, block.byteOffset, M));
    process.stdout.write(frame);
  }
});
