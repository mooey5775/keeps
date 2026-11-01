// The remote queue (demo/remote.ts): a worker that can't be reached asks for work over HTTP and answers it.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteEvaluator, RemoteQueue } from '../src/remote/remote.ts';
import type { EvaluateJob, Evaluator } from '../src/search/search.ts';

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
    await expect(queue.submit('search', {}, 100)).rejects.toThrow('took over');
    void poll;
  });
});
