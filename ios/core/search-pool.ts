// The app's search: an Evaluator (packages/bot/src/search/search.ts) over Web Workers (search-worker.ts), the network
// in Core ML. A search's worlds go out in chunks, each with its own seed, to whichever worker has room (two at a time
// each, so a worker always has playouts to batch): fast cores take more chunks than slow ones, so no worker count or
// split needs tuning to a device, and the results come back in chunk order, the same whoever ran them.
//
// Every search's chunks wait in one queue, so however many searches are under way (Midstrike's, and training mode's
// advice for each of your decisions), the workers hold only so many chunks at once: the page's memory is bounded (all
// at once, they took more than WebKit allows a page, and it ended the page's process). A chunk whose search is no
// longer wanted (its position has passed) is dropped, not played.
//
// The round review's jobs (review-jobs.ts) go to the same workers, but only when no search is waiting, and at most one
// a worker: the live game always comes first.
//
// A worker that takes too long is taken for stuck, its work failed, and it's replaced; its place takes no work until
// the new worker is ready (work sent to the old one would never be answered). Too long is counted in time the app runs
// (awake.ts): a phone locked mid-search pauses the workers, it doesn't make them stuck.
import type { ReviewJob, ReviewResult } from '@keeps/bot/review/jobs.ts';
import { Superseded, type EvaluateJob, type WorldsPool } from '@keeps/bot/search/search.ts';
import { awakeTimeout } from './awake.ts';
import type { SearchWorkerMessage, SearchWorkerReply } from './search-worker.ts';

/**
 * Playouts per chunk (each world plays every candidate move): enough for a worker to batch, and about the same work
 * whatever the decision. Worlds per chunk follow from it: 64 at four candidate moves, 5 at Providence's 46 pairs.
 * (A chunk of 64 worlds whatever the decision made a 46-move one's chunks eleven times the work, past the watchdog.)
 */
const CHUNK_PLAYOUTS = 256;
/** Worlds per chunk, at most. */
const CHUNK_WORLDS = 64;

/** How long a worker may take over one chunk before it's taken for stuck: replaced, and its chunk failed. */
const CHUNK_MS = 90_000;
/** Chunks a worker holds at once: two, so it always has playouts to batch while the other's wait on the network. */
const PER_WORKER = 2;
/** How long a worker may take over one review job (a few dozen playouts) before it's taken for stuck. */
const REVIEW_MS = 120_000;

type ChunkJob = Extract<SearchWorkerMessage, { t: 'search' }>['job'];
interface Queued {
  job: ChunkJob;
  wanted: () => boolean;
  resolve: (rows: number[][]) => void;
  reject: (e: Error) => void;
}
interface QueuedReview {
  job: ReviewJob;
  resolve: (result: ReviewResult) => void;
  reject: (e: Error) => void;
}

/** A search worker, as the pool starts it (a Web Worker running search-worker.ts; tests give their own). */
export type MakeWorker = () => Worker;
const searchWorker: MakeWorker = () => new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });

export class WorkerSearch implements WorldsPool {
  /** The workers; null where one was lost and its replacement isn't ready yet. */
  private readonly workers: (Worker | null)[] = [];
  /** Each chunk sent and not yet answered: its worker, and what to tell its search. */
  private readonly waiting = new Map<
    number,
    { worker: Worker; review: boolean; resolve: (answer: never) => void; reject: (e: Error) => void; cancel: () => void }
  >();
  private id = 0;
  private seed = (Math.random() * 2 ** 32) >>> 0;
  private weights: ArrayBuffer = new ArrayBuffer(0);
  /** Chunks waiting for a worker, every search's, in the order asked. */
  private readonly queue: Queued[] = [];
  /** Review jobs waiting: taken only when no chunk is. */
  private readonly reviews: QueuedReview[] = [];

  private readonly make: MakeWorker;

  private constructor(make: MakeWorker) {
    this.make = make;
  }

  /** `count` workers, each with the network's weights (for its policy's sampling; Core ML runs the network). */
  static async start(count: number, weights: ArrayBuffer, make: MakeWorker = searchWorker): Promise<WorkerSearch> {
    const pool = new WorkerSearch(make);
    pool.weights = weights;
    pool.workers.push(...(await Promise.all(Array.from({ length: count }, () => pool.spawn()))));
    return pool;
  }

