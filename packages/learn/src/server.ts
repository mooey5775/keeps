import { createInterface } from 'node:readline';
import { actionName, NUM_ACTIONS } from '@keeps/bot';
import { observationSize, RoundEnv, type ObservationVersion } from '@keeps/bot';
import { encoderFingerprint } from '@keeps/bot';
import { LAYOUT2 } from '@keeps/bot';
import { TRUTH_LAYOUT } from './truth.ts';

// The environment server: Python (OpenSpiel) drives heads-up rounds through it,
// so the rules exist only in the TypeScript engine. Run: node src/server.ts.
//
// Protocol: one JSON request per line on stdin, one JSON response per line on
// stdout. A request is {"ops": [op, ...]}; the response is {"results": [...]},
// one result per op (or {"error": message}).
//   {"op": "new", "seed": "..."}           → {"id", ...status}
//   {"op": "step", "id", "action"}         → {...status}
//   {"op": "clone", "id"}                  → {"id", ...status}
//   {"op": "obs", "id", "player"}          → {"obs"}
//   {"op": "free", "ids": [...]}           → {}
//   {"op": "describe", "id"}               → {"text"}
//   {"op": "info"}                         → {"observationSize", "observationVersion", "layout", "numActions", "actionNames", "fingerprint", "truthLayout"}
// status = {"player", "legal", "terminal", "returns", "obs"}: "player" is the
// player to move (-4 when the round is over), "obs" their observation.
// Observations are little-endian float32 arrays, base64-encoded.

// Observation version: node src/server.ts [version] (default 1).
const version = Number(process.argv[2] ?? 1) as ObservationVersion;
const envs = new Map<number, RoundEnv>();
let fingerprint: string | undefined;
let nextId = 1;

const encodeObs = (obs: Float32Array) => Buffer.from(obs.buffer, obs.byteOffset, obs.byteLength).toString('base64');

function status(env: RoundEnv) {
  const terminal = env.terminal;
  const player = env.currentPlayer;
  return {
    player,
    legal: terminal ? [] : env.legalActions(),
    terminal,
    returns: env.returns(),
    obs: terminal ? null : encodeObs(env.observation(player)),
  };
}

function get(id: number): RoundEnv {
  const env = envs.get(id);
  if (!env) throw new Error(`no environment ${id}`);
  return env;
}

type Op =
  | { op: 'new'; seed: string }
  | { op: 'step'; id: number; action: number }
  | { op: 'clone'; id: number }
  | { op: 'obs'; id: number; player: number }
  | { op: 'free'; ids: number[] }
  | { op: 'describe'; id: number }
  | { op: 'info' };

function run(op: Op): object {
  switch (op.op) {
    case 'new': {
      const id = nextId++;
      const env = RoundEnv.start(op.seed, { checked: false, observation: version });
      envs.set(id, env);
      return { id, ...status(env) };
    }
    case 'step': {
      const env = get(op.id);
      env.step(op.action);
      return status(env);
    }
    case 'clone': {
      const id = nextId++;
      const env = get(op.id).clone();
      envs.set(id, env);
      return { id, ...status(env) };
    }
    case 'obs':
      return { obs: encodeObs(get(op.id).observation(op.player)) };
    case 'free':
      for (const id of op.ids) envs.delete(id);
      return {};
    case 'info':
      return {
        observationSize: observationSize(version),
        observationVersion: version,
        layout: version === 2 ? LAYOUT2 : null,
        numActions: NUM_ACTIONS,
        actionNames: Array.from({ length: NUM_ACTIONS }, (_, i) => actionName(i)),
        fingerprint: (fingerprint ??= encoderFingerprint(version)),
        truthLayout: TRUTH_LAYOUT, // the worker's `both` frames (truth.ts)
      };
    case 'describe': {
      const env = get(op.id);
      return { text: `seat to move: ${env.terminal ? '-' : env.decider()}; prefix [${env.prefix.join(', ')}]; phase ${env.state.phase}` };
    }
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let response: object;
  try {
    const request = JSON.parse(line) as { ops: Op[] };
    response = { results: request.ops.map(run) };
  } catch (error) {
    response = { error: (error as Error).message };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
