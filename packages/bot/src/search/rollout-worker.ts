// Rollout worker for the search bot: for one sampled world, plays each candidate command out to
// the end of the round with the policy on both sides (playout.ts), and reports +1 or -1 for the
// searching seat per command. The network runs here, one observation at a time; batch-worker.ts
// runs many playouts in lockstep instead. `sampled`: each id drawn from the policy as the bot plays
// it; otherwise greedy, the policy's most likely id.
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import type { Command, GameState, Seat, TraceEvent } from '@keeps/engine';
import { Policy } from '../policy.ts';
import { greedyPick, playOut, playout, sampledPick } from './playout.ts';

const policy = Policy.load(readFileSync(workerData.weights as string));
let x = (Math.random() * 2 ** 32) >>> 0;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const pick = workerData.sampled ? sampledPick(policy, random) : greedyPick(policy);

parentPort!.on('message', (job: { id: number; world: GameState; myLog: TraceEvent[]; theirLog: TraceEvent[]; me: Seat; commands: Command[] }) => {
  try {
    parentPort!.postMessage({ id: job.id, out: job.commands.map((c) => playOut(playout(job.world, job.me, c, job.myLog, job.theirLog, pick), policy)) });
  } catch (error) {
    parentPort!.postMessage({ id: job.id, error: String(error instanceof Error ? error.stack : error) });
  }
});
