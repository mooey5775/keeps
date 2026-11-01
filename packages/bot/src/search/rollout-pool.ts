// The search's playouts in Node worker threads, one playout at a time each (rollout-worker.ts): the Evaluator
// used where there is no GPU server (batch-search.ts batches them). Node only; search-bot.ts holds the search itself.
import { Worker } from 'node:worker_threads';
import { viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { Belief, noteObservation } from '../belief.ts';
import { sampleHistory, worldModel } from '../worlds.ts';
import { random, Superseded, type EvaluateJob, type Evaluator } from './search.ts';
import { Threads } from './threads.ts';

/** Worker threads that play out commands in sampled worlds. */
export class RolloutPool implements Evaluator {
  private readonly threads: Threads<{ out: number[] }>;
  private next = 0;

  /** `sampled`: rollouts sample the policy (as the bot plays it) instead of taking its most likely id. */
  constructor(size: number, weights: string, sampled = process.env.SEARCH_ROLLOUTS === 'sampled') {
    this.threads = new Threads(size, () => new Worker(new URL('./rollout-worker.ts', import.meta.url), { workerData: { weights, sampled } }));
  }

  async evaluate(job: EvaluateJob): Promise<number[][]> {
    // (A search no longer wanted isn't started; one under way plays out.)
    if (job.wanted && !job.wanted()) throw new Superseded();
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

  async run(job: { world: GameState; myLog: TraceEvent[]; theirLog: TraceEvent[]; me: Seat; commands: Command[] }): Promise<number[]> {
    return (await this.threads.post(this.next++ % this.threads.size, job)).out;
  }

  close(): Promise<void> {
    return this.threads.close();
  }
}

