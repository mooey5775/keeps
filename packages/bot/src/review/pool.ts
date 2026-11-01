// The review's jobs in Node worker processes at nice 19 (review-worker.ts), or on a remote worker when one is
// connected (remote.ts): Node only. review.ts holds the review itself, which takes any ReviewJobs.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { RemoteQueue } from '../remote/remote.ts';
import type { ReviewJobs } from './review.ts';
import type { ReviewJob, ReviewResult } from './jobs.ts';

interface Task {
  id: number;
  group: string;
  /** The round it's for (work for one round can be set aside). */
  tag: number;
  /** What it estimates (work for one estimate can be dropped once the live game has it). */
  key: string | null;
  job: ReviewJob;
  done: (result: ReviewResult | null) => void;
  cancelled: boolean;
}

/**
 * Worker processes at nice 19, started when first needed. Jobs are queued by group (a game) and taken in turn
 * across groups. With a remote worker connected (remote.ts), jobs go there instead, `remoteSlots` at a time;
 * one it fails goes back in the queue for the local workers, and the remote is left alone for a minute.
 */
export class ReviewPool implements ReviewJobs {
  remote: RemoteQueue | null = null;
  remoteSlots = 16;
  private remoteRunning = 0;
  private remoteTasks = new Set<Task>();
  private remoteAwayUntil = 0;
  private workers: { child: ChildProcess; task: Task | null }[] = [];
  private queues = new Map<string, Task[]>();
  private turn: string[] = [];
  private next = 0;
  private errors = 0;

  private readonly size: number;
  private readonly weights: string;

  constructor(size: number, weights: string) {
    this.size = size;
    this.weights = weights;
  }

  submit(group: string, tag: number, job: ReviewJob, done: (result: ReviewResult | null) => void, key: string | null = null): void {
    const task: Task = { id: this.next++, group, tag, key, job, done, cancelled: false };
    if (!this.queues.has(group)) {
      this.queues.set(group, []);
      this.turn.push(group);
    }
    this.queues.get(group)!.push(task);
    if (!this.useRemote()) this.start();
    this.pump();
  }

  /** Hands queued jobs out again (the remote is back: RemoteQueue.onPoll). */
  kick(): void {
    this.pump();
  }

  private useRemote(): boolean {
    return this.remote !== null && this.remote.connected() && Date.now() > this.remoteAwayUntil;
  }

  /** Drops the group's queued jobs; its running ones finish, unheard. */
  cancel(group: string): number {
    const dropped = this.queues.get(group)?.length ?? 0;
    this.queues.delete(group);
    this.turn = this.turn.filter((g) => g !== group);
    for (const w of this.workers) if (w.task?.group === group) w.task.cancelled = true;
    for (const t of this.remoteTasks) if (t.group === group) t.cancelled = true;
    return dropped;
  }

  /** Takes the group's queued jobs for one round out of the queue (to submit again later); running ones finish. */
  setAside(group: string, tag: number): { job: ReviewJob; done: (result: ReviewResult | null) => void }[] {
    const queue = this.queues.get(group);
    if (!queue) return [];
    const out = queue.filter((t) => t.tag === tag);
    this.queues.set(group, queue.filter((t) => t.tag !== tag));
    return out.map((t) => ({ job: t.job, done: t.done }));
  }

  /** Drops the group's queued jobs for one estimate (the live game worked it out); running ones finish. How many were dropped. */
  drop(group: string, key: string): number {
    const queue = this.queues.get(group);
    if (!queue) return 0;
    const keep = queue.filter((t) => t.key !== key);
    this.queues.set(group, keep);
    return queue.length - keep.length;
  }

  /** Jobs queued or running (here and remotely), for the status page and tests. */
  load(): { queued: number; running: number; workers: number; remote: number } {
    return {
      queued: [...this.queues.values()].reduce((a, q) => a + q.length, 0),
      running: this.workers.filter((w) => w.task).length + this.remoteRunning,
      workers: this.workers.length,
      remote: this.remoteRunning,
    };
  }

  /** Worker process ids (to check their priority). */
  pids(): number[] {
    return this.workers.flatMap((w) => (w.child.pid ? [w.child.pid] : []));
  }

  close(): void {
    for (const w of this.workers) w.child.kill();
    this.workers = [];
  }

  private start(): void {
    while (this.workers.length < this.size) this.spawn();
  }

  private spawn(): void {
    // `nice` sets the priority before node starts, so every thread of the worker has it.
    const child = spawn('nice', ['-n', '19', process.execPath, join(import.meta.dirname, 'worker.ts'), this.weights], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const worker = { child, task: null as Task | null };
    this.workers.push(worker);
    child.on('message', (m: { id: number; result?: ReviewResult; error?: string }) => {
      const task = worker.task;
      worker.task = null;
      if (task && task.id === m.id && !task.cancelled) {
        if (m.error && this.errors++ < 20) console.error(`review: a job failed: ${m.error}`);
        task.done(m.result ?? null);
      }
      this.pump();
    });
    child.on('exit', () => {
      // A worker that dies (out of memory, killed) is replaced; its job counts as failed.
      this.workers = this.workers.filter((w) => w !== worker);
      if (worker.task && !worker.task.cancelled) worker.task.done(null);
      if (this.queues.size) this.start();
      this.pump();
    });
  }

  private pump(): void {
    while (this.useRemote() && this.remoteRunning < this.remoteSlots) {
      const task = this.take();
      if (!task) return;
      this.remoteRunning++;
      this.remoteTasks.add(task);
      this.remote!.submit<ReviewResult>('review', task.job, 15 * 60_000).then(
        (result) => {
          if (!task.cancelled) task.done(result);
        },
        (error: unknown) => {
          if (this.errors++ < 20) console.error(`review: the remote failed a job (${error instanceof Error ? error.message : error}); doing it here`);
          this.remoteAwayUntil = Date.now() + 60_000;
          if (task.cancelled) return;
          // Back to the front of its game's queue, for the local workers.
          if (!this.queues.has(task.group)) {
            this.queues.set(task.group, []);
            this.turn.push(task.group);
          }
          this.queues.get(task.group)!.unshift(task);
          this.start();
        },
      ).finally(() => {
        this.remoteRunning--;
        this.remoteTasks.delete(task);
        this.pump();
      });
    }
    for (const worker of this.workers) {
      if (worker.task || !worker.child.connected) continue;
      const task = this.take();
      if (!task) return;
      worker.task = task;
      worker.child.send({ id: task.id, job: task.job });
    }
  }

  /** The next job, taking groups in turn. */
  private take(): Task | null {
    for (let i = 0; i < this.turn.length; i++) {
      const group = this.turn.shift()!;
      this.turn.push(group);
      const queue = this.queues.get(group)!;
      const task = queue.shift();
      if (!queue.length) {
        this.queues.delete(group);
        this.turn = this.turn.filter((g) => g !== group);
      }
      if (task) return task;
    }
    return null;
  }
}

