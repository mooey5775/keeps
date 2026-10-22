import { NUM_ACTIONS } from './actions.ts';
import { EntityNetwork } from './entity.ts';
import { observationSize, type ObservationVersion } from './env.ts';
import { encoderFingerprint } from './fingerprint.ts';

// A trained policy network, as exported by bot/keeps_bot/export.py: an MLP
// torso (ReLU after every layer) and a linear policy head, then R-NaD's
// legal-action softmax and its play-time post-processing (drop actions under a
// threshold, round the rest to multiples of 1/discretization). Ported from
// bot/keeps_bot/rnad.py (_legal_policy, FineTuning) to give the same
// probabilities as training; test/policy.test.ts checks it against JAX.

/** The file's header: where the policy came from and how to run it. */
export interface PolicyInfo {
  run: string;
  step: number;
  decisions: number | null;
  /** 'mlp' (R-NaD's, observation v1) or 'entity' (observation v2). Older files: 'mlp'. */
  network?: 'mlp' | 'entity';
  observationVersion?: ObservationVersion;
  layers: number[];
  observationSize: number;
  numActions: number;
  /** The encoder fingerprint the policy was trained with (see fingerprint.ts). */
  fingerprint: string;
  postprocess: { threshold: number; discretization: number };
  evals: Record<string, { score: number; ci95: number }> | null;
}

/** Reads a KPNN file: b'KPNN', a uint32 header length, the JSON header, float32 tensors. */
export function readTensors(bytes: Uint8Array): { header: Record<string, unknown>; tensors: Map<string, { shape: number[]; data: Float32Array }> } {
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== 'KPNN') throw new Error('not a KPNN file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as Record<string, unknown> & {
    tensors: { name: string; shape: number[]; offset: number }[];
  };
  // Copy the data so it's aligned for Float32Array whatever the buffer's offset.
  // (new Uint8Array(view) copies; a Node Buffer's slice() wouldn't.)
  const floats = new Float32Array(new Uint8Array(bytes.subarray(8 + length)).buffer);
  const tensors = new Map<string, { shape: number[]; data: Float32Array }>();
  for (const t of header.tensors) {
    const size = t.shape.reduce((a, b) => a * b, 1);
    tensors.set(t.name, { shape: t.shape, data: floats.subarray(t.offset, t.offset + size) });
  }
  return { header, tensors };
}

interface Linear {
  inputs: number;
  outputs: number;
  /** [inputs, outputs], row-major. */
  w: Float32Array;
  b: Float32Array;
}

export class Policy {
  readonly info: PolicyInfo;
  /** The observation version this policy reads. */
  readonly observation: ObservationVersion;
  private readonly torso: Linear[];
  private readonly head: Linear | null;
  private readonly entity: EntityNetwork | null;

  private constructor(info: PolicyInfo, torso: Linear[], head: Linear | null, entity: EntityNetwork | null) {
    this.info = info;
    this.observation = info.observationVersion ?? 1;
    this.torso = torso;
    this.head = head;
    this.entity = entity;
  }

  /**
   * Loads exported weights. Refuses weights trained with a different encoder
   * (pass `fingerprint` to skip recomputing the current one).
   */
  static load(bytes: Uint8Array, fingerprint?: string): Policy {
    const { header, tensors } = readTensors(bytes);
    if (header.format !== 'keeps-policy' || header.version !== 1) throw new Error('not a version 1 Keeps policy');
    const info = header as unknown as PolicyInfo;
    const version = info.observationVersion ?? 1;
    if (info.observationSize !== observationSize(version) || info.numActions !== NUM_ACTIONS) {
      throw new Error(`policy is for ${info.observationSize} observations and ${info.numActions} actions`);
    }
    fingerprint ??= encoderFingerprint(version);
    if (info.fingerprint !== fingerprint) {
      throw new Error(`policy was trained with encoder ${info.fingerprint}, but the encoder is now ${fingerprint}`);
    }
    const linear = (name: string): Linear => {
      const w = tensors.get(`${name}.w`);
      const b = tensors.get(`${name}.b`);
      if (!w || !b) throw new Error(`policy is missing ${name}`);
      return { inputs: w.shape[0]!, outputs: w.shape[1]!, w: w.data, b: b.data };
    };
    if (info.network === 'entity') {
      return new Policy(info, [], null, new EntityNetwork(tensors, (header as unknown as { layout: ConstructorParameters<typeof EntityNetwork>[1] }).layout));
    }
    return new Policy(info, info.layers.map((_, i) => linear(`torso.${i}`)), linear('policy'), null);
  }

