// The search's worker pool (search-pool.ts) when a worker goes wrong or the phone sleeps, with workers the test answers
// for, on fake timers: a worker gone quiet is replaced, and its place takes no work until the new one is ready; a phone
// locked mid-search (the page suspended, its clock running on) loses no worker.
//   pnpm -C ios/core test
import type { ReviewJob, ReviewResult } from '@keeps/bot/review/jobs.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awakeTimeout } from '../awake.ts';
import { WorkerSearch } from '../search-pool.ts';
import type { SearchWorkerMessage, SearchWorkerReply } from '../search-worker.ts';

/** A worker that answers its init (unless told to wait) and holds every job until the test answers it. */
class FakeWorker {
  onmessage: ((e: MessageEvent<SearchWorkerReply>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  received: SearchWorkerMessage[] = [];
  terminated = false;
  private ready: () => void = () => {};

  constructor(answerInit: boolean) {
    if (!answerInit) return;
    this.ready = () => this.reply({ t: 'ready' });
  }

  postMessage(m: SearchWorkerMessage): void {
    if (this.terminated) throw new Error('posted to a terminated worker');
    this.received.push(m);
    if (m.t === 'init') void Promise.resolve().then(() => this.ready());
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Its init answered now (a worker made to wait). */
  becomeReady(): void {
    this.reply({ t: 'ready' });
  }

  /** The last job sent to it, answered. */
  answer(result: unknown): void {
    const job = this.received.findLast((m) => m.t === 'review')! as Extract<SearchWorkerMessage, { t: 'review' }>;
    this.reply({ t: 'review', id: job.id, result: result as ReviewResult });
  }

  jobs(): number {
    return this.received.filter((m) => m.t !== 'init').length;
  }

  private reply(m: SearchWorkerReply): void {
    this.onmessage?.({ data: m } as MessageEvent<SearchWorkerReply>);
  }
}

const job = {} as ReviewJob;
/**
 * The page suspended for `ms` (the phone locked), then woken: its clock jumps, and each timer that came due meanwhile
 * fires once, late, as WebKit's do on waking (the fake clock's jump).
 */
const suspend = (ms: number) => (setTimeout as unknown as { clock: { jump(ms: number): void } }).clock.jump(ms);
const flush = () => new Promise<void>((r) => queueMicrotask(r)).then(() => new Promise<void>((r) => queueMicrotask(r)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('awakeTimeout', () => {
  it('counts time the page runs, not time it was suspended', () => {
    const fired = vi.fn();
    awakeTimeout(10_000, fired);
    vi.advanceTimersByTime(6000);
    // Locked for ten minutes: waking counts as one look at the clock (a second), not as the ten minutes.
    suspend(600_000);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled', () => {
    const fired = vi.fn();
    awakeTimeout(2000, fired)();
    vi.advanceTimersByTime(10_000);
    expect(fired).not.toHaveBeenCalled();
  });
});

describe('the search pool', () => {
  it('loses no worker to a phone locked mid-job: the job goes on and is answered', async () => {
    const workers: FakeWorker[] = [];
    const pool = await WorkerSearch.start(1, new ArrayBuffer(0), () => workers[workers.push(new FakeWorker(true)) - 1] as unknown as Worker);
    const result = pool.review(job);
    expect(workers[0]!.jobs()).toBe(1);
    vi.advanceTimersByTime(30_000);
    suspend(30 * 60_000); // locked for half an hour
    vi.advanceTimersByTime(1000);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
    workers[0]!.answer('reviewed');
    await expect(result).resolves.toBe('reviewed');
  });

  it("replaces a worker gone quiet, its job failed, and gives its place no work until the new one's ready", async () => {
    const workers: FakeWorker[] = [];
    // The first worker starts at once; its replacement takes its time.
    const make = () => workers[workers.push(new FakeWorker(workers.length === 0)) - 1] as unknown as Worker;
    const pool = await WorkerSearch.start(1, new ArrayBuffer(0), make);
    const stuck = pool.review(job);
    const failed = expect(stuck).rejects.toThrow(/took over 120 s/);
    vi.advanceTimersByTime(121_000);
    await failed;
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    // Work that comes while the replacement starts waits for it (sent to the old worker, it would never be answered).
    const next = pool.review(job);
    await flush();
    expect(workers[0]!.jobs()).toBe(1);
    expect(workers[1]!.jobs()).toBe(0);
    workers[1]!.becomeReady();
    await flush();
    expect(workers[1]!.jobs()).toBe(1);
    workers[1]!.answer('reviewed');
    await expect(next).resolves.toBe('reviewed');
  });
});
