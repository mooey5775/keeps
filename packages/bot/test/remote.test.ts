// The remote queue (remote/remote.ts): a worker that can't be reached asks for work over HTTP and answers it.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteAway, RemoteEvaluator, RemoteFailed, RemoteQueue } from '../src/remote/remote.ts';
import { Superseded, type EvaluateJob, type Evaluator } from '../src/search/search.ts';

let server: Server | null = null;

async function serve(queue: RemoteQueue): Promise<string> {
  server = createServer((req, res) => {
    if (!queue.handle(req, res, new URL(req.url ?? '/', 'http://x').pathname)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const post = (url: string, path: string, body: unknown, token = 'secret') =>
  fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
/** A worker's poll, waiting (the queue counts the worker as connected): `job`, what it's handed. */
async function waitingWorker(url: string, accept = ['search']) {
  const job = post(url, '/remote/poll', { accept }).then((r) => r.json() as Promise<{ id: number; payload: unknown }>);
  await tick();
  return { job };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe('the remote queue', () => {
  it('refuses a worker without the token', async () => {
    const url = await serve(new RemoteQueue('secret', '1:abc'));
    expect((await post(url, '/remote/poll', { accept: ['search'] }, 'wrong')).status).toBe(401);
  });

  it('hands searches out before reviews, and takes the answers back', async () => {
    const queue = new RemoteQueue('secret', '1:abc');
    const url = await serve(queue);
    // A worker asks first (so the queue knows one is there), and gets nothing for a moment.
    const first = post(url, '/remote/poll', { accept: ['search', 'review'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(queue.connected()).toBe(true);
    const review = queue.submit<string>('review', { r: 1 }, 5_000);
    const search = queue.submit<string>('search', { s: 1 }, 5_000);
    const a = (await (await first).json()) as { id: number };
    // The review was queued first and handed to the waiting poller; the search goes next, ahead of any other review.
    expect(a).toMatchObject({ kind: 'review', stamp: '1:abc', payload: { r: 1 } });
    const later = queue.submit<string>('review', { r: 2 }, 5_000).catch((e: Error) => e.message);
    const b = (await (await post(url, '/remote/poll', { accept: ['search', 'review'] })).json()) as { id: number };
    expect(b).toMatchObject({ kind: 'search', payload: { s: 1 } });
    await post(url, '/remote/result', { id: b.id, result: 'searched' });
    await post(url, '/remote/result', { id: a.id, result: 'reviewed' });
    expect(await search).toBe('searched');
    expect(await review).toBe('reviewed');
    // A worker that only takes searches isn't handed the review.
    const c = post(url, '/remote/poll', { accept: ['search'] }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    expect(queue.load().review.queued).toBe(1);
    void c;
    const d = (await (await post(url, '/remote/poll', { accept: ['review'] })).json()) as { id: number };
    await post(url, '/remote/result', { id: d.id, error: 'boom' });
    expect(await later).toContain('boom');
  });

  it('searches here when no worker is there, or when it does not answer in time', async () => {
    const queue = new RemoteQueue('secret', '1:abc');
    const url = await serve(queue);
    const here: EvaluateJob[] = [];
    const local: Evaluator = { evaluate: async (job) => (here.push(job), [[1]]) };
    const job: EvaluateJob = { state: {} as never, me: 0, myLog: [], commands: [], n: 32 };
    const remote = new RemoteEvaluator(queue, local, 512);
    expect(await remote.evaluate(job)).toEqual([[1]]);
    expect(here).toHaveLength(1);
    // Connected, but the search times out: done here too (with this machine's number of worlds).
    const poll = post(url, '/remote/poll', { accept: ['search'] }).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    await expect(queue.submit('search', {}, 100)).rejects.toThrow(RemoteFailed);
    void poll;
  });

  it("tells a machine that's away from a worker that failed: only the failures are counted", async () => {
    const queue = new RemoteQueue('secret', '1:abc');
    const url = await serve(queue);
    await expect(queue.submit('search', {}, 5_000)).rejects.toThrow(RemoteAway);
    const { job } = await waitingWorker(url);
    const failed = queue.submit('search', {}, 5_000).catch((e: unknown) => e);
    await post(url, '/remote/result', { id: (await job).id, error: 'out of memory' });
    expect(await failed).toEqual(new RemoteFailed('the worker: out of memory'));
    expect(await failed).toBeInstanceOf(RemoteFailed);
    expect(queue.failures).toEqual({ search: 1, review: 0 });
  });

  it("drops a job that's no longer wanted before handing it out", async () => {
    const queue = new RemoteQueue('secret', '1:abc');
    const url = await serve(queue);
    const { job: busy } = await waitingWorker(url);
    const first = queue.submit('search', { n: 1 }, 5_000);
    let wanted = true;
    const second = queue.submit('search', { n: 2 }, 5_000, { wanted: () => wanted }).catch((e: unknown) => e);
    wanted = false;
    const job = await busy;
    expect(job.payload).toEqual({ n: 1 });
    // The worker's next poll finds the second gone.
    const next = post(url, '/remote/poll', { accept: ['search'] });
    expect(await second).toBeInstanceOf(Superseded);
    await post(url, '/remote/result', { id: job.id, result: 'done' });
    expect(await first).toBe('done');
    expect(queue.load().search.queued).toBe(0);
    expect(queue.failures.search).toBe(0);
    void next.catch(() => null);
  });

  it('refuses a poll that takes nothing, a body too large, and a token of another length', async () => {
    const url = await serve(new RemoteQueue('secret', '1:abc'));
    expect((await post(url, '/remote/poll', { accept: [] })).status).toBe(400);
    expect((await post(url, '/remote/poll', { accept: ['everything'] })).status).toBe(400);
    expect((await post(url, '/remote/poll', { accept: ['search'] }, 'secret-and-more')).status).toBe(401);
    const huge = await post(url, '/remote/result', { id: 0, result: 'x'.repeat(17 * 1024 * 1024) }).catch(() => null);
    if (huge) expect(huge.status).toBe(413);
  });

  it("checks a search's shape: a malformed one is a failure, searched here if this server can", async () => {
    const queue = new RemoteQueue('secret', '1:abc');
    const url = await serve(queue);
    const job: EvaluateJob = { state: {} as never, me: 0, myLog: [], commands: [{ type: 'resign' }, { type: 'resign' }], n: 32 };
    const alone = new RemoteEvaluator(queue, null, 2);
    let poll = (await waitingWorker(url)).job;
    const malformed = alone.evaluate(job).catch((e: unknown) => e);
    await post(url, '/remote/result', { id: (await poll).id, result: [[1, 0], [0]] });
    expect(await malformed).toBeInstanceOf(RemoteFailed);
    poll = (await waitingWorker(url)).job;
    let search = alone.evaluate(job);
    await post(url, '/remote/result', { id: (await poll).id, result: [[1, 0], [0, 1]] });
    expect(await search).toEqual([[1, 0], [0, 1]]);
    const local: Evaluator = { evaluate: async () => [[0.5, 0.5]] };
    poll = (await waitingWorker(url)).job;
    search = new RemoteEvaluator(queue, local, 2).evaluate(job);
    await post(url, '/remote/result', { id: (await poll).id, result: 'nonsense' });
    expect(await search).toEqual([[0.5, 0.5]]);
    expect(queue.failures.search).toBe(2);
  });
});