  /** The network's policy over the legal actions (the softmax, before post-processing). */
  raw(obs: Float32Array, legal: ArrayLike<number>): Float32Array {
    if (this.entity) return legalPolicy(this.entity.logits(obs), legal);
    let x = obs;
    for (const layer of this.torso) x = forward(layer, x, true);
    return legalPolicy(forward(this.head!, x, false), legal);
  }

  /** The policy as the bot plays it: post-processed like R-NaD at test time. */
  probabilities(obs: Float32Array, legal: ArrayLike<number>): Float32Array {
    const { threshold, discretization } = this.info.postprocess;
    return discretize(thresholded(this.raw(obs, legal), legal, threshold), discretization);
  }
}

function forward(layer: Linear, x: Float32Array, relu: boolean): Float32Array {
  const { inputs, outputs, w, b } = layer;
  const out = new Float64Array(outputs);
  for (let i = 0; i < inputs; i++) {
    const xi = x[i]!;
    if (xi === 0) continue; // observations are mostly zeros
    const row = i * outputs;
    for (let j = 0; j < outputs; j++) out[j]! += xi * w[row + j]!;
  }
  const y = new Float32Array(outputs);
  for (let j = 0; j < outputs; j++) {
    const v = out[j]! + b[j]!;
    y[j] = relu && v < 0 ? 0 : v;
  }
  return y;
}

/** rnad._legal_policy: a softmax over the legal actions; illegal ones get 0. */
function legalPolicy(logits: Float32Array, legal: ArrayLike<number>): Float32Array {
  let max = -Infinity;
  for (let a = 0; a < logits.length; a++) if (legal[a] && logits[a]! > max) max = logits[a]!;
  const out = new Float32Array(logits.length);
  let sum = 0;
  for (let a = 0; a < logits.length; a++) {
    if (!legal[a]) continue;
    out[a] = Math.exp(logits[a]! - max);
    sum += out[a]!;
  }
  for (let a = 0; a < out.length; a++) out[a] = out[a]! / sum;
  return out;
}

/** FineTuning._threshold: drop legal actions under `threshold` (unless every one is under it) and renormalize. */
function thresholded(policy: Float32Array, legal: ArrayLike<number>, threshold: number): Float32Array {
  if (threshold <= 0) return policy;
  let max = 0;
  for (const p of policy) max = Math.max(max, p);
  const out = new Float32Array(policy.length);
  let sum = 0;
  for (let a = 0; a < policy.length; a++) {
    if (legal[a] && (policy[a]! >= threshold || max < threshold)) {
      out[a] = policy[a]!;
      sum += policy[a]!;
    }
  }
  for (let a = 0; a < out.length; a++) out[a] = out[a]! / sum;
  return out;
}

/**
 * FineTuning._discretize_single: round to multiples of 1/n. Largest first, each
 * action takes ceil(p·n) units while units are left; any left over go to the largest.
 */
function discretize(policy: Float32Array, n: number): Float32Array {
  if (n <= 0) return policy;
  // jnp.argsort(-mu) is stable: ties keep index order.
  const order = Array.from(policy.keys()).sort((a, b) => policy[b]! - policy[a]! || a - b);
  const units = new Float32Array(policy.length);
  let left = n;
  for (const a of order) {
    const x = Math.min(Math.ceil(Math.fround(policy[a]! * n)), left);
    units[a] = x;
    left -= x;
  }
  if (left > 0) units[order[0]!] = units[order[0]!]! + left;
  return units.map((u) => u / n);
}

/** Picks an index with probability proportional to `probabilities` (`random` in [0, 1)). */
export function sample(probabilities: ArrayLike<number>, random: () => number): number {
  let total = 0;
  for (let a = 0; a < probabilities.length; a++) total += probabilities[a]!;
  let u = random() * total;
  let last = -1;
  for (let a = 0; a < probabilities.length; a++) {
    if (probabilities[a]! <= 0) continue;
    last = a;
    if (u < probabilities[a]!) return a;
    u -= probabilities[a]!;
  }
  if (last < 0) throw new Error('nothing to sample');
  return last;
}
