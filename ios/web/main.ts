// The iOS spike's page: how fast Midstrike's search runs on the phone. Each step's results go to the page and to the
// app's log (stdout, so `devicectl device process launch --console` shows them).
//   1. the Core ML model: its network and its speed by compute units and batch size (timed natively);
//   2. its logits against the JavaScript network's, on real observations;
//   3. the bridge alone: requests of real observations sent to the app and answered without the network;
//   4. whole searches: each position's worlds in chunks the workers take as they're free, the network in Core ML;
//   5. the same with the network in JavaScript (a few positions, fewer worlds): what the bridge and Core ML buy.
// The query string can change the plan: ?positions=24&worlds=512&units=ane,all&js=2&big=4&chunk=64, and
// &workers=4,6 to compare worker counts. By default: one per core but two, as the app reports its cores (the page,
// WebKit's own processes and Core ML's CPU-side work need the rest; on the iPhone Air, 6 workers were slower than 4).
import type { Command, GameState, Seat, TraceEvent } from '../../packages/engine/src/index.ts';
import { Policy } from '../../packages/learn/src/policy.ts';
import { worldGames, type WorldsJob } from '../../packages/learn/demo/lockstep.ts';
import { encodeRequest } from '../../packages/learn/demo/request.ts';
import type { WorkerMessage, WorkerReply } from './worker.ts';

type Position = { state: GameState; me: Seat; myLog: TraceEvent[]; commands: Command[] };
const query = new URLSearchParams(location.search);
const option = (name: string, fallback: number) => Number(query.get(name) ?? fallback);
const POSITIONS = option('positions', 24);
const WORLDS = option('worlds', 512);
const CHUNK = option('chunk', 64);
const UNITS = (query.get('units') ?? 'ane,all').split(',');
const JS_POSITIONS = option('js', 2);
const BIG = option('big', 4);

const out = document.getElementById('out')!;
const handler = (window as unknown as { webkit?: { messageHandlers?: { log?: { postMessage(s: string): void } } } }).webkit?.messageHandlers?.log;
function log(line: string): void {
  out.textContent += line + '\n';
  handler?.postMessage(line);
  window.scrollTo(0, document.body.scrollHeight);
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

class Workers {
  private readonly pool: Worker[] = [];
  private readonly waiting = new Map<number, (r: WorkerReply) => void>();
  private id = 0;

  async start(n: number, weights: ArrayBuffer): Promise<void> {
    await Promise.all(
      Array.from({ length: n }, () => {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        this.pool.push(w);
        return new Promise<void>((resolve, reject) => {
          w.onmessage = (e: MessageEvent<WorkerReply>) => {
            const m = e.data;
            if (m.t === 'ready') return resolve();
            if (m.t === 'error' && m.id === undefined) return reject(new Error(m.message));
            const done = this.waiting.get((m as { id: number }).id);
            this.waiting.delete((m as { id: number }).id);
            if (m.t === 'error') log(`worker error: ${m.message}`);
            done?.(m);
          };
          w.postMessage({ t: 'init', weights: weights.slice(0) } satisfies WorkerMessage);
        });
      }),
    );
  }

  ask(i: number, m: Omit<Extract<WorkerMessage, { id: number }>, 'id'>): Promise<WorkerReply> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.pool[i]!.postMessage({ ...m, id } as WorkerMessage);
    });
  }

  get size(): number {
    return this.pool.length;
  }

  /** The workers' computing time since the last call, summed. */
  async busy(): Promise<number> {
    const replies = await Promise.all(this.pool.map((_, i) => this.ask(i, { t: 'busy' })));
    return replies.reduce((a, r) => a + (r.t === 'busy' ? r.ms : 0), 0);
  }

  stop(): void {
    for (const w of this.pool) w.terminate();
  }
}

/**
 * One search: the position's worlds in chunks of CHUNK, each with its own seed, taken by whichever worker has room
 * (two at a time each, so a worker always has playouts to batch). Fast cores take more chunks than slow ones, so no
 * worker count or split needs tuning to a device; the results come back in chunk order, the same whoever ran them.
 */
