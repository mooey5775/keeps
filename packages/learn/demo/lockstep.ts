// The batched search's core (batch-worker.ts runs it in each worker thread): a search's worlds sampled, every
// candidate command played out in each (playout.ts), all the playouts in lockstep: each step, every unfinished
// playout's next observation goes to the network in one batch. The playouts are split into groups that take
// turns, so one group's engine work overlaps the other's wait for the network.
import { viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { Belief, noteObservation } from '../src/belief.ts';
import type { Policy } from '../src/policy.ts';
import { sampleHistory, worldModel } from '../src/worlds.ts';
import { greedyPick, playout, sampledPick, type Ask } from './playout.ts';
import { seeded } from './random.ts';

export interface WorldsJob {
  state: GameState;
  me: Seat;
  myLog: TraceEvent[];
  commands: Command[];
  /** Worlds to sample and play out. */
  n: number;
  seed: number;
}

export type Logits = (rows: Float32Array[]) => Promise<Float32Array>;

/**
 * The job's playouts, world after world, each world's commands in order. Each draws from its own stream, so its
 * result doesn't depend on how the playouts are batched.
 */
export function worldGames(job: WorldsJob, policy: Policy, sampled: boolean): Generator<Ask, number, Float32Array>[] {
  const { state, me, myLog, commands, n, seed } = job;
  const opponent = ((me + 2) % 4) as Seat;
  const random = seeded(seed, 0);
  const view = viewFor(state, me);
  // The log notes what the player saw at their decisions (BotPlayer's does), this one too.
  const log = noteObservation([...myLog], view, me);
  const belief = new Belief(me, { sound: true }).update(log);
  const model = worldModel(state, me, belief, view, log);
  const worlds = Array.from({ length: n }, () => sampleHistory(model, random));
  return worlds.flatMap((h, w) =>
    commands.map((c, k) => {
      const pick = sampled ? sampledPick(policy, seeded(seed, 1 + w * commands.length + k)) : greedyPick(policy);
      return playout(h.world, me, c, log, h.logs[opponent]!, pick);
    }),
  );
}

/**
 * At most this many playouts under way at once per group: each holds a game state, two beliefs and two logs, so
 * a search's thousands of playouts (worlds × commands) can't all be alive at once. The rest start as others end.
 */
export const LIVE = 256;

/** Each game's result, the games advanced in lockstep: one batch of observations per step and group. */
export async function drive(games: Generator<Ask, number, Float32Array>[], logits: Logits, actions: number, groups = 2, live = LIVE): Promise<number[]> {
  const results = new Array<number>(games.length);
  const asks: (Ask | null)[] = new Array(games.length).fill(null);
  let started = 0;
  /** Starts the next game that has a decision to make (finishing any that end without one); -1 if none are left. */
  const start = (): number => {
    while (started < games.length) {
      const i = started++;
      const r = games[i]!.next();
      if (!r.done) {
        asks[i] = r.value;
        return i;
      }
      results[i] = r.value;
    }
    return -1;
  };
  await Promise.all(
    Array.from({ length: groups }, async () => {
      let running: number[] = [];
      for (let i; running.length < live && (i = start()) >= 0; ) running.push(i);
      while (running.length > 0) {
        const out = await logits(running.map((i) => asks[i]!.obs));
        const next: number[] = [];
        running.forEach((i, k) => {
          const r = games[i]!.next(out.subarray(k * actions, (k + 1) * actions));
          if (r.done) {
            results[i] = r.value;
            asks[i] = null;
            const j = start();
            if (j >= 0) next.push(j);
          } else {
            asks[i] = r.value;
            next.push(i);
          }
        });
        running = next;
      }
    }),
  );
  return results;
}

/** The job's results: one row per world, ±1 per command (`me`'s result). */
export async function playWorlds(job: WorldsJob, policy: Policy, sampled: boolean, logits: Logits): Promise<number[][]> {
  const results = await drive(worldGames(job, policy, sampled), logits, policy.info.numActions);
  const k = job.commands.length;
  return Array.from({ length: job.n }, (_, w) => results.slice(w * k, (w + 1) * k));
}
