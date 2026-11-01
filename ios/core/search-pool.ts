// The app's search: an Evaluator (packages/bot/src/search/search.ts) over Web Workers (search-worker.ts), the network
// in Core ML. A search's worlds go out in chunks, each with its own seed, to whichever worker has room (two at a time
// each, so a worker always has playouts to batch): fast cores take more chunks than slow ones, so no worker count or
// split needs tuning to a device, and the results come back in chunk order, the same whoever ran them.
//
// Every search's chunks wait in one queue, so however many searches are under way (Midstrike's, and training mode's
// advice for each of your decisions), the workers hold only so many chunks at once: the page's memory is bounded (all
// at once, they took more than WebKit allows a page, and it ended the page's process). A chunk whose search is no
// longer wanted (its position has passed) is dropped, not played.
import { Superseded, type EvaluateJob, type Evaluator } from '../../packages/bot/src/search/search.ts';
import type { SearchWorkerMessage, SearchWorkerReply } from './search-worker.ts';

/** Worlds per chunk: enough playouts for a worker to batch (each world plays every candidate move). */
const CHUNK = 64;

/** How long a worker may take over one chunk before it's taken for stuck: replaced, and its chunk failed. */
const CHUNK_MS = 90_000;
/** Chunks a worker holds at once: two, so it always has playouts to batch while the other's wait on the network. */
const PER_WORKER = 2;

type ChunkJob = Extract<SearchWorkerMessage, { t: 'search' }>['job'];
interface Queued {
  job: ChunkJob;
  wanted: () => boolean;
  resolve: (rows: number[][]) => void;
  reject: (e: Error) => void;
}

export class WorkerSearch implements Evaluator {
  private readonly workers: Worker[] = [];
  /** Each chunk sent and not yet answered: its worker, and what to tell its search. */
  private readonly waiting = new Map<number, { worker: Worker; resolve: (rows: number[][]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private id = 0;
  private seed = (Math.random() * 2 ** 32) >>> 0;
  private weights: ArrayBuffer = new ArrayBuffer(0);
  /** Chunks waiting for a worker, every search's, in the order asked. */
  private readonly queue: Queued[] = [];

  private constructor() {}

  /** `count` workers, each with the network's weights (for its policy's sampling; Core ML runs the network). */
  static async start(count: number, weights: ArrayBuffer): Promise<WorkerSearch> {
    const pool = new WorkerSearch();
    pool.weights = weights;
    pool.workers.push(...(await Promise.all(Array.from({ length: count }, () => pool.spawn()))));
    return pool;
  }

  /** A worker, ready (its weights loaded). */
  private spawn(): Promise<Worker> {
    const w = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });
    return new Promise<Worker>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<SearchWorkerReply>) => {
        const m = e.data;
        if (m.t === 'ready') return resolve(w);
        if (m.t === 'error' && m.id === undefined) return reject(new Error(m.message));
        const job = this.waiting.get(m.id!);
        if (!job) return;
        this.waiting.delete(m.id!);
        clearTimeout(job.timer);
        if (m.t === 'error') job.reject(new Error(m.message));
        else job.resolve(m.rows);
        this.pump();
      };
      // A worker that fails outright (out of memory, say) answers nothing more: its chunks fail now, and it's replaced.
      w.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        this.lose(w, `a search worker failed: ${e.message || 'no message'}`);
      };
      w.postMessage({ t: 'init', weights: this.weights.slice(0) } satisfies SearchWorkerMessage);
    });
  }

  /** `worker` is gone: its chunks fail with `why`, and a new worker takes its place. */
  private lose(worker: Worker, why: string): void {
    const at = this.workers.indexOf(worker);
    if (at < 0) return;
    console.error(why);
    worker.terminate();
    for (const [id, job] of this.waiting) {
      if (job.worker !== worker) continue;
      this.waiting.delete(id);
      clearTimeout(job.timer);
      job.reject(new Error(why));
    }
    this.spawn().then(
      (fresh) => {
        this.workers[at] = fresh;
        this.pump();
      },
      (error: unknown) => console.error(`a search worker couldn't be replaced: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  get size(): number {
    return this.workers.length;
  }

  async evaluate(job: EvaluateJob): Promise<number[][]> {
    const { state, me, myLog, commands, n, wanted = () => true } = job;
    const seed = this.seed;
    this.seed = (this.seed + 0x9e3779b9) >>> 0;
    const chunks = Array.from({ length: Math.ceil(n / CHUNK) }, (_, c) => ({ n: Math.min(CHUNK, n - c * CHUNK), seed: (seed + Math.imul(c, 0x85ebca6b)) >>> 0 }));
    const rows = chunks.map((chunk) => new Promise<number[][]>((resolve, reject) => this.queue.push({ job: { state, me, myLog, commands, ...chunk }, wanted, resolve, reject })));
    this.pump();
    return (await Promise.all(rows)).flat();
  }

  /** Chunks from the queue to the workers with room: those still wanted; the others dropped (Superseded). */
  private pump(): void {
    for (const worker of this.workers) {
      let held = [...this.waiting.values()].filter((w) => w.worker === worker).length;
      while (held < PER_WORKER && this.queue.length > 0) {
        const next = this.queue.shift()!;
        if (!next.wanted()) {
          next.reject(new Superseded());
          continue;
        }
        this.run(worker, next);
        held++;
      }
    }
  }

  private run(worker: Worker, { job, resolve, reject }: Queued): void {
    const id = ++this.id;
    const timer = setTimeout(() => this.lose(worker, `a search worker took over ${CHUNK_MS / 1000} s on ${job.n} worlds`), CHUNK_MS);
    this.waiting.set(id, { worker, resolve, reject, timer });
    worker.postMessage({ t: 'search', id, job } satisfies SearchWorkerMessage);
  }
}

/** `search` with at most `worlds` worlds per search. */
export const capped = (search: Evaluator, worlds: number): Evaluator => ({ evaluate: (job) => search.evaluate({ ...job, n: Math.min(job.n, worlds) }) });