async function search(workers: Workers, p: Position, worlds: number, seed: number, inference: 'native' | 'js') {
  const chunks = Array.from({ length: Math.ceil(worlds / CHUNK) }, (_, c) => ({ n: Math.min(CHUNK, worlds - c * CHUNK), seed: (seed + Math.imul(c, 0x85ebca6b)) >>> 0 }));
  const done: Extract<WorkerReply, { t: 'search' }>[] = new Array(chunks.length);
  await workers.busy();
  await fetch('/nn/stats');
  let next = 0;
  const t = performance.now();
  await Promise.all(
    Array.from({ length: 2 * workers.size }, async (_, slot) => {
      while (next < chunks.length) {
        const c = next++;
        const job: WorldsJob = { state: p.state, me: p.me, myLog: p.myLog, commands: p.commands, ...chunks[c]! };
        const r = await workers.ask(slot % workers.size, { t: 'search', job, inference });
        if (r.t !== 'search') throw new Error('a worker failed');
        done[c] = r;
      }
    }),
  );
  const ms = performance.now() - t;
  const busy = await workers.busy();
  const native = (await getJson<Record<string, number>>('/nn/stats'));
  const rows = done.flatMap((r) => r.rows);
  const q = p.commands.map((_, k) => rows.reduce((a, r) => a + r[k]!, 0) / rows.length);
  const calls = done.reduce((a, r) => a + r.calls, 0);
  const rowsSent = done.reduce((a, r) => a + r.rowsSent, 0);
  return { ms, q, calls, rowsSent, jsBusy: busy / (workers.size * ms), native };
}

/** Where a search's native time went: each part's share of the search's wall time (summed over lanes). */
function nativeShares(n: Record<string, number>, ms: number): string {
  const share = (x: number) => `${((100 * x * 1000) / ms).toFixed(0)}%`;
  return `native: parse ${share(n.parse!)}, fill ${share(n.fill!)}, Core ML ${share(n.predict!)}, read ${share(n.read!)}`;
}

async function main(): Promise<void> {
  log(`Keeps spike; ${navigator.userAgent}`);
  const weights = await (await fetch('midstrike.bin')).arrayBuffer();
  const policy = Policy.load(new Uint8Array(weights));
  const positions = (await getJson<Position[]>('positions.json')).slice(0, POSITIONS);
  const info = await getJson<Record<string, string>>('/nn/info');
  log(`cores: ${info.cores} (${info.performanceCores} performance, ${info.efficiencyCores} efficiency); WebKit reports ${navigator.hardwareConcurrency}`);
  log(`network: JavaScript ${policy.info.run} step ${policy.info.step} (${policy.info.fingerprint}); Core ML ${info.run} step ${info.step} (${info.fingerprint})`);
  if (info.fingerprint !== policy.info.fingerprint || Number(info.step) !== policy.info.step) throw new Error('the Core ML model is another network');

  // 1. Core ML alone.
  log('\n1. Core ML alone (native timing, per call):');
  for (const line of (await (await fetch('/nn/bench')).text()).trim().split('\n')) log(`   ${line}`);

  // 2. Logits against JavaScript's, on real observations: each world's first ask, for the first positions.
  const asks = positions.slice(0, 8).flatMap((p, i) =>
    worldGames({ ...p, n: 8, seed: 100 + i }, policy, true).flatMap((g) => {
      const r = g.next();
      return r.done ? [] : [r.value];
    }),
  );
  const nativeLogits = new Float32Array(await (await fetch('/nn/forward', { method: 'POST', body: encodeRequest(asks.map((a) => a.obs)) })).arrayBuffer());
  let tv = 0, worstTv = 0, changed = 0, worstLogit = 0;
  asks.forEach((a, i) => {
    const want = policy.probabilitiesFrom(policy.logits(a.obs), a.mask);
    const got = policy.probabilitiesFrom(nativeLogits.subarray(i * 48, (i + 1) * 48), a.mask);
    let d = 0;
    for (const id of a.ids) {
      d += Math.abs(want[id]! - got[id]!) / 2;
      worstLogit = Math.max(worstLogit, Math.abs(policy.logits(a.obs)[id]! - nativeLogits[i * 48 + id]!));
    }
    tv += d;
    worstTv = Math.max(worstTv, d);
    const top = (p: Float32Array) => a.ids.reduce((b, id) => (p[id]! > p[b]! ? id : b), a.ids[0]!);
    if (top(want) !== top(got)) changed++;
  });
  log(`\n2. Core ML vs JavaScript on ${asks.length} real observations: total variation mean ${((100 * tv) / asks.length).toFixed(2)}%, max ${(100 * worstTv).toFixed(1)}%; top move changed in ${changed}; max |logit difference| ${worstLogit.toFixed(3)}`);

  for (const count of (query.get('workers') ?? String(Math.max(1, Number(info.cores) - 2))).split(',').map(Number)) {
    log(`\n=== ${count} workers ===`);
    const workers = new Workers();
    await workers.start(count, weights);
    await measure(workers, policy, positions, asks);
    workers.stop();
  }
  log('\nDONE');
}

