// The app's search: an Evaluator (packages/learn/demo/search-bot.ts) over Web Workers (search-worker.ts), the network
// in Core ML. A search's worlds go out in chunks, each with its own seed, to whichever worker has room (two at a time
// each, so a worker always has playouts to batch): fast cores take more chunks than slow ones, so no worker count or
// split needs tuning to a device, and the results come back in chunk order, the same whoever ran them.
import type { EvaluateJob, Evaluator } from '../../packages/learn/demo/search-bot.ts';
import type { SearchWorkerMessage, SearchWorkerReply } from './search-worker.ts';

/** Worlds per chunk: enough playouts for a worker to batch (each world plays every candidate move). */
const CHUNK = 64;

export class WorkerSearch implements Evaluator {
  private readonly workers: Worker[] = [];
  private readonly waiting = new Map<number, { resolve: (rows: number[][]) => void; reject: (e: Error) => void }>();
  private id = 0;
  private seed = (Math.random() * 2 ** 32) >>> 0;

  private constructor() {}

  /** `count` workers, each with the network's weights (for its policy's sampling; Core ML runs the network). */
  static async start(count: number, weights: ArrayBuffer): Promise<WorkerSearch> {
    const pool = new WorkerSearch();
    await Promise.all(
      Array.from({ length: count }, () => {
        const w = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });
        pool.workers.push(w);
        return new Promise<void>((resolve, reject) => {
          w.onmessage = (e: MessageEvent<SearchWorkerReply>) => {
            const m = e.data;
            if (m.t === 'ready') return resolve();
            if (m.t === 'error' && m.id === undefined) return reject(new Error(m.message));
            const job = pool.waiting.get(m.id!);
            pool.waiting.delete(m.id!);
            if (m.t === 'error') job?.reject(new Error(m.message));
            else job?.resolve(m.rows);
          };
          w.postMessage({ t: 'init', weights: weights.slice(0) } satisfies SearchWorkerMessage);
        });
      }),
    );
    return pool;
  }

  get size(): number {
    return this.workers.length;
  }

  async evaluate(job: EvaluateJob): Promise<number[][]> {
    const { state, me, myLog, commands, n } = job;
    const seed = this.seed;
    this.seed = (this.seed + 0x9e3779b9) >>> 0;
    const chunks = Array.from({ length: Math.ceil(n / CHUNK) }, (_, c) => ({ n: Math.min(CHUNK, n - c * CHUNK), seed: (seed + Math.imul(c, 0x85ebca6b)) >>> 0 }));
    const rows: number[][][] = new Array(chunks.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(2 * this.workers.length, chunks.length) }, async (_, slot) => {
        const worker = this.workers[slot % this.workers.length]!;
        while (next < chunks.length) {
          const c = next++;
          rows[c] = await this.run(worker, { state, me, myLog, commands, ...chunks[c]! });
        }
      }),
    );
    return rows.flat();
  }

  private run(worker: Worker, job: Extract<SearchWorkerMessage, { t: 'search' }>['job']): Promise<number[][]> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ t: 'search', id, job } satisfies SearchWorkerMessage);
    });
  }
}

/** `search` with at most `worlds` worlds per search. */
export const capped = (search: Evaluator, worlds: number): Evaluator => ({ evaluate: (job) => search.evaluate({ ...job, n: Math.min(job.n, worlds) }) });
