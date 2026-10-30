// The remote worker for the demo server (remote.ts): runs on a machine the server can't reach (gpu03), asks the
// server for work over HTTPS, and answers it. Searches run in worker threads here; reviews in worker processes
// at nice 19 (the review pool's own), so the live game's searches come first.
//   node remote-worker.ts <server url> <token file> <weights> <search threads> <review processes>
// With SEARCH_INFERENCE=<socket of bot/keeps_bot/serve.py>, searches are batched (batch-search.ts), the network on
// that GPU server; otherwise each thread plays its playouts one at a time (RolloutPool).
// It must run the server's network: a job stamped with another network is refused (the server then searches itself).
import { readFileSync } from 'node:fs';
import { Policy } from '../src/policy.ts';
import { ReviewPool } from './review.ts';
import type { ReviewJob, ReviewResult } from './review-worker.ts';
import { BatchedPool } from './batch-search.ts';
import { RolloutPool, type EvaluateJob, type Evaluator } from './search-bot.ts';
import type { RemoteKind } from './remote.ts';

const [url, tokenFile, weights, searchArg, reviewArg] = process.argv.slice(2);
if (!url || !tokenFile || !weights) throw new Error('usage: remote-worker.ts <server url> <token file> <weights> <search threads> <review processes>');
const token = readFileSync(tokenFile, 'utf8').trim();
const { step, fingerprint } = Policy.load(readFileSync(weights)).info;
const stamp = `${step}:${fingerprint}`;
const inference = process.env.SEARCH_INFERENCE || null;
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const searches: Evaluator = inference ? new BatchedPool(Number(searchArg ?? 32), weights, inference, true, log) : new RolloutPool(Number(searchArg ?? 32), weights, true);
const reviews = new ReviewPool(Number(reviewArg ?? 16), weights);
/** Jobs at once, by kind: a search fills the threads by itself, so a few are plenty; a review job takes one process. */
const slots: Record<RemoteKind, number> = { search: 4, review: Number(reviewArg ?? 16) };
const busy: Record<RemoteKind, number> = { search: 0, review: 0 };
const done = { search: 0, review: 0, refused: 0 };
const debug = process.env.REMOTE_DEBUG ? log : () => {};

async function post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function answer(id: number, result: { result: unknown } | { error: string }): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await post('/remote/result', { id, ...result }, 30_000);
      if (res.ok) return;
    } catch {
      // try again
    }
  }
  log(`could not deliver the answer to job ${id}`);
}

async function work(job: { id: number; kind: RemoteKind; stamp: string; payload: unknown }): Promise<void> {
  if (job.stamp !== stamp) {
    done.refused++;
    log(`refused job ${job.id}: the server runs network ${job.stamp}, this worker ${stamp}`);
    await answer(job.id, { error: `network mismatch: server ${job.stamp}, worker ${stamp}` });
    return;
  }
  try {
    if (job.kind === 'search') {
      const rows = await searches.evaluate(job.payload as EvaluateJob);
      await answer(job.id, { result: rows });
    } else {
      const result = await new Promise<ReviewResult | null>((resolve) => reviews.submit('remote', 0, job.payload as ReviewJob, resolve));
      await answer(job.id, result === null ? { error: 'the review job failed' } : { result });
    }
    done[job.kind]++;
  } catch (error) {
    await answer(job.id, { error: String(error instanceof Error ? error.message : error) });
  }
}

setInterval(() => log(`done: ${done.search} searches, ${done.review} review jobs, ${done.refused} refused; now ${busy.search} searching, ${busy.review} reviewing`), 10 * 60_000).unref();
log(`remote worker for ${url}: network ${stamp}, ${searchArg} search threads (${inference ? `batched, the network on the GPU server at ${inference}` : 'one playout at a time'}), ${slots.review} review processes`);

/**
 * One kind's lane: asks for a job whenever it has a free slot, and starts on it at once (each kind polls on its own,
 * so a long poll waiting for a search never holds up reviews, or the other way round).
 */
async function lane(kind: RemoteKind): Promise<never> {
  let freed: (() => void) | null = null;
  let failures = 0;
  for (;;) {
    if (busy[kind] >= slots[kind]) {
      await new Promise<void>((resolve) => (freed = resolve));
      continue;
    }
    let res: Response;
    try {
      debug(`poll ${kind} (${busy[kind]} of ${slots[kind]} busy)`);
      res = await post('/remote/poll', { accept: [kind] }, 40_000);
    } catch (error) {
      if (failures++ % 60 === 0) log(`${kind}: the server is unreachable (${error instanceof Error ? error.message : error}); retrying`);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    if (res.status === 204) continue;
    if (!res.ok) {
      if (failures++ % 60 === 0) log(`${kind}: poll refused, HTTP ${res.status}; retrying`);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    let job: { id: number; kind: RemoteKind; stamp: string; payload: unknown };
    try {
      job = (await res.json()) as typeof job;
      if (typeof job?.id !== 'number' || job.kind !== kind) throw new Error('not a job');
    } catch {
      // A server without remote work (an older version answers with its web page): ask again later.
      if (failures++ % 20 === 0) log(`${kind}: the server answered without a job (no remote work there yet?); retrying`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    if (failures > 0) log(`${kind}: connected`);
    failures = 0;
    debug(`job ${job.id}: ${job.kind}`);
    busy[kind]++;
    void work(job).finally(() => {
      debug(`job ${job.id} answered`);
      busy[kind]--;
      freed?.();
      freed = null;
    });
  }
}

await Promise.all([lane('search'), lane('review')]);
