// Search and review work done on another machine (gpu03), which this server can't reach: it asks for work.
// The remote worker (worker.ts) long-polls POST /remote/poll (Authorization: Bearer <REMOTE_TOKEN>, body {accept:
// kinds it has room for}) and is handed at most one job, which it answers at /remote/result. The live game's
// searches go before reviews; a job whose result is no longer wanted (its position has passed) is dropped before
// it's handed out.
//
// How it fails, and what's done (RemoteEvaluator; ReviewPool for reviews):
// - no worker connected (RemoteAway): the work is done here if this server searches; if not (LOCAL_SEARCH=off), the
//   bot waits for the worker and the table is told. That's no bug: the machine is away.
// - the worker answered with an error, or a result of the wrong shape, or took far longer than a search takes while
//   connected (RemoteFailed): a bug, or the wrong network on the worker. It's logged and counted (the admin page
//   shows it), and the search is done here, or the bot plays its network's own move.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Superseded, type EvaluateJob, type Evaluator } from '../search/search.ts';
import { throttled } from '../throttled.ts';

export type RemoteKind = 'search' | 'review';

interface Job {
  id: number;
  kind: RemoteKind;
  payload: unknown;
  /** Whether it's still wanted: one that isn't is dropped before it's handed out (Superseded). */
  wanted: () => boolean;
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
/** The largest request a worker may send (a review's results are the largest: well under this). */
const BODY_LIMIT = 16 * 1024 * 1024;

/** No remote worker is connected. */
export class RemoteAway extends Error {}

/** The remote worker failed a job: it answered with an error or a malformed result, or never answered. A bug. */
export class RemoteFailed extends Error {}

export class RemoteQueue {
  private queue: Job[] = [];
  private inFlight = new Map<number, Job>();
  private pollers: Poller[] = [];
  private lastSeen = 0;
  private next = 1;
  /** Called on every poll (work waiting for the remote, such as reviews, can go now). */
  onPoll: (() => void) | null = null;
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

  /** Failures counted since the server started (the admin page shows them), by kind. */
  readonly failures: Record<RemoteKind, number> = { search: 0, review: 0 };

  /**
   * Has the remote do a job. Fails with RemoteAway if no worker is connected (or none takes it in time), RemoteFailed
   * if the worker fails it, answers what `check` throws for (RemoteFailed: the result isn't of the shape it must be),
   * or doesn't answer within `timeoutMs` once it has it, and Superseded if it's no longer `wanted` when its turn comes.
   */
  submit<T>(
    kind: RemoteKind,
    payload: unknown,
    timeoutMs: number,
    { wanted = () => true, check = (result) => result as T }: { wanted?: () => boolean; check?: (result: unknown) => T } = {},
  ): Promise<T> {
    if (!this.connected()) return Promise.reject(new RemoteAway('no remote worker is connected'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id: this.next++,
        kind,
        payload,
        wanted,
        resolve: (result) => {
          try {
            resolve(check(result));
          } catch (error) {
            job.reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject: (error) => {
          if (error instanceof RemoteFailed) this.fail(kind, error);
          reject(error);
        },
        timer: setTimeout(() => {
          const taken = this.inFlight.delete(job.id);
          this.queue = this.queue.filter((j) => j !== job);
          job.reject(taken ? new RemoteFailed(`the remote ${kind} took over ${timeoutMs / 1000} s`) : new RemoteAway(`no remote worker took the ${kind} in ${timeoutMs / 1000} s`));
        }, timeoutMs),
      };
      // Searches go before reviews: the live game waits on them.
      const at = kind === 'search' ? this.queue.findIndex((j) => j.kind !== 'search') : -1;
      if (at < 0) this.queue.push(job);
      else this.queue.splice(at, 0, job);
      this.dispatch();
    });
  }

  private readonly report = throttled();

  /** A failure, counted and logged. */
  private fail(kind: RemoteKind, error: Error): void {
    this.failures[kind]++;
    this.report(`remote ${kind} failed (${this.failures[kind]} so far): ${error.message}`);
  }

  /** Whether `header` is this queue's token (compared in constant time). */
  private authorized(header: string | undefined): boolean {
    const given = Buffer.from(header ?? '');
    const wanted = Buffer.from(`Bearer ${this.token}`);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  /** Routes /remote/poll and /remote/result; false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (path !== '/remote/poll' && path !== '/remote/result') return false;
    if (req.method !== 'POST' || !this.authorized(req.headers.authorization)) {
      res.writeHead(401).end();
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        res.writeHead(413).end();
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body: { accept?: RemoteKind[]; id?: number; result?: unknown; error?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400).end();
        return;
      }
      this.lastSeen = Date.now();
      if (path === '/remote/result') return this.answer(res, body);
      // (A worker offering to take nothing would only look connected.)
      const accept = new Set((body.accept ?? []).filter((k): k is RemoteKind => k === 'search' || k === 'review'));
      if (accept.size === 0) {
        res.writeHead(400).end();
        return;
      }
      this.poll(res, accept);
      this.onPoll?.();
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
    if (body.error !== undefined) job.reject(new RemoteFailed(`the worker: ${body.error}`));
    else job.resolve(body.result);
  }

  /** Hands queued jobs to waiting pollers that accept their kind (dropping those no longer wanted). */
  private dispatch(): void {
    for (const job of this.queue.filter((j) => !j.wanted())) {
      this.queue = this.queue.filter((j) => j !== job);
      clearTimeout(job.timer);
      job.reject(new Superseded());
    }
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

/**
 * The search's evaluations on the remote (with its own, larger number of worlds), or here when it's away or fails
 * (if this server searches). A result is checked for its shape: a row per world, a value per command.
 */
export class RemoteEvaluator implements Evaluator {
  private readonly remote: RemoteQueue;
  private readonly local: Evaluator | null;
  private readonly worlds: number;

  constructor(remote: RemoteQueue, local: Evaluator | null, worlds: number) {
    this.remote = remote;
    this.local = local;
    this.worlds = worlds;
  }

  async evaluate(job: EvaluateJob): Promise<number[][]> {
    if (this.remote.connected()) {
      try {
        const { wanted, ...payload } = job;
        return await this.remote.submit('search', { ...payload, n: this.worlds }, 120_000, {
          ...(wanted ? { wanted } : {}),
          check: (rows) => checked(rows, this.worlds, job.commands.length),
        });
      } catch (error) {
        if (error instanceof Superseded) throw error;
        if (!this.local) throw error;
        // (A failure is logged and counted by the queue; the search goes on here.)
      }
    }
    if (!this.local) throw new RemoteAway('no remote worker is connected');
    return this.local.evaluate(job);
  }
}

/** A search's result, if it's `worlds` rows of `commands` numbers each; RemoteFailed if it isn't. */
function checked(rows: unknown, worlds: number, commands: number): number[][] {
  const ok =
    Array.isArray(rows) &&
    rows.length === worlds &&
    rows.every((row) => Array.isArray(row) && row.length === commands && row.every((v) => typeof v === 'number' && Number.isFinite(v)));
  if (!ok) throw new RemoteFailed(`the worker's search result isn't ${worlds} rows of ${commands} numbers`);
  return rows as number[][];
}
