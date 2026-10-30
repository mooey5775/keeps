// One of the app's search workers (search-pool.ts): its chunks of a search's worlds, played out in lockstep
// (packages/learn/demo/lockstep.ts), each step's observations sent to the app's Core ML host (keeps://app/nn/forward).
import { Policy } from '../../packages/learn/src/policy.ts';
import { playWorlds, type WorldsJob } from '../../packages/learn/demo/lockstep.ts';
import { encodeRequest } from '../../packages/learn/demo/request.ts';

export type SearchWorkerMessage = { t: 'init'; weights: ArrayBuffer } | { t: 'search'; id: number; job: WorldsJob };
export type SearchWorkerReply =
  | { t: 'ready' }
  | { t: 'search'; id: number; rows: number[][] }
  | { t: 'error'; id?: number; message: string };

let policy: Policy | null = null;

async function logits(rows: Float32Array[]): Promise<Float32Array> {
  const response = await fetch('/nn/forward', { method: 'POST', body: encodeRequest(rows) });
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
