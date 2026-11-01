// The round review's jobs (review.ts makes them), playing rounds out to the end with the network sampling every move
// for both sides, each side reading its own log:
//   truth   the real position, n times (optionally after one given first move): wins by seat;
//   worlds  n worlds drawn from what `me` knows (each with its history: the opponent reads their own log
//           of it), each played on once, or once per given first move (the same worlds for every move):
//           `me`'s result per world and move, 1 won, 0 not.
// Run anywhere, as playouts (reviewGames): the website's review workers one observation at a time (reviewRunner), the
// app's Web Workers in lockstep, the network on the Neural Engine.
import { viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { Belief, noteObservation } from '../belief.ts';
import type { Policy } from '../policy.ts';
import { seeded } from '../random.ts';
import { playOut, roundPlayout, sampledPick, type Ask } from '../search/playout.ts';
import { sampleHistory, worldModel } from '../worlds.ts';

export type ReviewJob =
  | { kind: 'truth'; state: GameState; logs: [Seat, TraceEvent[]][]; first: { seat: Seat; command: Command } | null; n: number }
  | { kind: 'worlds'; state: GameState; me: Seat; myLog: TraceEvent[]; commands: Command[] | null; n: number };
export type ReviewResult = { wins: Partial<Record<Seat, number>>; n: number } | { rows: number[][] };

/**
 * A job's playouts, for a driver to run (one observation at a time, playOut; or in lockstep on a GPU or the Neural
 * Engine, lockstep.ts's drive), and `finish`, its result from their winners in order. Each playout draws from its
 * own stream (seeded from `random`), so the result doesn't depend on how the playouts are run.
 */
export function reviewGames(job: ReviewJob, policy: Policy, random: () => number): { games: Generator<Ask, Seat | null, Float32Array>[]; finish: (winners: (Seat | null)[]) => ReviewResult } {
  const seed = Math.floor(random() * 2 ** 32);
  const pick = (i: number) => sampledPick(policy, seeded(seed, i + 1));
  if (job.kind === 'truth') {
    const games = Array.from({ length: job.n }, (_, i) => roundPlayout(job.state, job.logs, job.first, pick(i)));
    return {
      games,
      finish: (winners) => {
        const wins: Partial<Record<Seat, number>> = {};
        for (const w of winners) if (w !== null) wins[w] = (wins[w] ?? 0) + 1;
        return { wins, n: job.n };
      },
    };
  }
  const { state, me } = job;
  const commands = job.commands ?? [null];
  const belief = new Belief(me, { sound: true });
  const view = viewFor(state, me);
  // The player's log notes what they saw at their decisions; this view too (what they see now).
  const myLog = noteObservation([...job.myLog], view, me);
  belief.update(myLog);
  const model = worldModel(state, me, belief, view, myLog);
  const opponent = ((me + 2) % 4) as Seat;
  const worlds = Array.from({ length: job.n }, () => sampleHistory(model, random));
  const games = worlds.flatMap((h, w) =>
    commands.map((command, k) =>
      roundPlayout(h.world, [[me, myLog], [opponent, h.logs[opponent]!]], command ? { seat: me, command } : null, pick(w * commands.length + k)),
    ),
  );
  return {
    games,
    // One row per world: 1 where `me` won after that move, 0 where not.
    finish: (winners) => ({ rows: worlds.map((_, w) => commands.map((_, k) => (winners[w * commands.length + k] === me ? 1 : 0))) }),
  };
}

/** Runs review jobs with `policy` here, one observation at a time, drawing chance from `random`. */
export function reviewRunner(policy: Policy, random: () => number): (job: ReviewJob) => ReviewResult {
  return (job) => {
    const { games, finish } = reviewGames(job, policy, random);
    return finish(games.map((game) => playOut(game, policy)));
  };
}
