// The search's playouts batched (an Evaluator, like RolloutPool): each worker thread (batch-worker.ts) samples
// its share of the worlds and plays its playouts in lockstep, the network run once per step for all of them,
// on a GPU server (bot/keeps_bot/serve.py) when `inference` names its socket, else in the worker. About 95% of a
// playout's time is the network, one observation at a time; batched on a GPU it's a small part.
import { Worker } from 'node:worker_threads';
import type { BatchJob } from './batch-worker.ts';
import type { EvaluateJob, Evaluator } from './search.ts';

export class BatchedPool implements Evaluator {
  private readonly workers: Worker[];
  private readonly waiting = new Map<number, { resolve: (rows: number[][]) => void; reject: (e: Error) => void }>();
  private id = 0;
  private seed = (Math.random() * 2 ** 32) >>> 0;

  /** `inference`: the GPU server's socket (null: the network runs in the workers). `sampled`: as RolloutPool's. */
  constructor(size: number, weights: string, inference: string | null, sampled = process.env.SEARCH_ROLLOUTS === 'sampled', log: (line: string) => void = console.log) {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./batch-worker.ts', import.meta.url), { workerData: { weights, sampled, inference } });
      w.on('message', (m: { id?: number; rows?: number[][]; error?: string; log?: string }) => {
        if (m.log) {
          log(m.log);
          return;
        }
        const job = this.waiting.get(m.id!);
        this.waiting.delete(m.id!);
        if (m.error) job?.reject(new Error(m.error));
        else job?.resolve(m.rows!);
      });
      return w;
    });
  }

  /** Fixes the next searches' seeds (each search takes the next one), for reproducible runs. */
  setSeed(seed: number): void {
    this.seed = seed >>> 0;
  }

  async evaluate(job: EvaluateJob): Promise<number[][]> {
    const { state, me, myLog, commands, n } = job;
    const seed = this.seed;
    this.seed = (this.seed + 0x9e3779b9) >>> 0;
    // The worlds as evenly as the workers allow: each worker's are sampled there, from its own stream.
    const shares = this.workers.map((_, i) => Math.floor(n / this.workers.length) + (i < n % this.workers.length ? 1 : 0));
    const parts = await Promise.all(
      shares.map((share, i) => {
        if (share === 0) return Promise.resolve([] as number[][]);
        const id = this.id++;
        const message: BatchJob = { id, state, me, myLog, commands, n: share, seed: (seed + Math.imul(i, 0x85ebca6b)) >>> 0 };
        return new Promise<number[][]>((resolve, reject) => {
          this.waiting.set(id, { resolve, reject });
          this.workers[i]!.postMessage(message);
        });
      }),
    );
    return parts.flat();
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
