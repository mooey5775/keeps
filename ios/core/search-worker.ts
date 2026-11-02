// One of the app's search workers (search-pool.ts): its chunks of a search's worlds, and the round review's jobs, played
// out in lockstep (packages/bot/src/search/lockstep.ts), each step's observations sent to the app's Core ML host
// (keeps://app/nn/forward).
import { Policy } from '@keeps/bot/policy.ts';
import { reviewGames, type ReviewJob, type ReviewResult } from '@keeps/bot/review/jobs.ts';
import { drive, playWorlds, type WorldsJob } from '@keeps/bot/search/lockstep.ts';
import { encodeRequest } from '@keeps/bot/search/request.ts';
import { awakeTimeout } from './awake.ts';

export type SearchWorkerMessage =
  | { t: 'init'; weights: ArrayBuffer }
  | { t: 'search'; id: number; job: WorldsJob }
  | { t: 'review'; id: number; job: ReviewJob };
export type SearchWorkerReply =
  | { t: 'ready' }
  | { t: 'search'; id: number; rows: number[][] }
  | { t: 'review'; id: number; result: ReviewResult }
  | { t: 'error'; id?: number; message: string };

let policy: Policy | null = null;

/** How long the app's network may take to answer one request before the search gives up, saying so. */
const NETWORK_MS = 30_000;

async function logits(rows: Float32Array[]): Promise<Float32Array> {
  // (Counted in time the app runs: a phone locked while the network works isn't the network failing.)
  const abort = new AbortController();
  const cancel = awakeTimeout(NETWORK_MS, () => abort.abort(new Error('timed out')));
  const response = await fetch('/nn/forward', { method: 'POST', body: encodeRequest(rows), signal: abort.signal })
    .catch((error: unknown) => {
      throw new Error(`the network didn't answer ${rows.length} rows in ${NETWORK_MS / 1000} s (${error instanceof Error ? error.message : String(error)})`);
    })
    .finally(cancel);
  if (!response.ok) throw new Error(`the network: HTTP ${response.status} ${await response.text()}`);
  return new Float32Array(await response.arrayBuffer());
}

const post = (m: SearchWorkerReply) => (globalThis as unknown as { postMessage(m: unknown): void }).postMessage(m);

onmessage = async (e: MessageEvent<SearchWorkerMessage>) => {
  const m = e.data;
  try {
    if (m.t === 'init') {
      policy = Policy.load(new Uint8Array(m.weights));
      post({ t: 'ready' });
    } else if (m.t === 'search') {
      // Sampled rollouts, as Midstrike plays (the policy sampled on both sides).
      post({ t: 'search', id: m.id, rows: await playWorlds(m.job, policy!, true, logits) });
    } else {
      const { games, finish } = reviewGames(m.job, policy!, Math.random);
      post({ t: 'review', id: m.id, result: finish(await drive(games, logits, policy!.info.numActions)) });
    }
  } catch (error) {
    post({ t: 'error', id: m.t === 'init' ? undefined : m.id, message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  }
};
