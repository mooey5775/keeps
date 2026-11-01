// A search worker for the spike: its share of a search's worlds, played out in lockstep (packages/learn/demo
// lockstep.ts), the network run either natively (Core ML, through the app's keeps:// scheme) or here in JavaScript.
import { Policy } from '../../packages/bot/src/policy.ts';
import { playWorlds, type WorldsJob } from '../../packages/bot/src/search/lockstep.ts';
import { encodeRequest } from '../../packages/bot/src/search/request.ts';

export type WorkerMessage =
  | { t: 'init'; weights: ArrayBuffer }
  | { t: 'search'; id: number; job: WorldsJob; inference: 'native' | 'js' }
  | { t: 'echo'; id: number; rows: Float32Array[]; times: number }
  | { t: 'busy'; id: number };

export type WorkerReply =
  | { t: 'ready' }
  | { t: 'search'; id: number; rows: number[][]; calls: number; rowsSent: number }
  /** The time this worker spent computing (not waiting for the network) since the last ask. */
  | { t: 'busy'; id: number; ms: number }
  | { t: 'echo'; id: number; ms: number[] }
  | { t: 'error'; id?: number; message: string };

let policy: Policy | null = null;
// Busy time: the worker's thread runs one stretch of a search at a time, from when an answer from the network (or
// the search's start) resumes it to its next request (or its end), so the stretches add up without overlapping,
// however many searches and groups interleave here.
let busyMs = 0;
let resumedAt = 0;

/** The network's logits for `rows`, from the app's Core ML host (or its echo endpoint: the bridge alone). */
async function native(rows: Float32Array[], path = '/nn/forward'): Promise<Float32Array> {
  const response = await fetch(path, { method: 'POST', body: encodeRequest(rows) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return new Float32Array(await response.arrayBuffer());
}

const post = (m: WorkerReply) => postMessage(m);

onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const m = e.data;
  try {
    if (m.t === 'init') {
      policy = Policy.load(new Uint8Array(m.weights));
      post({ t: 'ready' });
    } else if (m.t === 'search') {
      const p = policy!;
      let calls = 0, rowsSent = 0;
      const logits = async (rows: Float32Array[]) => {
        calls++;
        rowsSent += rows.length;
        if (m.inference === 'js') return new Float32Array(rows.flatMap((obs) => [...p.logits(obs)]));
        busyMs += performance.now() - resumedAt;
        const out = await native(rows);
        resumedAt = performance.now();
        return out;
      };
      resumedAt = performance.now();
      const rows = await playWorlds(m.job, p, true, logits);
      busyMs += performance.now() - resumedAt;
      post({ t: 'search', id: m.id, rows, calls, rowsSent });
    } else if (m.t === 'busy') {
      post({ t: 'busy', id: m.id, ms: busyMs });
      busyMs = 0;
    } else if (m.t === 'echo') {
      const ms: number[] = [];
      for (let i = 0; i < m.times; i++) {
        const t = performance.now();
        await native(m.rows, '/nn/echo');
        ms.push(performance.now() - t);
      }
      post({ t: 'echo', id: m.id, ms });
    }
  } catch (error) {
    post({ t: 'error', id: 'id' in m ? m.id : undefined, message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  }
};
