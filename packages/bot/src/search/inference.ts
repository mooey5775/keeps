// Where the batched search's network runs (batch-worker.ts): here, one observation at a time (LocalInference),
// or in the GPU server (bot/keeps_bot/serve.py) over a Unix socket (SocketInference), many at once.
//
// The socket's protocol, all little-endian:
//   hello     client: b'KPI1', uint32 length, JSON {fingerprint, step, observationSize, numActions}
//             server: uint32 length, JSON {ok: true} or {error}
//   request   client: uint32 rows, uint32 nonzeros, uint32 rowEnds[rows] (cumulative nonzeros),
//             float32 values[nonzeros], uint16 indices[nonzeros]: the observations, sparse (about an eighth
//             of their entries are nonzero), their values exactly as encoded here
//   reply     server: float32 logits[rows × numActions], requests answered in the order sent
import { createConnection, type Socket } from 'node:net';
import type { Policy } from '../policy.ts';
import { encodeRequest } from './request.ts';

export { encodeRequest } from './request.ts';

export interface Inference {
  /** The network's logits for each observation, row after row (rows × numActions). */
  logits(rows: Float32Array[]): Promise<Float32Array>;
}

/** The network run here, one observation at a time. */
export class LocalInference implements Inference {
  private readonly policy: Policy;

  constructor(policy: Policy) {
    this.policy = policy;
  }

  logits(rows: Float32Array[]): Promise<Float32Array> {
    const actions = this.policy.info.numActions;
    const out = new Float32Array(rows.length * actions);
    rows.forEach((obs, i) => out.set(this.policy.logits(obs), i * actions));
    return Promise.resolve(out);
  }
}

/** The network in the GPU server, reached over a Unix socket. */
export class SocketInference implements Inference {
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private readonly waiting: { bytes: number; resolve: (logits: Float32Array) => void; reject: (e: Error) => void }[] = [];
  private failure: Error | null = null;
  private readonly socket: Socket;
  private readonly actions: number;

  private constructor(socket: Socket, actions: number) {
    this.socket = socket;
    this.actions = actions;
    socket.on('data', (chunk: Buffer) => {
      this.buffered.push(chunk);
      this.bufferedBytes += chunk.length;
      this.deliver();
    });
    const fail = (error: Error) => {
      this.failure ??= error;
      for (const w of this.waiting.splice(0)) w.reject(this.failure);
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('the inference server closed the connection')));
  }

  /** Connects and checks that the server runs `policy`'s network (by its step and encoder fingerprint). */
  static connect(path: string, policy: Policy, timeoutMs = 5_000): Promise<SocketInference> {
    const { fingerprint, step, observationSize, numActions } = policy.info;
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`no answer from the inference server at ${path}`));
      }, timeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        const hello = Buffer.from(JSON.stringify({ fingerprint, step, observationSize, numActions }));
        const header = Buffer.alloc(8);
        header.write('KPI1', 0, 'latin1');
        header.writeUInt32LE(hello.length, 4);
        socket.write(Buffer.concat([header, hello]));
      });
      let got = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        got = Buffer.concat([got, chunk]);
        if (got.length < 4 || got.length < 4 + got.readUInt32LE(0)) return;
        socket.off('data', onData);
        socket.off('error', fail);
        clearTimeout(timer);
        const length = got.readUInt32LE(0);
        const answer = JSON.parse(got.subarray(4, 4 + length).toString()) as { ok?: boolean; error?: string };
        if (!answer.ok) {
          socket.destroy();
          reject(new Error(`the inference server refused: ${answer.error}`));
          return;
        }
        // The server answers only requests, so nothing follows its hello yet.
        resolve(new SocketInference(socket, numActions));
      };
      socket.on('data', onData);
    });
  }

  get broken(): boolean {
    return this.failure !== null;
  }

  logits(rows: Float32Array[]): Promise<Float32Array> {
    if (this.failure) return Promise.reject(this.failure);
    if (rows.length === 0) return Promise.resolve(new Float32Array(0));
    return new Promise((resolve, reject) => {
      this.waiting.push({ bytes: 4 * rows.length * this.actions, resolve, reject });
      this.socket.write(encodeRequest(rows));
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private deliver(): void {
    while (this.waiting.length > 0 && this.bufferedBytes >= this.waiting[0]!.bytes) {
      const { bytes, resolve } = this.waiting.shift()!;
      const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered);
      // Copied into its own buffer, so it's aligned for Float32Array.
      resolve(new Float32Array(new Uint8Array(all.subarray(0, bytes)).buffer));
      const rest = all.subarray(bytes);
      this.buffered = rest.length > 0 ? [rest] : [];
      this.bufferedBytes = rest.length;
    }
  }
}