  /** A worker, ready (its weights loaded). */
  private spawn(): Promise<Worker> {
    const w = this.make();
    return new Promise<Worker>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<SearchWorkerReply>) => {
        const m = e.data;
        if (m.t === 'ready') return resolve(w);
        if (m.t === 'error' && m.id === undefined) return reject(new Error(m.message));
        const job = this.waiting.get(m.id!);
        if (!job) return;
        this.waiting.delete(m.id!);
        job.cancel();
        if (m.t === 'error') job.reject(new Error(m.message));
        else (job.resolve as (answer: unknown) => void)(m.t === 'search' ? m.rows : m.result);
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

  /** `worker` is gone: its chunks fail with `why`, and a new worker takes its place (none meanwhile). */
  private lose(worker: Worker, why: string): void {
    const at = this.workers.indexOf(worker);
    if (at < 0) return;
    console.error(why);
    worker.terminate();
    this.workers[at] = null;
    for (const [id, job] of this.waiting) {
      if (job.worker !== worker) continue;
      this.waiting.delete(id);
      job.cancel();
      job.reject(new Error(why));
    }
    this.replace(at);
  }

  /** A new worker in place `at`; if it can't start, another try a little later (the place stays empty meanwhile). */
  private replace(at: number): void {
    this.spawn().then(
      (fresh) => {
        this.workers[at] = fresh;
        this.pump();
      },
      (error: unknown) => {
        console.error(`a search worker couldn't be replaced: ${error instanceof Error ? error.message : String(error)}`);
        setTimeout(() => this.replace(at), 5000);
      },
    );
  }

  get size(): number {
    return this.workers.length;
  }

  async evaluate(job: EvaluateJob & { n: number }): Promise<number[][]> {
    const { state, me, myLog, commands, n, wanted = () => true } = job;
    const seed = this.seed;
    this.seed = (this.seed + 0x9e3779b9) >>> 0;
    const per = Math.max(1, Math.min(CHUNK_WORLDS, Math.floor(CHUNK_PLAYOUTS / Math.max(1, commands.length))));
    const chunks = Array.from({ length: Math.ceil(n / per) }, (_, c) => ({ n: Math.min(per, n - c * per), seed: (seed + Math.imul(c, 0x85ebca6b)) >>> 0 }));
    const rows = chunks.map((chunk) => new Promise<number[][]>((resolve, reject) => this.queue.push({ job: { state, me, myLog, commands, ...chunk }, wanted, resolve, reject })));
    this.pump();
    return (await Promise.all(rows)).flat();
  }

  /** A review job, played on the workers when the live game leaves them room (review-jobs.ts queues them). */
  review(job: ReviewJob): Promise<ReviewResult> {
    const result = new Promise<ReviewResult>((resolve, reject) => this.reviews.push({ job, resolve, reject }));
    this.pump();
    return result;
  }

  /**
   * Chunks from the queue to the workers with room: those still wanted; the others dropped (Superseded). Then, with no
   * chunk waiting, review jobs: one a worker at most, so a search that comes finds room.
   */
  private pump(): void {
    for (const worker of this.workers) {
      if (!worker) continue;
      const mine = [...this.waiting.values()].filter((w) => w.worker === worker);
      let held = mine.length;
      while (held < PER_WORKER && this.queue.length > 0) {
        const next = this.queue.shift()!;
        if (!next.wanted()) {
          next.reject(new Superseded());
          continue;
        }
        this.run(worker, next);
        held++;
      }
      if (held < PER_WORKER && this.queue.length === 0 && this.reviews.length > 0 && !mine.some((w) => w.review)) {
        const next = this.reviews.shift()!;
        const id = ++this.id;
        const cancel = awakeTimeout(REVIEW_MS, () => this.lose(worker, `a search worker took over ${REVIEW_MS / 1000} s on a review job`));
        this.waiting.set(id, { worker, review: true, resolve: next.resolve as (answer: never) => void, reject: next.reject, cancel });
        worker.postMessage({ t: 'review', id, job: next.job } satisfies SearchWorkerMessage);
      }
    }
  }

  private run(worker: Worker, { job, resolve, reject }: Queued): void {
    const id = ++this.id;
    const cancel = awakeTimeout(CHUNK_MS, () => this.lose(worker, `a search worker took over ${CHUNK_MS / 1000} s on ${job.n} worlds`));
    this.waiting.set(id, { worker, review: false, resolve: resolve as (answer: never) => void, reject, cancel });
    worker.postMessage({ t: 'search', id, job } satisfies SearchWorkerMessage);
  }
}

