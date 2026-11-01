// The search's playouts in Node worker threads, one playout at a time each (rollout-worker.ts): the Evaluator
// used where there is no GPU server (batch-search.ts batches them). Node only; search-bot.ts holds the search itself.
import { Worker } from 'node:worker_threads';
import { viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../../engine/src/index.ts';
import { Belief, noteObservation } from '../belief.ts';
import { sampleHistory, worldModel } from '../worlds.ts';
import { random, type EvaluateJob, type Evaluator } from './search.ts';

/** Worker threads that play out commands in sampled worlds. */
export class RolloutPool implements Evaluator {
  private readonly workers: Worker[];
  private next = 0;
  private readonly waiting = new Map<number, { resolve: (out: number[]) => void; reject: (e: Error) => void }>();
  private id = 0;

  /** `sampled`: rollouts sample the policy (as the bot plays it) instead of taking its most likely id. */
  constructor(size: number, weights: string, sampled = process.env.SEARCH_ROLLOUTS === 'sampled') {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./rollout-worker.ts', import.meta.url), { workerData: { weights, sampled } });
      w.on('message', (m: { id: number; out?: number[]; error?: string }) => {
        const job = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) job?.reject(new Error(m.error));
        else job?.resolve(m.out!);
      });
      return w;
    });
  }

  async evaluate(job: EvaluateJob): Promise<number[][]> {
    const { state, me, myLog, commands, n } = job;
    const opponent = ((me + 2) % 4) as Seat;
    const view = viewFor(state, me);
    // The log notes what the player saw at their decisions (BotPlayer's does), this one too.
    const log = noteObservation([...myLog], view, me);
    const belief = new Belief(me, { sound: true }).update(log);
    const model = worldModel(state, me, belief, view, log);
    const worlds = Array.from({ length: n }, () => sampleHistory(model, random));
    return Promise.all(worlds.map((h) => this.run({ world: h.world, myLog: log, theirLog: h.logs[opponent]!, me, commands })));
  }

  run(job: { world: GameState; myLog: TraceEvent[]; theirLog: TraceEvent[]; me: Seat; commands: Command[] }): Promise<number[]> {
    const id = this.id++;
    const worker = this.workers[this.next++ % this.workers.length]!;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, ...job });
    });
  }
}

