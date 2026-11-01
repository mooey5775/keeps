// Worker threads that answer jobs by id: the search pools' (rollout-pool.ts, batch-search.ts). A thread that dies
// (out of memory, a crash outside a job) fails the jobs it had, loudly, and a new one is started for the next job.
import { Worker } from 'node:worker_threads';

type Reply = { id?: number; error?: string; log?: string };

export class Threads<R> {
  private readonly slots: ({ worker: Worker; jobs: Set<number> } | null)[];
  private readonly waiting = new Map<number, { resolve: (reply: R) => void; reject: (e: Error) => void }>();
  private id = 0;
  private closed = false;
  private readonly make: () => Worker;
  private readonly log: (line: string) => void;

  /** `make` starts a thread; `log`, for the lines a thread sends as {log}. */
  constructor(size: number, make: () => Worker, log: (line: string) => void = console.log) {
    this.make = make;
    this.log = log;
    this.slots = Array.from({ length: size }, () => this.start());
  }

  get size(): number {
    return this.slots.length;
  }

  /** Has thread `i` do `job` (sent with an id); its reply, or a failure if it answers {error} or dies first. */
  post(i: number, job: object): Promise<R> {
    if (this.closed) return Promise.reject(new Error('the threads are closed'));
    const slot = (this.slots[i] ??= this.start());
    const id = this.id++;
    return new Promise<R>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      slot.jobs.add(id);
      slot.worker.postMessage({ ...job, id });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map((s) => s?.worker.terminate()));
  }

  private start(): { worker: Worker; jobs: Set<number> } {
    const worker = this.make();
    const slot = { worker, jobs: new Set<number>() };
    let crash: Error | null = null;
    worker.on('message', (m: R & Reply) => {
      if (m.log !== undefined) return this.log(m.log);
      const job = this.waiting.get(m.id!);
      this.waiting.delete(m.id!);
      slot.jobs.delete(m.id!);
      if (m.error !== undefined) job?.reject(new Error(m.error));
      else job?.resolve(m);
    });
    worker.on('error', (error: Error) => (crash = error));
    worker.on('exit', (code) => {
      const i = this.slots.indexOf(slot);
      if (i >= 0) this.slots[i] = null;
      if (this.closed) return;
      const why = new Error(`a search thread died (exit code ${code})${crash ? `: ${crash.stack ?? crash.message}` : ''}`);
      console.error(why.message);
      for (const id of slot.jobs) {
        this.waiting.get(id)?.reject(why);
        this.waiting.delete(id);
      }
    });
    return slot;
  }
}