async function measure(workers: Workers, policy: Policy, positions: Position[], asks: { obs: Float32Array }[]): Promise<void> {
  // 3. The bridge alone.
  const rows256 = Array.from({ length: 256 }, (_, i) => asks[i % asks.length]!.obs);
  const bytes = encodeRequest(rows256).length;
  log(`\n3. The bridge alone (256 observations, ${(bytes / 1024).toFixed(0)} KB per request, answered without the network):`);
  for (const n of [1, workers.size]) {
    const t = performance.now();
    const replies = await Promise.all(Array.from({ length: n }, (_, i) => workers.ask(i, { t: 'echo', rows: rows256, times: 20 })));
    const wall = performance.now() - t;
    const ms = replies.flatMap((r) => (r.t === 'echo' ? r.ms : []));
    log(`   ${n} worker${n > 1 ? 's' : ''} at once: ${mean(ms).toFixed(1)} ms per round trip (median ${median(ms).toFixed(1)}), ${((n * 20 * bytes) / 1e6 / (wall / 1000)).toFixed(0)} MB/s in all`);
  }

  // 4. Whole searches, the network in Core ML.
  for (const units of UNITS) {
    await fetch(`/nn/units?set=${units}`);
    log(`\n4. Searches of ${WORLDS} worlds, Core ML on ${units} (${positions.length} positions):`);
    await search(workers, positions[0]!, 64, 1, 'native'); // warm-up
    const times: number[] = [];
    let moves = 0;
    for (const [i, p] of positions.entries()) {
      const r = await search(workers, p, WORLDS, 7 + i, 'native');
      times.push(r.ms);
      moves += p.commands.length;
      log(`   position ${i + 1}: ${p.commands.length} moves, ${s(r.ms)}; ${r.calls} requests of ${(r.rowsSent / r.calls).toFixed(0)} observations; workers busy ${(100 * r.jsBusy).toFixed(0)}%; ${nativeShares(r.native, r.ms)}`);
    }
    log(`   ${units}: mean ${s(mean(times))}, median ${s(median(times))}, max ${s(Math.max(...times))} (${(moves / positions.length).toFixed(1)} moves per decision)`);
  }
  if (BIG > 0) {
    await fetch(`/nn/units?set=${UNITS[0]}`);
    const times: number[] = [];
    for (const [i, p] of positions.slice(0, BIG).entries()) times.push((await search(workers, p, 2048, 70 + i, 'native')).ms);
    log(`\n4b. 2,048 worlds, ${UNITS[0]}, first ${BIG} positions: ${times.map(s).join(', ')} (mean ${s(mean(times))})`);
  }

  // 5. The network in JavaScript, for comparison.
  if (JS_POSITIONS > 0) {
    const times: number[] = [];
    for (const [i, p] of positions.slice(0, JS_POSITIONS).entries()) times.push((await search(workers, p, 128, 50 + i, 'js')).ms);
    log(`\n5. The network in JavaScript, 128 worlds, first ${JS_POSITIONS} positions: ${times.map(s).join(', ')} (about ${s((mean(times) * WORLDS) / 128)} for ${WORLDS} worlds)`);
  }
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
  log('DONE');
});
