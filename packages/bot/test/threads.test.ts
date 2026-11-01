// The search pools' threads (search/threads.ts): a thread that dies fails its jobs at once, rather than leave a
// search waiting forever, and the next job gets a new thread.
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { Threads } from '../src/search/threads.ts';

// Doubles `n`; dies on `die` (as a thread out of memory would); answers {error} on `fail`.
const code = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (job) => {
  if (job.die) process.exit(3);
  if (job.fail) parentPort.postMessage({ id: job.id, error: 'no good' });
  else parentPort.postMessage({ id: job.id, out: job.n * 2 });
});`;

describe('the search threads', () => {
  it('answer jobs, fail those of a thread that dies, and start another for the next', async () => {
    let started = 0;
    const threads = new Threads<{ out: number }>(2, () => (started++, new Worker(code, { eval: true })));
    const errors = console.error;
    console.error = () => {};
    try {
      expect((await threads.post(0, { n: 2 })).out).toBe(4);
      await expect(threads.post(1, { fail: true })).rejects.toThrow('no good');
      await expect(threads.post(0, { die: true })).rejects.toThrow('a search thread died (exit code 3)');
      expect((await threads.post(0, { n: 5 })).out).toBe(10);
      expect(started).toBe(3);
    } finally {
      console.error = errors;
      await threads.close();
    }
    await expect(threads.post(0, { n: 1 })).rejects.toThrow('closed');
  });
});
