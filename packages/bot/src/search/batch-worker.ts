// Worker thread of the batched search (batch-search.ts): samples its share of a search's worlds and plays every
// candidate command out in each, all its playouts in lockstep (lockstep.ts).
//
// With a GPU server (workerData.inference, its socket) the network runs there; whenever the server can't be
// reached, here instead (the same network on the CPU: slower, the same results), trying the server again later.
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { Policy } from '../policy.ts';
import { LocalInference, SocketInference, type Inference } from './inference.ts';
import { playWorlds, type WorldsJob } from './lockstep.ts';

export interface BatchJob extends WorldsJob {
  id: number;
}

const policy = Policy.load(readFileSync(workerData.weights as string));
const sampled = Boolean(workerData.sampled);
const socketPath = (workerData.inference as string | null) ?? null;
const RETRY_MS = 10_000;
const local = new LocalInference(policy);
let remote: SocketInference | null = null;
let lastTry = -Infinity;
let warned = false;
const say = (line: string) => parentPort!.postMessage({ log: line });

async function inference(): Promise<Inference> {
  if (!socketPath) return local;
  if (remote && !remote.broken) return remote;
  if (Date.now() - lastTry < RETRY_MS) return local;
  lastTry = Date.now();
  try {
    remote = await SocketInference.connect(socketPath, policy);
    if (warned) say(`[batch] the inference server is back`);
    warned = false;
    return remote;
  } catch (error) {
    if (!warned) say(`[batch] no inference server (${(error as Error).message}): the network runs on the CPU until it's back`);
    warned = true;
    return local;
  }
}

async function logits(rows: Float32Array[]): Promise<Float32Array> {
  const network = await inference();
  try {
    return await network.logits(rows);
  } catch (error) {
    if (network === local) throw error;
    if (!warned) say(`[batch] the inference server failed (${(error as Error).message}): the network runs on the CPU until it's back`);
    warned = true;
    return local.logits(rows);
  }
}

parentPort!.on('message', (job: BatchJob) => {
  playWorlds(job, policy, sampled, logits).then(
    (rows) => parentPort!.postMessage({ id: job.id, rows }),
    (error) => parentPort!.postMessage({ id: job.id, error: String(error instanceof Error ? error.stack : error) }),
  );
});
