// Round review worker: a separate process, started at the lowest CPU priority by review-pool.ts, running the
// review's jobs (review-jobs.ts) that come over IPC.
//   node review-worker.ts <weights>
import { readFileSync } from 'node:fs';
import { Policy } from '../policy.ts';
import { reviewRunner, type ReviewJob } from './jobs.ts';

let x = (Math.random() * 2 ** 32) >>> 0;
const run = reviewRunner(Policy.load(readFileSync(process.argv[2]!)), () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32);

process.on('message', (message: { id: number; job: ReviewJob }) => {
  try {
    process.send!({ id: message.id, result: run(message.job) });
  } catch (error) {
    process.send!({ id: message.id, error: String(error instanceof Error ? error.stack : error) });
  }
});
process.on('disconnect', () => process.exit(0));
