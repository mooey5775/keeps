// One of the app's search workers (search-pool.ts): its chunks of a search's worlds, played out in lockstep
// (packages/bot/src/search/lockstep.ts), each step's observations sent to the app's Core ML host (keeps://app/nn/forward).
import { Policy } from '../../packages/bot/src/policy.ts';
import { playWorlds, type WorldsJob } from '../../packages/bot/src/search/lockstep.ts';
import { encodeRequest } from '../../packages/bot/src/search/request.ts';

export type SearchWorkerMessage = { t: 'init'; weights: ArrayBuffer } | { t: 'search'; id: number; job: WorldsJob };
export type SearchWorkerReply =
  | { t: 'ready' }
  | { t: 'search'; id: number; rows: number[][] }
  | { t: 'error'; id?: number; message: string };

let policy: Policy | null = null;

/** How long the app's network may take to answer one request before the search gives up, saying so. */
const NETWORK_MS = 30_000;

async function logits(rows: Float32Array[]): Promise<Float32Array> {
  const response = await fetch('/nn/forward', { method: 'POST', body: encodeRequest(rows), signal: AbortSignal.timeout(NETWORK_MS) }).catch((error: unknown) => {
    throw new Error(`the network didn't answer ${rows.length} rows in ${NETWORK_MS / 1000} s (${error instanceof Error ? error.message : String(error)})`);
  });
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
    } else {
      // Sampled rollouts, as Midstrike plays (the policy sampled on both sides).
      post({ t: 'search', id: m.id, rows: await playWorlds(m.job, policy!, true, logits) });
    }
  } catch (error) {
    post({ t: 'error', id: m.t === 'search' ? m.id : undefined, message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  }
};
