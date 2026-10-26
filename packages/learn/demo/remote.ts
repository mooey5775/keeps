// Search and review work done on another machine (gpu03), which this server can't reach: it asks for work.
// The remote worker (remote-worker.ts) long-polls POST /remote/poll (Authorization: Bearer <REMOTE_TOKEN>,
// body {accept: kinds it has room for}) and is handed at most one job, which it answers at /remote/result.
// The live game's searches go before reviews. Work the remote doesn't take or answer in time is done here
// (RemoteEvaluator falls back to the local search; ReviewPool to its local workers), so a game never waits
// on the other machine.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EvaluateJob, Evaluator } from './search-bot.ts';

export type RemoteKind = 'search' | 'review';

interface Job {
  id: number;
  kind: RemoteKind;
  payload: unknown;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Poller {
  res: ServerResponse;
  accept: Set<RemoteKind>;
  timer: ReturnType<typeof setTimeout>;
}

const POLL_MS = 25_000;

export class RemoteQueue {
  private queue: Job[] = [];
  private inFlight = new Map<number, Job>();
  private pollers: Poller[] = [];
  private lastSeen = 0;
  private next = 1;
  private readonly token: string;
  /** The network's identity (step and encoder): the remote must run the same one. */
  readonly stamp: string;

  constructor(token: string, stamp: string) {
    this.token = token;
    this.stamp = stamp;
  }

  /** A remote worker asked for work lately. */
  connected(): boolean {
    return this.pollers.length > 0 || Date.now() - this.lastSeen < POLL_MS + 15_000;
  }

  /** Jobs waiting for the remote, and being worked on there, by kind (for the status page). */
  load(): Record<RemoteKind, { queued: number; running: number }> {
    const count = (jobs: Iterable<Job>, kind: RemoteKind) => [...jobs].filter((j) => j.kind === kind).length;
    return {
      search: { queued: count(this.queue, 'search'), running: count(this.inFlight.values(), 'search') },
      review: { queued: count(this.queue, 'review'), running: count(this.inFlight.values(), 'review') },
    };
  }

  /** Has the remote do a job; fails if no remote is there, or it doesn't answer within `timeoutMs`. */
  submit<T>(kind: RemoteKind, payload: unknown, timeoutMs: number): Promise<T> {
    if (!this.connected()) return Promise.reject(new Error('no remote worker'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id: this.next++,
        kind,
        payload,
        resolve: resolve as (result: unknown) => void,
        reject,
        timer: setTimeout(() => {
          this.queue = this.queue.filter((j) => j !== job);
          this.inFlight.delete(job.id);
          reject(new Error(`the remote ${kind} took over ${timeoutMs / 1000} s`));
        }, timeoutMs),
      };
      // Searches go before reviews: the live game waits on them.
      const at = kind === 'search' ? this.queue.findIndex((j) => j.kind !== 'search') : -1;
      if (at < 0) this.queue.push(job);
      else this.queue.splice(at, 0, job);
      this.dispatch();
    });
  }

  /** Routes /remote/poll and /remote/result; false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (path !== '/remote/poll' && path !== '/remote/result') return false;
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return true;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: { accept?: RemoteKind[]; id?: number; result?: unknown; error?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400).end();
        return;
      }
      this.lastSeen = Date.now();
      if (path === '/remote/poll') this.poll(res, new Set(body.accept ?? []));
      else this.answer(res, body);
    });
    return true;
  }

  private poll(res: ServerResponse, accept: Set<RemoteKind>): void {
    const poller: Poller = {
      res,
      accept,
      timer: setTimeout(() => {
        this.pollers = this.pollers.filter((p) => p !== poller);
        if (!res.writableEnded) res.writeHead(204).end();
      }, POLL_MS),
    };
    res.on('close', () => {
      clearTimeout(poller.timer);
      this.pollers = this.pollers.filter((p) => p !== poller);
    });
    this.pollers.push(poller);
    this.dispatch();
  }

  private answer(res: ServerResponse, body: { id?: number; result?: unknown; error?: string }): void {
    res.writeHead(200).end();
    const job = this.inFlight.get(body.id ?? -1);
    if (!job) return; // timed out already: done here instead
    this.inFlight.delete(job.id);
    clearTimeout(job.timer);
    if (body.error !== undefined) job.reject(new Error(`remote ${job.kind}: ${body.error}`));
    else job.resolve(body.result);
  }

  /** Hands queued jobs to waiting pollers that accept their kind. */
  private dispatch(): void {
    for (const poller of [...this.pollers]) {
      const at = this.queue.findIndex((j) => poller.accept.has(j.kind));
      if (at < 0) continue;
      const [job] = this.queue.splice(at, 1);
      this.pollers = this.pollers.filter((p) => p !== poller);
      clearTimeout(poller.timer);
      if (poller.res.writableEnded || poller.res.destroyed) {
        this.queue.unshift(job!);
        continue;
      }
      this.inFlight.set(job!.id, job!);
      poller.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: job!.id, kind: job!.kind, stamp: this.stamp, payload: job!.payload }));
    }
  }
}

/** The search's evaluations on the remote (with its own, larger number of worlds), or here when it's away or slow. */
export class RemoteEvaluator implements Evaluator {
  private readonly remote: RemoteQueue;
  private readonly local: Evaluator;
  private readonly worlds: number;
  private failures = 0;

  constructor(remote: RemoteQueue, local: Evaluator, worlds: number) {
    this.remote = remote;
    this.local = local;
    this.worlds = worlds;
  }

  async evaluate(job: EvaluateJob): Promise<number[][]> {
    if (this.remote.connected()) {
      try {
        return await this.remote.submit<number[][]>('search', { ...job, n: this.worlds }, 120_000);
      } catch (error) {
        if (this.failures++ < 50) console.error(`remote search failed (${error instanceof Error ? error.message : error}); searching here with ${job.n} worlds`);
      }
    }
    return this.local.evaluate(job);
  }
}
