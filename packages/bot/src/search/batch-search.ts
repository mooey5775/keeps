// The search's playouts batched (an Evaluator, like RolloutPool): each worker thread (batch-worker.ts) samples
// its share of the worlds and plays its playouts in lockstep, the network run once per step for all of them,
// on a GPU server (bot/keeps_bot/serve.py) when `inference` names its socket, else in the worker. About 95% of a
// playout's time is the network, one observation at a time; batched on a GPU it's a small part.
import { Worker } from 'node:worker_threads';
import type { BatchJob } from './batch-worker.ts';
import { Superseded, type EvaluateJob, type Evaluator } from './search.ts';
import { Threads } from './threads.ts';

export class BatchedPool implements Evaluator {
  private readonly threads: Threads<{ rows: number[][] }>;
  private seed = (Math.random() * 2 ** 32) >>> 0;

  /** `inference`: the GPU server's socket (null: the network runs in the workers). `sampled`: as RolloutPool's. */
  constructor(size: number, weights: string, inference: string | null, sampled = process.env.SEARCH_ROLLOUTS === 'sampled', log: (line: string) => void = console.log) {
    this.threads = new Threads(size, () => new Worker(new URL('./batch-worker.ts', import.meta.url), { workerData: { weights, sampled, inference } }), log);
  }

  /** Fixes the next searches' seeds (each search takes the next one), for reproducible runs. */
  setSeed(seed: number): void {
    this.seed = seed >>> 0;
  }

  async evaluate(job: EvaluateJob): Promise<number[][]> {
    // (A search no longer wanted isn't started; one under way plays out.)
    if (job.wanted && !job.wanted()) throw new Superseded();
    const { state, me, myLog, commands, n } = job;
    const seed = this.seed;
    this.seed = (this.seed + 0x9e3779b9) >>> 0;
    // The worlds as evenly as the workers allow: each worker's are sampled there, from its own stream.
    const size = this.threads.size;
    const shares = Array.from({ length: size }, (_, i) => Math.floor(n / size) + (i < n % size ? 1 : 0));
    const parts = await Promise.all(
      shares.map(async (share, i) => {
        if (share === 0) return [];
        const message: Omit<BatchJob, 'id'> = { state, me, myLog, commands, n: share, seed: (seed + Math.imul(i, 0x85ebca6b)) >>> 0 };
        return (await this.threads.post(i, message)).rows;
      }),
    );
    return parts.flat();
  }

  close(): Promise<void> {
    return this.threads.close();
  }
}
