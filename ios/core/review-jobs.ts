// The round review's jobs on the phone (packages/bot/src/review): queued here, by game and round, and handed to the
// search's workers (search-pool.ts) a few at a time, so they play only when the live game leaves the workers room.
// A game that ends, or a round set aside (you left the table), drops its queued jobs; one already playing finishes,
// unheard.
import type { ReviewJob, ReviewResult } from '@keeps/bot/review/jobs.ts';
import type { ReviewJobs } from '@keeps/bot/review/review.ts';
import type { WorkerSearch } from './search-pool.ts';

interface Task {
  group: string;
  tag: number;
  key: string | null;
  job: ReviewJob;
  done: (result: ReviewResult | null) => void;
  cancelled: boolean;
}

export class PhoneReviews implements ReviewJobs {
  private queue: Task[] = [];
  private readonly running = new Set<Task>();
  private readonly search: WorkerSearch;

  constructor(search: WorkerSearch) {
    this.search = search;
  }

  submit(group: string, tag: number, job: ReviewJob, done: (result: ReviewResult | null) => void, key: string | null = null): void {
    this.queue.push({ group, tag, key, job, done, cancelled: false });
    this.pump();
  }

  cancel(group: string): number {
    const dropped = this.queue.filter((t) => t.group === group).length;
    this.queue = this.queue.filter((t) => t.group !== group);
    for (const t of this.running) if (t.group === group) t.cancelled = true;
    return dropped;
  }

  setAside(group: string, tag: number): { job: ReviewJob; done: (result: ReviewResult | null) => void }[] {
    const aside = this.queue.filter((t) => t.group === group && t.tag === tag);
    this.queue = this.queue.filter((t) => !aside.includes(t));
    return aside.map(({ job, done }) => ({ job, done }));
  }

  drop(group: string, key: string): number {
    const dropped = this.queue.filter((t) => t.group === group && t.key === key).length;
    this.queue = this.queue.filter((t) => !(t.group === group && t.key === key));
    return dropped;
  }

  /** Jobs to the workers, one a worker at most (the search pool holds them behind any search). */
  private pump(): void {
    while (this.running.size < this.search.size && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running.add(task);
      this.search.review(task.job).then(
        (result) => {
          if (!task.cancelled) task.done(result);
        },
        (error: unknown) => {
          // (A job that fails counts as done with nothing, as the website's review pool has it: the review goes on.)
          console.error(`review: a job failed: ${error instanceof Error ? error.message : String(error)}`);
          if (!task.cancelled) task.done(null);
        },
      ).finally(() => {
        this.running.delete(task);
        this.pump();
      });
    }
  }
}
