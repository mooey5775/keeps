import { NUM_ACTIONS } from './actions.ts';
import { RoundEnv } from './env.ts';
import { observationSize, type ObservationVersion } from './env.ts';

// The training worker: many heads-up rounds at once, stepped in lockstep with
// binary frames, for self-play at speed. (server.ts is the general, JSON
// interface OpenSpiel's per-state API uses.) Run: node src/worker.ts <rounds> <seed> [observation version].
//
// Each slot holds one round; when it ends, the slot deals a new one at once.
// Protocol, repeated: read M int32 actions (little-endian; -1 = none, as on the
// first frame), apply each to its slot, then write one frame:
//   obs     float32 [M, OBSERVATION_SIZE]  the player to move's observation
//   legal   uint8   [M, NUM_ACTIONS]       their legal actions (1 = legal)
//   player  int8    [M]                    the player to move (0 or 1)
//   done    uint8   [M]                    1 if this step ended the slot's round (obs etc. are the next round's)
//   reward  int8    [M]                    that round's result for player 0 (+1 or -1), else 0

const M = Number(process.argv[2]);
const seedBase = process.argv[3] ?? 'w';
const version = Number(process.argv[4] ?? 1) as ObservationVersion;
const OBSERVATION_SIZE = observationSize(version);
if (!Number.isInteger(M) || M <= 0) throw new Error('usage: worker.ts <rounds> <seed>');

let dealt = 0;
const deal = () => RoundEnv.start(`${seedBase}-${dealt++}`, { checked: false, observation: version });
const envs = Array.from({ length: M }, deal);

const obsBytes = M * OBSERVATION_SIZE * 4;
const frame = Buffer.alloc(obsBytes + M * NUM_ACTIONS + M * 3);
const obs = new Float32Array(frame.buffer, frame.byteOffset, M * OBSERVATION_SIZE);
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
    env.observeInto(p, obs, i * OBSERVATION_SIZE);
    for (const a of env.legalActions()) legal[i * NUM_ACTIONS + a] = 1;
  }
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
